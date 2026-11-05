// E08-S04 — Undo a reversible action (design §9 "Undo writes a new entry"; brief
// "Dispute and undo"; constitution principle 14 "Warthog writes the record").
// Target module (does NOT exist yet):
//   • src/server/activity/undo.ts  (the undo service)
//
// RED-first: the `./undo` module does not exist, so importing `createUndoService`
// throws (ERR_MODULE_NOT_FOUND) and this whole suite fails to load. That absence IS
// the point of test-first — do NOT implement anything to make these pass; the builder
// writes `undo.ts` afterwards. The sound activity chains these tests undo against are
// produced by the REAL writer (`./writer`, E08-S01) through the REAL migrations, so a
// correct undo appends a NEW entry WITHOUT disturbing the chain of the one it reverses.
//
// These tests pin BEHAVIOUR — what the service RETURNS, what reaches its injected
// seams (the reversal executor, the recorder), what is left in the database, and what a
// boundary handler does with bad input — never the source text of a module. A later
// rename that preserves behaviour must not redden them.
//
// WHY this exists: a reversible action can be undone. Undo is ITSELF a recorded action:
// for an entry whose tool declares a reversal, Warthog RUNS the declared reversal tool
// and WRITES a NEW activity entry for it; the activity record is append-only, so the
// ORIGINAL entry is NEVER changed. An entry whose tool declares no reversal is refused
// with a plain reason, and a person can only ever undo their OWN entries.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the builder implements exactly this).
//
//   interface UndoInput {
//     userId: string;    // the person undoing — the SESSION user id, the member scope
//     entrySeq: number;  // the entry to undo, by its `seq` within THAT user's chain
//     reason?: string;   // optional plain reason, carried into the new entry
//   }
//
//   type UndoResult =
//     | { ok: true;  entry: ActivityEntry }  // the NEW reversal entry that was recorded
//     | { ok: false; reason: string };       // refused, with a plain-words reason
//
//   createUndoService(deps: {
//     db: Db;                     // reads the ORIGINAL entry (parameterized, member-scoped)
//     recorder: ActivityRecorder; // writes the NEW reversal entry (Warthog writes the record)
//     // the declared reversal tool for a tool name, or undefined when none is declared
//     // (the "is this reversible?" decision). A read/approval/connection entry — whose
//     // tool is null/undeclared — yields undefined.
//     reversalFor: (tool: string | undefined) => string | undefined;
//     // effects the reversal (in production, routes the reversal tool through the agent
//     // pipeline / connector — the SAME seam shape as check_approval's
//     // `executeApprovedHold`). Injected so tests never touch a network.
//     runReversal: (job: { userId: string; reversalTool: string; originalSeq: number })
//       => Promise<{ outcome: string }>;
//   }): {
//     // Undo the CALLER'S OWN entry at `entrySeq`. If the entry's tool declares a
//     // reversal, run it (runReversal) and record a NEW entry whose `tool` is the
//     // reversal tool (recorder); return { ok:true, entry }. If the entry does not
//     // exist for this caller, or its tool declares no reversal, refuse with a plain
//     // reason and run/record NOTHING. The original entry is never altered.
//     undo(input: UndoInput): Promise<UndoResult>;
//   }
//
// The builder MAY pass more fields to `runReversal` (connector id, agent id, the reason);
// these tests only COUNT its calls and read the recorded entry, so they never pin the
// job's exact shape. Undo needs NO new table — it appends through the existing
// `activity_entries` chain via the recorder (design §9 "Undo writes a new entry").
//
// Acceptance criteria → tests:
//   AC1 "Undo on a reversible entry runs the declared reversal tool and writes a new
//        activity entry; the original entry is unchanged." — undo a reversible entry:
//        the reversal executor is run exactly once, a NEW entry is appended (next seq,
//        source "warthog", tool = the declared reversal tool), the disputed^H^Horiginal
//        entry row (and its entry_hash) is byte-for-byte unchanged, and the chain still
//        verifies intact. Scoping: a person undoes their OWN entry even when another
//        user has a reversible entry at the SAME seq.
//   AC2 "Undo on an entry whose tool declares no reversal is refused with a plain
//        reason." — a read/undeclared-reversal entry → { ok:false, reason:<non-empty> };
//        nothing is run and nothing is appended.
//   AC3 "A user cannot undo another user's entry." — undo scopes by the CALLER's userId,
//        so it can only reference the caller's own (userId, seq); undoing an entry the
//        caller does not own refuses, runs/records nothing, and leaves the owner's entry
//        and chain untouched.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a fixture handler on
//        the `../http/validate` boundary rejects malformed / oversized / mis-shaped input
//        with a 4xx BEFORE the service is ever called, and undoes under the SESSION user
//        id (never a body-supplied id); the service binds the user id as a parameter
//        (never concatenation), and a SQL-injection probe in an input field travels as a
//        bound/inert value and cannot drop a table.
//   AC5 [obligation:secrets-from-env] (INV-103) — the service holds no key and reads no
//        `process.env`: a decoy env secret never appears in a returned result; it works
//        purely from its injected db / recorder / reversalFor / runReversal.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createUndoService } from "./undo";
import { createDbRecorder } from "./writer";
import { checkIntegrity } from "./integrity";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import type { Db } from "../db/index";
import type { ActivityRecorder } from "./recorder";

