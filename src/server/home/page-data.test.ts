// E18-S05 — Home dashboard metrics read (`src/server/home/page-data.ts`).
//
// RED-first: the module under test does NOT exist yet, so importing `./page-data`
// throws and every test here fails (and `tsc --noEmit` reddens on the missing
// module) until the builder writes the minimum code to pass. That absence IS the
// point of test-first; do NOT implement anything to make these pass — the builder
// writes `page-data.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the read RETURNS: the pending count, the
// newest-first activity across all the person's agents, each agent's status /
// last-active / period-spend against its budget in the account currency, and the
// records whose reminder date is upcoming — and whose data it reads), never the
// source text of the module or any SQL. A later rename or moved import that
// preserves behaviour must stay green.
//
// WHY this exists (task E18-S05; brief "Home dashboard"; design §5 — every
// member-scoped read takes the user id from the session, never a client value):
// the completed home dashboard shows live counts, activity, per-agent spend and
// reminders, and this is the single OWNER-scoped aggregation that feeds them. It
// REUSES the already-built, tested primitives rather than re-running their SQL —
// the approval inbox (pending), the activity list (newest-first), the agents
// aggregate (status / last-active), the agent-permission grant (the card budget),
// the card-spend ledger + the shared budget-period math (period spend), the
// account currency and the life-admin records (reminders). It adds no SQL and no
// crypto of its own: like the sibling set-up-checklist read it resolves the
// person's DEK through the injected `KeyWrapper` seam (from `users.wrapped_dek`)
// so the activity payloads and life-admin fields decrypt, reads no `process.env`
// and holds no key (INV-103), and every underlying store binds `userId` as a
// parameter (INV-102).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface HomeMetricsDeps {   // the injected seams — no process.env.
//     db: Db;                     // the parameterizing database seam.
//     keyWrapper: KeyWrapper;     // unwraps the person's DEK (from users.wrapped_dek)
//                                  // so the activity payloads + life-admin fields decrypt.
//     clock: Clock;               // "now", for the current budget period and "upcoming".
//   }
//
//   // One of the person's agents on the dashboard: its identity, connection status,
//   // last-active time, and the spend in its current budget period against its budget
//   // — both expressed in the person's account currency (`spendThisPeriod`/`budget`
//   //  may come back as a number or a numeric string, like the ledger sums).
//   interface HomeAgentSpend {
//     agentId: string;
//     displayName: string;
//     status: "connected" | "disconnected";
//     lastActiveAt: Date | string | null;
//     spendThisPeriod: number | string;
//     budget: number | string;
//     budgetPeriod: "day" | "week" | "month";
//     currency: string;          // the person's account currency
//   }
//
//   interface HomeMetrics {
//     pendingApprovals: number;          // the count of PENDING approvals (decided excluded)
//     activity: ActivityEntry[];         // the latest entries across ALL the person's agents,
//                                         //   NEWEST FIRST (each payload DECRYPTED)
//     agents: HomeAgentSpend[];          // the person's agents, each with spend-this-period
//     reminders: LifeAdminRecord[];      // the life-admin records whose reminder date is upcoming
//   }                                     //   (fields DECRYPTED); a record with no due date, or a
//                                         //   due/reminder date already past, is NOT upcoming.
//
//   loadHomeMetrics(deps: HomeMetricsDeps, userId: string): Promise<HomeMetrics>
//     • Aggregates the four figures for `userId` (the SESSION's id, NEVER a client
//       value) from the reused stores. Member-scoped by the passed id alone — one
//       person can never read another's approvals, activity, agents, spend or
//       reminders; the period spend is derived with the shared budget-period math
//       from the INJECTED clock (never SQL now()).
//
// Acceptance criteria → tests (this file):
//   AC1 "For a user with one pending approval, recent activity and an agent that has
//        spent this period, the read returns a pending count of 1, the latest activity
//        entries newest first, the agent with its status/last-active and its period
//        spend against the budget held in its agent-permission grant, in the person's
//        account currency, and the records whose reminder date is upcoming."
//   AC2 "Every figure is filtered by the session user id only; one user can never read
//        another user's approvals, activity, agents, spend or reminders, and
//        budget-period spend is derived with the shared budget-period math."
//
// The obligation acceptance criteria (validate-and-parameterize-input;
// secrets-from-env) are pinned in the sibling `page-data.obligations.test.ts`.
//
// Database tests use `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and the real store functions to seed; each handle is closed in a
// `finally`. Tests touch no network and no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { loadHomeMetrics } from "./page-data";
import { createUser } from "../db/users";
import { createAgent, recordAgentActivity } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { recordRelease } from "../db/card-spend-ledger";
import { createApproval, decide } from "../db/approvals";
import { createRecord } from "../db/life-admin-records";
import { setAccountCurrency } from "../db/account-currency";
import { savePreferences } from "../db/preferences";
import { createDbRecorder } from "../activity/writer";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";

