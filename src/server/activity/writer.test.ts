// E08-S01 — DB-backed activity writer and append-only role
// (`src/server/activity/writer.ts`, `db/migrations/0016_activity.sql`).
//
// RED-first: neither the writer module nor the migration exists yet, so importing
// `./writer` throws and `freshDb()` has no `activity_entries` table — every test
// here fails until the builder adds them. That absence IS the point of test-first;
// do NOT implement anything to make these pass — the builder writes the module and
// the migration afterwards.
//
// These tests pin BEHAVIOUR (what the writer DOES: a row is inserted with a
// contiguous per-user seq and a prev_hash chained to the previous entry_hash, the
// payload is redacted then DEK-encrypted at rest and reads back decrypted, the DB
// role cannot UPDATE or DELETE an entry, a handler rejects bad input and binds
// probes, and no env secret lands in a row), never the source text of the module or
// the SQL file — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (design §9, constitution principle 14 "Warthog writes the record"):
// the real activity record is append-only and hash-chained over CIPHERTEXT, so no
// code path updates or deletes an entry except the account-purge job. Before this
// task an in-memory recorder (`./recorder`, E07-S02) served tests and local dev; this
// task adds the Postgres-backed `ActivityRecorder` that persists each entry: it runs
// the payload through redaction (`../../domain/redaction/redact`, design §4.3) BEFORE
// encrypting it with the person's data key (`../crypto/envelope`, design §4.1), assigns
// a contiguous per-user `seq`, chains `prev_hash` to the previous entry's `entry_hash`,
// and inserts the row. The application DB role has INSERT and SELECT only on
// `activity_entries` — UPDATE and DELETE are revoked (design §9).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the builder implements exactly this).
//
// The DB writer is a drop-in `ActivityRecorder` (the ONE contract the agent pipeline
// and every write-through depend on), reusing the EXISTING shapes from `./recorder`
// (constitution: one-source-of-truth):
//   interface ActivityEntryInput { userId; kind; source: "warthog"|"agent_reported";
//       agentId?; connectorId?; tool?; outcome?; merchant?; payload?: unknown }
//   interface ActivityEntry { userId; seq; occurredAt; kind; source; agentId?;
//       connectorId?; tool?; outcome?; merchant?; payload; prevHash; entryHash }
//       // `payload` is the REDACTED payload (card masked, secret fields [redacted], …)
//   interface ActivityRecorder { record(input): Promise<ActivityEntry> }
//
//   createDbRecorder(options: {
//     db: Db;                       // the parameterizing db seam (INV-102)
//     clock: Clock;                 // supplies occurred_at (never Date.now())
//     dekFor: (userId: string) => Promise<Uint8Array>;   // the person's unwrapped DEK
//     matchesReleased?: (userId: string, normalisedToken: string) => boolean;
//   }): ActivityRecorder
//     • record(input): redacts input.payload with the per-user matcher, DEK-encrypts the
//       redacted payload, assigns a contiguous per-user seq (1, 2, 3, …), sets prev_hash
//       to the previous entry_hash of that user (a genesis sentinel for the first), inserts
//       the row, and returns the stored ActivityEntry (its payload the REDACTED plaintext).
//       `record()` resolves the DEK internally via `dekFor` because the one-arg recorder
//       contract can serve many users. The module reads no `process.env` and holds no key
//       (INV-103): clock, dekFor and matchesReleased are all INJECTED.
//
//   readActivity(db: Db, userId: string, dek: Uint8Array): Promise<ActivityEntry[]>
//     • the person's entries in ascending seq order, each payload DECRYPTED under `dek`.
//       Member-scoped: the user id is bound (the session's id, never a client value), so
//       one person never reads another's entries. (A direct `dek` — not `dekFor` — because
//       the user is already a parameter here, exactly as `listRules(db, userId, dek)`.)
//
// Acceptance criteria → tests:
//   AC1 "Recording inserts a row with a contiguous per-user seq and prev_hash equal to the
//        previous entry_hash, payload stored DEK-encrypted." — seqs are 1..N contiguous per
//        user; each prev_hash is the previous entry_hash; two users interleaved keep
//        independent chains from the same genesis; the stored payload is a `v1:` envelope and
//        reads back decrypted; occurred_at comes from the injected clock.
//   AC2 "Redaction runs before encryption so a card number or released value never reaches the
//        stored ciphertext in clear." — a card, a secret-named field and a per-user released
//        value in the payload are masked; decrypting the stored payload yields exactly
//        redact(payload, matcher); the raw card / secret / released token appear in NO stored
//        cell in clear.
//   AC3 "The app DB role has no UPDATE or DELETE on activity_entries (an UPDATE attempt is
//        rejected)." — the migration grants an app role SELECT+INSERT only; acting AS that
//        role a SELECT succeeds but an UPDATE and a DELETE are both rejected (permission denied).
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a fixture handler on the
//        `../http/validate` boundary rejects malformed/oversized input with a 4xx BEFORE any
//        query runs and records only under the SESSION user id; a SQL-injection probe in an
//        input field travels as a BOUND value (placeholders, never concatenation), is stored as
//        inert data, and cannot drop the table. The handler is a test fixture, not implementation.
//   AC5 [obligation:secrets-from-env] (INV-103) — the payload is encrypted under the INJECTED
//        DEK, not a baked-in secret: a different DEK cannot read it back; and the writer reads no
//        `process.env` and holds no key, so a decoy secret in the environment never lands in a row.
//   Ownership — a second signed-in person never reads another's entries (member-scoped by the
//        session user id).
//   Migration — `activity_entries` exists after the project migrations and a second run of every
//        migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests share
// no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createDbRecorder, readActivity } from "./writer";
import type { ActivityEntry, ActivityRecorder } from "./recorder";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "../db/index";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import { redact } from "../../domain/redaction/redact";

