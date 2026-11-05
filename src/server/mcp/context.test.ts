// E07-S09 — Agent policy-context loader (`src/server/mcp/context.ts`).
//
// RED-first: the module does not exist yet, so importing `./context` throws and every
// test here fails (and `tsc --noEmit` reddens on the missing module) until the builder
// writes the minimum code to pass. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes `context.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the loader DOES: what it returns for a connection,
// whose data it reads, how it defaults the currency, what a handler rejects, that every
// value reaches the db as a BOUND parameter), never the source text of the module — a
// later rename that preserves behaviour must not redden them.
//
// WHY this exists (design §6.1 pipeline, §8 policy engine): the agent-call pipeline
// (E07-S10) passes ONE context object to the PURE policy engine `evaluate(call, ctx)`
// (E03-S13). Assembling that object in one place — reading a connection's permission
// grants (E07-S05), the rules applicable to it (E07-S06) and its approved-release spend
// for the current budget period (E07-S07) — keeps the engine pure and testable. The
// loader is a SERVER module: it reads through the injected `Db` seam, resolves the
// person's data key through the injected `KeyWrapper` seam (to decrypt rule conditions,
// the totp-store idiom) and reads the current instant through the injected `Clock` seam
// (for the budget-period key). It reads no `process.env` and holds no secret (INV-103):
// all configuration flows in as injected seams. Every read is member-scoped by the
// connection's OWNING user id — never a value from the client (INV-102, project rule:
// every member-scoped read takes userId from the session/connection).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface AgentConnection {       // the resolved connection the loader reads for.
//     userId: string;                 // the OWNING person (member scope) — from the
//                                      // session/connection, NEVER a client value.
//     connectionId: string;           // the agent connection these grants/rules/spend
//                                      // belong to (an opaque uuid; the connections
//                                      // table arrives in a later migration). This is
//                                      // also the rule-scope "chosen agent" id space.
//     agentId: string;                // the agent identity (same id space as
//                                      // connectionId — "one row per connection").
//     active: boolean;                // whether the connection is still connected.
//   }
//
//   interface LoadAgentContextDeps {  // the injected seams — no process.env.
//     db: Db;                         // the parameterizing database seam.
//     keyWrapper: KeyWrapper;         // unwraps the person's DEK to decrypt rule
//                                      // conditions (resolved from users.wrapped_dek).
//     clock: Clock;                   // the current instant → the budget-period key.
//   }
//
//   interface AgentContext {          // the assembled context the pipeline hands the
//                                      // pure engine.
//     permissions: ConnectionPermissions; // the connection's granted permissions
//                                      // (exactly what getConnectionPermissions returns).
//     rules: StoredRule[];            // the ACTIVE rules APPLICABLE to this connection:
//                                      // scoped to any_agent OR to this agent; a
//                                      // different agent's rule and a paused rule are
//                                      // excluded. Conditions are DECRYPTED. (No action
//                                      // filter — the loader has no call; the pure
//                                      // engine does the per-call action matching.)
//     spend: number;                  // the connection's approved-release TOTAL for the
//                                      // current budget period (the budget's period, or
//                                      // month when no budget is set). 0 when none.
//     accountCurrency: string;        // the budget's currency, or "AUD" when no budget
//                                      // currency is set.
//   }
//
//   loadAgentContext(connection: AgentConnection, deps: LoadAgentContextDeps)
//     : Promise<AgentContext>
//     • reads the connection's grants, its applicable rules and its current-period spend,
//       every read member-scoped by `connection.userId`, and returns them as one object.
//     • the current budget-period key is derived from `deps.clock.now()` (UTC): the month
//       bucket is "YYYY-MM" and the day bucket "YYYY-MM-DD" (the opaque keys the ledger
//       stores, design §8 / E07-S07) — the budget's `period` selects which granularity.
//
// Acceptance criteria → tests:
//   AC1 "loadAgentContext returns the connection's granted permissions, its applicable
//        rules and the agent's spend so far this budget period." — the returned grants
//        equal the stored grants; the applicable active rules (any_agent + this agent)
//        come back (both rule kinds / actions, conditions decrypted) while a different
//        agent's and a paused rule do not; `spend` totals the current budget period's
//        releases for this connection and the budget's PERIOD drives the granularity.
//   AC2 "It reads data only for the connection's owning user (filtered by session/
//        connection user id)." — with two people sharing one connection id, the loader
//        for one returns only that person's grants, rules, spend and currency, never the
//        other's and never the two combined.
//   AC3 "With no account currency set it defaults amounts to AUD." — no card budget →
//        accountCurrency "AUD"; a budget in another currency → that currency.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed/oversized/mis-shaped input with a
//        4xx before the loader runs, and takes the user id from the session, never the
//        body; a SQL-injection probe in the connection ids travels as a BOUND value
//        (placeholders, never concatenation) and cannot alter a query. The handler is a
//        test fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the loader runs purely from its
//        injected seams and reads no `process.env`, so a decoy secret in the environment
//        never lands in the assembled context.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { loadAgentContext } from "./context";
import { createUser } from "../db/users";
import { upsertPermissions, getConnectionPermissions } from "../db/agent-permissions";
import { createRule, pauseRule } from "../db/rules";
import { recordRelease } from "../db/card-spend-ledger";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { parseBody, HttpError } from "../http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";

