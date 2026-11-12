import { activityEvidence } from "@/domain/activity/evidence";
// E18-S08 — Home page loader (the injectable seam the thin `page.tsx` loader
// composes). Extends the earlier minimal loader (E18-S13 greeting + all-not-done
// checklist + empty states) to feed the dashboard view from the two already-built
// owner-scoped reads — the set-up status read (`loadSetupChecklist`, E18-S04) and
// the dashboard metrics read (`loadHomeMetrics`, E18-S05) — so the five checklist
// items reflect the person's REAL progress and the approvals/activity the person
// actually has show up.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry
// file may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The thin loader reads the
// session + database and renders the view; the testable logic lives here (the
// convention's `createXHandler({ db })` pattern, here `createHomeActions`, exactly
// as the sibling security page uses `createSecurityActions`).
//
// Security (design §5): `load` takes the person's VERIFIED Session and derives the
// acting user id from `session.userId` — never a client-supplied value — so the
// greeting names the session's OWN person and both owner-scoped reads are scoped to
// that id alone. Every underlying read is parameterized (INV-102).
//
// This loader adds no SQL and no crypto of its own: it REUSES the two owner-scoped
// reads, which resolve the person's DEK through the injected `KeyWrapper` seam and
// derive "now" from the injected `Clock`. When those seams are absent (the earliest
// callers inject neither) the reads cannot run, so the loader falls back to the
// first-run empty states exactly as the minimal loader did.

import { computeSetupChecklist } from "@/domain/home/checklist";
import { agentLabel, entryTitle, humanise } from "@/domain/activity/describe";
import { outcomeGroup } from "@/domain/activity/category";
import { dayOf, timeOfDay } from "@/domain/display-time";
import { agentNamesForUser } from "@/server/db/agents";
import type { ActivityGroupSummary } from "@/server/activity/list";
import type {
  DashboardActivity,
  DashboardAgent,
  DashboardReminder,
  DashboardViewProps,
} from "@/components/home/dashboard-view";
import { getUserById } from "@/server/db/users";
import { listIdentityFields } from "@/server/db/identity-fields";
import { loadSetupChecklist } from "@/server/home/checklist-data";
import { loadHomeMetrics, type HomeAgentSpend } from "@/server/home/page-data";
import type { ActivityEntry } from "@/server/activity/recorder";
import type { LifeAdminRecord } from "@/server/db/life-admin-records";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Clock } from "@/server/seams/clock";
import type { Session } from "@/server/auth/session";
import type { Db } from "@/server/db/index";
import { formatAccountTime } from "@/server/display-time";
import { timeZoneFor } from "@/server/spending/time-zone";

// The dependency bundle: the database seam, plus the KeyWrapper that unwraps the
// person's DEK (so the greeting and the two owner-scoped reads can decrypt their
// own data) and the Clock the reads derive "now" through. Both seams are optional —
// with either absent the loader keeps the first-run empty states.
export interface HomeActionsDeps {
  readonly db: Db;
  readonly keyWrapper?: KeyWrapper;
  readonly clock?: Clock;
  // Names a connected service through the connector catalogue (absent ⇒ its id).
  readonly serviceName?: (connectorId: string) => string | undefined;
}

// The home actions the thin loader drives: turn the verified session into the
// dashboard's props.
export interface HomeActions {
  load(session: Session): Promise<DashboardViewProps>;
}

