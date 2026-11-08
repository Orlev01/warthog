// E18-S21 — In-process job scheduler (`src/server/jobs/scheduler.ts`), reworked into
// two explicit parts: PERIODIC SWEEPS the scheduler runs DIRECTLY on their interval (no
// job rows), and a DISPATCH TABLE for the payload-driven queue rows the drain claims and
// routes by `type`.
//
// RED-first: the reworked `./scheduler` does NOT exist yet (today's scheduler enqueues
// payload-less periodic rows and dispatches from a `jobs: SchedulerJob[]` set), so the
// new `createScheduler({ getDb, clock, sweeps, dispatch, log })` shape and behaviours
// below fail until the builder reworks it. That absence IS the point of test-first — do
// NOT implement anything to make these pass. The claim/run library (`../db/jobs`), the
// clock seam, the registry builders (`./registry`), the approvals / users / fallback job
// modules and the in-memory PGlite (via `src/test/db`) all already exist.
//
// These tests pin BEHAVIOUR (what a tick DOES: which sweeps run, what the drain does to
// the jobs table, which handler each claimed row reaches, that a failure is logged
// through redaction and never aborts the rest), never the source text of the module.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // One periodic background job the scheduler runs DIRECTLY on its interval — no job
//   // row is ever enqueued for it. `run()` is the sweep itself (closed over its seams).
//   interface PeriodicSweep {
//     readonly name: string;
//     readonly intervalMs: number;
//     readonly run: () => void | Promise<void>;
//   }
//
//   interface SchedulerDeps {
//     readonly getDb: () => Promise<Db>;        // resolved per tick (lazy db source)
//     readonly clock: Clock;
//     readonly sweeps: readonly PeriodicSweep[]; // periodic sweeps, run directly
//     // the dispatch table: enqueued `type` → the handler that runs a claimed row.
//     readonly dispatch: Readonly<Record<string, (job: Job) => void | Promise<void>>>;
//     readonly log: (entry: unknown) => void;   // the scheduler REDACTS before calling this
//   }
//
//   function createScheduler(deps: SchedulerDeps): { tick(): Promise<unknown> };
//   function getScheduler(): { tick(): Promise<unknown> };   // memoised per-process
//
// A tick:
//   1. runs every periodic sweep whose interval has elapsed, DIRECTLY (never by enqueuing
//      a payload-less row); a sweep that throws is logged (redacted) and does not stop the
//      other sweeps or the drain;
//   2. drains the runnable rows through `../db/jobs`'s claim/run, dispatching each claimed
//      row to `dispatch[row.type]`; a row whose type has no entry is dead-lettered, a row
//      whose handler throws is retried/failed by the queue library, one failing row never
//      stops the drain of the others, and every failure is logged through redaction.
//
// ───────────────────────────────────────────────────────────────────────────────────
// Acceptance criteria → tests:
//   AC1  a due queue row is claimed and dispatched to its registered handler BY TYPE and
//        marked done; a row already claimed by another tick is not run again; a real
//        enqueued `approval.fallback` row (with its `approvalId` payload) is executed by
//        the drain THROUGH `runApprovalFallback`.
//   AC2  a pending approval past its `expires_at` is expired by the periodic sweep on its
//        next tick; a not-yet-due approval is untouched.
//   AC3  a queued row with an unknown type is dead-lettered (failed, no retry), a throwing
//        handler is retried/failed, and in BOTH cases the other due rows in the SAME drain
//        still run — every failure logged (redacted), never swallowed.
//   AC4  each periodic sweep runs on its interval, DIRECTLY (no payload-less rows); a sweep
//        that throws is logged (redacted) and stops neither the scheduler nor the other
//        sweeps.
//   INV-103 the scheduler runs purely from its injected deps; no ambient env value lands in
//        what it writes.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state. No test touches the network or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";

import { createScheduler, getScheduler } from "./scheduler";
import { buildDispatchTable, buildPeriodicSweeps } from "./registry";