// --- shapes taken from the stores' own signatures, so a later type rename that
// preserves behaviour does not redden these tests. --------------------------------
type Grants = Parameters<typeof upsertPermissions>[1];
type CardBudget = NonNullable<Grants["cardBudget"]>;
type PeriodKeys = Parameters<typeof recordRelease>[1]["periodKeys"];

// A loose structural view of the assembled metrics, so the assertions do not depend
// on the (absent) module's exported types at the point they run.
interface HomeAgentLike {
  readonly agentId: string;
  readonly displayName: string;
  readonly status: string;
  readonly lastActiveAt: Date | string | null;
  readonly spendThisPeriod: number | string;
  readonly budget: number | string | null;
  readonly budgetPeriod: string;
  readonly currency: string;
}
interface HomeActivityLike {
  readonly occurredAt: string | Date;
  readonly agentId?: string;
  readonly payload: unknown;
}
interface HomeReminderLike {
  readonly id: string;
  readonly fields: Record<string, unknown>;
  readonly dueDate: string | Date | null;
}
interface HomeMetricsLike {
  readonly pendingApprovals: number;
  readonly activity: HomeActivityLike[];
  readonly agents: HomeAgentLike[];
  readonly reminders: HomeReminderLike[];
}

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit key-encryption key for the local AES wrapper

// The frozen instant every read derives its current period bucket and its
// "upcoming" cut-off through — noon mid-month UTC, so the month/day buckets are
// unambiguous in UTC calendar arithmetic (the convention E07-S07 / the budget-period
// math use). A read that wrongly called Date.now() instead of the injected clock
// would land in a different period bucket and a different "upcoming" cut-off.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// The period buckets that fall in NOW (the opaque keys E07-S07 stores) and a set in
// a DIFFERENT period, so a release outside the current bucket must not be counted.
const KEYS_NOW: PeriodKeys = { day: "2026-11-15", week: "2026-W47", month: "2026-11" };
const KEYS_OTHER: PeriodKeys = { day: "2026-12-20", week: "2026-W51", month: "2026-12" };

// Due dates relative to NOW (2026-11-15): one a couple of days OUT (both its due date
// and its 1-day-before reminder, 2026-11-16, are still future → upcoming under any
// reasonable reading) and one well in the PAST (every reminder date, and the due date,
// already gone → not upcoming).
const DUE_UPCOMING = "2026-11-17";
const DUE_PAST = "2026-11-05";

// One real local KeyWrapper (dev/test) for the whole file — exactly the one a
// non-production composition root selects, so a stored wrapped-DEK really unwraps to
// the DEK the seed encrypted under.
const keyWrapper: KeyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
const clock: Clock = fixedClock(NOW);

// Build the read under test with the pinned deps, so every call site passes the SAME
// literal shape the builder must accept.
function load(db: Db, userId: string): Promise<HomeMetricsLike> {
  return loadHomeMetrics({ db, keyWrapper, clock }, userId) as Promise<HomeMetricsLike>;
}

// Create a person whose stored wrapped-DEK really unwraps (under `keyWrapper`) to the
// returned `dek`, so values the seed encrypts under `dek` round-trip through the read.
async function makeUserWithDek(db: Db, who: string): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// A fully-populated grants record; a seeder overrides only what it is about. Built via
// a helper (a non-literal passed to upsertPermissions) so excess-property checks never
// bite and a superset of fields stays assignable.
function baseGrants(userId: string, connectionId: string, budget: CardBudget): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: ["gmail"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: false,
    highTierAccess: false,
    cardAccess: true,
    cardBudget: budget,
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
  };
}

