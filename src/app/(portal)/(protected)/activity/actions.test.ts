// E08-S07 — Activity page server actions (`src/app/(portal)/(protected)/activity/`).
//
// RED-first: the activity actions seam does NOT exist yet, so importing `./actions`
// throws (ERR_MODULE_NOT_FOUND) and this whole suite fails to load. That absence IS the
// point of test-first — do NOT implement anything to make these pass; the builder writes
// `actions.ts` afterwards. The real sub-services these actions wrap — the dispute repo
// (`@/server/activity/disputes`, E08-S03), the undo service (`@/server/activity/undo`,
// E08-S04) and the integrity check (`@/server/activity/integrity`, E08-S02) — already
// exist, and the sound chains these tests act on are produced by the REAL writer
// (`@/server/activity/writer`, E08-S01) through the REAL migrations. So a correct actions
// layer wires identity-from-the-session + input validation over those services WITHOUT
// disturbing their behaviour.
//
// These tests pin BEHAVIOUR (what each action RETURNS, what it CHANGES in the database,
// what it REFUSES, and what a boundary handler does with bad input) against an isolated
// in-memory PGlite with the REAL migrations (`@/test/db`) and the REAL seams. No test
// asserts on the source text of any module, so a later behaviour-preserving refactor (a
// rename, a moved import) stays green.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file may
// export ONLY its framework fields, so it cannot carry an injectable, unit-testable seam
// without breaking `next build`. The thin protected-page loader (`page.tsx`) reads the
// session + the process-wide database, composes the sub-services, and renders the view;
// the testable logic — turning a verified session into a dispute / undo / integrity
// outcome — lives in the plain sibling module `actions.ts` (the convention's
// `createXActions(deps)` factory pattern, here `createActivityActions(deps)`, exactly as
// the sibling security page uses `createSecurityActions(deps)`).
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   createActivityActions(deps: {
//     db: Db;              // the integrity check reads this (parameterized, member-scoped)
//     disputes: DisputeRepo;   // createDisputeRepo(...)  — { fileDispute, readDisputes }
//     undo: UndoService;       // createUndoService(...)  — { undo }
//   }): {
//     disputeEntry(session: Session, entrySeq: number, note: string):
//        Promise<{ ok: true } | { ok: false; reason: string }>
//     undoEntry(session: Session, entrySeq: number, reason?: string):
//        Promise<{ ok: true; entry: { seq: number } } | { ok: false; reason: string }>
//     checkIntegrity(session: Session):
//        Promise<{ intact: boolean; checked: number; brokenSeq: number | null }>
//   }
//
//   • Every action derives the acting user id from `session.userId` — NEVER a
//     client-supplied value (design §5: every member-scoped query is filtered by the
//     session's user id, never an id from the client). There is no `userId` parameter on
//     any method: identity comes from the session alone.
//   • disputeEntry / undoEntry validate `entrySeq` at the boundary and REJECT anything
//     that is not a POSITIVE INTEGER with a 4xx `HttpError` (OBS-049) — it never reaches a
//     query as a raw cast (a bad id never becomes `Number(x)` → a NaN/negative at
//     `WHERE … seq = $n`). An over-long / mis-shaped note or reason is likewise rejected
//     with a 4xx before any query runs.
//   • A WELL-FORMED entry id that is simply not this person's (or declares no reversal)
//     returns { ok: false } with a plain-words reason and changes nothing — a reported
//     refusal, never a silent success and never another person's row.
//   • checkIntegrity returns the whole result: a sound chain of N → { intact: true,
//     checked: N, brokenSeq: null }; the first broken entry → { intact: false,
//     brokenSeq: <that seq> }, scoped to the session user's own chain.
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1  each action reads the user id from the SESSION and rejects an entry id that is
//        not a positive integer with a 4xx (not a raw cast).
//   AC2  a signed-in user cannot dispute or undo ANOTHER user's entry by id.
//   AC3  checkIntegrity returns the intact count or the first broken seq.
//   AC4  [obligation:validate-and-parameterize-input] a handler rejects malformed or
//        oversized input with a 4xx, and a SQL-injection probe in an input field cannot
//        alter a query (parameter binding is used).
//   AC5  [obligation:secrets-from-env] no secret value is folded into a result; the
//        actions work purely from their injected seams and read no `process.env`.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createActivityActions } from "./actions";

import { createDisputeRepo } from "@/server/activity/disputes";
import { createUndoService } from "@/server/activity/undo";
import { createDbRecorder } from "@/server/activity/writer";
import { checkIntegrity } from "@/server/activity/integrity";
import type { ActivityRecorder } from "@/server/activity/recorder";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { parseBody, HttpError } from "@/server/http/validate";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// --- fixtures ----------------------------------------------------------------------

// A fixed instant so occurred_at / created_at are deterministic across a run (a clean
// whole-ms UTC instant, so a timestamptz round-trip reproduces an exact value). A session
// created at T0 and read by a clock also at T0 is comfortably inside its windows.
const T0 = new Date("2026-01-01T00:00:00.000Z");
const clock = fixedClock(T0);

const DEK_BYTES = 32; // a 256-bit per-person data key

// A curated reversible tool and its declared reversal (design §7: create_event ↔
// delete_event), plus a read that declares no reversal. Names are `<connector>__<tool>`.
const CREATE_EVENT = "google_calendar__create_event";
const DELETE_EVENT = "google_calendar__delete_event";
const LIST_EVENTS = "google_calendar__list_events";
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
// activity entry's user_id, the dispute's user_id, and each action's scope).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A real session for `userId`, so each action is driven with a genuine verified Session
// and must read `session.userId` to act (never a client value).
async function sessionFor(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  return created.session;
}

// A DEK provider over a fixed map of user → key (the repos resolve the DEK per user
// internally, exactly as the writer does).
function dekProvider(
  byUser: Record<string, Uint8Array>,
): (userId: string) => Promise<Uint8Array> {
  return async (userId: string) => {
    const dek = byUser[userId];
    if (!dek) throw new Error(`no DEK for ${userId}`);
    return dek;
  };
}

// A real DB-backed recorder with a fixed clock and a per-user DEK map — used both to SEED
// each chain and as the undo service's own recorder (so an undo appends to the SAME
// chain, exactly as in production).
function makeRecorder(db: Db, dekByUser: Record<string, Uint8Array>): ActivityRecorder {
  return createDbRecorder({ db, clock, dekFor: dekProvider(dekByUser) });
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

// Build the REAL activity actions over a real db, with real sub-services (a dispute repo
// and an undo service) composed from the same seams production uses. Returns the actions
// plus the pieces a test reads back through (the repo, the recorder, the reversal-run log).
function realActions(
  db: Db,
  opts: { dekByUser: Record<string, Uint8Array>; runCalls?: unknown[] },
) {
  const runCalls = opts.runCalls ?? [];
  const recorder = makeRecorder(db, opts.dekByUser);
  const disputes = createDisputeRepo({ db, clock, dekFor: dekProvider(opts.dekByUser) });
  const undo = createUndoService({
    db,
    recorder,
    reversalFor: (tool) => (tool ? REVERSALS[tool] : undefined),
    runReversal: async (job) => {
      runCalls.push(job);
      return { status: "executed", outcome: "reversed" };
    },
  });
  const actions = createActivityActions({ db, disputes, undo });
  return { actions, disputes, undo, recorder, runCalls };
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

// How many activity entries this user has (to prove an undo appends exactly one — or none).
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

// A trivial db seam the validation-only actions never actually query (validation fails
// first). It satisfies `Db` and records nothing — so "a query ran" cannot be confused for
// "validation passed".
function noopDb(): Db {
  return {
    query() {
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// The minimal shapes the actions factory depends on (declared locally so these tests
// couple to BEHAVIOUR, not to the module's exported type names). A recording stand-in for
// each proves whether a validated call reached the sub-service — so a validation failure
// is shown to stop BEFORE any query.
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
interface UndoServiceLike {
  undo(input: { userId: string; entrySeq: number; reason?: string }): Promise<
    { ok: true; entry: { seq: number } } | { ok: false; reason: string }
  >;
}

interface RecordingDisputeRepo extends DisputeRepoLike {
  readonly filed: { userId: string; entrySeq: number; note: string }[];
}
function recordingDisputeRepo(): RecordingDisputeRepo {
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

interface RecordingUndoService extends UndoServiceLike {
  readonly calls: { userId: string; entrySeq: number; reason?: string }[];
}
function recordingUndoService(): RecordingUndoService {
  const calls: { userId: string; entrySeq: number; reason?: string }[] = [];
  return {
    calls,
    async undo(input) {
      calls.push(input);
      return { ok: true, entry: { seq: 42 } };
    },
  };
}

// Actions wired to recording sub-services — for validation tests, where the point is that
// bad input NEVER reaches a sub-service (so `filed`/`calls` stay empty).
function recordingActions() {
  const disputes = recordingDisputeRepo();
  const undo = recordingUndoService();
  const actions = createActivityActions({ db: noopDb(), disputes, undo });
  return { actions, disputes, undo };
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary) — the
// bad input never reached a query as a cast.
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: bad input must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      err.status >= 400 && err.status < 500,
      `${label}: the rejection must carry a 4xx status, got ${err.status}`,
    );
  }
  assert.ok(threw, `${label}: bad input must be rejected (nothing was thrown)`);
}

// A minimal Session shape for the fixture handler, which only needs the user id.
type SessionUserId = string;

// A recording sink standing in for "the dispute was filed" — so the fixture handler test
// can prove malformed/oversized bodies NEVER reach the action, and that a well-formed body
// is filed under the SESSION user id (never a body-supplied id).
interface DisputeSink {
  readonly filed: { userId: string; entrySeq: number; note: string }[];
}
function disputeSink(): DisputeSink & { file(input: { userId: string; entrySeq: number; note: string }): void } {
  const filed: { userId: string; entrySeq: number; note: string }[] = [];
  return {
    filed,
    file(input) {
      filed.push(input);
    },
  };
}

// A TEST FIXTURE handler on the real `@/server/http/validate` boundary: it parses +
// validates a raw JSON body, then files under the SESSION user id (never a body value). A
// rejection maps to a 4xx Response and never reaches the sink. This is NOT an
// implementation file — it exercises the boundary the real server action sits behind.
function createDisputeBodyHandler(
  sink: ReturnType<typeof disputeSink>,
  sessionUserId: SessionUserId,
): (req: Request) => Promise<Response> {
  const schema = z.object({
    entrySeq: z.number().int().positive(),
    note: z.string().min(1).max(4000),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 16 * 1024 });
      sink.file({ userId: sessionUserId, entrySeq: body.entrySeq, note: body.note });
      return new Response(JSON.stringify({ entrySeq: body.entrySeq }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function postJson(body: string): Request {
  return new Request("https://warthog.com.au/activity/dispute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// The entry-id values that are NOT positive integers — every one must be rejected with a
// 4xx, and none may reach a query via a raw cast. All are typed `number`, so they exercise
// the validation (not a TypeScript call-site error): a naive `Number(x)` would let the
// NaN / fractional / non-positive values straight through to `WHERE … seq = $n`.
const NON_POSITIVE_INTEGER_IDS: { label: string; value: number }[] = [
  { label: "negative", value: -1 },
  { label: "zero", value: 0 },
  { label: "fractional", value: 1.5 },
  { label: "NaN", value: Number.NaN },
  { label: "Infinity", value: Number.POSITIVE_INFINITY },
];

// ===================================================================================
// AC1 — each action reads the user id from the SESSION and rejects an entry id that is not
// a positive integer with a 4xx (not a raw cast).
// ===================================================================================

test("disputeEntry rejects an entry id that is not a positive integer with a 4xx, and never reaches the repo", async () => {
  for (const { label, value } of NON_POSITIVE_INTEGER_IDS) {
    const { actions, disputes } = recordingActions();
    const session = { userId: "session-user" } as unknown as Session;
    await assertRejects4xx(`disputeEntry(${label})`, () => actions.disputeEntry(session, value, "a note"));
    assert.equal(disputes.filed.length, 0, `${label}: a non-positive-integer id must never reach the dispute repo`);
  }
});

test("undoEntry rejects an entry id that is not a positive integer with a 4xx, and never reaches the service", async () => {
  for (const { label, value } of NON_POSITIVE_INTEGER_IDS) {
    const { actions, undo } = recordingActions();
    const session = { userId: "session-user" } as unknown as Session;
    await assertRejects4xx(`undoEntry(${label})`, () => actions.undoEntry(session, value));
    assert.equal(undo.calls.length, 0, `${label}: a non-positive-integer id must never reach the undo service`);
  }
});

test("disputeEntry acts under the SESSION user id — a person disputes their OWN entry", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "dispute-own");
    const dek = freshDek();
    const { actions, disputes, recorder } = realActions(db, { dekByUser: { [alice]: dek } });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]); // seqs 1..3

    const before = await entryRow(db, alice, 2);
    const session = await sessionFor(db, alice);

    const result = await actions.disputeEntry(session, 2, "this charge is wrong");
    assert.equal(result.ok, true, "a person may dispute their own entry");

    // The dispute landed on THIS person's entry, scoped by the session user id.
    const read = await disputes.readDisputes(alice, 2);
    assert.equal(read.length, 1, "exactly one dispute is attached to the person's own entry");
    assert.equal(read[0]!.note, "this charge is wrong", "and it round-trips to the filed note");

    // The disputed entry is never altered — the record is append-only.
    assert.deepEqual(await entryRow(db, alice, 2), before, "the disputed entry row is byte-for-byte unchanged");
    const integ = await checkIntegrity(db, alice);
    assert.equal(integ.intact, true, "the activity chain still verifies intact after a dispute");
  } finally {
    await db.close();
  }
});

test("undoEntry acts under the SESSION user id — a person undoes their OWN reversible entry", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "undo-own");
    const dek = freshDek();
    const runCalls: unknown[] = [];
    const { actions, recorder } = realActions(db, { dekByUser: { [alice]: dek }, runCalls });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]); // seq 2 is reversible

    const before = await entryRow(db, alice, 2);
    const beforeCount = await entryCount(db, alice);
    const session = await sessionFor(db, alice);

    const result = await actions.undoEntry(session, 2, "undo that event");
    assert.equal(result.ok, true, "a person may undo their own reversible entry");
    assert.equal(runCalls.length, 1, "the declared reversal tool is run exactly once");

    // The undo is a NEW entry appended to THIS person's chain; the original is unchanged.
    assert.equal(await entryCount(db, alice), beforeCount + 1, "exactly one entry is appended");
    assert.deepEqual(await entryRow(db, alice, 2), before, "the reversed entry's row is byte-for-byte unchanged");
    const integ = await checkIntegrity(db, alice);
    assert.equal(integ.intact, true, "the activity chain still verifies intact after the undo");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — a signed-in user cannot dispute or undo ANOTHER user's entry by id. Identity is
// the session user id, so an entry that is not theirs is simply not found.
// ===================================================================================

test("a member cannot dispute another user's entry by id — the owner's entry is untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "victim-dispute");
    const bob = await makeUser(db, "attacker-dispute");
    const dekA = freshDek();
    const dekB = freshDek();
    const { actions, disputes, recorder } = realActions(db, { dekByUser: { [alice]: dekA, [bob]: dekB } });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]); // Alice: seqs 1..3
    // Bob has NO entries — "entry 2" exists only in Alice's chain.

    const aliceEntry2Before = await entryRow(db, alice, 2);
    const bobSession = await sessionFor(db, bob);

    // Bob, signed in, tries to dispute "entry 2". The action scopes by the SESSION user id
    // (bob), so it can only ever reference (bob, 2) — which does not exist.
    const result = await actions.disputeEntry(bobSession, 2, "BOB-TRIES-TO-DISPUTE-ALICE");
    assert.equal(result.ok, false, "disputing another user's entry is a reported refusal, not a silent success");

    assert.deepEqual(await entryRow(db, alice, 2), aliceEntry2Before, "Alice's entry row is untouched by Bob's attempt");
    assert.equal((await disputes.readDisputes(alice, 2)).length, 0, "no dispute was attached to Alice's entry");
    assert.equal((await disputes.readDisputes(bob, 2)).length, 0, "and Bob's failed attempt created no dispute of his own");
  } finally {
    await db.close();
  }
});

