// E15-S08 — Own spending detail read (list-all) (`src/server/spending/own-read.ts`).
//
// RED-first: the module under test does NOT exist yet, so importing `./own-read`
// throws and every test here fails until the builder writes it. That absence IS the
// point of test-first — do NOT implement anything to make these pass; the builder
// writes `own-read.ts` (and whatever read-only storage it composes) afterwards.
//
// These tests pin BEHAVIOUR (what the read returns: which agents, which releases,
// which amounts are COUNTED vs merely REPORTED, scoped to whom) — never the source
// text of the module or any SQL. A later rename that preserves behaviour must not
// redden them.
//
// WHY this exists (brief "Spending view", design §8 step 4 / §9; constitution
// principle 14 "Warthog writes the record … labels agent-submitted summaries as
// reported by that agent, never treats an agent report as the source of truth"): on
// the Spending page and each agent's page a person sees FULL DETAIL of their OWN
// agents' spending — the approved card releases this budget period against the
// agent's budget, each release's merchant and APPROVED amount (what counts toward
// budget), ANY amount the agent later reported (shown only with its label, NEVER
// counted) and a link to the activity entry. It is OWNER-scoped and never returns
// another person's spending.
//
// It composes the already-built, tested stores rather than re-running their SQL:
//   • the owner's agents            — `listAgentsForUser` (E10-S01), each with its
//                                      `connectionId` (an agent IS one connection);
//   • each agent's card budget      — `getConnectionPermissions` (E03-S06), the
//                                      `cardBudget` {amount, currency, period};
//   • the approved releases this    — the card-spend ledger (E07-S07): recordRelease
//     period against that budget      writes the plaintext amount/currency/merchant
//                                      against the connection for the period bucket;
//   • the agent-reported amounts    — the activity record (E08-S05): an
//     + the activity-entry link       `agent_reported` entry the agent wrote via
//                                      `log_activity` carries its reported `amount`
//                                      and the `cardRelease` reference in its
//                                      DEK-encrypted payload.
// All reads are member-scoped by the `userId` the caller passes (the session's id,
// never a client value) and bind it as a parameter (INV-102). The read holds no key
// and reads no `process.env` (INV-103): the db, the per-person DEK and the clock are
// all INJECTED (the DEK decrypts the activity payloads; a different DEK cannot read
// them back).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // One approved card release this period, as shown in the owner's detail.
//   interface OwnSpendingRelease {
//     id: string;                 // the release's stable identity (the ledger id)
//     merchant: string;           // the merchant the release paid
//     amount: number | string;    // the APPROVED amount — what counts toward budget
//     currency: string;
//     reportedAmount: number | string | null;  // any amount the agent later
//                                  //   reported for THIS release — shown LABELLED,
//                                  //   never added to the counted total; null when
//                                  //   the agent reported nothing
//     activityLink: unknown;       // a non-empty link/reference to the activity entry
//   }
//
//   // One of the owner's agents, with its budget and its releases this period.
//   interface OwnSpendingAgent {
//     agentId: string;            // the agent row id (the `/agents/[id]` identity)
//     displayName: string;
//     budget: { amount: number | string; currency: string;
//               period: "day" | "week" | "month" } | null;
//     approvedTotal: number | string;  // the sum of the APPROVED amounts only —
//                                  //   reported amounts are NEVER part of it
//     releases: OwnSpendingRelease[];
//   }
//
//   interface OwnSpending { agents: OwnSpendingAgent[] }
//
//   readOwnSpending(db, userId, dek, clock): Promise<OwnSpending>
//     • Lists the SESSION user's own agents; for each, its card budget and the
//       approved card releases this budget period (merchant + approved amount),
//       the per-release agent-reported amount (labelled, never counted) and a link
//       to the activity entry, plus the agent's APPROVED total for the period.
//       Member-scoped by the passed `userId` alone — another person's agents and
//       releases are never returned. The user id is bound as a parameter (no spliced
//       SQL). The period bucket is derived from the INJECTED clock (never SQL now()).
//
// Acceptance criteria → tests:
//   AC1 "Returns, per the owner's agent, the approved card releases this period with
//        merchant and approved amount counted against that agent's budget, plus any
//        reported amount shown labelled as reported by the agent and a link to the
//        activity entry."
//   AC2 "Only the approved release amounts are counted toward budget; reported
//        amounts are never counted."
//   AC3 "It reads only the session user's own agents' spending (filtered by session
//        user id)."
//   AC4 [obligation:validate-and-parameterize-input] — a handler rejects malformed /
//        oversized input with a 4xx (nothing reaches a query); the user id is bound as
//        a parameter and a SQL-injection probe in a field travels as data and cannot
//        alter a query. The handler is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] — the read runs from its INJECTED deps alone
//        (db, userId, dek, clock): no secret, no ambient config.
//
// Every db handle is closed in a `finally`; each real-db test uses its own `freshDb()`
// (an isolated in-memory PGlite with the real migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { readOwnSpending } from "./own-read";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { recordRelease } from "../db/card-spend-ledger";
import { createDbRecorder } from "../activity/writer";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import type { Db } from "../db/index";

