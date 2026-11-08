// E08-S03 — Activity disputes (append-only). Target modules:
//   • db/migrations/0017_activity_disputes.sql  (the `activity_disputes` table)
//   • src/server/activity/disputes.ts           (the dispute repo)
//
// RED-first: neither the `./disputes` module nor the 0017 migration exists yet, so
// importing `createDisputeRepo` throws (ERR_MODULE_NOT_FOUND) and this whole suite
// fails to load. That absence IS the point of test-first — do NOT implement anything
// to make these pass; the builder writes `disputes.ts` and the migration afterwards.
// The sound activity chains these tests dispute against are produced by the REAL
// writer (`./writer`, E08-S01) through the REAL migrations, so a correct repo attaches
// a dispute WITHOUT disturbing that chain.
//
// These tests pin BEHAVIOUR (what the repo RETURNS, what is left in the database, and
// what a boundary handler does with bad input), never the source text of a module — a
// later rename that preserves behaviour must not redden them.
//
// WHY this exists: a person can dispute an activity entry. The activity record is
// APPEND-ONLY and hash-chained over ciphertext, so the original entry is NEVER changed;
// the dispute is added ALONGSIDE it, as its own DEK-encrypted row referencing the entry
// (design §9, constitution principle 14 "Warthog writes the record").
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the builder implements exactly this).
//
//   interface FileDisputeInput {
//     userId: string;    // the person filing it — the SESSION user id, the member scope
//     entrySeq: number;  // the disputed entry's `seq` within THAT user's activity chain
//     note: string;      // the dispute note (plaintext in; stored DEK-encrypted)
//   }
//
//   interface FiledDispute {
//     userId: string;    // echoes the filer (member scope)
//     entrySeq: number;  // the disputed entry's seq
//     createdAt: string; // ISO-8601, from the INJECTED clock
//     note: string;      // the note, in plaintext (decrypted on read)
//     // the builder MAY carry more (an id, a per-entry dispute seq); tests never
//     // require it.
//   }
//
//   createDisputeRepo(options: {
//     db: Db;
//     clock: Clock;
//     dekFor: (userId: string) => Promise<Uint8Array>;  // per-user DEK, resolved inside
//   }): {
//     // Attach a dispute to one of the FILER'S OWN entries. The entry is identified by
//     // (options-less) the caller's userId + entrySeq — an entry the caller does not own
//     // (no such row for that userId) is rejected; the referenced entry row is never
//     // altered. The note is DEK-encrypted before it is stored.
//     fileDispute(input: FileDisputeInput): Promise<FiledDispute>;
//     // The caller's disputes on their OWN entry (userId bound, never a client value),
//     // each note decrypted under the caller's DEK.
//     readDisputes(userId: string, entrySeq: number): Promise<FiledDispute[]>;
//   }
//
// The migration creates `activity_disputes` as an APPEND-ONLY table whose row references
// an activity entry by (user_id, entry_seq) → activity_entries(user_id, seq). The exact
// name of the ciphertext column is the builder's choice: tests never read the note by
// column name — they read the whole row (to prove the plaintext is absent) and round-trip
// through the repo (to prove it decrypts). `user_id` and `entry_seq` are the reference
// columns tests scope their raw reads by.
//
// Acceptance criteria → tests:
//   AC1 "Disputing an entry inserts a dispute row referencing it and leaves the entry row
//        unchanged (its entry_hash is unchanged)." — after fileDispute, the disputed entry
//        row is byte-for-byte identical (entry_hash included), the entry count is unchanged,
//        the chain still verifies intact (checkIntegrity), and readDisputes returns the
//        dispute scoped to that entry.
//   AC2 "The dispute note is stored DEK-encrypted." — the note's plaintext appears NOWHERE
//        in the stored dispute row; the repo round-trips it back to plaintext under the
//        right DEK; a WRONG DEK fails to read it (proving it is genuinely encrypted, not
//        stored in clear under a fixed key).
//   AC3 "A user cannot dispute or read disputes on another user's entry." — two people who
//        each dispute "entry 2" see only their OWN dispute (reads are member-scoped and
//        "entry 2" is per-user); a person cannot file a dispute on an entry they do not own
//        (it rejects and leaves the owner's entry and disputes untouched).
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a fixture handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-shaped input with a
//        4xx BEFORE the repo is ever called, and files under the SESSION user id (never a
//        body-supplied id); a SQL-injection probe in an input field travels as a BOUND value
//        (placeholders, never concatenation) and cannot drop a table.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo holds no key and reads no
//        `process.env`: a decoy env secret never appears in a filed/read dispute, and the
//        repo works purely from the injected db/clock/dekFor.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createDisputeRepo } from "./disputes";
import { createDbRecorder } from "./writer";
import { checkIntegrity } from "./integrity";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ----------------------------------------------------------------------