// Create one of `userId`'s agents (one row per connection) holding a card budget in
// its agent-permission grant, and return the agent + its connection id (the ledger +
// permissions key off the connection; the output identifies the agent by `agentId`).
async function setupAgent(
  db: Db,
  userId: string,
  displayName: string,
  budget: CardBudget = { amount: 200, currency: "AUD", period: "month" },
): Promise<{ agentId: string; connectionId: string }> {
  const connectionId = randomUUID();
  const agent = await createAgent(
    db,
    { userId, connectionId, displayName, platform: "Claude Desktop" },
    clock,
  );
  await upsertPermissions(db, baseGrants(userId, connectionId, budget));
  return { agentId: agent.id, connectionId };
}

// Record one approved card release against `connectionId`'s budget for `periodKeys`
// (defaulting to the buckets that fall in NOW).
async function addRelease(
  db: Db,
  input: { userId: string; connectionId: string; amount: number; currency?: string; periodKeys?: PeriodKeys },
): Promise<void> {
  await recordRelease(db, {
    userId: input.userId,
    connectionId: input.connectionId,
    householdId: null,
    amount: input.amount,
    currency: input.currency ?? "AUD",
    merchant: "Woolworths",
    periodKeys: input.periodKeys ?? KEYS_NOW,
  });
}

// Record one activity entry for `userId` at the instant `at`, with `payload` DECRYPTED
// back under the SAME `dek` the read resolves. Reuses the DB-backed recorder (the
// production write path), so the entry is a genuine chained, encrypted row.
async function recordActivity(
  db: Db,
  dek: Uint8Array,
  userId: string,
  input: { at: Date; payload: Record<string, unknown>; agentId?: string },
): Promise<void> {
  const recorder = createDbRecorder({ db, clock: fixedClock(input.at), dekFor: async () => dek });
  await recorder.record({
    userId,
    kind: "tool_call",
    source: "warthog",
    agentId: input.agentId,
    payload: input.payload,
  });
}

// Seed one life-admin record carrying a due date (the reminder anchor); its fields are
// DEK-encrypted and come back DECRYPTED through the read.
async function seedReminder(
  db: Db,
  dek: Uint8Array,
  userId: string,
  input: { what: string; dueDate: string | null },
): Promise<string> {
  const record = await createRecord(
    db,
    {
      userId,
      kind: "renewal_appointment",
      fields: { what: input.what },
      dueDate: input.dueDate,
      status: "upcoming",
      source: { kind: "person" },
    },
    dek,
  );
  return record.id;
}

// The agent entry with this display name, so a test locates its agent without betting
// on array order.
function agentNamed(metrics: HomeMetricsLike, displayName: string): HomeAgentLike | undefined {
  return metrics.agents.find((a) => a.displayName === displayName);
}

// The `summary` fields of the returned activity, in order — the per-entry marker the
// seeds plant, so ordering + membership can be asserted without an entry id.
function activitySummaries(metrics: HomeMetricsLike): string[] {
  return metrics.activity.map((e) => (e.payload as { summary?: string }).summary ?? "");
}

// The `what` fields of the returned reminders — the per-record marker the seeds plant.
function reminderWhats(metrics: HomeMetricsLike): string[] {
  return metrics.reminders.map((r) => String(r.fields.what ?? ""));
}

const num = (value: unknown): number => Number(value);

// ===========================================================================
// AC1 — the pending-approval count is the number of PENDING approvals.
// ===========================================================================

test("the pending-approval count is 1 for one pending approval, and a decided approval is not counted", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "pending");

    // One pending approval.
    await createApproval(db, { userId, agentId: randomUUID(), detail: { sentence: "Pay $20" } }, dek, clock);
    // One more, then DECIDED — it must drop out of the count.
    const decided = await createApproval(
      db,
      { userId, agentId: randomUUID(), detail: { sentence: "Send file" } },
      dek,
      clock,
    );
    await decide(db, { userId, id: decided.id, decision: { status: "approved" } }, dek, clock);

    const metrics = await load(db, userId);

    assert.equal(metrics.pendingApprovals, 1, "exactly the one PENDING approval is counted; the decided one is not");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — the latest activity, NEWEST FIRST, across ALL the person's agents.