// --- shapes taken from the stores' own signatures, so a later type rename that
// preserves behaviour does not redden these tests. ----------------------------------
type Grants = Parameters<typeof upsertPermissions>[1];
type NewRelease = Parameters<typeof recordRelease>[1];
type PeriodKeys = NewRelease["periodKeys"];
type StoredRelease = Awaited<ReturnType<typeof recordRelease>>;
type CardBudget = NonNullable<Grants["cardBudget"]>;

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// The frozen instant every read derives its period bucket through — noon mid-month
// UTC, so the month/day buckets are unambiguous in UTC calendar arithmetic (the same
// convention E07-S07 / the policy-context loader use). A read that wrongly called
// Date.now() instead of the injected clock would land in a different bucket.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// The period buckets that fall in NOW (the opaque keys E07-S07 stores).
const MONTH_NOW = "2026-11";
const DAY_NOW = "2026-11-15";
const WEEK_NOW = "2026-W47";

// Buckets in a DIFFERENT period than NOW, so a release here must not count or appear.
const MONTH_OTHER = "2026-12";
const DAY_OTHER = "2026-12-20";
const WEEK_OTHER = "2026-W51";

// pg `numeric` may come back as a number or a string depending on the driver; compare
// the VALUE, not its representation (either is a reasonable choice for money).
const num = (value: unknown): number => Number(value);

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a
// layer up; this read only ever receives the already-unwrapped bytes (like the store).
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque; this read never unwraps it — it takes
// the already-unwrapped dek directly).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A fully-populated grants record; a test overrides only what it is about. Built via a
// helper (a non-literal passed to upsertPermissions) so excess-property checks never
// bite and a superset of fields stays assignable.
function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: ["gmail"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: false,
    highTierAccess: false,
    cardAccess: true,
    cardBudget: { amount: 200, currency: "AUD", period: "month" },
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  };
}

// Create one of `userId`'s agents (one row per connection) with a card budget, and
// return the agent together with its connection id (the ledger + permissions key off
// the connection; the output identifies the agent by its `agentId`).
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
    fixedClock(NOW),
  );
  await upsertPermissions(db, baseGrants(userId, connectionId, { cardAccess: true, cardBudget: budget }));
  return { agentId: agent.id, connectionId };
}

// The three period keys for a release, defaulting to the buckets that fall in NOW.
function keys(overrides: Partial<PeriodKeys> = {}): PeriodKeys {
  return { day: DAY_NOW, week: WEEK_NOW, month: MONTH_NOW, ...overrides };
}

// The three period keys for a DIFFERENT period than NOW (every granularity differs),
// so a release here is outside the current bucket whichever period the budget uses.
function keysOther(): PeriodKeys {
  return { day: DAY_OTHER, week: WEEK_OTHER, month: MONTH_OTHER };
}

