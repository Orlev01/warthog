// E18-S05 — Home dashboard metrics read, the obligation acceptance criteria
// (INV-102 validate-and-parameterize-input; INV-103 secrets-from-env).
//
// RED-first: `./page-data` does not exist yet, so importing `loadHomeMetrics` throws
// and every test here fails until the builder writes the module. That absence IS the
// point of test-first; do NOT implement anything to make these pass.
//
// The pinned reads are documented in the sibling `page-data.test.ts`; this file
// depends on the same surface and pins only the two obligation ACs, as BEHAVIOUR:
//
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) —
//     • VALIDATE: a handler on the `../http/validate` boundary rejects a malformed,
//       oversized or mis-typed request body with a 4xx BEFORE the read runs, and takes
//       the owner from the SESSION — a `userId` smuggled in the body is stripped and
//       ignored (the handler below is a TEST FIXTURE — the intended usage — not an
//       implementation file); and
//     • PARAMETERIZE: the read binds the person id as a parameter, so a SQL-injection
//       probe routed through it travels as a BOUND value (placeholders, never spliced
//       into the SQL text) and cannot alter a query or drop a table.
//   AC4 [obligation:secrets-from-env] (INV-103) — the read runs purely from its
//       injected seams (db + keyWrapper + clock + the session id) and reads no
//       `process.env`, so a decoy secret planted in the environment never lands in the
//       assembled metrics, and the read still works with a decoy app env set.
//
// Database tests use `freshDb()` and a `recordingDb` that captures what reached the
// query layer; each real-db handle is closed in a `finally`. Tests touch no network
// and no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { loadHomeMetrics } from "./page-data";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { recordRelease } from "../db/card-spend-ledger";
import { createApproval } from "../db/approvals";
import { createRecord } from "../db/life-admin-records";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const KEYS_NOW = { day: "2026-11-15", week: "2026-W47", month: "2026-11" };
const DUE_UPCOMING = "2026-11-17";

const clock: Clock = fixedClock(NOW);
const keyWrapper: KeyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));

type Grants = Parameters<typeof upsertPermissions>[1];
type CardBudget = NonNullable<Grants["cardBudget"]>;

// A loose structural view of the assembled metrics, so the helpers do not depend on
// the (absent) module's exported types at the point they run.
interface MetricsLike {
  readonly pendingApprovals: number;
  readonly activity: unknown[];
  readonly agents: { readonly displayName: string }[];
  readonly reminders: unknown[];
}

async function makeUserWithDek(db: Db, who: string): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

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