// ===========================================================================

test("the latest activity comes back newest first, spanning all the person's agents, with payloads decrypted", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "activity");
    const a = await setupAgent(db, userId, "Agent A");
    const b = await setupAgent(db, userId, "Agent B");

    // Record THREE entries at increasing instants, from two DIFFERENT agents, so the
    // read must (a) span all the person's agents and (b) order newest-first.
    await recordActivity(db, dek, userId, {
      at: new Date(NOW.getTime() - 2 * 60_000),
      agentId: a.agentId,
      payload: { summary: "A: sent an email" },
    });
    await recordActivity(db, dek, userId, {
      at: new Date(NOW.getTime() - 1 * 60_000),
      agentId: b.agentId,
      payload: { summary: "B: created an event" },
    });
    await recordActivity(db, dek, userId, {
      at: NOW,
      agentId: a.agentId,
      payload: { summary: "A: read a file" },
    });

    const metrics = await load(db, userId);
    const summaries = activitySummaries(metrics);

    // All three entries are present, and the payloads were decrypted (the markers show).
    assert.ok(summaries.includes("A: read a file"), "the newest entry is present and decrypted");
    assert.ok(summaries.includes("B: created an event"), "a second agent's entry is present (across all agents)");
    assert.ok(summaries.includes("A: sent an email"), "the oldest entry is present");

    // Newest first: the ordering follows occurred_at descending.
    assert.deepEqual(
      summaries.slice(0, 3),
      ["A: read a file", "B: created an event", "A: sent an email"],
      "activity is ordered newest first across all the person's agents",
    );

    // Belt-and-braces: occurred_at is non-increasing down the whole returned list.
    const times = metrics.activity.map((e) => new Date(e.occurredAt).getTime());
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1]! >= times[i]!, "each entry is at or before the previous one (newest first)");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — the agent's status / last-active and its period spend against the budget held
// in its agent-permission grant, in the person's account currency; and AC2's
// "budget-period spend is derived with the shared budget-period math".
// ===========================================================================

test("an agent carries its status, last-active and this-period spend against its grant budget", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "agent-spend");

    // An agent whose grant holds a A$200/month card budget.
    const { agentId, connectionId } = await setupAgent(db, userId, "Spender", {
      amount: 200,
      currency: "AUD",
      period: "month",
    });
    // Stamp a genuine last-active time through the agents aggregate.
    await recordAgentActivity(db, { userId, id: agentId }, clock);

    // Spend this period: two releases IN the current month bucket (42 + 8 = 50) and
    // one in a DIFFERENT period (999) that the shared budget-period math must exclude.
    await addRelease(db, { userId, connectionId, amount: 42, periodKeys: KEYS_NOW });
    await addRelease(db, { userId, connectionId, amount: 8, periodKeys: KEYS_NOW });
    await addRelease(db, { userId, connectionId, amount: 999, periodKeys: KEYS_OTHER });

    const metrics = await load(db, userId);
    const agent = agentNamed(metrics, "Spender");

    assert.ok(agent, "the person's agent is present");
    assert.equal(agent!.agentId, agentId, "the agent carries its own id");
    assert.equal(agent!.status, "connected", "the agent's status comes from the agent row");
    assert.equal(
      new Date(agent!.lastActiveAt as string).getTime(),
      NOW.getTime(),
      "the agent's last-active time is surfaced",
    );
    assert.equal(num(agent!.budget), 200, "the budget is the amount held in the agent-permission grant");
    assert.equal(agent!.budgetPeriod, "month", "the budget period is the grant's period");
    assert.equal(
      num(agent!.spendThisPeriod),
      50,
      "only the releases in the CURRENT budget period are counted (shared budget-period math); the other-period release is excluded",
    );
    assert.equal(agent!.currency, "AUD", "the figures are expressed in the person's account currency (AUD default)");
  } finally {
    await db.close();
  }
});

