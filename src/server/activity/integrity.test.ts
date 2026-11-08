// E08-S02 — Activity integrity check (design §9 "activity hash chain",
// constitution principle 14 "Warthog writes the record", INV-19 operators cannot
// read vault contents). Target module: `src/server/activity/integrity.ts`.
//
// RED-first: the `./integrity` module does NOT exist yet, so importing
// `checkIntegrity` throws and this whole suite fails. That absence IS the point of
// test-first — do NOT implement anything to make these pass; the builder writes
// `integrity.ts` afterwards. The sound chains below are produced by the REAL writer
// (`./writer`, E08-S01), so a correct `checkIntegrity` reports them intact; a
// tamper via direct SQL is what the check must catch.
//
// These tests pin BEHAVIOUR (what `checkIntegrity` RETURNS for a sound vs a tampered
// stored chain, and what a boundary handler does with bad input), never the source
// text of the module — a later rename that preserves behaviour must not redden them.
//
// WHY this exists: Warthog's activity record is append-only and hash-chained over
// CIPHERTEXT (each entry carries a contiguous per-user `seq` and `prev_hash` equal to
// the previous entry's `entry_hash`, where
// `entry_hash = SHA-256(prev_hash ‖ canonical(all other fields incl. payload_ct))`).
// The person and a daily job verify the record was not altered, removed or reordered
// by recomputing that chain FROM THE STORED ROW ALONE — over the ciphertext, with NO
// decryption — so an operator can detect tampering without any path to the vault
// contents (INV-19).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the builder implements exactly this).
//
//   interface IntegrityResult {
//     intact: boolean;            // true ⇔ every stored entry verifies (all N intact)
//     checked: number;            // how many entries were examined (N)
//     brokenSeq: number | null;   // the seq of the FIRST broken entry; null when intact
//   }
//
//   checkIntegrity(db: Db, userId: string): Promise<IntegrityResult>
//     • Recomputes the per-user hash chain over the STORED CIPHERTEXT: reads the user's
//       entries (ordered by seq) and verifies, for each, that seq is contiguous, that
//       prev_hash chains to the previous entry's entry_hash (a genesis sentinel for the
//       first), and that entry_hash recomputes from the stored row. A sound chain of N
//       reports { intact: true, checked: N, brokenSeq: null }; the first entry that fails
//       reports { intact: false, brokenSeq: <that entry's seq> }.
//     • Takes NO DEK and no key material — it verifies over the ciphertext bytes and never
//       decrypts a payload (design §9, INV-19). The signature itself (db, userId) carries
//       no key, so decryption is not even possible here.
//     • Member-scoped: the user id is BOUND as a parameter (INV-102), taken from the session
//       (or the agent connection), never a client value — so one person's check never reads
//       or is affected by another's entries.
//     • Reads no `process.env` and holds no secret (INV-103): the db is INJECTED.
//
// Acceptance criteria → tests:
//   AC1 "A sound chain reports all N entries intact; altering, deleting or reordering any
//        stored entry makes it report the first broken entry's seq." — a writer-built chain of
//        N (and of 1, and the empty chain) is intact; a tampered field (mid and tail), a deleted
//        middle entry, and a reordering (two entries' seq swapped) each report broken with the
//        first broken entry's seq.
//   AC2 "The check runs without decrypting any payload." — checkIntegrity takes only (db, userId)
//        (no DEK) and verifies a sound chain; a tampered payload CIPHERTEXT is DETECTED (reported,
//        not thrown) — a decrypting verifier would throw on the corrupt bytes, so a clean break
//        report proves it hashes the ciphertext without decrypting.
//   AC3 "It verifies only the session user's entries." — tampering one user's chain leaves the
//        other user's check intact; checkIntegrity binds the user id (never a client value).
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a fixture handler on the
//        `../http/validate` boundary rejects malformed/oversized/mis-shaped input with a 4xx BEFORE
//        any query runs and checks only under the SESSION user id; a SQL-injection probe as the id
//        travels as a BOUND value (placeholders, never concatenation) and cannot drop the table.
//   AC5 [obligation:secrets-from-env] (INV-103) — the check holds no key and reads no `process.env`:
//        a decoy secret in the environment never appears in its result, and it works purely from the
//        injected db.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests share
// no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { checkIntegrity } from "./integrity";
import { createDbRecorder } from "./writer";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ----------------------------------------------------------------------