// Record one approved card release against `connectionId`'s budget for the period
// buckets `periodKeys` (defaulting to NOW). Returns the StoredRelease (its id is the
// release's stable identity and the `cardRelease` reference an agent reports against).
async function addRelease(
  db: Db,
  input: {
    userId: string;
    connectionId: string;
    amount: number;
    merchant: string;
    currency?: string;
    periodKeys?: PeriodKeys;
  },
): Promise<StoredRelease> {
  return recordRelease(db, {
    userId: input.userId,
    connectionId: input.connectionId,
    householdId: null,
    amount: input.amount,
    currency: input.currency ?? "AUD",
    merchant: input.merchant,
    periodKeys: input.periodKeys ?? keys(),
  });
}

// The DB-backed activity recorder wired to `dek`, so an entry it writes decrypts back
// under the SAME dek the read is handed (the read decrypts the agent-reported payloads
// to surface their amounts). No released-value matcher ⇒ nothing in these plain
// payloads is redacted.
function makeRecorder(db: Db, dek: Uint8Array) {
  return createDbRecorder({ db, clock: fixedClock(NOW), dekFor: async () => dek });
}

// Write the agent's OWN self-reported summary for `releaseId` — exactly as the
// `log_activity` tool does: source "agent_reported", with the reported `amount`,
// currency and the `cardRelease` reference in the payload. This is NEVER the source of
// truth and must never be counted toward budget.
async function reportForRelease(
  recorder: ReturnType<typeof makeRecorder>,
  input: { userId: string; agentId: string; releaseId: string; amount: number; currency?: string },
): Promise<void> {
  await recorder.record({
    userId: input.userId,
    kind: "agent_report",
    source: "agent_reported",
    agentId: input.agentId,
    payload: {
      reason: "ran the errand",
      amount: input.amount,
      currency: input.currency ?? "AUD",
      cardRelease: input.releaseId,
    },
  });
}

// The owner's agent entry with this display name (unique per test), so a test locates
// its agent without betting on array order or on which id field identifies it.
function agentNamed(out: { agents: any[] }, displayName: string): any {
  return out.agents.find((a) => a.displayName === displayName);
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no
// rows and satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// ===========================================================================
// AC1 — per the owner's agent: the approved card releases this period with merchant
// and approved amount, the agent's budget, a reported amount (labelled) and a link.
// ===========================================================================

test("readOwnSpending returns, per the owner's agent, this period's approved releases with merchant, approved amount and the agent's budget", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();
    const { agentId, connectionId } = await setupAgent(db, userId, "Shopper", {
      amount: 300,
      currency: "AUD",
      period: "month",
    });

    await addRelease(db, { userId, connectionId, amount: 10.5, merchant: "BoxCo" });

    const out = await readOwnSpending(db, userId, dek, fixedClock(NOW));
    const entry = agentNamed(out, "Shopper");
    assert.ok(entry, "the owner's agent appears in the spending detail");
    assert.equal(entry.agentId, agentId, "the agent is identified by its agent id");

    assert.ok(entry.budget, "the agent carries its card budget");
    assert.equal(num(entry.budget.amount), 300, "the budget amount is carried");
    assert.equal(entry.budget.currency, "AUD", "the budget currency is carried");
    assert.equal(entry.budget.period, "month", "the budget period is carried");

    assert.equal(entry.releases.length, 1, "this period's one approved release is listed");
    const rel = entry.releases[0];
    assert.equal(rel.merchant, "BoxCo", "the release's merchant is carried");
    assert.equal(num(rel.amount), 10.5, "the release's approved amount is carried");
    assert.equal(rel.currency, "AUD", "the release's currency is carried");
  } finally {
    await db.close();
  }
});