// UI/UX pass content-20: an agent with no card budget carries no budget (null), so Home
// says "No card budget" instead of showing "A$0 of A$0 this month".
test("an agent without a card budget carries no budget, and no spend is summed for it", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "no-budget");
    await createAgent(db, { userId, connectionId: randomUUID(), displayName: "Unbudgeted", platform: "Claude Desktop" }, clock);
    const agent = agentNamed(await load(db, userId), "Unbudgeted");
    assert.ok(agent, "the person's agent is present");
    assert.equal(agent!.budget, null, "no card budget reads as none, never as a zero budget");
    assert.equal(num(agent!.spendThisPeriod), 0);
  } finally {
    await db.close();
  }
});

// The figures are expressed in the PERSON'S account currency, read from the
// account-currency store — not a hard-coded default. With the account currency set to
// a non-default code and the grant budget in that same currency (the brief: agent
// budgets are in the account currency), the agent's figures carry that code.
test("the agent's spend and budget are expressed in the person's account currency", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "currency");
    const set = await setAccountCurrency(db, { userId, currency: "NZD" });
    assert.ok(set.ok, "the account currency was set to NZD");

    const { connectionId } = await setupAgent(db, userId, "Kiwi", {
      amount: 500,
      currency: "NZD",
      period: "month",
    });
    await addRelease(db, { userId, connectionId, amount: 120, currency: "NZD", periodKeys: KEYS_NOW });

    const metrics = await load(db, userId);
    const agent = agentNamed(metrics, "Kiwi");

    assert.ok(agent, "the agent is present");
    assert.equal(agent!.currency, "NZD", "the figures carry the person's account currency, not a hard-coded default");
    assert.equal(num(agent!.budget), 500, "the budget is in the account currency");
    assert.equal(num(agent!.spendThisPeriod), 120, "the spend this period is in the account currency");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — the records whose reminder date is UPCOMING (a future due date); a record with
// no due date, or whose reminder/due date has already passed, is not upcoming.
// ===========================================================================

test("reminders are the records whose reminder date is upcoming, decrypted; past and no-due records are excluded", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "reminders");

    const upcomingId = await seedReminder(db, dek, userId, { what: "Passport renewal", dueDate: DUE_UPCOMING });
    await seedReminder(db, dek, userId, { what: "Missed dentist", dueDate: DUE_PAST });
    await seedReminder(db, dek, userId, { what: "Netflix (no date)", dueDate: null });

    const metrics = await load(db, userId);
    const whats = reminderWhats(metrics);

    assert.ok(whats.includes("Passport renewal"), "the record with an upcoming reminder date is returned");
    assert.ok(!whats.includes("Missed dentist"), "a record whose reminder/due date has passed is NOT upcoming");
    assert.ok(!whats.includes("Netflix (no date)"), "a record with no due date has no reminder and is NOT upcoming");

    // The returned reminder is the real record, its encrypted fields decrypted.
    const upcoming = metrics.reminders.find((r) => r.id === upcomingId);
    assert.ok(upcoming, "the upcoming reminder carries the record's own id");
    assert.equal(upcoming!.fields.what, "Passport renewal", "the reminder's fields are decrypted");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — every figure is member-scoped by the SESSION user id alone; one person never
// reads another's approvals, activity, agents, spend or reminders.
// ===========================================================================