// A fixed instant so occurred_at is deterministic across a run (a clean round whole-ms
// UTC instant, so a timestamptz round-trip reproduces the exact string the chain hashed).
const T0 = new Date("2026-01-01T00:00:00.000Z");

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. Only the WRITER needs it (to encrypt payloads); the
// integrity check never receives a DEK.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this flow never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id — the
// activity entry's user_id, and the integrity check's scope).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A DEK provider over a fixed map of user → key (the writer's record() contract resolves
// the DEK per user internally).
function dekProvider(byUser: Record<string, Uint8Array>): (userId: string) => Promise<Uint8Array> {
  return async (userId: string) => {
    const dek = byUser[userId];
    if (!dek) throw new Error(`no DEK for ${userId}`);
    return dek;
  };
}

// Write a sound chain of `n` entries for one user through the REAL writer, so the chain
// is genuinely hash-chained over ciphertext — exactly what a correct checkIntegrity
// reports as intact.
async function buildChain(db: Db, userId: string, dek: Uint8Array, n: number): Promise<void> {
  const recorder = createDbRecorder({
    db,
    clock: fixedClock(T0),
    dekFor: dekProvider({ [userId]: dek }),
  });
  for (let i = 1; i <= n; i += 1) {
    await recorder.record({ userId, kind: "tool_call", source: "warthog", payload: { n: i } });
  }
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no rows
// (so the check treats the chain as empty — vacuously intact) and satisfies `Db`.
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
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// ===================================================================================
// AC1 — a sound chain reports all N intact.
// ===================================================================================

test("a sound chain of N entries reports all N intact", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "sound-n");
    await buildChain(db, userId, freshDek(), 3);

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, true, "a writer-built chain verifies as intact");
    assert.equal(result.checked, 3, "all three entries were examined");
    assert.ok(result.brokenSeq == null, "no broken seq is reported for a sound chain");
  } finally {
    await db.close();
  }
});

test("a single-entry chain is intact", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "sound-one");
    await buildChain(db, userId, freshDek(), 1);

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, true, "a one-entry chain (genesis only) is intact");
    assert.equal(result.checked, 1, "exactly one entry was examined");
    assert.ok(result.brokenSeq == null, "no broken seq for a sound single-entry chain");
  } finally {
    await db.close();
  }
});

test("an empty chain (no entries) is vacuously intact", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "sound-empty");

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, true, "a user with no entries has a vacuously sound chain");
    assert.equal(result.checked, 0, "no entries were examined");
    assert.ok(result.brokenSeq == null, "no broken seq for an empty chain");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC1 — altering a stored entry reports that entry's seq as the first break.
// ===================================================================================

test("altering a stored entry (mid-chain) reports that entry's seq as the first break", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "alter-mid");
    await buildChain(db, userId, freshDek(), 3);

    // Mutate a HASHED field of entry 2 (its entry_hash stays as written) — so recomputing
    // the hash from the stored row no longer matches the stored entry_hash.
    await db.query("UPDATE activity_entries SET kind = $2 WHERE user_id = $1 AND seq = $3", [
      userId,
      "tampered",
      2,
    ]);

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, false, "the altered chain is reported broken");
    assert.equal(result.brokenSeq, 2, "the first broken entry is the altered one, seq 2");
  } finally {
    await db.close();
  }
});

test("altering the LAST stored entry is detected (the tail is verified too)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "alter-tail");
    await buildChain(db, userId, freshDek(), 3);

    await db.query("UPDATE activity_entries SET kind = $2 WHERE user_id = $1 AND seq = $3", [
      userId,
      "tampered",
      3,
    ]);

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, false, "altering the last entry is caught (no entry is skipped)");
    assert.equal(result.brokenSeq, 3, "the first broken entry is the altered tail, seq 3");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC1 — deleting a stored entry breaks the chain and reports a broken seq.
// ===================================================================================