// --- fixtures ----------------------------------------------------------------------

// A fixed instant so occurred_at is deterministic across a run (a clean whole-ms UTC
// instant, so a timestamptz round-trip reproduces an exact value).
const T0 = new Date("2026-01-01T00:00:00.000Z");

const DEK_BYTES = 32; // a 256-bit per-person data key

// A curated reversible tool and its declared reversal (design §7:
// "Google Calendar (list, create↔delete, update)" — create_event is undone by
// delete_event). The names are namespaced `<connector>__<tool>` (design §6.2).
const CREATE_EVENT = "google_calendar__create_event";
const DELETE_EVENT = "google_calendar__delete_event";
const LIST_EVENTS = "google_calendar__list_events"; // a read — declares no reversal

// The reversal table a reversible fixture uses: create_event ↔ delete_event only.
const REVERSALS: Record<string, string> = { [CREATE_EVENT]: DELETE_EVENT };

// A fresh random 256-bit DEK.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this flow never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id — the
// activity entry's user_id, and the undo service's scope).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A DEK provider over a fixed map of user → key (the recorder resolves the DEK per user
// internally).
function dekProvider(
  byUser: Record<string, Uint8Array>,
): (userId: string) => Promise<Uint8Array> {
  return async (userId: string) => {
    const dek = byUser[userId];
    if (!dek) throw new Error(`no DEK for ${userId}`);
    return dek;
  };
}

// A real DB-backed recorder with a fixed clock and a per-user DEK map — used both to
// SEED the original chain and as the undo service's own recorder (so the new reversal
// entry appends to the SAME chain, exactly as in production).
function makeRecorder(db: Db, dekByUser: Record<string, Uint8Array>): ActivityRecorder {
  return createDbRecorder({ db, clock: fixedClock(T0), dekFor: dekProvider(dekByUser) });
}

// Seed a sound activity chain for one user through the REAL writer, one entry per `tools`
// item (its `tool` column). `undefined` records an entry with no tool.
async function seedChain(
  recorder: ActivityRecorder,
  userId: string,
  tools: readonly (string | undefined)[],
): Promise<void> {
  for (const tool of tools) {
    await recorder.record({
      userId,
      kind: "tool_call",
      source: "warthog",
      tool,
      payload: { note: tool ?? "none" },
    });
  }
}