test("a member cannot undo another user's entry by id — nothing is run and the owner's chain is untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "victim-undo");
    const bob = await makeUser(db, "attacker-undo");
    const dekA = freshDek();
    const dekB = freshDek();
    const runCalls: unknown[] = [];
    const { actions, recorder } = realActions(db, { dekByUser: { [alice]: dekA, [bob]: dekB }, runCalls });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]); // Alice: seqs 1..3
    // Bob has NO entries.

    const aliceEntry2Before = await entryRow(db, alice, 2);
    const bobSession = await sessionFor(db, bob);

    const result = await actions.undoEntry(bobSession, 2, "BOB-TRIES-TO-UNDO-ALICE");
    assert.equal(result.ok, false, "undoing another user's entry is a reported refusal, not a silent success");

    assert.equal(runCalls.length, 0, "no reversal runs for an entry the caller does not own");
    assert.equal(await entryCount(db, bob), 0, "Bob's failed attempt appends nothing to his own chain");
    assert.equal(await entryCount(db, alice), 3, "and nothing is appended to the owner's chain");
    assert.deepEqual(await entryRow(db, alice, 2), aliceEntry2Before, "Alice's entry row is untouched by Bob's attempt");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3 — checkIntegrity returns the intact count or the first broken seq, scoped to the