import { enqueue, claim, type Job } from "../db/jobs";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import { fixedRandom } from "../seams/random";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fakeRateSource } from "../currency/rate-source";
import { createApproval } from "../db/approvals";
import { createUser } from "../db/users";
// The EXACT type string production code enqueues for the approval fallback job — imported
// from the module that owns/enqueues it, never retyped (AC1).
import { FALLBACK_JOB_TYPE } from "../notify/approval-notifier";
import type { OutgoingMessage } from "../notify/senders";
import type { Db } from "../db/index";

// A fixed origin instant; time only moves when a test advances it, so "due" is
// deterministic with no wall-clock dependence.
const T0 = new Date("2026-03-01T00:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// A Luhn-valid card number planted inside a thrown error's message, so a test can prove
// the scheduler routes the failure THROUGH redaction before logging: after redaction the
// full number is masked (only the last four survive), so the full string must be absent.
const CARD = "4111111111111111";

// A clock whose "now" the test controls. `advance(ms)` moves it forward so a periodic
// sweep becomes due again.
function mutableClock(start: Date): { clock: Clock; advance(ms: number): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// A handler that records every job it is dispatched. Id-scoped checks against `received`
// survive whatever else a drain processes.
function recorder(): { received: Job[]; handler: (job: Job) => Promise<void> } {
  const received: Job[] = [];
  return {
    received,
    handler: async (job: Job): Promise<void> => {
      received.push(job);
    },
  };
}

// How many times the recorder saw a specific row id.
function timesSeen(received: Job[], id: string): number {
  return received.filter((j) => j.id === id).length;
}

// Read one job row's status straight from the table (behaviour, not source text).
async function statusOf(db: Db, id: string): Promise<string | undefined> {
  const result = await db.query("SELECT status FROM jobs WHERE id = $1", [id]);
  return result.rows[0]?.status as string | undefined;
}

// Read one approval row's status straight from the table (a plaintext column — no
// decryption needed to observe the lifecycle transition the sweep drives).
async function approvalStatus(db: Db, id: string): Promise<string | undefined> {
  const result = await db.query("SELECT status FROM approvals WHERE id = $1", [id]);
  return result.rows[0]?.status as string | undefined;
}

// A COMPLETE seam bundle for the registry builders (`buildDispatchTable` /
// `buildPeriodicSweeps`), built from cheap fakes plus whichever real seams a test needs
// (db, clock, keyWrapper, an email recorder). The builders only ASSEMBLE handlers from
// these seams — the fakes are never invoked unless the matching handler/sweep actually
// runs — so a structural bundle is enough. Returned as a variable (not an inline literal
// at the call site) so its superset of fields stays assignable to the builders' seam type.
function jobSeams(args: {
  db: Db;
  clock: Clock;
  keyWrapper: KeyWrapper;
  onEmail?: (message: OutgoingMessage) => void;
}) {
  return {
    db: args.db,
    clock: args.clock,
    keyWrapper: args.keyWrapper,
    random: fixedRandom(7),
    senders: {
      push: { sendPush: async (): Promise<void> => {} },
      email: {
        sendEmail: async (message: OutgoingMessage): Promise<void> => {
          args.onEmail?.(message);
        },
      },
      sms: { sendSms: async (): Promise<void> => {} },
    },
    push: { sendPush: async (): Promise<void> => {} },
    refresh: async (): Promise<void> => {},
    resetExecutor: {
      eraseVaultData: async (): Promise<void> => {},
      revokeAgentsAndConnections: async (): Promise<void> => {},
    },
    rateSource: fakeRateSource({ rateDate: "2026-03-01", baseCurrency: "AUD", rates: { USD: 0.65 } }),
    publicBaseUrl: "https://warthog.com.au",
  };
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper` (so the expiry
// sweep can recover it), returning the ids a test needs.
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// Arrange a PENDING approval created at `createdAt` (its 15-minute window ends at
// createdAt + 15m), owned by `person`.
async function arrangeApproval(
  db: Db,
  person: { userId: string; dek: Uint8Array },
  createdAt: Date,
): Promise<string> {
  const approval = await createApproval(
    db,
    { userId: person.userId, agentId: randomUUID(), detail: { field: "card", amount: 1 } },
    person.dek,
    fixedClock(createdAt),
  );
  return approval.id;
}

// ===========================================================================
// AC1 — the drain claims a due row and dispatches it to its registered handler BY TYPE.
// ===========================================================================

test("a tick drains a due row and dispatches it to the handler registered for its type, marking it done", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    // Two dispatch entries so we also prove routing goes to the CORRECT handler by type.
    const recA = recorder();
    const recB = recorder();
    const scheduler = createScheduler({
      getDb: async () => db,
      clock,
      sweeps: [],
      dispatch: { "job-a": recA.handler, "job-b": recB.handler },
      log: () => {},
    });

    const row = await enqueue(db, { type: "job-b", runAt: new Date(T0.getTime() - HOUR_MS) });

    await scheduler.tick();

    assert.equal(timesSeen(recB.received, row.id), 1, "job-b's handler ran for the due row once");
    assert.equal(
      recB.received.find((j) => j.id === row.id)?.type,
      "job-b",
      "the handler is dispatched the claimed job (routed by type)",
    );
    assert.equal(timesSeen(recA.received, row.id), 0, "a different type's handler is not dispatched the row");
    assert.equal(await statusOf(db, row.id), "done", "the processed row is marked done");
  } finally {
    await db.close();
  }
});

test("a due row is drained and run exactly once across repeated ticks (idempotent)", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const rec = recorder();
    const scheduler = createScheduler({
      getDb: async () => db,
      clock,
      sweeps: [],
      dispatch: { "job-a": rec.handler },
      log: () => {},
    });

    const row = await enqueue(db, { type: "job-a", runAt: new Date(T0.getTime() - HOUR_MS) });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    assert.equal(timesSeen(rec.received, row.id), 1, "the due row's handler ran exactly once across ticks");
    assert.equal(await statusOf(db, row.id), "done", "the row stays done, never re-claimed");
  } finally {
    await db.close();
  }
});

test("a row already claimed by another tick is not run again", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const rec = recorder();
    const scheduler = createScheduler({
      getDb: async () => db,
      clock,
      sweeps: [],
      dispatch: { "job-a": rec.handler },
      log: () => {},
    });

    const row = await enqueue(db, { type: "job-a", runAt: new Date(T0.getTime() - HOUR_MS) });

    // Another tick/worker claims it first (claim marks it in the same statement).
    const claimed = await claim(db, clock);
    assert.equal(claimed?.id, row.id, "the overdue row is the one another tick claims");
    assert.equal(await statusOf(db, row.id), "claimed", "the row is now claimed by the other tick");

    await scheduler.tick();

    assert.equal(timesSeen(rec.received, row.id), 0, "an already-claimed row's handler is not run again");
    assert.equal(await statusOf(db, row.id), "claimed", "the already-claimed row is left untouched");
  } finally {
    await db.close();
  }
});

test("an idle tick (no sweeps, empty queue) runs nothing, enqueues nothing and does not throw", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const scheduler = createScheduler({ getDb: async () => db, clock, sweeps: [], dispatch: {}, log: () => {} });
    await scheduler.tick();
    const rows = await db.query("SELECT count(*)::int AS n FROM jobs");
    assert.equal(rows.rows[0]?.n, 0, "an idle tick enqueues nothing");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — periodic sweeps run DIRECTLY on their interval, enqueuing no rows.
// ===========================================================================

test("a periodic sweep runs directly on its interval and enqueues no job rows", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    let ran = 0;
    const scheduler = createScheduler({
      getDb: async () => db,
      clock: c.clock,
      sweeps: [{ name: "sweep-a", intervalMs: MINUTE_MS, run: async () => { ran += 1; } }],
      dispatch: {},
      log: () => {},
    });

    await scheduler.tick();
    assert.equal(ran, 1, "a sweep runs on the first tick");

    // A second tick at the SAME instant: the interval has not elapsed, so it does NOT run
    // again — a sweep runs on its interval, not on every tick.
    await scheduler.tick();
    assert.equal(ran, 1, "a sweep does not run again within its interval");

    // Once the interval has elapsed it runs again.
    c.advance(MINUTE_MS);
    await scheduler.tick();
    assert.equal(ran, 2, "a sweep runs again once its interval has elapsed");

    // It ran DIRECTLY: no payload-less job row was ever enqueued (not for its name, not
    // at all).
    const rows = await db.query("SELECT count(*)::int AS n FROM jobs");
    assert.equal(rows.rows[0]?.n, 0, "a periodic sweep runs directly and enqueues no job rows");
  } finally {
    await db.close();
  }
});

test("a sweep that throws is logged (redacted) and stops neither the scheduler nor the other sweeps", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const logs: unknown[] = [];
    let ranOther = 0;
    const scheduler = createScheduler({
      getDb: async () => db,
      clock,
      // The throwing sweep is listed FIRST, so its failure must not prevent the next one.
      sweeps: [
        { name: "boom-sweep", intervalMs: MINUTE_MS, run: async () => { throw new Error(`SWEEP_BOOM ${CARD}`); } },
        { name: "ok-sweep", intervalMs: MINUTE_MS, run: async () => { ranOther += 1; } },
      ],
      dispatch: {},
      log: (entry) => logs.push(entry),
    });

    // The tick must resolve (not reject) even though a sweep threw.
    await scheduler.tick();

    assert.equal(ranOther, 1, "a throwing sweep does not stop the other sweeps from running");
    assert.ok(logs.length > 0, "the failing sweep is logged, never swallowed");

    const logged = logs.map((e) => JSON.stringify(e)).join("\n");
    assert.ok(logged.includes("SWEEP_BOOM"), "the sweep's failure (its error) is logged");
    assert.ok(
      !logged.includes(CARD),
      "the logged failure passed through redaction (the card number is masked, not leaked)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the drain dead-letters unknown types, retries/continues past a throwing row, and
// logs every failure (redacted); one failing row never stops the others.
// ===========================================================================

test("the drain dead-letters an unknown type, retries a throwing handler, and still runs the other due rows — logging failures redacted", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const logs: unknown[] = [];
    const good = recorder();
    const scheduler = createScheduler({
      getDb: async () => db,
      clock,
      sweeps: [],
      dispatch: {
        "good.type": good.handler,
        "throws.type": async () => { throw new Error(`DRAIN_BOOM ${CARD}`); },
        // "unknown.type" intentionally absent from the dispatch table.
      },
      log: (entry) => logs.push(entry),
    });

    const overdue = new Date(T0.getTime() - HOUR_MS);
    const rowGood = await enqueue(db, { type: "good.type", runAt: overdue });
    const rowThrows = await enqueue(db, { type: "throws.type", runAt: overdue });
    const rowUnknown = await enqueue(db, { type: "unknown.type", runAt: overdue });

    await scheduler.tick();

    // The good row ran to done EVEN THOUGH the other two rows in the same drain failed.
    assert.equal(timesSeen(good.received, rowGood.id), 1, "a good row still runs when other rows in the drain fail");
    assert.equal(await statusOf(db, rowGood.id), "done", "the good row is marked done");

    // The unknown-type row is dead-lettered: marked failed, never retried.
    assert.equal(await statusOf(db, rowUnknown.id), "failed", "an unknown-type row is dead-lettered (failed)");

    // The throwing row is retried (re-queued pending with a backoff) or failed — never
    // done, never lost.
    const throwsStatus = await statusOf(db, rowThrows.id);
    assert.notEqual(throwsStatus, "done", "a throwing row is never marked done");
    assert.ok(
      throwsStatus === "pending" || throwsStatus === "failed",
      `a throwing row is retried or failed, got ${throwsStatus}`,
    );

    // Failures are logged, redacted, never swallowed.
    assert.ok(logs.length > 0, "drain failures are logged, never swallowed");
    const logged = logs.map((e) => JSON.stringify(e)).join("\n");
    assert.ok(logged.includes("DRAIN_BOOM"), "the throwing row's failure (its error) is logged");
    assert.ok(
      !logged.includes(CARD),
      "the logged drain failure passed through redaction (the card number is masked, not leaked)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — a REAL enqueued approval.fallback row is executed by the drain THROUGH
// runApprovalFallback (wired via the registry's dispatch table, keyed on the module's
// exported type constant).
// ===========================================================================

test("a real approval.fallback row (with its approvalId payload) is executed by the drain through runApprovalFallback", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    // A real pending, unopened approval owned by a real person.
    const person = await makePerson(db, "fallback", keyWrapper);
    const approvalId = await arrangeApproval(db, person, T0);

    // The dispatch table wired from the registry, with a recording email sender so we can
    // observe the fallback job's effect, and the SAME db it drains.
    const emails: OutgoingMessage[] = [];
    const seams = jobSeams({ db, clock: fixedClock(T0), keyWrapper, onEmail: (m) => emails.push(m) });
    const dispatch = buildDispatchTable(seams);

    // The dispatch table is keyed on the EXACT enqueued type string.
    assert.equal(typeof dispatch[FALLBACK_JOB_TYPE], "function", "the dispatch table has an approval.fallback entry");

    const scheduler = createScheduler({
      getDb: async () => db,
      clock: fixedClock(T0),
      sweeps: [],
      dispatch,
      log: () => {},
    });

    // The real queue row production enqueues: carrying the approval id in its payload.
    const row = await enqueue(db, {
      type: FALLBACK_JOB_TYPE,
      payload: { approvalId },
      runAt: new Date(T0.getTime() - HOUR_MS),
    });

    await scheduler.tick();

    // runApprovalFallback ran end-to-end through the drain: it issued the single-use link
    // (an approval_links row for this approval) and sent the fallback email.
    const links = await db.query("SELECT count(*)::int AS n FROM approval_links WHERE approval_id = $1", [approvalId]);
    assert.ok(
      Number(links.rows[0]?.n) > 0,
      "the drain executed runApprovalFallback (a single-use approval link was issued)",
    );
    assert.equal(emails.length, 1, "the fallback job sent exactly one email through the injected sender");
    assert.equal(await statusOf(db, row.id), "done", "the fallback row is marked done once handled");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the periodic approval-expiry sweep expires a pending, past-due approval on its
// next tick, and leaves a not-yet-due approval untouched.
// ===========================================================================

test("the approval-expiry sweep expires a past-due pending approval on its next tick and leaves a not-yet-due one", async () => {
  const NOW = new Date("2026-11-15T12:00:00.000Z"); // the sweep's "now"
  // Created a day ago, so its window (whatever its exact length) has long since ended →
  // past-due at NOW. Created AT NOW, so its window is still open → not yet due at NOW.
  // (Robust to the approval window's exact length — no 15-minute assumption.)
  const CREATED_DUE = new Date(NOW.getTime() - DAY_MS);
  const CREATED_NOT_DUE = NOW;
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const person = await makePerson(db, "expiry", keyWrapper);
    const dueId = await arrangeApproval(db, person, CREATED_DUE); // expires_at < NOW
    const notDueId = await arrangeApproval(db, person, CREATED_NOT_DUE); // expires_at > NOW

    assert.equal(await approvalStatus(db, dueId), "pending", "precondition: the overdue approval starts pending");
    assert.equal(await approvalStatus(db, notDueId), "pending", "precondition: the not-due approval starts pending");

    const c = mutableClock(NOW);
    // Build the real periodic sweeps and pick the approval-expiry one (the only one this
    // test runs), wired with the real db + keyWrapper + the sweep's clock.
    const sweeps = buildPeriodicSweeps(jobSeams({ db, clock: c.clock, keyWrapper }));
    const expirySweep = sweeps.find((s) => s.name === "approval-expiry");
    assert.ok(expirySweep, "buildPeriodicSweeps must include the approval-expiry sweep");

    const scheduler = createScheduler({
      getDb: async () => db,
      clock: c.clock,
      sweeps: [expirySweep!],
      dispatch: {},
      log: () => {},
    });

    await scheduler.tick();

    assert.equal(await approvalStatus(db, dueId), "expired", "a pending approval past its expiry is expired by the sweep");
    assert.equal(await approvalStatus(db, notDueId), "pending", "a not-yet-due approval is left untouched");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// getScheduler — a single memoised per-process instance (never re-instantiated per call).
// ===========================================================================

test("getScheduler returns the same memoised instance on every call (never re-instantiated per call)", () => {
  // A fully valid development environment, set defensively in case the composition root
  // reads config while constructing the memoised instance. It is restored afterwards so
  // no other test observes it. (A correct, lazy getScheduler reads the database URL from
  // config only when a tick opens the database, so this env is harmless either way.)
  const env: Record<string, string> = {
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "http://localhost:3000",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_DEV_TOOLS: "1",
    WARTHOG_HMAC_KEY: Buffer.alloc(48, 0x2a).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 0x5c).toString("base64"),
  };
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const first = getScheduler();
    const second = getScheduler();
    assert.equal(first, second, "getScheduler is memoised per-process: the same instance every call");
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

// ===========================================================================
// INV-103 — the scheduler runs purely from its injected deps; no ambient env value lands
// in what it writes (periodic sweeps run directly, so the only thing it writes is the
// claim/mark of a drained row).
// ===========================================================================

test("a tick folds no ambient env secret into what it writes (config is read from env, not arbitrary process.env)", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_scheduler";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const rec = recorder();
    const scheduler = createScheduler({
      getDb: async () => db,
      clock,
      sweeps: [{ name: "sweep-a", intervalMs: MINUTE_MS, run: async () => {} }],
      dispatch: { "work.item": rec.handler },
      log: () => {},
    });

    // A benign dispatch row the drain processes, so there IS a written/updated row to scan.
    await enqueue(db, { type: "work.item", runAt: new Date(T0.getTime() - HOUR_MS) });
    await scheduler.tick();

    const all = await db.query("SELECT * FROM jobs");
    assert.ok(all.rows.length > 0, "the scheduler processed jobs rows to scan");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        const text = typeof cell === "string" ? cell : JSON.stringify(cell);
        assert.ok(!text.includes(DECOY), "no ambient env value is folded into a job the scheduler writes");
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Ticks never overlap (review finding: the interval timer fires regardless of whether the
// previous tick finished, so long drains ran concurrently with the next tick's sweeps and
// drain — overlapping approval-expiry runs, and a lease-lapsed row reclaimed while its
// first handler was still running).
// ===========================================================================

test("a tick that fires while the previous one is still running does nothing", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    let running = 0;
    let maxConcurrent = 0;
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const scheduler = createScheduler({
      getDb: async () => db,
      clock: c.clock,
      sweeps: [
        {
          name: "slow-sweep",
          intervalMs: MINUTE_MS,
          run: async () => {
            runs += 1;
            running += 1;
            maxConcurrent = Math.max(maxConcurrent, running);
            markStarted();
            await gate;
            running -= 1;
          },
        },
      ],
      dispatch: {},
      log: () => {},
    });

    const first = scheduler.tick();
    await started;
    // The timer fires again (twice) after the interval, while the first tick is stuck.
    c.advance(MINUTE_MS);
    await scheduler.tick();
    c.advance(MINUTE_MS);
    await scheduler.tick();
    assert.equal(runs, 1, "the overlapping ticks ran nothing");

    release();
    await first;
    assert.equal(maxConcurrent, 1, "the sweep never ran concurrently with itself");

    // Once the first tick has finished, the next one runs normally.
    await scheduler.tick();
    assert.equal(runs, 2, "a tick after the previous one finished runs the due sweep");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// A sweep's schedule survives a restart and is shared by every instance (review finding: the
// "when did this sweep last run" state lived in an in-memory Map, so every deploy or restart
// re-ran every sweep on its first tick — re-sending integrity alerts, duplicating metric
// snapshots — and two revisions overlapping during a deploy both ran every sweep).
// ===========================================================================

test("a restarted scheduler does not re-run a sweep inside its interval, and two instances never both run it", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    let runs = 0;
    const make = () =>
      createScheduler({
        getDb: async () => db,
        clock: c.clock,
        sweeps: [{ name: "daily-sweep", intervalMs: DAY_MS, run: async () => void (runs += 1) }],
        dispatch: {},
        log: () => {},
      });

    await make().tick();
    assert.equal(runs, 1, "the first boot runs the sweep");

    // A deploy an hour later: a brand-new scheduler over the same database.
    c.advance(HOUR_MS);
    await make().tick();
    assert.equal(runs, 1, "the restarted scheduler does not run it again inside its interval");

    // Two instances (overlapping revisions) tick at once once the interval has passed.
    c.advance(DAY_MS);
    await Promise.all([make().tick(), make().tick()]);
    assert.equal(runs, 2, "exactly one of them runs the now-due sweep");
  } finally {
    await db.close();
  }
});
