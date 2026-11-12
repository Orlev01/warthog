// E18-S05 — Home dashboard metrics read (brief "Home dashboard"; design §5 —
// every member-scoped read takes the user id from the session, never a client
// value).
//
// The completed home dashboard shows live counts, activity, per-agent spend and
// reminders. This is the single OWNER-scoped aggregation that feeds them: it
// REUSES the already-built, tested primitives rather than re-running their SQL —
//   • the pending count          — the approval inbox (`listPendingForUser`);
//   • the activity feed           — the activity list read, newest first, the
//                                    latest HOME_ACTIVITY_LIMIT entries only
//                                    (`listActivity` with no filters);
//   • each agent's status /        — the agents aggregate (`listAgentsForUser`);
//     last-active
//   • each agent's budget          — its agent-permission grant's `cardBudget`
//                                    (`getConnectionPermissions`);
//   • each agent's period spend    — the card-spend ledger's member-scoped sum,
//                                    bucketed by the SHARED budget-period math
//                                    (`sumForConnectionPeriod` + `periodKeyFor`);
//   • the account currency         — `getAccountCurrency` (the person's own code);
//   • the upcoming reminders       — the life-admin records (`listRecordsForUser`),
//                                    filtered to a due date that has not passed.
//
// It adds NO SQL and NO crypto of its own. Like the sibling set-up-checklist read
// it resolves the person's DEK through the injected `KeyWrapper` seam (read the
// wrapped DEK from `users.wrapped_dek`, unwrap it) so the approval details, the
// activity payloads and the life-admin fields decrypt; it reads no `process.env`
// and holds no key (INV-103). Every figure is member-scoped by the session's
// `userId`, never a client value, and each underlying store binds its ids as
// parameters, so an id shaped like SQL travels as data and cannot alter a query
// (INV-102). The current period bucket and the "upcoming" cut-off are derived from
// the INJECTED clock, never SQL now().

import { listActivity, summariseActivity, type ActivityGroupSummary } from "../activity/list";
import type { ActivityEntry } from "../activity/recorder";
import { getAccountCurrency } from "../db/account-currency";
import { getConnectionPermissions } from "../db/agent-permissions";
import { listAgentsForUser, type AgentStatus } from "../db/agents";
import { listPendingForUser } from "../db/approvals";
import { periodKeyFor, type PeriodKind } from "../db/card-spend-ledger";
import { readAgentSpending } from "../spending/agent-spending";
import type { Db } from "../db/index";
import { listRecordsForUser, type LifeAdminRecord } from "../db/life-admin-records";
import { getUserById } from "../db/users";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Clock } from "../seams/clock";
import { timeZoneFor } from "../spending/time-zone";

// The injected seams — no process.env. `db` is the parameterizing database seam;
// `keyWrapper` unwraps the person's DEK (from users.wrapped_dek) so the approval
// details, activity payloads and life-admin fields decrypt; `clock` is "now" for
// the current budget period and the "upcoming" cut-off.
export interface HomeMetricsDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
}

// One of the person's agents on the dashboard: its identity, connection status,
// last-active time, and the spend in its current budget period against its budget
// — both expressed in the person's account currency (`spendThisPeriod`/`budget`
// may come back as a number or a numeric string, like the ledger sums).
export interface HomeAgentSpend {
  readonly agentId: string;
  readonly displayName: string;
  readonly platform?: string;
  readonly status: AgentStatus;
  readonly lastActiveAt: Date | string | null;
  readonly spendThisPeriod: number | string;
  readonly spendUnavailable?: boolean;
  readonly budget: number | string;
  readonly budgetPeriod: PeriodKind;
  readonly currency: string;
}

// How many of the latest activity entries the Home feed shows.
export const HOME_ACTIVITY_LIMIT = 20;

const DAY_MS = 86_400_000;

// A record's due date as a sortable YYYY-MM-DD (records without one sort last).
function dueKey(record: LifeAdminRecord): string {
  if (record.dueDate == null) return "9999-12-31";
  const iso = record.dueDate instanceof Date ? record.dueDate.toISOString() : String(record.dueDate);
  return iso.slice(0, 10);
}

export interface HomeMetrics {
  readonly pendingApprovals: number; // the count of PENDING approvals (decided excluded)
  readonly activity: ActivityEntry[]; // the latest HOME_ACTIVITY_LIMIT entries across ALL the person's agents, newest first
  readonly agents: HomeAgentSpend[]; // the person's agents, each with spend-this-period
  readonly reminders: LifeAdminRecord[]; // the life-admin records whose reminder date is upcoming, soonest first
  // Exact counts of the last 24 hours' activity per agent (null key ⇒ no agent), from
  // plaintext metadata — so Home can say "14 entries today · 2 need attention" per agent.
  readonly lastDayByAgent?: ActivityGroupSummary[];
}

// Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK (bound by
// userId through the users store) and unwrap it through the KeyWrapper seam. Throws
// when the person has no row (never fails silently) — the set-up-checklist idiom.
async function dataKeyFor(db: Db, keyWrapper: KeyWrapper, userId: string): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("loadHomeMetrics: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// A record is an UPCOMING reminder iff it has a due date that has not yet passed
// (today or later). A record with no due date, or whose due date is already gone,
// is not upcoming. Compared as calendar-day keys ("YYYY-MM-DD"), so the exact
// instant within the day never matters.
function isUpcoming(record: LifeAdminRecord, today: string): boolean {
  if (record.dueDate == null) return false;
  const iso = record.dueDate instanceof Date ? record.dueDate.toISOString() : record.dueDate;
  return iso.slice(0, 10) >= today;
}

// Aggregate the four home-dashboard figures for `userId` (the SESSION's id, NEVER a
// client value) from the reused stores. Member-scoped by the passed id alone — one
// person can never read another's approvals, activity, agents, spend or reminders;
// the period spend is derived with the shared budget-period math from the injected
// clock (never SQL now()).
export async function loadHomeMetrics(
  deps: HomeMetricsDeps,
  userId: string,
): Promise<HomeMetrics> {
  const { db, keyWrapper, clock } = deps;
  const now = clock.now();

  // Resolve the person's data key first (it decrypts the approval details, the
  // activity payloads and the life-admin fields; the member-scoped lookup also
  // binds `userId` as a parameter).
  const dek = await dataKeyFor(db, keyWrapper, userId);

  // The person's account currency — the code every agent figure is expressed in.
  const currency = await getAccountCurrency(db, userId);

  // The person's own time zone (review fix W4.3): "this period" and "today" are their
  // local day/week/month — the same buckets the release handler writes.
  const timeZone = await timeZoneFor(db, userId, dek);

  // The pending-approval count (decided approvals are excluded by the inbox read).
  const pending = await listPendingForUser(db, userId, dek);

  // The latest activity across ALL the person's agents, newest first, decrypted — a
  // bounded page, so Home never decrypts the person's whole history (the Activity page
  // holds the full record).
  const activity = await listActivity(db, userId, {}, dek, { limit: HOME_ACTIVITY_LIMIT });
  const lastDayByAgent = await summariseActivity(db, userId, { from: new Date(now.getTime() - DAY_MS).toISOString() }, "agent");

  // Each agent with its status / last-active and its spend this budget period
  // against the budget held in its agent-permission grant.
  const agentRows = await listAgentsForUser(db, userId);
  const agents: HomeAgentSpend[] = [];
  for (const agent of agentRows) {
    const permissions = await getConnectionPermissions(db, userId, agent.connectionId);
    const cardBudget = permissions?.cardBudget ?? null;
    const budgetPeriod: PeriodKind = cardBudget?.period ?? "month";
    const budget = cardBudget?.amount ?? 0;
    // Only an agent with a card budget has a period to bucket its releases by; the
    // sum uses the SHARED budget-period math to pick the current bucket.
    const spending = cardBudget
      ? await readAgentSpending(db, userId, agent.connectionId, cardBudget, now, timeZone)
      : { total: 0, unconverted: [] };
    agents.push({
      agentId: agent.id,
      displayName: agent.displayName,
      platform: agent.platform,
      status: agent.status,
      lastActiveAt: agent.lastActiveAt,
      spendThisPeriod: spending.total,
      ...(spending.unconverted.length ? { spendUnavailable: true } : {}),
      budget,
      budgetPeriod,
      currency: cardBudget?.currency ?? currency,
    });
  }

  // The records whose reminder date is upcoming (a due date today or later),
  // decrypted; a record with no due date, or a past one, is excluded.
  const today = periodKeyFor("day", now, timeZone);
  const records = await listRecordsForUser(db, userId, dek);
  const reminders = records
    .filter((record) => isUpcoming(record, today))
    .sort((a, b) => dueKey(a).localeCompare(dueKey(b)));

  return {
    pendingApprovals: pending.length,
    activity,
    agents,
    reminders,
    lastDayByAgent,
  };
}