// session user's own chain.
// ===================================================================================

test("checkIntegrity returns the intact count for a sound chain, scoped to the session user", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "integ-sound");
    const dek = freshDek();
    const { actions, recorder } = realActions(db, { dekByUser: { [alice]: dek } });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]); // 3 sound entries

    const session = await sessionFor(db, alice);
    const result = await actions.checkIntegrity(session);

    assert.equal(result.intact, true, "a writer-built chain verifies as intact");
    assert.equal(result.checked, 3, "all three of the person's entries were examined");
    assert.ok(result.brokenSeq == null, "no broken seq is reported for a sound chain");
  } finally {
    await db.close();
  }
});

test("checkIntegrity returns the first broken seq for a tampered chain, scoped to the session user", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "integ-alice");
    const bob = await makeUser(db, "integ-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const { actions, recorder } = realActions(db, { dekByUser: { [alice]: dekA, [bob]: dekB } });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]);
    await seedChain(recorder, bob, [LIST_EVENTS, CREATE_EVENT, undefined]);

    // Tamper ONLY Alice's chain (a hashed field of entry 2).
    await db.query("UPDATE activity_entries SET kind = $2 WHERE user_id = $1 AND seq = $3", [alice, "tampered", 2]);

    const aliceResult = await actions.checkIntegrity(await sessionFor(db, alice));
    assert.equal(aliceResult.intact, false, "Alice's chain is reported broken");
    assert.equal(aliceResult.brokenSeq, 2, "and the first broken entry is the tampered one, seq 2");

    // Bob's own check, under Bob's session, is unaffected — scope is the session user id.
    const bobResult = await actions.checkIntegrity(await sessionFor(db, bob));
    assert.equal(bobResult.intact, true, "Bob's chain is unaffected — the check is scoped to the session user");
    assert.equal(bobResult.checked, 3, "Bob's three entries are examined");
    assert.ok(bobResult.brokenSeq == null, "and none of Bob's entries are reported broken");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC4 — a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
// probe in an input field cannot alter a query (parameter binding is used).
// ===================================================================================

// -- action-level: an over-long / mis-shaped note or reason is rejected at the boundary --

test("disputeEntry rejects an empty or oversized note with a 4xx, and never reaches the repo", async () => {
  const cases: { label: string; note: string }[] = [
    { label: "empty note", note: "" },
    { label: "oversized note", note: "x".repeat(200_000) },
  ];
  for (const { label, note } of cases) {
    const { actions, disputes } = recordingActions();
    const session = { userId: "session-user" } as unknown as Session;
    await assertRejects4xx(`disputeEntry(${label})`, () => actions.disputeEntry(session, 2, note));
    assert.equal(disputes.filed.length, 0, `${label}: invalid input must never reach the dispute repo`);
  }
});

test("undoEntry rejects an oversized reason with a 4xx, and never reaches the service", async () => {
  const { actions, undo } = recordingActions();
  const session = { userId: "session-user" } as unknown as Session;
  await assertRejects4xx("undoEntry(oversized reason)", () => actions.undoEntry(session, 2, "x".repeat(200_000)));
  assert.equal(undo.calls.length, 0, "an oversized reason must never reach the undo service");
});

// -- handler-level: a raw JSON body that is malformed or oversized is rejected by bytes --

test("the dispute handler rejects malformed JSON with a 4xx and never reaches the action", async () => {
  const sink = disputeSink();
  const handler = createDisputeBodyHandler(sink, "session-user");

  const res = await handler(postJson("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(sink.filed.length, 0, "malformed input must never reach the action");
});

test("the dispute handler rejects an oversized body with a 4xx and never reaches the action", async () => {
  const sink = disputeSink();
  const handler = createDisputeBodyHandler(sink, "session-user");

  // ~40 KiB body, well over the handler's 16 KiB cap: rejected by size before parsing.
  const huge = JSON.stringify({ entrySeq: 1, note: "x".repeat(40 * 1024) });
  const res = await handler(postJson(huge));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(sink.filed.length, 0, "an oversized body must never reach the action");
});

test("the dispute handler files a well-formed body under the SESSION user id, never a body-supplied id", async () => {
  const sink = disputeSink();
  const handler = createDisputeBodyHandler(sink, "session-user");

  // The body smuggles a victim's user id; the handler must ignore it and use the session's.
  const res = await handler(postJson(JSON.stringify({ entrySeq: 2, note: "wrong charge", userId: "attacker" })));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(sink.filed.length, 1, "a well-formed request reaches the action exactly once");
  assert.equal(sink.filed[0]!.userId, "session-user", "under the session user id");
  assert.ok(!sink.filed.some((f) => f.userId === "attacker"), "the body-supplied id never becomes the actor");
});

// -- parameterization (INV-102): a SQL-injection probe in an input field is inert data --

test("a SQL-injection probe in the dispute note is stored as inert data and the tables survive", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "probe-dispute");
    const dek = freshDek();
    const { actions, disputes, recorder } = realActions(db, { dekByUser: { [alice]: dek } });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT]); // seqs 1..2

    const session = await sessionFor(db, alice);
    const probe = "evil'); DROP TABLE activity_disputes; --";
    const result = await actions.disputeEntry(session, 2, probe);
    assert.equal(result.ok, true, "a SQL-shaped note is inert data — the dispute still files");

    assert.equal(await tableExists(db, "activity_disputes"), true, "the disputes table survives the probe");
    assert.equal(await tableExists(db, "activity_entries"), true, "the entries table survives the probe");

    const read = await disputes.readDisputes(alice, 2);
    assert.equal(read.length, 1, "the dispute is stored");
    assert.equal(read[0]!.note, probe, "the probe round-trips exactly — it was bound, never run as SQL");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the undo reason is inert — the undo still succeeds and the tables survive", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "probe-undo");
    const dek = freshDek();
    const { actions, recorder } = realActions(db, { dekByUser: { [alice]: dek } });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT]); // seq 2 reversible

    const session = await sessionFor(db, alice);
    const probe = "evil'); DROP TABLE activity_entries; --";
    const result = await actions.undoEntry(session, 2, probe);
    assert.equal(result.ok, true, "a SQL-shaped reason is inert data — the undo still succeeds");

    assert.equal(await tableExists(db, "activity_entries"), true, "the entries table survives the probe");
    assert.equal(await entryCount(db, alice), 3, "the undo appended exactly one new entry");
    const integ = await checkIntegrity(db, alice);
    assert.equal(integ.intact, true, "the activity chain still verifies intact after the probe");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC5 — no secret value is folded into a result; the actions work purely from their
// injected seams and read no process.env.
// ===================================================================================

test("the activity actions read no process.env: a decoy env secret never appears in any result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "env-check");
    const dek = freshDek();
    const { actions, recorder } = realActions(db, { dekByUser: { [alice]: dek } });
    await seedChain(recorder, alice, [LIST_EVENTS, CREATE_EVENT, undefined]);

    const session = await sessionFor(db, alice);

    const disputeResult = await actions.disputeEntry(session, 1, "a plain note");
    assert.equal(disputeResult.ok, true, "disputeEntry works purely from its injected seams");
    assert.ok(!JSON.stringify(disputeResult).includes(DECOY), "no ambient env value is folded into the dispute result");

    const undoResult = await actions.undoEntry(session, 2, "a plain reason");
    assert.equal(undoResult.ok, true, "undoEntry works purely from its injected seams");
    assert.ok(!JSON.stringify(undoResult).includes(DECOY), "no ambient env value is folded into the undo result");

    const integResult = await actions.checkIntegrity(session);
    assert.ok(!JSON.stringify(integResult).includes(DECOY), "no ambient env value is folded into the integrity result");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