// --- fixtures ----------------------------------------------------------------------

// A fixed instant so occurred_at is deterministic across a run.
const T0 = new Date("2026-01-01T00:00:00.000Z");

// The classic Luhn-valid test card (redaction masks it, revealing only the last four).
const CARD = "4242424242424242";

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a
// layer up; the writer only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this flow never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id — the
// activity entry's user_id). Using a real user keeps a user_id foreign key, if present,
// satisfied.
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A DEK provider over a fixed map of user → key (the record() contract resolves the DEK
// per user internally). A one-user recorder is the common case: `dekProvider({ [id]: dek })`.
function dekProvider(byUser: Record<string, Uint8Array>): (userId: string) => Promise<Uint8Array> {
  return async (userId: string) => {
    const dek = byUser[userId];
    if (!dek) throw new Error(`no DEK for ${userId}`);
    return dek;
  };
}

// A single-user recorder helper: wires db + a frozen clock + one person's DEK.
function recorderFor(
  db: Db,
  userId: string,
  dek: Uint8Array,
  matchesReleased?: (userId: string, normalisedToken: string) => boolean,
): ActivityRecorder {
  return createDbRecorder({
    db,
    clock: fixedClock(T0),
    dekFor: dekProvider({ [userId]: dek }),
    matchesReleased,
  });
}

// A compact way to scan a (redacted) payload for a substring without assuming its shape
// — scoped to the one payload under test, never a whole-output check.
function json(payload: unknown): string {
  return JSON.stringify(payload);
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). A read returns no
// rows (so the writer treats the chain as fresh); an `INSERT … RETURNING` answers with the
// inserted row's seq, as a real database does when the insert lands (the writer treats an
// empty RETURNING as a lost race and retries). It satisfies the `Db` shape structurally.
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      const inserted = /^\s*INSERT\b[\s\S]*\bRETURNING\b/i.test(text);
      return Promise.resolve({ rows: (inserted ? [{ seq: values[1] }] : []) as Record<string, unknown>[] });
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

// Every raw cell of the one table under test, as the writer actually stored it — used to
// prove plaintext never leaked and the payload is an envelope. Scoped to activity_entries
// alone; the same value may legitimately live (encrypted) elsewhere.
async function allCells(db: Db, userId: string): Promise<unknown[]> {
  const result = await db.query("SELECT * FROM activity_entries WHERE user_id = $1", [userId]);
  const cells: unknown[] = [];
  for (const row of result.rows) for (const cell of Object.values(row)) cells.push(cell);
  return cells;
}

// Discover the application role by its GRANT SHAPE, name-agnostic: the grantee on
// activity_entries that holds SELECT and INSERT but neither UPDATE nor DELETE (the table
// owner holds all four, so it is excluded). This pins the design's "INSERT and SELECT only"
// as a property of the grants, not a hard-coded role name.
async function appRoleFor(db: Db, table: string): Promise<string | null> {
  const result = await db.query(
    `SELECT grantee
       FROM information_schema.role_table_grants
      WHERE table_name = $1
      GROUP BY grantee
     HAVING bool_or(privilege_type = 'SELECT')
        AND bool_or(privilege_type = 'INSERT')
        AND NOT bool_or(privilege_type = 'UPDATE')
        AND NOT bool_or(privilege_type = 'DELETE')`,
    [table],
  );
  const grantee = result.rows[0]?.grantee;
  return typeof grantee === "string" ? grantee : null;
}

// ===================================================================================
// AC1 — a contiguous per-user seq, prev_hash chaining, and a payload DEK-encrypted at
// rest that reads back decrypted.
// ===================================================================================

test("record inserts rows with a contiguous per-user seq and prev_hash chained to the previous entry_hash", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-chain");
    const recorder = recorderFor(db, userId, freshDek());

    const e1 = await recorder.record({ userId, kind: "tool_call", source: "warthog", payload: { n: 1 } });
    const e2 = await recorder.record({ userId, kind: "tool_call", source: "warthog", payload: { n: 2 } });
    const e3 = await recorder.record({ userId, kind: "tool_call", source: "warthog", payload: { n: 3 } });

    // Contiguous per-user seq.
    assert.equal(typeof e1.seq, "number", "seq is a number");
    assert.equal(e2.seq, e1.seq + 1, "seq is contiguous (increments by one)");
    assert.equal(e3.seq, e2.seq + 1, "seq stays contiguous for the next entry");

    // The first entry starts a fresh chain: its prev_hash is a sentinel, not a real hash.
    assert.equal(typeof e1.prevHash, "string", "prev_hash is a string");
    assert.ok(e1.prevHash.length > 0, "the genesis prev_hash is non-empty");
    assert.notEqual(e1.prevHash, e1.entryHash, "the genesis prev_hash is not a real entry hash");

    // Each later entry's prev_hash is exactly the previous entry's entry_hash.
    assert.equal(e2.prevHash, e1.entryHash, "entry 2 chains to entry 1's hash");
    assert.equal(e3.prevHash, e2.entryHash, "entry 3 chains to entry 2's hash");
    assert.notEqual(e1.entryHash, e2.entryHash, "different entries hash differently");
    assert.notEqual(e2.entryHash, e3.entryHash, "and so do the next two");
  } finally {
    await db.close();
  }
});

