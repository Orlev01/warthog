// E15-S08 — Own spending detail read (list-all) (brief "Spending view", design §8
// step 4 / §9; constitution principle 14 "Warthog writes the record … labels
// agent-submitted summaries as reported by that agent, never treats an agent report
// as the source of truth").
//
// On the Spending page and each agent's page a person sees FULL DETAIL of their OWN
// agents' spending: per agent, its card budget and the approved card releases this
// budget period (merchant + the APPROVED amount — the only amount counted toward
// budget), any amount the agent later REPORTED for a release (surfaced only with its
// label, NEVER counted) and a link to the activity entry, plus the agent's approved
// total for the period.
//
// It COMPOSES the already-built, tested stores rather than re-running their SQL:
//   • the owner's agents           — `listAgentsForUser` (one row per connection);
//   • each agent's card budget      — `getConnectionPermissions` (the `cardBudget`);
//   • the approved releases this     — the card-spend ledger's list-all read,
//     period against that budget      bucketed by the budget's period key;
//   • the agent-reported amounts     — the activity record: an `agent_reported`
//     + the activity-entry link       entry carries its reported `amount` and the
//                                      `cardRelease` reference in its payload.
//
// It is OWNER-scoped: every read is member-scoped by the `userId` the caller passes
// (the session's id, never a client value) and binds it as a parameter (INV-102), so
// another person's agents and releases are never returned. The read holds no key and
// reads no `process.env` (INV-103): the db, the per-person DEK and the clock are all
// INJECTED — the DEK decrypts the activity payloads; a different DEK cannot read them
// back. The period bucket is derived from the INJECTED clock, never SQL now().

import { listAgentsForUser } from "../db/agents";
import { getConnectionPermissions, type CardBudget } from "../db/agent-permissions";
import { readAgentSpending, type UnconvertedAgentSpend } from "./agent-spending";
import { listReleasesForConnectionPeriod, periodKeyFor } from "../db/card-spend-ledger";
import { listActivity } from "../activity/list";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

// One approved card release this period, as shown in the owner's detail. `amount` is
// the APPROVED amount (what counts toward budget); `reportedAmount` is any amount the
// agent later reported for THIS release — shown LABELLED, never added to the counted
// total, null when the agent reported nothing. `numeric` comes back as a number or a
// string depending on the driver, so money fields allow either.
export interface OwnSpendingRelease {
  readonly id: string;
  readonly merchant: string;
  readonly amount: number | string;
  readonly currency: string;
  readonly reportedAmount: number | string | null;
  readonly activityLink: string;
}

// One of the owner's agents, with its budget and its releases this period.
// `approvedTotal` is the sum of the APPROVED amounts only — reported amounts are
// never part of it.
export interface OwnSpendingAgent {
  readonly agentId: string;
  readonly displayName: string;
  readonly budget: CardBudget | null;
  readonly approvedTotal: number | string;
  readonly unconverted?: readonly UnconvertedAgentSpend[];
  readonly releases: OwnSpendingRelease[];
}

export interface OwnSpending {
  readonly agents: OwnSpendingAgent[];
}

// The agent-reported amounts for `userId`, keyed by the release each one references.
// Read ONCE for the owner (reused across their agents): only `agent_reported` entries
// are read (filtered in SQL, one bounded page, newest first) and decrypted, and only
// those carrying a `cardRelease` reference contribute — a Warthog-written entry is never
// treated as a report. The latest report for the same release wins.
async function reportedAmountsByRelease(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<Map<string, number | string>> {
  const entries = await listActivity(db, userId, { source: "agent_reported" }, dek);
  const byRelease = new Map<string, number | string>();
  for (const entry of entries) {
    const payload = entry.payload;
    if (payload === null || typeof payload !== "object") continue;
    const { cardRelease, amount } = payload as { cardRelease?: unknown; amount?: unknown };
    if (typeof cardRelease !== "string" || (typeof amount !== "number" && typeof amount !== "string")) continue;
    // Newest first: the first report seen for a release is its latest.
    if (!byRelease.has(cardRelease)) byRelease.set(cardRelease, amount);
  }
  return byRelease;
}

// Read the SESSION user's own spending detail: their agents, each with its card
// budget, the approved card releases this budget period (merchant + approved amount),
// the per-release agent-reported amount (labelled, never counted) and a link to the
// activity entry, plus the agent's approved total for the period. Member-scoped by
// `userId` alone — another person's agents and releases are never returned. The
// period is the person's own: `timeZone` is their IANA zone (`./time-zone`, review fix
// W4.3), the same one the release handler bucketed with; Sydney when absent.
export async function readOwnSpending(
  db: Db,
  userId: string,
  dek: Uint8Array,
  clock: Clock,
  timeZone?: string,
): Promise<OwnSpending> {
  const agents = await listAgentsForUser(db, userId);
  if (agents.length === 0) {
    return { agents: [] };
  }

  const reportedByRelease = await reportedAmountsByRelease(db, userId, dek);

  const result: OwnSpendingAgent[] = [];
  for (const agent of agents) {
    const permissions = await getConnectionPermissions(db, userId, agent.connectionId);
    const budget = permissions?.cardBudget ?? null;

    // Only an agent with a card budget has a period to bucket releases by; without
    // one there is nothing to count against (empty list, zero total).
    const now = clock.now();
    const spending = budget
      ? await readAgentSpending(db, userId, agent.connectionId, budget, now, timeZone)
      : { total: 0, unconverted: [] };
    const releases = budget ? await listReleasesForConnectionPeriod(db, userId, agent.connectionId,
      budget.period, periodKeyFor(budget.period, now, timeZone)) : [];

    const detailed: OwnSpendingRelease[] = releases.map((release) => ({
      id: release.id,
      merchant: release.merchant,
      amount: release.amount,
      currency: release.currency,
      reportedAmount: reportedByRelease.get(release.id) ?? null,
      activityLink: `/activity?release=${release.id}`,
    }));

    // Only the APPROVED amounts count toward budget — the reported amounts above are
    // surfaced but never summed here.
    const approvedTotal = spending.total;

    result.push({
      agentId: agent.id,
      displayName: agent.displayName,
      budget,
      approvedTotal,
      ...(spending.unconverted.length ? { unconverted: spending.unconverted } : {}),
      releases: detailed,
    });
  }

  return { agents: result };
}