// --- the pinned shapes, taken from the stores' own signatures so a later type rename
// that preserves behaviour does not redden these tests. -----------------------------
type Grants = Parameters<typeof upsertPermissions>[1];
type NewRule = Parameters<typeof createRule>[1];
type StoredRule = Awaited<ReturnType<typeof createRule>>;
type NewRelease = Parameters<typeof recordRelease>[1];
type PeriodKeys = NewRelease["periodKeys"];

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// Connection ids are uuids (the columns are `uuid`); the rule-scope "chosen agent" id is
// the SAME id space. Two people may hold a row for the SAME connection id (the stores'
// primary key is the (user, connection) pair), which the ownership test relies on.
const CONN = "11111111-1111-1111-1111-111111111111";
const OTHER_CONN = "22222222-2222-2222-2222-222222222222";

// The frozen instant every loader reads time through, and the period keys that fall in
// it. Noon mid-month UTC, so the month/day buckets are unambiguous in UTC calendar
// arithmetic (the budget domain is UTC). These are the opaque keys E07-S07 stores.
const NOW = new Date("2026-11-15T12:00:00.000Z");
const MONTH_NOW = "2026-11"; // the month bucket for NOW (design §8 example "2026-11")
const DAY_NOW = "2026-11-15"; // the day bucket for NOW (example "2026-11-05")
const WEEK_PLACEHOLDER = "2026-W47"; // the week bucket is never summed by these tests

// Period buckets in a DIFFERENT period than NOW, so a release here must not count.
const MONTH_OTHER = "2026-12";
const DAY_OTHER = "2026-11-14";

// Rule parts (the domain vocabulary), as `as const` literals so each is assignable to its
// discriminated-union member without importing the domain type names.
const ANY_AGENT = { type: "any_agent" } as const;
function agentScope(agentId: string, name = "Claude") {
  return { type: "agent", agentId, name } as const;
}
const SEND_EMAIL = { type: "send_message", channel: "email" } as const;
const CARD_REQUEST = { type: "card_request" } as const;
const ANY_CHANGE = { type: "any_change" } as const;
const HIGH_TIER = { type: "high_tier_request" } as const;

// A condition carrying a UNIQUE token, so a decrypted round-trip through the loader is
// unambiguous — proving the loader resolved the DEK and decrypted the condition.
function merchantCondition(token: string) {
  return { type: "merchant_in", merchants: [`SecretStore-${token}`, "BoxCo"] } as const;
}

// A fresh random 256-bit DEK, and a KeyWrapper + the wrapped form of that DEK. The loader
// is handed the KeyWrapper and resolves the DEK itself from `users.wrapped_dek`; the
// rules store (a layer down) receives the already-unwrapped bytes. A real wrap/unwrap
// round-trip means a condition encrypted under `dek` on create reads back through the
// loader, end to end.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}
function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, and return their
// id with the DEK the rules were encrypted under.
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = freshDek();
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// A fully-populated grants record; a test overrides only what it is about. Built via a
// helper (a non-literal passed to upsertPermissions) so excess-property checks never bite.
function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: ["gmail", "google-calendar"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: ["house-skill"],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  };
}