// Seed a FULL account for `userId`: one pending approval, one agent with a budget and
// a release this period, and one upcoming reminder — so a probe or a decoy must leave
// a populated account untouched / unleaked.
async function seedFullAccount(db: Db, userId: string, dek: Uint8Array): Promise<void> {
  await createApproval(db, { userId, agentId: randomUUID(), detail: { sentence: "Pay $20" } }, dek, clock);
  const connectionId = randomUUID();
  await createAgent(db, { userId, connectionId, displayName: "Agent", platform: "Claude Desktop" }, clock);
  await upsertPermissions(db, baseGrants(userId, connectionId, { amount: 200, currency: "AUD", period: "month" }));
  await recordRelease(db, {
    userId,
    connectionId,
    householdId: null,
    amount: 42,
    currency: "AUD",
    merchant: "Woolworths",
    periodKeys: KEYS_NOW,
  });
  await createRecord(
    db,
    { userId, kind: "renewal_appointment", fields: { what: "Passport" }, dueDate: DUE_UPCOMING, status: "upcoming", source: { kind: "person" } },
    dek,
  );
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (a bound value vs. spliced text). Returns no rows
// and satisfies the `Db` shape structurally (query + close).
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

// Whether a relation of this exact name exists on this handle — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert the probe reached the query layer as a BOUND value and never as spliced SQL
// text, scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

// ===========================================================================
// AC3 (VALIDATE) — a handler on the validation boundary rejects bad input and takes the
// owner from the SESSION; a userId in the body is ignored.
//
// The read takes no client filter, so the handler only validates the request envelope
// (a well-formed JSON object within a size cap) and reads for the SESSION's id from the
// closure. This handler is a TEST FIXTURE (the intended usage) — not an implementation
// file.
// ===========================================================================

function metricsHandler(
  deps: { db: Db; keyWrapper: KeyWrapper; clock: Clock },
  sessionUserId: string,
): (req: Request) => Promise<{ status: number; reached: boolean; metrics: MetricsLike | null }> {
  const schema = z.object({});
  return async (req: Request) => {
    let reached = false;
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      reached = true;
      const metrics = (await loadHomeMetrics(deps, sessionUserId)) as MetricsLike;
      return { status: 200, reached, metrics };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, reached, metrics: null };
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a
      // test sees the raw failure rather than a masked success.
      return { status: 500, reached, metrics: null };
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/home", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("[validate-and-parameterize-input] the handler rejects malformed JSON with a 4xx before the read runs", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "hm-malformed");
    const handler = metricsHandler({ db, keyWrapper, clock }, userId);
    const res = await handler(jsonRequest("{ not valid json"));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "malformed input never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler rejects an oversized body with a 4xx before the read runs", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "hm-oversized");
    const handler = metricsHandler({ db, keyWrapper, clock }, userId);
    // ~8 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
    const res = await handler(jsonRequest(JSON.stringify({ junk: "a".repeat(8 * 1024) })));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "an oversized body never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler rejects a mis-typed body (not an object) with a 4xx", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "hm-mistyped");
    const handler = metricsHandler({ db, keyWrapper, clock }, userId);
    const res = await handler(jsonRequest(JSON.stringify(42)));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "a mis-typed body never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a well-formed request reaches the read and returns the session person's metrics", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "hm-ok");
    await seedFullAccount(db, userId, dek);
    const handler = metricsHandler({ db, keyWrapper, clock }, userId);

    const res = await handler(jsonRequest(JSON.stringify({})));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(res.reached, true, "a valid body reaches the read");
    assert.equal(res.metrics!.pendingApprovals, 1, "the session person's real metrics are returned");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the owner is the SESSION — a userId smuggled in the body is ignored (AC2)", async () => {
  const db = await freshDb();
  try {
    const session = await makeUserWithDek(db, "hm-session");
    const attacker = await makeUserWithDek(db, "hm-attacker");
    // The session person has ONE pending approval; the attacker has TWO — so a mix-up
    // would be unmistakable.
    await createApproval(db, { userId: session.userId, agentId: randomUUID(), detail: { sentence: "s" } }, session.dek, clock);
    await createApproval(db, { userId: attacker.userId, agentId: randomUUID(), detail: { sentence: "a1" } }, attacker.dek, clock);
    await createApproval(db, { userId: attacker.userId, agentId: randomUUID(), detail: { sentence: "a2" } }, attacker.dek, clock);

    const handler = metricsHandler({ db, keyWrapper, clock }, session.userId);

    // The body tries to redirect the read at the attacker. The handler validates the
    // envelope, strips the unknown key, and reads for the SESSION's id regardless.
    const res = await handler(jsonRequest(JSON.stringify({ userId: attacker.userId })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(
      res.metrics!.pendingApprovals,
      1,
      "the count is the SESSION person's (1), never the body-supplied user's (2)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 (PARAMETERIZE) — the person id reaches the db as a BOUND value, never spliced; a
// SQL-injection id cannot alter a query, drop a table, or leak another person's data.
// ===========================================================================

test("[validate-and-parameterize-input] the person id reaches the db as a BOUND value, never spliced into the SQL", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE agents; --";
  // The recording db returns no rows, so the read cannot resolve the person — but the
  // member-scoped query it DID issue must have bound the probe, never spliced it.
  try {
    await loadHomeMetrics({ db, keyWrapper, clock }, probe);
  } catch {
    /* no user row ⇒ the read reports a failure; we assert on HOW it queried */
  }
  assertBoundNotSpliced(db, probe);
});

test("[validate-and-parameterize-input] a SQL-injection person id cannot alter a query, drop a table, or leak another person's data", async () => {
  const db = await freshDb();
  try {
    // A real owner with a FULL account; the probe must neither reach nor harm it.
    const { userId, dek } = await makeUserWithDek(db, "probe-owner");
    await seedFullAccount(db, userId, dek);

    const probe = "p'); DROP TABLE agents; --";
    // Bound as a parameter, the probe is at worst a value the uuid-typed id column
    // rejects (OBS-049: an id-typed selector); it is NEVER executed as SQL. Either
    // outcome — the DB rejects it, or it simply matches nothing — proves it did not run.
    let rejectedOrEmpty = false;
    try {
      const metrics = (await loadHomeMetrics({ db, keyWrapper, clock }, probe)) as MetricsLike;
      rejectedOrEmpty = metrics.pendingApprovals === 0 && metrics.agents.length === 0 && metrics.reminders.length === 0;
    } catch {
      rejectedOrEmpty = true;
    }
    assert.ok(rejectedOrEmpty, "the probe is bound, not executed — it yields nothing or is rejected");

    // The decisive proof: every table and the real owner's whole account are intact.
    for (const table of [
      "approvals",
      "agents",
      "agent_permissions",
      "card_spend_ledger",
      "activity_entries",
      "life_admin_records",
      "users",
    ]) {
      assert.equal(await tableExists(db, table), true, `the ${table} table is intact`);
    }
    const stillThere = (await loadHomeMetrics({ db, keyWrapper, clock }, userId)) as MetricsLike;
    assert.equal(stillThere.pendingApprovals, 1, "the real owner's pending approval survived the probe");
    assert.equal(stillThere.agents.length, 1, "the real owner's agent survived the probe");
    assert.equal(stillThere.reminders.length, 1, "the real owner's reminder survived the probe");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [secrets-from-env] — the read uses injected deps only; no ambient env value lands
// in the assembled metrics, and it runs with a decoy app env set.
// ===========================================================================

test("[secrets-from-env] no ambient env secret appears in the metrics; the read runs from its injected seams alone", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  // Prove the read does not reach for an ambient database URL: point it at a decoy and
  // rely solely on the injected db seam.
  process.env.DATABASE_URL = `postgres://decoy:${DECOY}@127.0.0.1:1/decoy`;

  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "env-user");
    await seedFullAccount(db, userId, dek);

    const metrics = (await loadHomeMetrics({ db, keyWrapper, clock }, userId)) as MetricsLike;

    // The read worked purely from the injected db + keyWrapper + clock + session id.
    assert.equal(metrics.pendingApprovals, 1, "the read works from its injected inputs alone (the injected db supplied the data)");
    assert.ok(!JSON.stringify(metrics).includes(DECOY), "no ambient env secret appears in the metrics");
  } finally {
    await db.close();
    restoreEnv("WARTHOG_DECOY_SECRET", prevDecoy);
    restoreEnv("DATABASE_URL", prevDbUrl);
  }
});