test("the persisted chain and payloads read back under the writing DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-readback");
    const dek = freshDek();
    const recorder = recorderFor(db, userId, dek);

    await recorder.record({ userId, kind: "tool_call", source: "warthog", payload: { n: 1 } });
    await recorder.record({ userId, kind: "tool_call", source: "warthog", payload: { n: 2 } });

    const stored = await readActivity(db, userId, dek);
    assert.equal(stored.length, 2, "both entries persisted");
    assert.deepEqual(stored[0].payload, { n: 1 }, "the first payload reads back decrypted");
    assert.deepEqual(stored[1].payload, { n: 2 }, "the second payload reads back decrypted");
    assert.equal(stored[1].prevHash, stored[0].entryHash, "the persisted chain links the two entries");
    assert.equal(stored[1].seq, stored[0].seq + 1, "the persisted seq is contiguous");
  } finally {
    await db.close();
  }
});

test("each user has an independent chain — interleaved records never cross users", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1-alice");
    const bob = await makeUser(db, "ac1-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const recorder = createDbRecorder({
      db,
      clock: fixedClock(T0),
      dekFor: dekProvider({ [alice]: dekA, [bob]: dekB }),
    });

    const a1 = await recorder.record({ userId: alice, kind: "k", source: "warthog", payload: { a: 1 } });
    const b1 = await recorder.record({ userId: bob, kind: "k", source: "warthog", payload: { b: 1 } });
    const a2 = await recorder.record({ userId: alice, kind: "k", source: "warthog", payload: { a: 2 } });
    const b2 = await recorder.record({ userId: bob, kind: "k", source: "warthog", payload: { b: 2 } });

    // Each user's seq is contiguous on its own, unaffected by the other's interleaved write.
    assert.equal(a2.seq, a1.seq + 1, "Alice's seq is contiguous despite Bob's interleaved write");
    assert.equal(b2.seq, b1.seq + 1, "Bob's seq is contiguous despite Alice's interleaved write");
    assert.equal(b1.seq, a1.seq, "each user's chain starts at the same base seq (fresh per user)");

    // Each entry chains to its OWN user's previous entry, never the other user's.
    assert.equal(a2.prevHash, a1.entryHash, "A2 chains to A1, not to B1");
    assert.equal(b2.prevHash, b1.entryHash, "B2 chains to B1, not to A2");

    // Bob's first entry starts fresh from the genesis, identical to Alice's starting point.
    assert.equal(a1.prevHash, b1.prevHash, "both users' chains start from the same fresh genesis");
    assert.notEqual(b1.prevHash, a1.entryHash, "Bob's chain does not continue Alice's chain");
  } finally {
    await db.close();
  }
});