// Build an undo service over the given db + recorder, with a reversal table and a call
// log for the reversal executor. The arrows live INLINE in `createUndoService`, so
// `tool` and `job` take their types from the service's dep contract (no type import).
function buildUndoService(opts: {
  db: Db;
  recorder: ActivityRecorder;
  reversals: Record<string, string>;
  runCalls: unknown[];
}) {
  return createUndoService({
    db: opts.db,
    recorder: opts.recorder,
    reversalFor: (tool) => (tool ? opts.reversals[tool] : undefined),
    runReversal: async (job) => {
      opts.runCalls.push(job);
      return { outcome: "reversed" };
    },
  });
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

// How many activity entries this user has (to prove undo appends exactly one — or none).
async function entryCount(db: Db, userId: string): Promise<number> {
  const result = await db.query(
    "SELECT count(*)::int AS c FROM activity_entries WHERE user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.c ?? 0);
}

// Whether a relation of this exact name exists. `to_regclass` yields the relation name
// when it exists and NULL when it does not — a non-throwing probe (behaviour, not source).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). Returns no rows.
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

// A recorder stand-in that records every write instead of persisting it — so a test can
// prove undo DID or did NOT append a new entry without a real database.
interface RecordingRecorder extends ActivityRecorder {
  readonly records: unknown[];
}
function recordingRecorder(): RecordingRecorder {
  const records: unknown[] = [];
  return {
    records,
    async record(input) {
      records.push(input);
      return {
        userId: input.userId,
        seq: 0,
        occurredAt: T0.toISOString(),
        kind: input.kind,
        source: input.source,
        tool: input.tool,
        payload: input.payload,
        prevHash: "x",
        entryHash: "y",
      };
    },
  };
}

// ===================================================================================
// AC1 — undo on a reversible entry runs the reversal, writes a new entry, leaves the
// original unchanged.
// ===================================================================================

test("undo of a reversible entry runs the declared reversal tool and appends a new entry; the original is unchanged", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "reversible");
    const dek = freshDek();
    const recorder = makeRecorder(db, { [alice]: dek });
    // seq 1: a read; seq 2: the reversible create; seq 3: another entry.
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]);

    const before = await entryRow(db, alice, 2);
    const beforeCount = await entryCount(db, alice);

    const runCalls: unknown[] = [];
    const service = buildUndoService({ db, recorder, reversals: REVERSALS, runCalls });
    const result = await service.undo({ userId: alice, entrySeq: 2, reason: "undo that event" });

    assert.ok(result.ok, "undo of a reversible entry succeeds");
    assert.equal(runCalls.length, 1, "the declared reversal tool is run exactly once");

    // The NEW entry is appended as the next link in the chain, recorded by Warthog,
    // and carries the DECLARED reversal tool — the action that was run.
    assert.equal(result.entry.seq, beforeCount + 1, "the undo is a NEW entry at the next seq");
    assert.equal(result.entry.source, "warthog", "Warthog wrote the record, not an agent");
    assert.equal(result.entry.tool, DELETE_EVENT, "the new entry records the declared reversal tool");

    // It is genuinely persisted in the person's chain.
    const newRow = await entryRow(db, alice, beforeCount + 1);
    assert.equal(newRow.tool, DELETE_EVENT, "the appended row carries the reversal tool");
    assert.equal(newRow.source, "warthog", "the appended row is Warthog-sourced");
    assert.equal(await entryCount(db, alice), beforeCount + 1, "exactly one entry is appended");

    // The ORIGINAL entry is never altered — append-only record.
    const after = await entryRow(db, alice, 2);
    assert.deepEqual(after, before, "the reversed entry's row is byte-for-byte unchanged");
    assert.equal(after.entry_hash, before.entry_hash, "its entry_hash is unchanged — the original is never altered");

    // The strongest proof the chain is sound: it still verifies end-to-end, now longer.
    const integ = await checkIntegrity(db, alice);
    assert.equal(integ.intact, true, "the activity chain still verifies intact after the undo");
    assert.equal(integ.checked, beforeCount + 1, "and now includes the appended undo entry");
  } finally {
    await db.close();
  }
});

test("undo scopes to the caller — a person undoes their OWN entry even when another user has a reversible entry at the same seq", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "scope-alice");
    const bob = await makeUser(db, "scope-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const recorder = makeRecorder(db, { [alice]: dekA, [bob]: dekB });
    // BOTH chains have a reversible create at seq 2.
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]);
    await seedChain(recorder, bob, [LIST_EVENTS, CREATE_EVENT, undefined]);

    const aliceEntry2Before = await entryRow(db, alice, 2);

    const runCalls: unknown[] = [];
    const service = buildUndoService({ db, recorder, reversals: REVERSALS, runCalls });

    // Bob undoes "entry 2" — scoped by Bob's userId, so it can only ever be BOB's entry 2.
    const result = await service.undo({ userId: bob, entrySeq: 2 });
    assert.ok(result.ok, "Bob undoes his own reversible entry 2");

    assert.equal(await entryCount(db, bob), 4, "the undo is appended to BOB's chain");
    assert.equal(await entryCount(db, alice), 3, "ALICE's chain is untouched by Bob's undo");
    assert.deepEqual(
      await entryRow(db, alice, 2),
      aliceEntry2Before,
      "Alice's entry 2 is byte-for-byte unchanged — Bob's undo never reached it",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — an entry whose tool declares no reversal is refused with a plain reason.
// ===================================================================================

test("undo of an entry whose tool declares no reversal is refused with a plain reason, and nothing is run or appended", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "no-reversal");
    const dek = freshDek();
    const recorder = makeRecorder(db, { [alice]: dek });
    // seq 1 is a READ — google_calendar__list_events declares no reversal.
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT]);

    const beforeCount = await entryCount(db, alice);
    const runCalls: unknown[] = [];
    const service = buildUndoService({ db, recorder, reversals: REVERSALS, runCalls });

    const result = await service.undo({ userId: alice, entrySeq: 1 });

    assert.ok(!result.ok, "a non-reversible entry cannot be undone");
    assert.equal(typeof result.reason, "string", "the refusal carries a reason");
    assert.ok(result.reason.length > 0, "and it is a plain, non-empty reason");

    assert.equal(runCalls.length, 0, "no reversal tool is run for a non-reversible entry");
    assert.equal(await entryCount(db, alice), beforeCount, "and no new activity entry is appended");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3 — a user cannot undo another user's entry.