test("deleting a stored entry breaks the chain and reports a broken seq", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "delete-mid");
    await buildChain(db, userId, freshDek(), 3);

    // Remove the middle entry. The next entry's prev_hash no longer chains to the entry
    // before it, and the seq is no longer contiguous — the chain is broken.
    await db.query("DELETE FROM activity_entries WHERE user_id = $1 AND seq = $2", [userId, 2]);

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, false, "a hole in the chain is detected");
    assert.equal(typeof result.brokenSeq, "number", "a broken seq is reported");
    // The break surfaces at the deletion point: either the now-missing seq (2) or the first
    // surviving entry that no longer chains (3). Both are faithful readings of "first broken".
    assert.ok(
      result.brokenSeq === 2 || result.brokenSeq === 3,
      `the break is reported at the deletion point (got ${result.brokenSeq})`,
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC1 — reordering two stored entries reports the first out-of-place seq.
// ===================================================================================

test("reordering two stored entries reports the first out-of-place seq", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "reorder");
    await buildChain(db, userId, freshDek(), 3);

    // Swap the rows at seq 2 and seq 3 (a reordering) via a temporary seq to dodge the
    // (user_id, seq) primary key. After the swap, the row now at seq 2 carries the former
    // entry 3's prev_hash/entry_hash, so its link no longer holds.
    await db.query("UPDATE activity_entries SET seq = $2 WHERE user_id = $1 AND seq = $3", [userId, -1, 2]);
    await db.query("UPDATE activity_entries SET seq = $2 WHERE user_id = $1 AND seq = $3", [userId, 2, 3]);
    await db.query("UPDATE activity_entries SET seq = $2 WHERE user_id = $1 AND seq = $3", [userId, 3, -1]);

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, false, "a reordered chain is detected as broken");
    assert.equal(result.brokenSeq, 2, "the first entry whose link no longer holds is seq 2");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — the check runs without decrypting any payload.
// ===================================================================================

test("checkIntegrity verifies a sound chain with no DEK and no key material", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "nokey");
    // Encrypt under a DEK the check will never see — checkIntegrity takes only (db, userId).
    await buildChain(db, userId, freshDek(), 2);

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, true, "the chain verifies with no key passed in");
    assert.equal(result.checked, 2, "both entries were examined over the ciphertext");
  } finally {
    await db.close();
  }
});

test("a tampered payload ciphertext is detected over the ciphertext, not decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ct-tamper");
    await buildChain(db, userId, freshDek(), 3);

    // Corrupt the STORED ciphertext of entry 2. A verifier that DECRYPTED would throw on the
    // now-garbage envelope; a ciphertext-only verifier simply recomputes the hash over the new
    // bytes and reports the break — which is exactly "recompute over ciphertext, no decryption".
    await db.query(
      "UPDATE activity_entries SET payload_ct = payload_ct || $2 WHERE user_id = $1 AND seq = $3",
      [userId, "TAMPER", 2],
    );

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, false, "a change to the stored ciphertext breaks the chain");
    assert.equal(result.brokenSeq, 2, "detected at the tampered entry, without decrypting it");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3 — it verifies only the given (session) user's entries.
// ===================================================================================

test("checkIntegrity verifies only the given user's entries", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "scope-alice");
    const bob = await makeUser(db, "scope-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const recorder = createDbRecorder({
      db,
      clock: fixedClock(T0),
      dekFor: dekProvider({ [alice]: dekA, [bob]: dekB }),
    });
    for (let i = 1; i <= 3; i += 1) {
      await recorder.record({ userId: alice, kind: "k", source: "warthog", payload: { a: i } });
    }
    for (let i = 1; i <= 3; i += 1) {
      await recorder.record({ userId: bob, kind: "k", source: "warthog", payload: { b: i } });
    }

    // Tamper ONLY Alice's chain.
    await db.query("UPDATE activity_entries SET kind = $2 WHERE user_id = $1 AND seq = $3", [
      alice,
      "tampered",
      2,
    ]);

    const aliceResult = await checkIntegrity(db, alice);
    assert.equal(aliceResult.intact, false, "Alice's chain is broken by the tamper");
    assert.equal(aliceResult.brokenSeq, 2, "and her first broken entry is seq 2");

    const bobResult = await checkIntegrity(db, bob);
    assert.equal(bobResult.intact, true, "Bob's chain is unaffected — the check is scoped to the user");
    assert.equal(bobResult.checked, 3, "Bob's three entries are examined");
    assert.ok(bobResult.brokenSeq == null, "and none of Bob's entries are reported broken");
  } finally {
    await db.close();
  }
});