// A fixed instant so occurred_at / created_at are deterministic across a run (a clean
// whole-ms UTC instant, so a timestamptz round-trip reproduces an exact value).
const T0 = new Date("2026-01-01T00:00:00.000Z");

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this flow never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id — the
// activity entry's user_id, the dispute's user_id, and the repo's scope).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A DEK provider over a fixed map of user → key (the repo's contract resolves the DEK per
// user internally, exactly as the writer does).
function dekProvider(
  byUser: Record<string, Uint8Array>,
): (userId: string) => Promise<Uint8Array> {
  return async (userId: string) => {
    const dek = byUser[userId];
    if (!dek) throw new Error(`no DEK for ${userId}`);
    return dek;
  };
}

// Build a sound activity chain of `n` entries for one user through the REAL writer, so the
// entries genuinely exist and are hash-chained — exactly what a dispute attaches alongside.
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

// A dispute repo over the real db, with a fixed clock and a per-user DEK map.
function disputeRepo(db: Db, dekByUser: Record<string, Uint8Array>) {
  return createDisputeRepo({ db, clock: fixedClock(T0), dekFor: dekProvider(dekByUser) });
}

// The stored columns of a single activity entry, so a before/after comparison proves the
// entry row was left unchanged (behaviour: stored state, not source text).
async function entryRow(db: Db, userId: string, seq: number): Promise<Record<string, unknown>> {
  const result = await db.query(
    `SELECT user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool,
            outcome, amount, currency, merchant, payload_ct, prev_hash, entry_hash
       FROM activity_entries
      WHERE user_id = $1 AND seq = $2`,
    [userId, seq],
  );
  const row = result.rows[0];
  assert.ok(row, `expected an activity entry at seq ${seq} for ${userId}`);
  return row;
}

// How many activity entries this user has (to prove a dispute adds none).
async function entryCount(db: Db, userId: string): Promise<number> {
  const result = await db.query(
    "SELECT count(*)::int AS c FROM activity_entries WHERE user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.c ?? 0);
}

// Whether a relation of this exact name exists. `to_regclass` yields the relation name when
// it exists and NULL when it does not — a non-throwing probe (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). Returns no rows.
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

// ===================================================================================
// AC1 — filing a dispute inserts a row referencing the entry and leaves the entry unchanged.
// ===================================================================================

test("filing a dispute references the entry and leaves the entry row (and its entry_hash) unchanged", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "unchanged");
    const dek = freshDek();
    await buildChain(db, alice, dek, 3);

    const before = await entryRow(db, alice, 2);
    const beforeCount = await entryCount(db, alice);

    const repo = disputeRepo(db, { [alice]: dek });
    const filed = await repo.fileDispute({ userId: alice, entrySeq: 2, note: "this charge is wrong" });

    assert.equal(filed.entrySeq, 2, "the dispute references the disputed entry's seq");
    assert.equal(filed.userId, alice, "and is scoped to the person who filed it");
    assert.equal(filed.note, "this charge is wrong", "the filed note is returned in plaintext");

    const after = await entryRow(db, alice, 2);
    assert.deepEqual(after, before, "the disputed entry row is byte-for-byte unchanged");
    assert.equal(after.entry_hash, before.entry_hash, "its entry_hash is unchanged — the original is never altered");
    assert.equal(
      await entryCount(db, alice),
      beforeCount,
      "no activity entry is added or removed — the dispute is a separate row",
    );

    const read = await repo.readDisputes(alice, 2);
    assert.equal(read.length, 1, "exactly one dispute is attached to the entry");
    assert.equal(read[0].note, "this charge is wrong", "and it round-trips to the filed note");

    // The strongest proof the chain was untouched: it still verifies end-to-end.
    const integ = await checkIntegrity(db, alice);
    assert.equal(integ.intact, true, "the activity chain still verifies intact after a dispute is filed");
    assert.equal(integ.checked, 3, "all three entries remain");
  } finally {
    await db.close();
  }
});

test("a dispute on one entry does not attach to a different entry", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "one-entry");
    const dek = freshDek();
    await buildChain(db, alice, dek, 3);

    const repo = disputeRepo(db, { [alice]: dek });
    await repo.fileDispute({ userId: alice, entrySeq: 2, note: "only entry two" });

    assert.equal((await repo.readDisputes(alice, 2)).length, 1, "the disputed entry carries the dispute");
    assert.equal((await repo.readDisputes(alice, 1)).length, 0, "an undisputed entry carries none");
    assert.equal((await repo.readDisputes(alice, 3)).length, 0, "and neither does another undisputed entry");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — the dispute note is stored DEK-encrypted.