// The three period keys for a release, defaulting to the buckets that fall in NOW.
function keys(overrides: Partial<PeriodKeys> = {}): PeriodKeys {
  return { day: DAY_NOW, week: WEEK_PLACEHOLDER, month: MONTH_NOW, ...overrides };
}

// A release for `userId` on `CONN`, overriding only what the test is about.
function release(userId: string, overrides: Partial<NewRelease> = {}): NewRelease {
  return {
    userId,
    connectionId: CONN,
    householdId: null,
    amount: 10.5,
    currency: "AUD",
    merchant: "BoxCo",
    periodKeys: keys(),
    ...overrides,
  };
}

// The resolved connection the loader reads for. Built as a variable (not a fresh literal
// at the call site), so a superset of fields stays assignable to the loader's param type.
function connectionFor(userId: string, connectionId: string = CONN) {
  return { userId, connectionId, agentId: connectionId, active: true };
}

// The injected seams. A non-literal, for the same assignability reason.
function depsFor(db: Db, keyWrapper: KeyWrapper, now: Date = NOW) {
  return { db, keyWrapper, clock: fixedClock(now) };
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns a valid
// wrapped DEK for the users lookup (so DEK resolution succeeds and the loader proceeds to
// the member-scoped reads) and no rows otherwise. Satisfies `Db` structurally.
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(wrappedDek: string): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.toLowerCase().includes("wrapped_dek")) {
        return Promise.resolve({ rows: [{ wrapped_dek: wrappedDek }] as Record<string, unknown>[] });
      }
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// ===========================================================================
// AC1 — the loader returns the connection's grants, its applicable rules and
// its current budget-period spend.
// ===========================================================================

test("returns exactly the connection's granted permissions (what getConnectionPermissions reads back)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac1-perms", keyWrapper);
    await upsertPermissions(
      db,
      baseGrants(userId, CONN, {
        grantedConnectors: ["gmail", "notion", "linear"],
        changeTools: "allow",
        rateLimit: 90,
      }),
    );

    const ctx = await loadAgentContext(connectionFor(userId), depsFor(db, keyWrapper));

    const stored = await getConnectionPermissions(db, userId, CONN);
    assert.deepEqual(
      ctx.permissions,
      stored,
      "the context's permissions are exactly the connection's stored grants",
    );
    assert.deepEqual(ctx.permissions.grantedConnectors, ["gmail", "notion", "linear"]);
    assert.equal(ctx.permissions.changeTools, "allow");
    assert.equal(ctx.permissions.rateLimit, 90);
  } finally {
    await db.close();
  }
});

test("returns the ACTIVE rules applicable to this connection (any_agent + this agent), both decrypted; excludes another agent's and paused rules", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "ac1-rules", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    // R1: any_agent, send email — applicable.
    const r1 = await createRule(db, { userId, kind: "ask_first", scope: ANY_AGENT, action: SEND_EMAIL } as NewRule, dek);
    // R2: scoped to THIS agent, a card request carrying a decryptable condition — applicable.
    const cond = merchantCondition("rules-token");
    const r2 = await createRule(
      db,
      { userId, kind: "never_allow", scope: agentScope(CONN), action: CARD_REQUEST, condition: cond } as NewRule,
      dek,
    );
    // R3: scoped to a DIFFERENT agent — not applicable to this connection.
    const r3 = await createRule(db, { userId, kind: "never_allow", scope: agentScope(OTHER_CONN), action: ANY_CHANGE } as NewRule, dek);
    // R4: any_agent but PAUSED — excluded from the applicable set.
    const r4 = await createRule(db, { userId, kind: "ask_first", scope: ANY_AGENT, action: HIGH_TIER } as NewRule, dek);
    await pauseRule(db, userId, r4.id);

    const ctx = await loadAgentContext(connectionFor(userId), depsFor(db, keyWrapper));
    const ids = ctx.rules.map((r: StoredRule) => r.id);

    assert.ok(ids.includes(r1.id), "an any_agent rule is applicable to this connection");
    assert.ok(ids.includes(r2.id), "a rule scoped to this agent is applicable");
    assert.ok(!ids.includes(r3.id), "a rule scoped to a DIFFERENT agent is not applicable");
    assert.ok(!ids.includes(r4.id), "a paused rule is excluded from the applicable set");

    // Both rule kinds / actions come back (no per-call action filter — the pure engine
    // does that), and the condition is DECRYPTED (the loader resolved the DEK).
    const kinds = ctx.rules.filter((r: StoredRule) => r.id === r1.id || r.id === r2.id).map((r: StoredRule) => r.kind).sort();
    assert.deepEqual(kinds, ["ask_first", "never_allow"], "both ask_first and never_allow rules are returned");
    const r2back = ctx.rules.find((r: StoredRule) => r.id === r2.id);
    assert.deepEqual(r2back?.condition, cond, "the rule condition round-trips DECRYPTED through the loader");
  } finally {
    await db.close();
  }
});