test("every figure is scoped to the session person — never another person's approvals, activity, agents, spend or reminders", async () => {
  const db = await freshDb();
  try {
    const A = await makeUserWithDek(db, "owner-a");
    const B = await makeUserWithDek(db, "owner-b");

    // A: one pending approval, one activity entry, one agent that spent 50, one upcoming reminder.
    await createApproval(db, { userId: A.userId, agentId: randomUUID(), detail: { sentence: "A pays" } }, A.dek, clock);
    const aAgent = await setupAgent(db, A.userId, "A-agent");
    await addRelease(db, { userId: A.userId, connectionId: aAgent.connectionId, amount: 50, periodKeys: KEYS_NOW });
    await recordActivity(db, A.dek, A.userId, { at: NOW, agentId: aAgent.agentId, payload: { summary: "A-activity" } });
    await seedReminder(db, A.dek, A.userId, { what: "A-reminder", dueDate: DUE_UPCOMING });

    // B: TWO pending approvals, a DIFFERENT activity entry, a DIFFERENT agent that spent 77, a DIFFERENT reminder.
    await createApproval(db, { userId: B.userId, agentId: randomUUID(), detail: { sentence: "B pays 1" } }, B.dek, clock);
    await createApproval(db, { userId: B.userId, agentId: randomUUID(), detail: { sentence: "B pays 2" } }, B.dek, clock);
    const bAgent = await setupAgent(db, B.userId, "B-agent");
    await addRelease(db, { userId: B.userId, connectionId: bAgent.connectionId, amount: 77, periodKeys: KEYS_NOW });
    await recordActivity(db, B.dek, B.userId, { at: NOW, agentId: bAgent.agentId, payload: { summary: "B-activity" } });
    await seedReminder(db, B.dek, B.userId, { what: "B-reminder", dueDate: DUE_UPCOMING });

    // A's read reflects ONLY A's data.
    const forA = await load(db, A.userId);
    assert.equal(forA.pendingApprovals, 1, "A sees A's one pending approval, never B's two");
    assert.deepEqual(activitySummaries(forA), ["A-activity"], "A sees only A's activity");
    assert.deepEqual(forA.agents.map((x) => x.displayName), ["A-agent"], "A sees only A's agent");
    assert.equal(num(agentNamed(forA, "A-agent")!.spendThisPeriod), 50, "A's agent spend is A's, never B's");
    assert.deepEqual(reminderWhats(forA), ["A-reminder"], "A sees only A's reminder");

    // B's read reflects ONLY B's data.
    const forB = await load(db, B.userId);
    assert.equal(forB.pendingApprovals, 2, "B sees B's two pending approvals, never A's one");
    assert.deepEqual(activitySummaries(forB), ["B-activity"], "B sees only B's activity");
    assert.deepEqual(forB.agents.map((x) => x.displayName), ["B-agent"], "B sees only B's agent");
    assert.equal(num(agentNamed(forB, "B-agent")!.spendThisPeriod), 77, "B's agent spend is B's, never A's");
    assert.deepEqual(reminderWhats(forB), ["B-reminder"], "B sees only B's reminder");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// The Home feed is a bounded page (review finding: Home listed and decrypted the person's
// ENTIRE activity history on every visit, growing with every agent call).
// ===========================================================================

test("the Home feed holds only the latest entries, never the whole history", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "home-bounded");
    const { HOME_ACTIVITY_LIMIT } = await import("./page-data");
    const total = HOME_ACTIVITY_LIMIT + 5;
    for (let i = 1; i <= total; i += 1) {
      await recordActivity(db, dek, userId, {
        at: new Date(NOW.getTime() - (total - i) * 60_000),
        payload: { summary: `entry ${i}` },
      });
    }

    const summaries = activitySummaries(await load(db, userId));
    assert.equal(summaries.length, HOME_ACTIVITY_LIMIT, "only the latest page is read");
    assert.equal(summaries[0], `entry ${total}`, "starting from the newest");
    assert.ok(!summaries.includes("entry 1"), "the oldest entries are left to the Activity page");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Review fix W4.3 — Home reads the person's own (local) budget period and "today", in
// the zone saved in their preferences. At 2026-12-01T05:00Z it is still 30 November in
// Los Angeles (already 1 December in Sydney).
// ---------------------------------------------------------------------------

test("W4.3: each agent's spend this period and today's reminders follow the person's saved time zone", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "tz-home");
    await savePreferences(
      db,
      {
        userId,
        tone: "warm",
        length: "short",
        language: "en-AU",
        units: "metric",
        timeZone: "America/Los_Angeles",
        briefing: "brief",
      },
      dek,
    );
    const { connectionId } = await setupAgent(db, userId, "Claude");
    await addRelease(db, {
      userId,
      connectionId,
      amount: 70,
      periodKeys: { day: "2026-11-30", week: "2026-W49", month: "2026-11" },
    });
    await seedReminder(db, dek, userId, { what: "Due today, locally", dueDate: "2026-11-30" });

    const metrics = (await loadHomeMetrics(
      { db, keyWrapper, clock: fixedClock(new Date("2026-12-01T05:00:00.000Z")) },
      userId,
    )) as HomeMetricsLike;
    assert.equal(Number(agentNamed(metrics, "Claude")?.spendThisPeriod), 70, "November's spend is still this month");
    assert.deepEqual(reminderWhats(metrics), ["Due today, locally"], "a reminder due today (locally) is upcoming");
  } finally {
    await db.close();
  }
});