// ===================================================================================

test("the dispute note's plaintext is nowhere in the stored dispute row, and the repo decrypts it back", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "enc");
    const dek = freshDek();
    await buildChain(db, alice, dek, 3);

    const repo = disputeRepo(db, { [alice]: dek });
    // A unique marker that cannot appear in the base64 ciphertext by chance.
    const marker = `MARKER_${randomBytes(16).toString("hex")}`;
    const note = `this charge is wrong ${marker}`;
    await repo.fileDispute({ userId: alice, entrySeq: 2, note });

    // Inspect the stored row: the plaintext (its unique marker) must appear in NO column.
    const stored = await db.query(
      "SELECT * FROM activity_disputes WHERE user_id = $1 AND entry_seq = $2",
      [alice, 2],
    );
    assert.equal(stored.rows.length, 1, "exactly one dispute row was inserted for this (user, entry)");
    assert.ok(
      !JSON.stringify(stored.rows[0]).includes(marker),
      "the note's plaintext is absent from the stored dispute row — it is DEK-encrypted at rest",
    );

    // The repo decrypts it back under the person's DEK.
    const read = await repo.readDisputes(alice, 2);
    assert.equal(read.length, 1, "the dispute reads back");
    assert.ok(read[0].note.includes(marker), "the repo decrypts the note to its plaintext under the DEK");
  } finally {
    await db.close();
  }
});

test("a wrong DEK cannot read the note — it is genuinely DEK-encrypted, not stored in clear", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "wrongdek");
    const realDek = freshDek();
    await buildChain(db, alice, realDek, 2);

    const writer = disputeRepo(db, { [alice]: realDek });
    await writer.fileDispute({ userId: alice, entrySeq: 1, note: "secret dispute note" });

    // A repo that resolves a DIFFERENT key for Alice cannot recover the note.
    const wrong = disputeRepo(db, { [alice]: freshDek() });
    await assert.rejects(
      () => wrong.readDisputes(alice, 1),
      "a wrong DEK fails the GCM tag — the note was stored encrypted under the person's key, not in clear",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3 — a user cannot dispute or read disputes on another user's entry.
// ===================================================================================

test("each person sees only their OWN dispute on 'entry 2' — reads are member-scoped and entries are per-user", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "iso-alice");
    const bob = await makeUser(db, "iso-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    await buildChain(db, alice, dekA, 3);
    await buildChain(db, bob, dekB, 3);

    const repo = disputeRepo(db, { [alice]: dekA, [bob]: dekB });
    await repo.fileDispute({ userId: alice, entrySeq: 2, note: "ALICE-NOTE" });
    await repo.fileDispute({ userId: bob, entrySeq: 2, note: "BOB-NOTE" });

    const aliceReads = await repo.readDisputes(alice, 2);
    assert.deepEqual(
      aliceReads.map((d) => d.note),
      ["ALICE-NOTE"],
      "Alice sees only her own dispute on her entry 2 — never Bob's",
    );

    const bobReads = await repo.readDisputes(bob, 2);
    assert.deepEqual(
      bobReads.map((d) => d.note),
      ["BOB-NOTE"],
      "Bob sees only his own dispute on his entry 2 — never Alice's",
    );
  } finally {
    await db.close();
  }
});