test("`spend` totals this connection's approved releases for the current MONTH, excluding other months and other connections", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac1-spend-month", keyWrapper);
    await upsertPermissions(
      db,
      baseGrants(userId, CONN, { cardAccess: true, cardBudget: { amount: 200, currency: "AUD", period: "month" } }),
    );

    // Two releases this month on this connection → 30.75; one next month (excluded); one
    // this month on another connection (excluded — member-scoped to THIS connection).
    await recordRelease(db, release(userId, { amount: 10.5, periodKeys: keys() }));
    await recordRelease(db, release(userId, { amount: 20.25, periodKeys: keys() }));
    await recordRelease(db, release(userId, { amount: 100.0, periodKeys: keys({ month: MONTH_OTHER }) }));
    await recordRelease(db, release(userId, { connectionId: OTHER_CONN, amount: 500.0, periodKeys: keys() }));

    const ctx = await loadAgentContext(connectionFor(userId), depsFor(db, keyWrapper));
    assert.equal(ctx.spend, 30.75, "spend is this connection's current-month release total");
  } finally {
    await db.close();
  }
});

test("the budget's PERIOD drives which bucket `spend` sums (a day budget sums only today)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac1-spend-day", keyWrapper);
    await upsertPermissions(
      db,
      baseGrants(userId, CONN, { cardAccess: true, cardBudget: { amount: 50, currency: "AUD", period: "day" } }),
    );

    // One release today (day bucket of NOW) and one yesterday — a DAY budget sums only today.
    await recordRelease(db, release(userId, { amount: 42.5, periodKeys: keys({ day: DAY_NOW }) }));
    await recordRelease(db, release(userId, { amount: 100.0, periodKeys: keys({ day: DAY_OTHER }) }));

    const ctx = await loadAgentContext(connectionFor(userId), depsFor(db, keyWrapper));
    assert.equal(ctx.spend, 42.5, "a day budget sums only today's release, not yesterday's");
  } finally {
    await db.close();
  }
});