test("each release carries a non-empty link to its activity entry", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-link");
    const dek = freshDek();
    const { agentId, connectionId } = await setupAgent(db, userId, "Linker");
    const release = await addRelease(db, { userId, connectionId, amount: 5, merchant: "LinkCo" });

    // The activity entry Warthog wrote for the release (present so a read that resolves
    // the link from the activity record can find it; a read that derives the link from
    // the release itself ignores it harmlessly).
    const recorder = makeRecorder(db, dek);
    await recorder.record({
      userId,
      kind: "card_release",
      source: "warthog",
      agentId,
      merchant: "LinkCo",
      payload: { cardRelease: release.id, amount: 5, currency: "AUD" },
    });

    const out = await readOwnSpending(db, userId, dek, fixedClock(NOW));
    const entry = agentNamed(out, "Linker");
    assert.ok(entry, "the agent appears");
    assert.equal(entry.releases.length, 1, "the one release is listed");
    const link = entry.releases[0].activityLink;
    assert.ok(link != null && String(link).length > 0, "the release links to its activity entry");
  } finally {
    await db.close();
  }
});

test("a release the agent later reported an amount for carries that reported amount, distinct from the approved amount", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-reported");
    const dek = freshDek();
    const { agentId, connectionId } = await setupAgent(db, userId, "Reporter");

    // Warthog recorded the APPROVED release at 42.50; the agent later REPORTED it spent
    // 40.00 (a different figure — only a claim, shown with its label).
    const release = await addRelease(db, { userId, connectionId, amount: 42.5, merchant: "ErrandCo" });
    const recorder = makeRecorder(db, dek);
    await reportForRelease(recorder, { userId, agentId, releaseId: release.id, amount: 40.0 });

    const out = await readOwnSpending(db, userId, dek, fixedClock(NOW));
    const entry = agentNamed(out, "Reporter");
    assert.ok(entry, "the agent appears");
    const rel = entry.releases.find((r: any) => r.id === release.id);
    assert.ok(rel, "the reported release is listed");

    assert.equal(num(rel.amount), 42.5, "the APPROVED amount is unchanged (the authority)");
    assert.ok(rel.reportedAmount != null, "the agent-reported amount is surfaced");
    assert.equal(num(rel.reportedAmount), 40.0, "the reported amount is the agent's figure, labelled separately");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — only approved amounts are counted toward budget; reported amounts never are.
// ===========================================================================

test("the approved total counts only approved release amounts — never an agent-reported amount", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-count");
    const dek = freshDek();
    const { agentId, connectionId } = await setupAgent(db, userId, "Counter");

    // Two approved releases: 10.50 + 20.25 = 30.75 counts. The agent then REPORTS a
    // wildly larger 1000.00 against the first — it must NOT inflate the counted total.
    const r1 = await addRelease(db, { userId, connectionId, amount: 10.5, merchant: "BoxCo" });
    await addRelease(db, { userId, connectionId, amount: 20.25, merchant: "CafeCo" });
    const recorder = makeRecorder(db, dek);
    await reportForRelease(recorder, { userId, agentId, releaseId: r1.id, amount: 1000.0 });

    const out = await readOwnSpending(db, userId, dek, fixedClock(NOW));
    const entry = agentNamed(out, "Counter");
    assert.ok(entry, "the agent appears");

    assert.equal(num(entry.approvedTotal), 30.75, "the counted total is the approved sum (never the reported 1000)");

    // And the counted total is exactly the sum of the listed APPROVED amounts.
    const sumApproved = entry.releases.reduce((s: number, r: any) => s + num(r.amount), 0);
    assert.equal(num(entry.approvedTotal), sumApproved, "the approved total equals the sum of the approved amounts");

    // The reported amount is still SHOWN on its release (labelled), just never counted.
    const rel1 = entry.releases.find((r: any) => r.id === r1.id);
    assert.ok(rel1, "the reported release is listed");
    assert.equal(num(rel1.reportedAmount), 1000.0, "the reported amount is shown with its label");
    assert.equal(num(rel1.amount), 10.5, "its approved amount is the one that counted");
  } finally {
    await db.close();
  }
});