test("a person cannot dispute an entry they do not own, and the owner's entry/disputes are untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    await buildChain(db, alice, dekA, 3); // Alice has entries 1..3
    // Bob has NO entries — "entry 2" exists only in Alice's chain.

    const repo = disputeRepo(db, { [alice]: dekA, [bob]: dekB });
    const aliceEntry2Before = await entryRow(db, alice, 2);

    // Bob tries to dispute "entry 2". fileDispute scopes by the CALLER's userId, so it can
    // only ever reference (bob, 2) — which does not exist. It must reject, never reach Alice.
    await assert.rejects(
      () => repo.fileDispute({ userId: bob, entrySeq: 2, note: "BOB-TRIES-TO-DISPUTE-ALICE" }),
      "Bob cannot dispute an entry he does not own (there is no entry at seq 2 for Bob)",
    );

    assert.deepEqual(
      await entryRow(db, alice, 2),
      aliceEntry2Before,
      "Alice's entry row is untouched by Bob's attempt",
    );
    assert.equal(
      (await repo.readDisputes(alice, 2)).length,
      0,
      "no dispute was attached to Alice's entry",
    );
    assert.equal(
      (await repo.readDisputes(bob, 2)).length,
      0,
      "and Bob's failed attempt created no dispute of his own",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC4 — a boundary handler validates input (4xx before the repo is reached) and files under
// the SESSION user id; every value is bound (parameterized). The handler below is a TEST
// FIXTURE exercising the modules — NOT an implementation file.
// ===================================================================================

// The minimal shape the fixture handler depends on (declared locally so this test couples to
// behaviour, not to the module's exported type names).
interface DisputeRepoLike {
  fileDispute(input: { userId: string; entrySeq: number; note: string }): Promise<{
    userId: string;
    entrySeq: number;
    createdAt: string;
    note: string;
  }>;
  readDisputes(
    userId: string,
    entrySeq: number,
  ): Promise<{ userId: string; entrySeq: number; createdAt: string; note: string }[]>;
}

// A recording repo stand-in: it never touches a database, so "the repo was called" is a proxy
// for "a query ran". Validation failures must leave `filed` empty (no query reached).
interface RecordingRepo extends DisputeRepoLike {
  readonly filed: { userId: string; entrySeq: number; note: string }[];
}
function recordingRepo(): RecordingRepo {
  const filed: { userId: string; entrySeq: number; note: string }[] = [];
  return {
    filed,
    async fileDispute(input) {
      filed.push(input);
      return { userId: input.userId, entrySeq: input.entrySeq, createdAt: T0.toISOString(), note: input.note };
    },
    async readDisputes() {
      return [];
    },
  };
}

// Validate the body at the boundary, then file under the SESSION user id (never a body value).
// A rejection maps to a 4xx Response and never reaches the repo.
function createDisputeHandler(
  repo: DisputeRepoLike,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  const schema = z.object({
    entrySeq: z.number().int().positive(),
    note: z.string().min(1).max(4000),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 16 * 1024 });
      const filed = await repo.fileDispute({
        userId: sessionUserId,
        entrySeq: body.entrySeq,
        note: body.note,
      });
      return new Response(JSON.stringify({ entrySeq: filed.entrySeq }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/activity/disputes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the dispute handler rejects malformed JSON with a 4xx and never reaches the repo", async () => {
  const repo = recordingRepo();
  const handler = createDisputeHandler(repo, "session-user");

  const res = await handler(postJson("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(repo.filed.length, 0, "malformed input must never reach the repo");
});

test("the dispute handler rejects an oversized body with a 4xx and never reaches the repo", async () => {
  const repo = recordingRepo();
  const handler = createDisputeHandler(repo, "session-user");

  // ~40 KiB body, well over the handler's 16 KiB cap: rejected by size before parsing.
  const huge = JSON.stringify({ entrySeq: 1, note: "x".repeat(40 * 1024) });
  const res = await handler(postJson(huge));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(repo.filed.length, 0, "an oversized body must never reach the repo");
});

test("the dispute handler rejects mis-shaped input with a 4xx and never reaches the repo", async () => {
  const cases: Record<string, unknown> = {
    "entrySeq as a string": { entrySeq: "2", note: "a note" },
    "entrySeq missing": { note: "a note" },
    "entrySeq negative": { entrySeq: -1, note: "a note" },
    "entrySeq fractional": { entrySeq: 1.5, note: "a note" },
    "note missing": { entrySeq: 2 },
    "note as a number": { entrySeq: 2, note: 12345 },
    "note empty": { entrySeq: 2, note: "" },
  };
  for (const [label, body] of Object.entries(cases)) {
    const repo = recordingRepo();
    const handler = createDisputeHandler(repo, "session-user");

    const res = await handler(postJson(JSON.stringify(body)));

    assert.ok(res.status >= 400 && res.status < 500, `${label}: expected a 4xx, got ${res.status}`);
    assert.equal(repo.filed.length, 0, `${label}: a mis-shaped field must never reach the repo`);
  }
});

test("a well-formed request files the dispute and returns a 2xx", async () => {
  const repo = recordingRepo();
  const handler = createDisputeHandler(repo, "session-user");

  const res = await handler(postJson(JSON.stringify({ entrySeq: 2, note: "wrong charge" })));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(repo.filed.length, 1, "a well-formed request reaches the repo exactly once");
  assert.equal(repo.filed[0].entrySeq, 2, "with the validated entry seq");
  assert.equal(repo.filed[0].note, "wrong charge", "and the validated note");
});

test("the dispute handler files under the SESSION user id, never a body-supplied id", async () => {
  const repo = recordingRepo();
  const handler = createDisputeHandler(repo, "session-user");

  // The body smuggles a victim's user id; the handler must ignore it and use the session's.
  const res = await handler(
    postJson(JSON.stringify({ entrySeq: 2, note: "x", userId: "attacker" })),
  );

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(repo.filed.length, 1, "the request is filed");
  assert.equal(repo.filed[0].userId, "session-user", "under the session user id");
  assert.ok(
    !repo.filed.some((f) => f.userId === "attacker"),
    "the body-supplied id never becomes the filer",
  );
});

// ---- parameterization (INV-102): every value is bound, never concatenated ----------

test("readDisputes binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const repo = createDisputeRepo({ db, clock: fixedClock(T0), dekFor: async () => freshDek() });
  const probe = "r'); DROP TABLE activity_disputes; --";

  const out = await repo.readDisputes(probe, 3);
  assert.deepEqual(out, [], "the recording db returns no rows → no disputes");

  assert.ok(db.calls.length >= 1, "readDisputes issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("fileDispute binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const repo = createDisputeRepo({ db, clock: fixedClock(T0), dekFor: async () => freshDek() });
  const probe = "p'); DROP TABLE activity_disputes; --";

  // With the recording db returning no rows, fileDispute may reject (no such entry); either
  // way, every statement it issued must have bound the id rather than splicing it.
  await repo.fileDispute({ userId: probe, entrySeq: 7, note: "a note" }).catch(() => {});

  assert.ok(db.calls.length >= 1, "fileDispute issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in the note field is stored as inert data and the tables survive", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "probe");
    const dek = freshDek();
    await buildChain(db, alice, dek, 2);

    const repo = disputeRepo(db, { [alice]: dek });
    const probe = "evil'); DROP TABLE activity_disputes; --";
    const filed = await repo.fileDispute({ userId: alice, entrySeq: 2, note: probe });
    assert.equal(filed.note, probe, "the note is stored and returned verbatim as inert data");

    assert.equal(await tableExists(db, "activity_disputes"), true, "the disputes table survives the probe");
    assert.equal(await tableExists(db, "activity_entries"), true, "the entries table survives the probe");

    const read = await repo.readDisputes(alice, 2);
    assert.equal(read.length, 1, "the dispute is stored");
    assert.equal(read[0].note, probe, "the probe round-trips exactly — it never executed as SQL");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC5 — the repo holds no key and reads no process.env: no secret value is folded in.
// ===================================================================================

test("the dispute repo reads no process.env: a decoy env secret never appears in a filed or read dispute", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "env-check");
    const dek = freshDek();
    await buildChain(db, alice, dek, 2);

    const repo = disputeRepo(db, { [alice]: dek });
    const filed = await repo.fileDispute({ userId: alice, entrySeq: 1, note: "a plain note" });
    assert.ok(
      !JSON.stringify(filed).includes(DECOY),
      "no ambient env value is folded into the filed dispute — the repo works purely from its injected seams",
    );

    const read = await repo.readDisputes(alice, 1);
    assert.equal(read.length, 1, "the dispute reads back from the injected db alone");
    assert.ok(
      !JSON.stringify(read).includes(DECOY),
      "and no ambient env value appears in a read dispute",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===================================================================================
// Two disputes filed at once on one entry both land (review finding: the per-entry
// dispute_seq was max()+1 with no lock, so a double-submitted form or a second device got a
// duplicate-key error instead of a stored dispute).
// ===================================================================================

test("two disputes filed at the same moment on one entry are both stored, as dispute 1 and 2", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "dispute-race");
    const dek = freshDek();
    await buildChain(db, userId, dek, 1);
    const repo = disputeRepo(db, { [userId]: dek });

    const results = await Promise.allSettled([
      repo.fileDispute({ userId, entrySeq: 1, note: "first device" }),
      repo.fileDispute({ userId, entrySeq: 1, note: "second device" }),
    ]);
    assert.deepEqual(
      results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)),
      [],
      "neither filing failed",
    );
    const stored = await repo.readDisputes(userId, 1);
    assert.deepEqual(stored.map((d) => d.note).sort(), ["first device", "second device"]);
    const seqs = await db.query(
      "SELECT dispute_seq FROM activity_disputes WHERE user_id = $1 AND entry_seq = 1 ORDER BY dispute_seq",
      [userId],
    );
    assert.deepEqual(seqs.rows.map((r) => Number(r.dispute_seq)), [1, 2]);
  } finally {
    await db.close();
  }
});