test("`spend` is 0 (not undefined/NaN) when the connection has no releases this period", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac1-spend-zero", keyWrapper);
    await upsertPermissions(
      db,
      baseGrants(userId, CONN, { cardAccess: true, cardBudget: { amount: 200, currency: "AUD", period: "month" } }),
    );

    const ctx = await loadAgentContext(connectionFor(userId), depsFor(db, keyWrapper));
    assert.equal(ctx.spend, 0, "no releases this period totals 0");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the loader reads ONLY the connection's owning user's data (member-scoped
// by the session/connection user id), even when two people share a connection id.
// ===========================================================================

test("two people sharing one connection id: the loader returns only the owner's grants, rules, spend and currency", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, "ac2-alice", keyWrapper);
    const bob = await makePerson(db, "ac2-bob", keyWrapper);

    // Both hold a row for the SAME connection id, with DIFFERENT grants/currency.
    await upsertPermissions(
      db,
      baseGrants(alice.userId, CONN, {
        grantedConnectors: ["gmail"],
        cardAccess: true,
        cardBudget: { amount: 200, currency: "AUD", period: "month" },
      }),
    );
    await upsertPermissions(
      db,
      baseGrants(bob.userId, CONN, {
        grantedConnectors: ["slack"],
        cardAccess: true,
        cardBudget: { amount: 999, currency: "USD", period: "month" },
      }),
    );

    // Each has their own rule and their own spend on the shared connection id.
    const aliceRule = await createRule(db, { userId: alice.userId, kind: "ask_first", scope: ANY_AGENT, action: SEND_EMAIL } as NewRule, alice.dek);
    const bobRule = await createRule(db, { userId: bob.userId, kind: "never_allow", scope: ANY_AGENT, action: CARD_REQUEST } as NewRule, bob.dek);
    await recordRelease(db, release(alice.userId, { amount: 30.75, periodKeys: keys() }));
    await recordRelease(db, release(bob.userId, { amount: 999.0, periodKeys: keys() }));

    const ctx = await loadAgentContext(connectionFor(alice.userId), depsFor(db, keyWrapper));

    assert.deepEqual(ctx.permissions.grantedConnectors, ["gmail"], "Alice's granted connectors, not Bob's");
    assert.equal(ctx.accountCurrency, "AUD", "Alice's budget currency, not Bob's USD");
    assert.equal(ctx.spend, 30.75, "Alice's spend only — never Bob's 999 and never the two combined");

    const ids = ctx.rules.map((r: StoredRule) => r.id);
    assert.ok(ids.includes(aliceRule.id), "Alice's own rule is returned");
    assert.ok(!ids.includes(bobRule.id), "Bob's rule on the same connection id is never returned");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — with no account currency set, amounts default to AUD.
// ===========================================================================

test("no card budget → accountCurrency defaults to AUD", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac3-default", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN, { cardAccess: false, cardBudget: null }));

    const ctx = await loadAgentContext(connectionFor(userId), depsFor(db, keyWrapper));
    assert.equal(ctx.accountCurrency, "AUD", "with no budget currency set, amounts default to AUD");
  } finally {
    await db.close();
  }
});

test("a budget in another currency sets accountCurrency to that currency (the default only applies when none is set)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac3-usd", keyWrapper);
    await upsertPermissions(
      db,
      baseGrants(userId, CONN, { cardAccess: true, cardBudget: { amount: 300, currency: "USD", period: "month" } }),
    );

    const ctx = await loadAgentContext(connectionFor(userId), depsFor(db, keyWrapper));
    assert.equal(ctx.accountCurrency, "USD", "a set budget currency is used verbatim, not defaulted");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — parameter binding: a SQL-injection probe in the connection ids travels
// as a BOUND value, never woven into the SQL text.
// ===========================================================================