test("checkIntegrity binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const userId = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

  const result = await checkIntegrity(db, userId);
  assert.equal(result.intact, true, "the recording db returns no rows → a vacuously sound chain");

  assert.ok(db.calls.length >= 1, "the check issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(userId)), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userId), "the id is bound, never concatenated into the SQL");
  }

  // An id that is not even a uuid (an injection probe) matches no entries — it is turned
  // away before any query, so it can reach neither the SQL text nor a uuid cast (OBS-049).
  const probeDb = recordingDb();
  const probe = "p'; DROP TABLE activity_entries; --";
  assert.deepEqual(await checkIntegrity(probeDb, probe), { intact: true, checked: 0, brokenSeq: null });
  for (const call of probeDb.calls) {
    assert.ok(!call.text.includes(probe), "the probe is never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

// ===================================================================================
// AC4 — a boundary handler validates external input (rejects malformed/oversized/mis-shaped
// with a 4xx before any query), checks under the SESSION user id, and binds every value. The
// handler below is a TEST FIXTURE that exercises the modules — not an implementation file.
// ===================================================================================

// Validate the body at the boundary, then run the integrity check under the SESSION user id
// (never a body value). A rejection maps to a 4xx Response and never reaches the check/db.
function createIntegrityHandler(
  db: Db,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  const schema = z.object({ reason: z.string().min(1).max(200).optional() });
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const result = await checkIntegrity(db, sessionUserId);
      return new Response(JSON.stringify({ intact: result.intact, brokenSeq: result.brokenSeq }), {
        status: 200,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // Surface an uncontrolled 500 rather than masking it as success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function postJson(body: string): Request {
  return new Request("https://warthog.com.au/api/activity/integrity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the integrity handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createIntegrityHandler(db, "u");

  const res = await handler(postJson("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the integrity handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createIntegrityHandler(db, "u");

  // ~20 KiB body, well over the handler's 8 KiB cap: rejected by size before parsing.
  const huge = JSON.stringify({ reason: "x".repeat(20 * 1024) });
  const res = await handler(postJson(huge));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the integrity handler rejects a mis-shaped field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createIntegrityHandler(db, "u");

  // reason must be a string when present — a number is a schema violation.
  const res = await handler(postJson(JSON.stringify({ reason: 12345 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped field must never reach a query");
});

// Session user ids are uuids (users.id); the check turns anything else away before a query.
const SESSION_USER = "0b9d6c2a-1e3f-4a5b-9c8d-7e6f5a4b3c2d";
const BODY_USER = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

test("a well-formed request runs the check and returns 200", async () => {
  const db = recordingDb();
  const handler = createIntegrityHandler(db, SESSION_USER);

  const res = await handler(postJson(JSON.stringify({ reason: "daily job" })));

  assert.equal(res.status, 200, "a well-formed request succeeds");
  const body = (await res.json()) as { intact: boolean; brokenSeq: number | null };
  assert.equal(body.intact, true, "the empty recording db is a vacuously sound chain");
  assert.ok(db.calls.length >= 1, "a well-formed request reaches the query layer");
});

test("the integrity handler checks the session user, never a body-supplied id", async () => {
  const db = recordingDb();
  const handler = createIntegrityHandler(db, SESSION_USER);

  // The body smuggles a victim's user id; the handler must ignore it and use the session's.
  const res = await handler(postJson(JSON.stringify({ userId: BODY_USER, reason: "x" })));

  assert.equal(res.status, 200, `expected a 2xx, got ${res.status}`);
  assert.ok(
    db.calls.some((c) => c.values.includes(SESSION_USER)),
    "the query is scoped to the session user id",
  );
  assert.ok(
    !db.calls.some((c) => c.values.includes(BODY_USER)),
    "the body-supplied id never reaches the query",
  );
});

test("a SQL-injection probe as the user id matches no entries and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    await buildChain(db, userId, freshDek(), 2);

    const probe = "robert'); DROP TABLE activity_entries; --";
    const result = await checkIntegrity(db, probe);
    assert.equal(result.intact, true, "no entries match the probe id → vacuously intact");
    assert.equal(result.checked, 0, "no entries were examined for a non-matching id");

    assert.equal(
      await tableExists(db, "activity_entries"),
      true,
      "the activity_entries table survives (the probe was a bound value, not run as SQL)",
    );

    // The real user's chain is untouched and still verifies.
    const mine = await checkIntegrity(db, userId);
    assert.equal(mine.intact, true, "the genuine user's chain is unaffected");
    assert.equal(mine.checked, 2, "and both of its entries are examined");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC5 — the check holds no key and reads no process.env: no secret value is folded in.
// ===================================================================================

test("checkIntegrity reads no process.env: a decoy env secret never appears in its result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "env-check");
    await buildChain(db, userId, freshDek(), 2);
    // Tamper one entry so the check returns a non-trivial result to inspect.
    await db.query("UPDATE activity_entries SET kind = $2 WHERE user_id = $1 AND seq = $3", [
      userId,
      "tampered",
      1,
    ]);

    const result = await checkIntegrity(db, userId);
    assert.equal(result.intact, false, "the check works purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(result).includes(DECOY),
      "no ambient env value is folded into the integrity result",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===================================================================================
// The per-user check uses the (user_id, seq) index and reads the chain in bounded batches
// (review finding: `WHERE user_id::text = $1` defeated the primary key, so every check — once
// per account in the daily sweep, and on the Activity page's verify — scanned the WHOLE table
// and held the person's entire chain, ciphertext included, in memory at once).
// ===================================================================================

// A db seam over a real database that records every SELECT the check issues against
// activity_entries, so a test can EXPLAIN exactly those statements.
function capturingDb(inner: Db): Db & { readonly reads: { text: string; values: unknown[] }[] } {
  const reads: { text: string; values: unknown[] }[] = [];
  return {
    reads,
    async query(text: string, values: unknown[] = []) {
      if (/FROM\s+activity_entries/i.test(text)) reads.push({ text, values });
      return inner.query(text, values);
    },
    close: () => inner.close(),
  };
}

test("the integrity check reads a person's chain through the (user_id, seq) index, never a table scan", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "index-use");
    await buildChain(db, userId, freshDek(), 3);
    const capturing = capturingDb(db);
    assert.equal((await checkIntegrity(capturing, userId)).intact, true);
    assert.ok(capturing.reads.length >= 1, "the check read the chain");

    // With sequential scans priced out, a predicate the index can serve plans an index scan;
    // one it cannot (a cast on user_id) still has to fall back to a Seq Scan.
    await db.query("SET enable_seqscan = off");
    for (const read of capturing.reads) {
      const plan = await db.query(`EXPLAIN ${read.text}`, read.values);
      const text = plan.rows.map((r) => String(Object.values(r)[0])).join("\n");
      assert.doesNotMatch(text, /Seq Scan on activity_entries/, `the chain read uses the index:\n${text}`);
    }
  } finally {
    await db.close();
  }
});

test("the integrity check reads a long chain in bounded batches and still verifies it end to end", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "batched");
    const { INTEGRITY_BATCH_SIZE } = await import("./integrity");
    const n = INTEGRITY_BATCH_SIZE * 2 + 3;
    // Seed a long valid chain quickly through the writer's own digest.
    const { computeEntryHash, GENESIS_PREV_HASH } = await import("./writer");
    let prev = GENESIS_PREV_HASH;
    for (let seq = 1; seq <= n; seq += 1) {
      const occurredAt = T0.toISOString();
      const fields = {
        user_id: userId, seq, occurred_at: occurredAt, kind: "tool_call", source: "warthog",
        agent_id: null, connector_id: null, tool: null, outcome: null, amount: null, currency: null,
        merchant: null, payload_ct: `v1:${seq}`,
      };
      const hash = computeEntryHash(prev, fields);
      await db.query(
        `INSERT INTO activity_entries (user_id, seq, occurred_at, kind, source, payload_ct, prev_hash, entry_hash)
         VALUES ($1, $2, $3, 'tool_call', 'warthog', $4, $5, $6)`,
        [userId, seq, occurredAt, `v1:${seq}`, prev, hash],
      );
      prev = hash;
    }

    const capturing = capturingDb(db);
    assert.deepEqual(await checkIntegrity(capturing, userId), { intact: true, checked: n, brokenSeq: null });
    assert.ok(capturing.reads.length >= 3, "the chain was read in several bounded batches");

    // A break in the LAST batch is still found, with the right seq (the hash carries over
    // from one batch to the next).
    await db.query("UPDATE activity_entries SET kind = 'tampered' WHERE user_id = $1 AND seq = $2", [userId, n - 1]);
    assert.deepEqual(await checkIntegrity(db, userId), { intact: false, checked: n - 1, brokenSeq: n - 1 });
  } finally {
    await db.close();
  }
});