// ===================================================================================

test("a person cannot undo an entry they do not own — it refuses, runs/records nothing, and the owner's entry is untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const recorder = makeRecorder(db, { [alice]: dekA, [bob]: dekB });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]); // Alice: 1..3
    // Bob has NO entries — "entry 2" exists only in Alice's chain.

    const aliceEntry2Before = await entryRow(db, alice, 2);
    const runCalls: unknown[] = [];
    const service = buildUndoService({ db, recorder, reversals: REVERSALS, runCalls });

    // Bob tries to undo "entry 2". undo scopes by the CALLER's userId, so it references
    // (bob, 2) — which does not exist. It must refuse, never reach Alice's chain.
    const result = await service.undo({ userId: bob, entrySeq: 2, reason: "BOB-TRIES-TO-UNDO-ALICE" });

    assert.ok(!result.ok, "Bob cannot undo an entry he does not own");
    assert.ok(result.reason.length > 0, "the refusal is a plain reason");

    assert.equal(runCalls.length, 0, "no reversal runs for an entry the caller does not own");
    assert.equal(await entryCount(db, bob), 0, "Bob's failed attempt appends nothing to his own chain");
    assert.equal(await entryCount(db, alice), 3, "and nothing is appended to the owner's chain");
    assert.deepEqual(
      await entryRow(db, alice, 2),
      aliceEntry2Before,
      "Alice's entry row is untouched by Bob's attempt",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC4 — a boundary handler validates input (4xx before the service is reached) and
// undoes under the SESSION user id; every value is bound (parameterized). The handler
// below is a TEST FIXTURE exercising the modules — NOT an implementation file.
// ===================================================================================

// The minimal shape the fixture handler depends on (declared locally so this test
// couples to behaviour, not to the module's exported type names).
interface UndoServiceLike {
  undo(input: { userId: string; entrySeq: number; reason?: string }): Promise<
    { ok: true; entry: { seq: number } } | { ok: false; reason: string }
  >;
}

// A recording service stand-in: it never touches a database, so "the service was called"
// is a proxy for "a query ran". Validation failures must leave `calls` empty.
interface RecordingService extends UndoServiceLike {
  readonly calls: { userId: string; entrySeq: number; reason?: string }[];
}
function recordingService(): RecordingService {
  const calls: { userId: string; entrySeq: number; reason?: string }[] = [];
  return {
    calls,
    async undo(input) {
      calls.push(input);
      return { ok: true, entry: { seq: 42 } };
    },
  };
}

// Validate the body at the boundary, then undo under the SESSION user id (never a body
// value). A validation rejection maps to a 4xx Response and never reaches the service;
// a business refusal is reported in plain words (never a silent failure).
function createUndoHandler(
  service: UndoServiceLike,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  const schema = z.object({
    entrySeq: z.number().int().positive(),
    reason: z.string().min(1).max(2000).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 16 * 1024 });
      const result = await service.undo({
        userId: sessionUserId,
        entrySeq: body.entrySeq,
        reason: body.reason,
      });
      if (!result.ok) {
        return new Response(JSON.stringify({ ok: false, reason: result.reason }), { status: 200 });
      }
      return new Response(JSON.stringify({ entrySeq: result.entry.seq }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/activity/undo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the undo handler rejects malformed JSON with a 4xx and never reaches the service", async () => {
  const service = recordingService();
  const handler = createUndoHandler(service, "session-user");

  const res = await handler(postJson("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(service.calls.length, 0, "malformed input must never reach the service");
});

test("the undo handler rejects an oversized body with a 4xx and never reaches the service", async () => {
  const service = recordingService();
  const handler = createUndoHandler(service, "session-user");

  // ~40 KiB body, well over the handler's 16 KiB cap: rejected by size before parsing.
  const huge = JSON.stringify({ entrySeq: 1, reason: "x".repeat(40 * 1024) });
  const res = await handler(postJson(huge));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(service.calls.length, 0, "an oversized body must never reach the service");
});

test("the undo handler rejects mis-shaped input with a 4xx and never reaches the service", async () => {
  const cases: Record<string, unknown> = {
    "entrySeq as a string": { entrySeq: "2" },
    "entrySeq missing": { reason: "a reason" },
    "entrySeq negative": { entrySeq: -1 },
    "entrySeq zero": { entrySeq: 0 },
    "entrySeq fractional": { entrySeq: 1.5 },
    "reason as a number": { entrySeq: 2, reason: 12345 },
    "reason empty": { entrySeq: 2, reason: "" },
  };
  for (const [label, body] of Object.entries(cases)) {
    const service = recordingService();
    const handler = createUndoHandler(service, "session-user");

    const res = await handler(postJson(JSON.stringify(body)));

    assert.ok(res.status >= 400 && res.status < 500, `${label}: expected a 4xx, got ${res.status}`);
    assert.equal(service.calls.length, 0, `${label}: a mis-shaped field must never reach the service`);
  }
});

test("a well-formed request undoes the entry and returns a 2xx", async () => {
  const service = recordingService();
  const handler = createUndoHandler(service, "session-user");

  const res = await handler(postJson(JSON.stringify({ entrySeq: 2, reason: "undo it" })));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(service.calls.length, 1, "a well-formed request reaches the service exactly once");
  assert.equal(service.calls[0].entrySeq, 2, "with the validated entry seq");
  assert.equal(service.calls[0].reason, "undo it", "and the validated reason");
});

test("the undo handler undoes under the SESSION user id, never a body-supplied id", async () => {
  const service = recordingService();
  const handler = createUndoHandler(service, "session-user");

  // The body smuggles a victim's user id; the handler must ignore it and use the session's.
  const res = await handler(
    postJson(JSON.stringify({ entrySeq: 2, userId: "attacker" })),
  );

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(service.calls.length, 1, "the request is undone");
  assert.equal(service.calls[0].userId, "session-user", "under the session user id");
  assert.ok(
    !service.calls.some((c) => c.userId === "attacker"),
    "the body-supplied id never becomes the actor",
  );
});

// ---- parameterization (INV-102): every value is bound, never concatenated ----------

test("undo binds the user id and entry seq as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const runCalls: unknown[] = [];
  const service = buildUndoService({
    db,
    recorder: recordingRecorder(),
    reversals: REVERSALS,
    runCalls,
  });
  const probe = "u'); DROP TABLE activity_entries; --";

  // With the recording db returning no rows, undo finds no entry and refuses; either way,
  // every statement it issued must have BOUND the id rather than splicing it.
  const result = await service.undo({ userId: probe, entrySeq: 7 });
  assert.ok(!result.ok, "the recording db returns no rows → no entry to undo → refused");

  assert.ok(db.calls.length >= 1, "undo issues at least one query to read the entry");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
  assert.equal(runCalls.length, 0, "a refused undo runs no reversal");
});

test("a SQL-injection probe in the reason field is inert — the undo still succeeds and the tables survive", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "probe");
    const dek = freshDek();
    const recorder = makeRecorder(db, { [alice]: dek });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT]);

    const runCalls: unknown[] = [];
    const service = buildUndoService({ db, recorder, reversals: REVERSALS, runCalls });
    const probe = "evil'); DROP TABLE activity_entries; --";

    const result = await service.undo({ userId: alice, entrySeq: 2, reason: probe });
    assert.ok(result.ok, "a SQL-shaped reason is inert data — the undo still succeeds");

    assert.equal(await tableExists(db, "activity_entries"), true, "the entries table survives the probe");
    assert.equal(await entryCount(db, alice), 3, "the undo appended exactly one new entry");

    // The chain is still sound — nothing was dropped, altered or reordered by the probe.
    const integ = await checkIntegrity(db, alice);
    assert.equal(integ.intact, true, "the activity chain still verifies intact");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC5 — the service holds no key and reads no process.env: no secret value is folded in.
// ===================================================================================

test("the undo service reads no process.env: a decoy env secret never appears in a returned result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "env-check");
    const dek = freshDek();
    const recorder = makeRecorder(db, { [alice]: dek });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT]);

    const runCalls: unknown[] = [];
    const service = buildUndoService({ db, recorder, reversals: REVERSALS, runCalls });
    const result = await service.undo({ userId: alice, entrySeq: 2, reason: "a plain reason" });

    assert.ok(result.ok, "the undo works purely from its injected seams");
    assert.ok(
      !JSON.stringify(result).includes(DECOY),
      "no ambient env value is folded into the returned result — the service works from its injected seams alone",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