test("the connection's user id and connection id reach the db as BOUND parameters, never spliced into the SQL", async () => {
  const keyWrapper = keyWrapperFor();
  // A real wrapped DEK so the recording db's users lookup resolves and the loader
  // proceeds to the member-scoped reads that bind the connection ids.
  const wrappedDek = await keyWrapper.wrap(freshDek());
  const db = recordingDb(wrappedDek);

  const userProbe = "u'; DROP TABLE agent_permissions; --";
  const connProbe = "c'; DROP TABLE rules; --";

  // The loader may reject the (unseeded) connection partway; we only care that whatever
  // reached the db was bound. Swallow any resulting rejection.
  await loadAgentContext(connectionFor(userProbe, connProbe), depsFor(db, keyWrapper)).catch(() => undefined);

  assert.ok(db.calls.length >= 1, "the loader issues at least one query");
  const allValues = db.calls.flatMap((c) => c.values);
  assert.ok(allValues.includes(userProbe), "the owning user id travels as a bound value");
  assert.ok(allValues.includes(connProbe), "the connection id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userProbe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes(connProbe), "the connection id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects malformed/oversized/mis-shaped
// input with a 4xx before the loader runs, and takes the user id from the session,
// never the body. The handler is a test fixture (the intended usage), not an
// implementation file.
//
// The agent-call handler validates the request body (every core tool takes an optional
// `reason`, design §6.1), then calls the loader with the SESSION's connection — whose
// user id is the session's, NEVER a body value. A rejected input maps to a 4xx Response
// and never reaches the loader.
// ===========================================================================

function contextHandler(
  deps: Parameters<typeof loadAgentContext>[1],
  sessionConnection: Parameters<typeof loadAgentContext>[0],
): (req: Request) => Promise<Response> {
  // The body carries only the optional reason; the connection (incl. the user id) comes
  // from the session. `reason` is length-capped so an absurd value is rejected.
  const schema = z.object({ reason: z.string().max(500).optional() });
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const ctx = await loadAgentContext(sessionConnection, deps);
      // Return a NON-secret summary (currency + spend + connector count) — never grants
      // verbatim, tokens or any secret.
      return new Response(
        JSON.stringify({
          currency: ctx.accountCurrency,
          spend: ctx.spend,
          connectors: ctx.permissions.grantedConnectors.length,
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
  return new Request("https://warthog.com.au/mcp/get_context", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches the loader", async () => {
  const keyWrapper = keyWrapperFor();
  const db = recordingDb(await keyWrapper.wrap(freshDek()));
  const handler = contextHandler(depsFor(db, keyWrapper), connectionFor("session-user"));

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach the loader / a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches the loader", async () => {
  const keyWrapper = keyWrapperFor();
  const db = recordingDb(await keyWrapper.wrap(freshDek()));
  const handler = contextHandler(depsFor(db, keyWrapper), connectionFor("session-user"));

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ reason: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach the loader / a query");
});

test("the handler rejects a mis-shaped field with a 4xx and never reaches the loader", async () => {
  const keyWrapper = keyWrapperFor();
  const db = recordingDb(await keyWrapper.wrap(freshDek()));
  const handler = contextHandler(depsFor(db, keyWrapper), connectionFor("session-user"));

  // reason must be a string — a number is a schema violation rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ reason: 123 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped field must never reach the loader / a query");
});

test("the handler accepts a well-formed body and loads the SESSION user's context, never a body-smuggled user", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, "handler-alice", keyWrapper);
    const bob = await makePerson(db, "handler-bob", keyWrapper);

    await upsertPermissions(
      db,
      baseGrants(alice.userId, CONN, {
        grantedConnectors: ["gmail"],
        cardAccess: true,
        cardBudget: { amount: 200, currency: "AUD", period: "month" },
      }),
    );
    await upsertPermissions(
      db,
      baseGrants(bob.userId, CONN, {
        grantedConnectors: ["slack", "notion", "linear"],
        cardAccess: true,
        cardBudget: { amount: 999, currency: "USD", period: "month" },
      }),
    );
    await recordRelease(db, release(alice.userId, { amount: 12.25, periodKeys: keys() }));

    // The session is Alice's; the body smuggles Bob's ids (and a reason). The handler must
    // ignore the body ids and load ALICE's context.
    const handler = contextHandler(depsFor(db, keyWrapper), connectionFor(alice.userId));
    const res = await handler(
      jsonRequest(JSON.stringify({ reason: "why", userId: bob.userId, connectionId: CONN })),
    );

    assert.equal(res.status, 200, "a well-formed body is accepted");
    const body = (await res.json()) as { currency: string; spend: number; connectors: number };
    assert.equal(body.currency, "AUD", "Alice's currency — the session user's, not Bob's USD");
    assert.equal(body.spend, 12.25, "Alice's spend — the session user's");
    assert.equal(body.connectors, 1, "Alice's one connector, not Bob's three");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the loader runs purely from its injected seams and reads no process.env, so
// a decoy secret in the environment never lands in the assembled context.
// ===========================================================================

test("the loader reads no process.env: a decoy secret in the environment never appears in the context", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac5-env", keyWrapper);
    await upsertPermissions(
      db,
      baseGrants(userId, CONN, { cardAccess: true, cardBudget: { amount: 200, currency: "AUD", period: "month" } }),
    );
    await recordRelease(db, release(userId, { amount: 10.5, periodKeys: keys() }));

    // The loader is given ONLY its injected seams — no config object, no env — and still
    // assembles the context, proving it reads configuration from injected seams alone.
    const ctx = await loadAgentContext(connectionFor(userId), depsFor(db, keyWrapper));

    assert.equal(ctx.accountCurrency, "AUD", "the loader works purely from its injected seams");
    assert.ok(
      !JSON.stringify(ctx).includes(DECOY),
      "no ambient env value is folded into the assembled context",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