test("record stores the payload DEK-encrypted: a v1 envelope at rest, decrypted on read", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-enc");
    const dek = freshDek();
    const recorder = recorderFor(db, userId, dek);

    const UNIQUE = "payloadSecretABC123";
    await recorder.record({ userId, kind: "memory_write", source: "warthog", payload: { note: UNIQUE } });

    // At rest: the readable payload text is gone and a `v1:` envelope (the versioned
    // AES-256-GCM form, design §4.1) is what was actually stored.
    const cells = await allCells(db, userId);
    const strings = cells.filter((c): c is string => typeof c === "string");
    assert.ok(
      !strings.some((c) => c.includes(UNIQUE)),
      "the readable payload value must never be written to a column in clear",
    );
    assert.ok(
      strings.some((c) => c.startsWith("v1:")),
      "the payload is stored as a v1: DEK envelope (ciphertext), not readable JSON",
    );

    // On read, the owner's DEK decrypts it back verbatim.
    const [entry] = await readActivity(db, userId, dek);
    assert.deepEqual(entry.payload, { note: UNIQUE }, "the payload decrypts back verbatim under the owner's DEK");
  } finally {
    await db.close();
  }
});

test("record takes occurred_at from the injected clock, not the wall clock", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-clock");
    const dek = freshDek();
    const recorder = recorderFor(db, userId, dek);

    const e = await recorder.record({ userId, kind: "k", source: "warthog", payload: {} });
    assert.equal(
      new Date(e.occurredAt).getTime(),
      T0.getTime(),
      "occurred_at comes from the injected clock",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — redaction runs BEFORE encryption, so a card / secret field / released value
// never reaches the stored ciphertext in clear.
// ===================================================================================

test("record redacts the payload (card, secret field, released value) before encrypting; nothing leaks in clear", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-redact");
    const dek = freshDek();
    // A matcher that reports one normalised token as released for THIS user.
    const RELEASED = "swordfishxyz"; // lowercase alnum, so normaliseValue(token) === token
    const matchesReleased = (u: string, token: string): boolean => u === userId && token === RELEASED;
    const recorder = recorderFor(db, userId, dek, matchesReleased);

    // A fresh copy each read so the oracle can never observe mutation by record().
    const payloadFor = () => ({
      params: { body: `pay ${CARD} now`, token: "superseKRETvalue" },
      note: RELEASED,
    });

    await recorder.record({ userId, kind: "tool_call", source: "agent_reported", payload: payloadFor() });

    // Decrypting the stored payload yields EXACTLY the redaction module's output — which it
    // can only do if redaction ran BEFORE encryption (otherwise the raw card would decrypt back).
    const expected = redact(payloadFor(), (token) => matchesReleased(userId, token));
    const [entry] = await readActivity(db, userId, dek);
    assert.deepEqual(
      entry.payload,
      expected,
      "the stored payload is redact(payload, per-user matcher): card masked, secret [redacted], released value masked",
    );
    // Sanity: the redacted form really is masked (not the raw values).
    const text = json(entry.payload);
    assert.ok(!text.includes(CARD), "the full card number is not in the stored (decrypted) payload");
    assert.ok(text.includes("[card "), "the card is stored masked");
    assert.ok(text.includes("[redacted]"), "the secret-named field is stored [redacted]");
    assert.ok(text.includes("[released value]"), "the released value is masked");
    assert.ok(!text.includes(RELEASED), "the released token itself is not in the payload");
    assert.ok(!text.includes("superseKRETvalue"), "the secret field value itself is not in the payload");

    // And in NO raw stored cell does any of those appear in clear (they live only inside the
    // ciphertext). Scoped to activity_entries alone.
    const strings = (await allCells(db, userId)).filter((c): c is string => typeof c === "string");
    for (const cell of strings) {
      assert.ok(!cell.includes(CARD), "the raw card number must not appear in any stored cell");
      assert.ok(!cell.includes("superseKRETvalue"), "the raw secret value must not appear in any stored cell");
      assert.ok(!cell.includes(RELEASED), "the raw released value must not appear in any stored cell");
    }
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3 — the application DB role is append-only on activity_entries: INSERT and SELECT
// only, UPDATE and DELETE rejected.
// ===================================================================================

test("the app DB role has INSERT and SELECT but no UPDATE or DELETE on activity_entries", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac3-role");
    const dek = freshDek();
    // Write one real entry (as the superuser test connection) so there is a row to target.
    await recorderFor(db, userId, dek).record({ userId, kind: "k", source: "warthog", payload: { a: 1 } });

    const appRole = await appRoleFor(db, "activity_entries");
    assert.ok(
      appRole,
      "the migration must grant an application role SELECT+INSERT (and nothing else) on activity_entries",
    );
    // A conservative identifier so it is safe to interpolate into SET ROLE (role names come
    // from the migration, never user input; validated to be sure).
    assert.match(appRole!, /^[A-Za-z_][A-Za-z0-9_$]*$/, "the app role is a plain SQL identifier");

    // The grants themselves: SELECT + INSERT yes, UPDATE + DELETE no.
    const priv = await db.query(
      `SELECT has_table_privilege($1, 'activity_entries', 'SELECT') AS s,
              has_table_privilege($1, 'activity_entries', 'INSERT') AS i,
              has_table_privilege($1, 'activity_entries', 'UPDATE') AS u,
              has_table_privilege($1, 'activity_entries', 'DELETE') AS d`,
      [appRole],
    );
    assert.equal(priv.rows[0]?.s, true, "the app role may SELECT");
    assert.equal(priv.rows[0]?.i, true, "the app role may INSERT (append)");
    assert.equal(priv.rows[0]?.u, false, "the app role may NOT UPDATE");
    assert.equal(priv.rows[0]?.d, false, "the app role may NOT DELETE");

    // Enforcement: acting AS the app role, a SELECT works but UPDATE and DELETE are rejected.
    await db.query(`SET ROLE "${appRole}"`);
    try {
      const seen = await db.query("SELECT count(*)::int AS n FROM activity_entries");
      assert.ok(Number(seen.rows[0]?.n) >= 1, "the app role can read entries");

      await assert.rejects(
        () => db.query("UPDATE activity_entries SET outcome = 'tampered' WHERE user_id = $1", [userId]),
        /permission denied/i,
        "an UPDATE by the app role must be rejected (append-only)",
      );
      await assert.rejects(
        () => db.query("DELETE FROM activity_entries WHERE user_id = $1", [userId]),
        /permission denied/i,
        "a DELETE by the app role must be rejected (append-only)",
      );
    } finally {
      await db.query("RESET ROLE");
    }
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC4 — a handler validates external input at the boundary (rejects malformed/oversized
// with a 4xx before any write), records under the session user id, and binds probes. The
// handler below is a TEST FIXTURE that exercises the modules — not an implementation file.
// ===================================================================================

// Validate the body at the boundary, then record under the SESSION user id (never a body
// value) as an agent-reported entry. A rejection maps to a 4xx Response and never reaches
// the recorder/db.
function createLogActivityHandler(
  recorder: ActivityRecorder,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  const schema = z.object({
    kind: z.string().min(1).max(64),
    payload: z.unknown().optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const entry = await recorder.record({
        userId: sessionUserId,
        kind: body.kind,
        source: "agent_reported",
        payload: body.payload ?? {},
      });
      return new Response(JSON.stringify({ seq: entry.seq }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const recorder = createDbRecorder({ db, clock: fixedClock(T0), dekFor: dekProvider({ u: freshDek() }) });
  const handler = createLogActivityHandler(recorder, "u");

  const res = await handler(postJson("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const recorder = createDbRecorder({ db, clock: fixedClock(T0), dekFor: dekProvider({ u: freshDek() }) });
  const handler = createLogActivityHandler(recorder, "u");

  // ~20 KiB body, well over the handler's 8 KiB cap: rejected by size before parsing.
  const huge = JSON.stringify({ kind: "tool_call", payload: { blob: "x".repeat(20 * 1024) } });
  const res = await handler(postJson(huge));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a mis-shaped field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const recorder = createDbRecorder({ db, clock: fixedClock(T0), dekFor: dekProvider({ u: freshDek() }) });
  const handler = createLogActivityHandler(recorder, "u");

  // kind must be a non-empty string ≤ 64 chars — a number is a schema violation.
  const res = await handler(postJson(JSON.stringify({ kind: 12345, payload: { ok: true } })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped field must never reach a query");
});

test("the handler records under the session user id, never a body-supplied one", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const recorder = createDbRecorder({
      db,
      clock: fixedClock(T0),
      dekFor: dekProvider({ [sessionUser]: dek, [attacker]: dek }),
    });
    const handler = createLogActivityHandler(recorder, sessionUser);

    // The body smuggles a victim's user id; the handler must ignore it and use the session's.
    const res = await handler(
      postJson(JSON.stringify({ kind: "tool_call", userId: attacker, payload: { note: "hi" } })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.ok((await readActivity(db, sessionUser, dek)).length >= 1, "the entry is written under the SESSION user");
    assert.deepEqual(
      await readActivity(db, attacker, dek),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("record binds its metadata as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'; DROP TABLE activity_entries; --";
  const recorder = createDbRecorder({ db, clock: fixedClock(T0), dekFor: dekProvider({ u: freshDek() }) });

  await recorder.record({ userId: "u", kind: probe, source: "warthog", merchant: probe, payload: { ok: true } });

  assert.ok(db.calls.length >= 1, "recording issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in a field is stored as data: the table survives and round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const recorder = recorderFor(db, userId, dek);
    const probe = "robert'); DROP TABLE activity_entries; --";

    await recorder.record({
      userId,
      kind: "tool_call",
      source: "warthog",
      merchant: probe,
      payload: { note: probe },
    });

    assert.equal(
      await tableExists(db, "activity_entries"),
      true,
      "the activity_entries table must still exist (the probe was stored as data, not run as SQL)",
    );

    const [entry] = await readActivity(db, userId, dek);
    assert.ok(entry, "the entry with the probe is read back");
    assert.equal(entry.merchant, probe, "the plaintext merchant probe round-trips verbatim as data");
    assert.deepEqual(entry.payload, { note: probe }, "the payload probe round-trips verbatim (decrypted) as data");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC5 — the payload is encrypted under the INJECTED DEK, not a baked-in key; and the
// writer reads no process.env, so no decoy env secret lands in a row.
// ===================================================================================

test("readActivity cannot decrypt a payload with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    await recorderFor(db, userId, dek).record({
      userId,
      kind: "k",
      source: "warthog",
      payload: { note: "bound-to-this-persons-dek" },
    });

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await readActivity(db, userId, wrongDek);
      },
      "the payload is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the writer reads no process.env: a decoy secret in the environment never lands in a row", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-env");
    const dek = freshDek();
    const recorder = recorderFor(db, userId, dek);

    const entry = await recorder.record({ userId, kind: "k", source: "warthog", payload: { note: "env-check" } });
    assert.ok(entry.seq >= 1, "the entry writes purely from the injected db/clock/dek — no app env needed");

    const read = await readActivity(db, userId, dek);
    assert.ok(!json(read).includes(DECOY), "no ambient env value is folded into a returned entry");

    const strings = (await allCells(db, userId)).filter((c): c is string => typeof c === "string");
    for (const cell of strings) {
      assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===================================================================================
// Ownership — a second signed-in person can never read another's entries. The user id
// is bound from the session, never the client.
// ===================================================================================

test("readActivity never returns another user's entries", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const recorder = createDbRecorder({
      db,
      clock: fixedClock(T0),
      dekFor: dekProvider({ [alice]: dekA, [bob]: dekB }),
    });

    await recorder.record({ userId: alice, kind: "k", source: "warthog", payload: { who: "alice" } });

    assert.equal((await readActivity(db, alice, dekA)).length, 1, "Alice reads her own entry");
    assert.deepEqual(await readActivity(db, bob, dekB), [], "Bob's read never includes Alice's entries");
  } finally {
    await db.close();
  }
});

test("readActivity binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'; DROP TABLE activity_entries; --";

  const result = await readActivity(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the read is empty");

  assert.ok(db.calls.length >= 1, "the read issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

// ===================================================================================
// Migration — the table applies and a second run of every migration changes nothing.
// ===================================================================================

test("the activity migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "activity_entries"),
      true,
      "the activity_entries table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0016_activity"),
      "db/migrations/0016_activity.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0016's CREATE/CREATE ROLE would throw, so an empty result AND no throw together prove the
    // second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Concurrency — parallel appends for ONE person never collide on (user_id, seq).
//
// WHY (review finding "concurrent activity writes collide on (user_id, seq)"): MCP clients
// issue parallel tool calls, and the pipeline runs the tool BEFORE it records. The append
// used to read the chain head, await the DEK and the encryption, then insert head+1 with no
// lock or retry, so every call that lost the race had already run its side effect, then
// failed with a duplicate-key error: the audit entry was lost and the agent was told the
// call failed (and retried it). Every parallel append must now land, contiguous and chained.
// ===================================================================================

// A db seam over a real database whose every query resolves on a LATER macrotask, the way
// a pooled network connection does, so concurrent callers genuinely interleave between the
// head read and the insert (an in-process PGlite otherwise answers in lock-step).
function laggyDb(inner: Db): Db {
  return {
    async query(text, values) {
      const result = await inner.query(text, values);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return result;
    },
    close: () => inner.close(),
  };
}

test("parallel record() calls for one person all land with seq 1..N, chained, and the chain verifies", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "race-parallel");
    const dek = freshDek();
    // Two recorder instances over the same handle (the pipeline's and a portal write's):
    // serialisation must hold across instances, not only within one.
    const a = recorderFor(laggyDb(db), userId, dek);
    const b = recorderFor(laggyDb(db), userId, dek);

    const N = 20;
    const settled = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        (i % 2 === 0 ? a : b).record({ userId, kind: "tool_call", source: "warthog", payload: { n: i } }),
      ),
    );
    const rejected = settled.filter((s) => s.status === "rejected");
    assert.deepEqual(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
      [],
      "no parallel append is rejected",
    );

    const stored = await readActivity(db, userId, dek);
    assert.deepEqual(
      stored.map((e) => e.seq),
      Array.from({ length: N }, (_, i) => i + 1),
      "the stored seqs are exactly 1..N",
    );
    for (let i = 1; i < stored.length; i += 1) {
      assert.equal(stored[i].prevHash, stored[i - 1].entryHash, `entry ${i + 1} chains to entry ${i}`);
    }
    assert.deepEqual(
      stored.map((e) => (e.payload as { n: number }).n).sort((x, y) => x - y),
      Array.from({ length: N }, (_, i) => i),
      "every call's own payload was recorded exactly once and decrypts",
    );

    const { checkIntegrity } = await import("./integrity");
    assert.deepEqual(
      await checkIntegrity(db, userId),
      { intact: true, checked: N, brokenSeq: null },
      "the integrity check verifies the whole chain",
    );
  } finally {
    await db.close();
  }
});

test("an append that loses the race to another writer (another replica) retries on the new head instead of failing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "race-replica");
    const dek = freshDek();
    const { computeEntryHash, GENESIS_PREV_HASH } = await import("./writer");

    // Between this recorder's head read and its insert, a DIFFERENT process (which shares no
    // in-process lock with it) commits a valid entry at the same seq. Simulated by a db seam
    // that slips that competitor row in just before the recorder's first INSERT runs.
    let competitorInserted = false;
    const racing: Db = {
      async query(text, values) {
        if (!competitorInserted && /^\s*INSERT INTO activity_entries/i.test(text)) {
          competitorInserted = true;
          const occurredAt = T0.toISOString();
          const fields = {
            user_id: userId,
            seq: 1,
            occurred_at: occurredAt,
            kind: "tool_call",
            source: "warthog",
            agent_id: null,
            connector_id: null,
            tool: "other-replica",
            outcome: null,
            amount: null,
            currency: null,
            merchant: null,
            payload_ct: "v1:competitor",
          };
          await db.query(
            `INSERT INTO activity_entries
               (user_id, seq, occurred_at, kind, source, tool, payload_ct, prev_hash, entry_hash)
             VALUES ($1, 1, $2, 'tool_call', 'warthog', 'other-replica', 'v1:competitor', $3, $4)`,
            [userId, occurredAt, GENESIS_PREV_HASH, computeEntryHash(GENESIS_PREV_HASH, fields)],
          );
        }
        return db.query(text, values);
      },
      close: () => db.close(),
    };

    const entry = await recorderFor(racing, userId, dek).record({
      userId,
      kind: "tool_call",
      source: "warthog",
      payload: { mine: true },
    });
    assert.equal(competitorInserted, true, "the competing writer won the first seq");
    assert.equal(entry.seq, 2, "the losing append moved to the next seq rather than failing");

    const rows = await db.query(
      "SELECT seq, tool, prev_hash, entry_hash FROM activity_entries WHERE user_id = $1 ORDER BY seq",
      [userId],
    );
    assert.deepEqual(
      rows.rows.map((r) => [Number(r.seq), r.tool ?? null]),
      [
        [1, "other-replica"],
        [2, null],
      ],
      "both entries are stored, the competitor's first",
    );
    assert.equal(rows.rows[1].prev_hash, rows.rows[0].entry_hash, "the retried entry chains to the competitor");

    const { checkIntegrity } = await import("./integrity");
    assert.deepEqual(await checkIntegrity(db, userId), { intact: true, checked: 2, brokenSeq: null });
  } finally {
    await db.close();
  }
});

test("an append inside an open transaction and a concurrent append outside it both commit, contiguous", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "race-in-tx");
    const dek = freshDek();
    const { withTransaction } = await import("../db/index");

    const [inTx, outside] = await Promise.all([
      withTransaction(db, (tx) =>
        recorderFor(tx, userId, dek).record({
          userId,
          kind: "connection_change",
          source: "warthog",
          payload: { in: "tx" },
        }),
      ),
      recorderFor(laggyDb(db), userId, dek).record({
        userId,
        kind: "tool_call",
        source: "warthog",
        payload: { in: "autocommit" },
      }),
    ]);

    assert.deepEqual([inTx.seq, outside.seq].sort(), [1, 2], "both appends committed with distinct seqs");
    const { checkIntegrity } = await import("./integrity");
    assert.deepEqual(await checkIntegrity(db, userId), { intact: true, checked: 2, brokenSeq: null });
  } finally {
    await db.close();
  }
});

test("an entry recorded without a payload is stored (as a null payload) rather than failing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "no-payload");
    const dek = freshDek();
    const entry = await recorderFor(db, userId, dek).record({ userId, kind: "tool_call", source: "warthog" });
    assert.equal(entry.seq, 1);
    const [stored] = await readActivity(db, userId, dek);
    assert.equal(stored.payload, null, "an omitted payload reads back as null");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// The PLAINTEXT metadata an agent can supply is redacted too (review finding: `merchant` —
// free agent text up to 500 characters from request_card — was written to a plaintext,
// hash-chained column verbatim, so an agent or a prompt injection could put a card number
// or a released value there permanently, unencrypted).
// ===================================================================================

test("record redacts a card number or released value in the merchant, kind and tool before storing them", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "meta-redact");
    const dek = freshDek();
    const RELEASED = "swordfishxyz";
    const matchesReleased = (u: string, token: string): boolean => u === userId && token === RELEASED;
    const recorder = recorderFor(db, userId, dek, matchesReleased);

    const entry = await recorder.record({
      userId,
      kind: `note ${CARD}`,
      source: "agent_reported",
      tool: `lookup ${RELEASED}`,
      merchant: `Shop ${CARD} ref ${RELEASED}`,
      payload: { ok: true },
    });

    const perUser = (token: string): boolean => matchesReleased(userId, token);
    assert.equal(entry.merchant, redact(`Shop ${CARD} ref ${RELEASED}`, perUser), "the returned merchant is the redacted one");
    assert.ok(String(entry.merchant).includes("[card "), "the card in the merchant is masked");
    assert.ok(String(entry.merchant).includes("[released value]"), "the released value in the merchant is masked");

    const [stored] = await readActivity(db, userId, dek);
    assert.equal(stored.merchant, entry.merchant, "the stored merchant is the redacted one");
    assert.equal(stored.kind, redact(`note ${CARD}`, perUser), "the stored kind is redacted");
    assert.equal(stored.tool, redact(`lookup ${RELEASED}`, perUser), "the stored tool is redacted");
    for (const cell of (await allCells(db, userId)).filter((c): c is string => typeof c === "string")) {
      assert.ok(!cell.includes(CARD), "no stored cell carries the raw card number");
      assert.ok(!cell.includes(RELEASED), "no stored cell carries the raw released value");
    }

    const { checkIntegrity } = await import("./integrity");
    assert.equal((await checkIntegrity(db, userId)).intact, true, "the chain is computed over the redacted values");
  } finally {
    await db.close();
  }
});