test("only releases in the current budget period are listed and counted; a different period's release is excluded", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-period");
    const dek = freshDek();
    const { connectionId } = await setupAgent(db, userId, "Periodic", {
      amount: 500,
      currency: "AUD",
      period: "month",
    });

    await addRelease(db, { userId, connectionId, amount: 7.5, merchant: "NowCo", periodKeys: keys() });
    await addRelease(db, { userId, connectionId, amount: 99.0, merchant: "OtherCo", periodKeys: keysOther() });

    const out = await readOwnSpending(db, userId, dek, fixedClock(NOW));
    const entry = agentNamed(out, "Periodic");
    assert.ok(entry, "the agent appears");

    const merchants = entry.releases.map((r: any) => r.merchant);
    assert.ok(merchants.includes("NowCo"), "this period's release is listed");
    assert.ok(!merchants.includes("OtherCo"), "a different period's release is excluded");
    assert.equal(num(entry.approvedTotal), 7.5, "only this period's approved amount is counted");
  } finally {
    await db.close();
  }
});

test("an agent with a budget but no releases this period appears with an empty list and a zero approved total", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-idle");
    const dek = freshDek();
    await setupAgent(db, userId, "Idle", { amount: 150, currency: "AUD", period: "month" });

    const out = await readOwnSpending(db, userId, dek, fixedClock(NOW));
    const entry = agentNamed(out, "Idle");
    assert.ok(entry, "the owner's agent still appears (its spend-against-budget is shown)");
    assert.equal(entry.releases.length, 0, "it has no releases this period");
    assert.equal(num(entry.approvedTotal), 0, "its counted total is zero");
    assert.equal(num(entry.budget.amount), 150, "its budget is still shown");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — reads ONLY the session user's own agents' spending (filtered by session id).
// ===========================================================================

test("readOwnSpending returns only the owner's agents and releases — never another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const dekA = freshDek();
    const dekB = freshDek();

    const a = await setupAgent(db, alice, "AliceAgent");
    const b = await setupAgent(db, bob, "BobAgent");
    const aRelease = await addRelease(db, { userId: alice, connectionId: a.connectionId, amount: 11.0, merchant: "AliceShop" });
    const bRelease = await addRelease(db, { userId: bob, connectionId: b.connectionId, amount: 22.0, merchant: "BobShop" });

    const aliceOut = await readOwnSpending(db, alice, dekA, fixedClock(NOW));
    const aliceNames = aliceOut.agents.map((x: any) => x.displayName);
    const aliceReleaseIds = aliceOut.agents.flatMap((x: any) => x.releases.map((r: any) => r.id));
    assert.ok(aliceNames.includes("AliceAgent"), "Alice sees her own agent");
    assert.ok(!aliceNames.includes("BobAgent"), "Alice never sees Bob's agent");
    assert.ok(aliceReleaseIds.includes(aRelease.id), "Alice sees her own release");
    assert.ok(!aliceReleaseIds.includes(bRelease.id), "Alice never sees Bob's release");

    const bobOut = await readOwnSpending(db, bob, dekB, fixedClock(NOW));
    const bobNames = bobOut.agents.map((x: any) => x.displayName);
    const bobReleaseIds = bobOut.agents.flatMap((x: any) => x.releases.map((r: any) => r.id));
    assert.ok(bobNames.includes("BobAgent"), "Bob sees his own agent");
    assert.ok(!bobNames.includes("AliceAgent"), "Bob never sees Alice's agent");
    assert.ok(bobReleaseIds.includes(bRelease.id), "Bob sees his own release");
    assert.ok(!bobReleaseIds.includes(aRelease.id), "Bob never sees Alice's release");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:validate-and-parameterize-input] (INV-102)
//
// A route handler validates the request HERE (`parseBody`), then reads the spending for
// the SESSION's user id — NEVER a value from the request body. A rejected input maps to
// a 4xx Response and never reaches a query. The user id is bound as a parameter (no
// spliced SQL), and a SQL-injection probe in a field (a merchant) travels as inert
// data. This handler is a test fixture that EXERCISES the modules — not an
// implementation file.
// ===========================================================================

function ownSpendingHandler(
  db: Db,
  dek: Uint8Array,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body is OPTIONAL and the only member scope is the SESSION's id — a `userId` in
  // the body is accepted by the shape but IGNORED (it must never widen the scope). The
  // size cap keeps an absurd body out before it is parsed.
  const schema = z.object({ userId: z.string().max(256).optional() });
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const spending = await readOwnSpending(db, sessionUserId, dek, clock);
      return new Response(
        JSON.stringify({
          agentIds: spending.agents.map((a: any) => a.agentId),
          releaseIds: spending.agents.flatMap((a: any) => a.releases.map((r: any) => r.id)),
        }),
        { status: 200 },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/spending", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("readOwnSpending binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE card_spend_ledger; --";

  const out = await readOwnSpending(db, probe, freshDek(), fixedClock(NOW));
  assert.deepEqual(out.agents, [], "the recording db returns no rows, so there are no agents");

  assert.ok(db.calls.length >= 1, "the read issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = ownSpendingHandler(db, freshDek(), fixedClock(NOW), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = ownSpendingHandler(db, freshDek(), fixedClock(NOW), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ filler: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler reads the SESSION user's spending and ignores a user id supplied in the body", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice");
    const bob = await makeUser(db, "handler-bob");
    const dekA = freshDek();

    const a = await setupAgent(db, alice, "AliceAgent");
    const b = await setupAgent(db, bob, "BobAgent");
    const aRelease = await addRelease(db, { userId: alice, connectionId: a.connectionId, amount: 5.0, merchant: "AliceShop" });
    const bRelease = await addRelease(db, { userId: bob, connectionId: b.connectionId, amount: 9.0, merchant: "BobShop" });

    // The handler is Alice's session; the body tries to pass BOB's id.
    const handler = ownSpendingHandler(db, dekA, fixedClock(NOW), alice);
    const res = await handler(jsonRequest(JSON.stringify({ userId: bob })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { releaseIds } = (await res.json()) as { releaseIds: string[] };
    assert.ok(releaseIds.includes(aRelease.id), "the handler reads the session (Alice's) spending");
    assert.ok(!releaseIds.includes(bRelease.id), "the body's user id is ignored — never widens the scope");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a release's merchant round-trips through the read as inert data", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const { connectionId } = await setupAgent(db, userId, "Injector");
    const probe = "evil'); DROP TABLE card_spend_ledger; --";
    const release = await addRelease(db, { userId, connectionId, amount: 3.0, merchant: probe });

    const out = await readOwnSpending(db, userId, dek, fixedClock(NOW));

    assert.equal(
      await tableExists(db, "card_spend_ledger"),
      true,
      "the ledger table survives the read (the probe is data, not SQL)",
    );
    const entry = agentNamed(out, "Injector");
    assert.ok(entry, "the agent appears");
    const rel = entry.releases.find((r: any) => r.id === release.id);
    assert.ok(rel, "the release is read back");
    assert.equal(rel.merchant, probe, "the probe merchant round-trips verbatim");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 [obligation:secrets-from-env] — the read runs from its INJECTED deps alone (db,
// userId, dek, clock): no secret, no ambient configuration.
// ===========================================================================

test("readOwnSpending runs from injected deps alone: no secret and no ambient configuration", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-secrets");
    const dek = freshDek();
    const { agentId, connectionId } = await setupAgent(db, userId, "Scoped");
    const release = await addRelease(db, { userId, connectionId, amount: 12.25, merchant: "ScopedCo" });
    const recorder = makeRecorder(db, dek);
    await reportForRelease(recorder, { userId, agentId, releaseId: release.id, amount: 12.0 });

    // Only db / userId / dek / clock — no connection string, no key read from env.
    const out = await readOwnSpending(db, userId, dek, fixedClock(NOW));

    const entry = agentNamed(out, "Scoped");
    assert.ok(entry, "the read runs with no secret or env handed to it");
    const rel = entry.releases.find((r: any) => r.id === release.id);
    assert.ok(rel, "the release is read back (the dek decrypts the reported amount) from injected deps alone");
    assert.equal(num(rel.reportedAmount), 12.0, "the injected dek decrypted the agent-reported amount");
  } finally {
    await db.close();
  }
});