// A string field of a decrypted payload (e.g. `summary`), or "" when the field is
// absent or not a string.
function payloadText(payload: unknown, key: string): string {
  if (payload !== null && typeof payload === "object") {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

// Calendar-only due dates are not instants: preserve their stored day, independent
// of the account's display zone. Activity instants use formatAccountTime instead.
function formatDue(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Map one decrypted activity entry to the view's line. The agent is shown by its
// display name (resolved from the person's own agents), absent when the entry is
// not attributed to one of them; the summary is the already-redacted payload text,
// or — for an entry with none, such as an agent call — the entry's title in plain
// words ("Add a task"), with its outcome alongside so a refused call never reads as done.
function toDashboardActivity(
  entry: ActivityEntry,
  agentNames: ReadonlyMap<string, string>,
  timeZone: string | undefined,
  serviceName: (id: string) => string,
  now: Date | undefined,
): DashboardActivity {
  const day = dayOf(entry.occurredAt, timeZone, now);
  return {
    id: entry.entryHash,
    title: entryTitle(entry),
    summary: activityEvidence(entry).summary,
    outcome: entry.outcome !== undefined ? humanise(entry.outcome) : undefined,
    outcomeGroup: outcomeGroup(entry.outcome),
    agent: agentLabel(agentNames, entry.agentId),
    reported: entry.source === "agent_reported",
    service: entry.connectorId === undefined ? undefined : serviceName(entry.connectorId),
    serviceId: entry.connectorId,
    at: formatAccountTime(entry.occurredAt, timeZone),
    when: `${day.label}, ${timeOfDay(entry.occurredAt, timeZone)}`,
    dateTime: entry.occurredAt,
    href: `/activity?entry=${entry.seq}#entry-${entry.seq}`,
  };
}

// Map one agent's spend aggregate to the view's agent. The store's status
// ("connected" | "disconnected") reads as the UI's StatusKey — a disconnected agent
// needs reconnecting before it can act again (CLAUDE.md "Reconnect needed"). Amounts
// may come back as numeric strings from the ledger sums, so coerce to the major-unit
// number the view renders.
function toDashboardAgent(
  agent: HomeAgentSpend,
  lastDay: ActivityGroupSummary | undefined,
  timeZone: string | undefined,
  now: Date | undefined,
): DashboardAgent {
  const lastActive = agent.lastActiveAt == null ? undefined : new Date(agent.lastActiveAt).toISOString();
  return {
    id: agent.agentId,
    platform: agent.platform,
    href: `/agents/${encodeURIComponent(agent.agentId)}`,
    activityHref: `/activity?agent=${encodeURIComponent(agent.agentId)}&via=agents`,
    lastActive: lastActive ? `${dayOf(lastActive, timeZone, now).label}, ${timeOfDay(lastActive, timeZone)}` : undefined,
    todayCount: lastDay?.total ?? 0,
    needsAttention: lastDay ? lastDay.byOutcome.blocked + lastDay.byOutcome.failed + lastDay.disputed : 0,
    name: agent.displayName,
    status: agent.status === "connected" ? "connected" : "needs-reconnect",
    spendThisPeriod: Number(agent.spendThisPeriod),
    budget: Number(agent.budget),
    budgetPeriod: agent.budgetPeriod,
    currency: agent.currency,
    ...(agent.spendUnavailable ? { spendUnavailable: true } : {}),
  };
}

// Map one upcoming life-admin record to the view's reminder: its title (from the
// decrypted fields) and a readable due label.
function toDashboardReminder(record: LifeAdminRecord): DashboardReminder {
  const categories: Record<LifeAdminRecord["kind"], string> = {
    subscription: "Subscription",
    receipt_warranty: "Receipt or warranty",
    renewal_appointment: "Renewal or appointment",
  };
  // Portal-created records use name; older/agent-created records can use title or
  // what. These are already decrypted by the owner-scoped Home read.
  const title = ["title", "name", "what"]
    .map((key) => payloadText(record.fields, key).trim()).find(Boolean);
  return {
    id: record.id,
    title: title || categories[record.kind],
    due: record.dueDate != null ? formatDue(record.dueDate) : "",
  };
}

export function createHomeActions(deps: HomeActionsDeps): HomeActions {
  const { db, keyWrapper, clock } = deps;

  // Assemble the dashboard's props for the signed-in person — scoped by the
  // session's user id, never a client value.
  async function load(session: Session): Promise<DashboardViewProps> {
    const user = await getUserById(db, session.userId);
    // The email's local part is the fallback greeting when no name is saved (or no
    // key is available to decrypt one).
    const email = user?.email ?? session.userId;
    const localPart = email.split("@")[0] ?? email;

    // Greet by the person's own low-tier name when it is readable: preferred name
    // first, then name, else the email's local part. The fields decrypt only under
    // THIS person's DEK, so the greeting can never name another account.
    let personName = localPart;
    let timeZone: string | undefined;
    if (user && keyWrapper) {
      const dek = await keyWrapper.unwrap(user.wrappedDek);
      timeZone = await timeZoneFor(db, user.id, dek);
      const fields = await listIdentityFields(db, user.id, dek);
      const preferred = fields.find((field) => field.kind === "preferred_name")?.value;
      const name = fields.find((field) => field.kind === "name")?.value;
      personName = preferred ?? name ?? localPart;
    }

    // Without the key wrapper AND clock the two owner-scoped reads cannot run (they
    // resolve the person's DEK and derive "now"); fall back to the first-run empty
    // states, exactly as the minimal loader did.
    if (!keyWrapper || !clock) {
      return {
        personName,
        checklist: computeSetupChecklist({}),
        pendingApprovals: 0,
        activity: [],
        agents: [],
        reminders: [],
      };
    }

    // Feed the dashboard from the two owner-scoped reads. Both take the injected
    // seams and the SESSION's user id — never a client value.
    const reads = { db, keyWrapper, clock };
    const checklist = await loadSetupChecklist(reads, session.userId);
    const metrics = await loadHomeMetrics(reads, session.userId);

    // The person's OWN agents' names, keyed by agent id and connection id, with the
    // "Unknown agent" fallback — the same resolution the Activity page uses.
    const agentNames = await agentNamesForUser(db, session.userId);
    const serviceName = (id: string) => deps.serviceName?.(id) ?? id;
    const now = clock.now();
    const lastDay = metrics.lastDayByAgent ?? [];
    const attention = lastDay.reduce((sum, group) => sum + group.byOutcome.blocked + group.byOutcome.failed + group.disputed, 0);

    return {
      personName,
      checklist,
      pendingApprovals: metrics.pendingApprovals,
      activity: metrics.activity.map((entry) => toDashboardActivity(entry, agentNames, timeZone, serviceName, now)),
      agents: metrics.agents.map((agent) =>
        toDashboardAgent(agent, lastDay.find((group) => group.key === agent.agentId), timeZone, now)),
      reminders: metrics.reminders.map(toDashboardReminder),
      attention: attention > 0 ? { count: attention, href: "/activity?attention=1" } : undefined,
    };
  }

  return { load };
}
