// E18-S10 — In-process job scheduler (`src/server/jobs/scheduler.ts`).
//
// RED-first: `./scheduler` does NOT exist yet, so importing `createScheduler` /
// `getScheduler` throws and every test here fails until the builder writes the
// minimum code to pass. That absence IS the point of test-first — do NOT implement
// anything to make these pass; the builder writes `scheduler.ts` afterwards. The
// claim/run library (`../db/jobs`), the clock seam, the registry (E18-S09) and the
// in-memory PGlite Queryable (via `src/test/db`) all already exist.
//
// These tests pin BEHAVIOUR (what a tick DOES to the jobs table and which handler it
// runs), never the source text of the module. Every test drives the injectable
// `createScheduler` factory against an isolated in-memory PGlite (the project's real
// driver seam with a `pglite:memory` URL) with a registry of handlers the test
// controls, so no test touches the network or Azure, and a later behaviour-preserving
// refactor stays green.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // One periodic background job the scheduler ticks. `name` is matched against a
//   // claimed row's `type` to dispatch it (exactly as the connector dispatcher routes
//   // `run(db, clock, handler)` work by `job.type`); `intervalMs` is the schedule it is
//   // enqueued on; `handler(job)` is run for a claimed row of that type.
//   interface SchedulerJob {
//     readonly name: string;
//     readonly intervalMs: number;
//     readonly handler: (job: Job) => void | Promise<void>;
//   }
//
//   interface SchedulerDeps {
//     readonly getDb: () => Promise<Db>;           // resolved per tick (lazy db source)
//     readonly clock: Clock;
//     readonly jobs: readonly SchedulerJob[];      // the injected registry
//   }
//
//   function createScheduler(deps: SchedulerDeps): { tick(): Promise<unknown> };
//   function getScheduler(): { tick(): Promise<unknown> };   // memoised per-process
//
// A `getDb` function (not a resolved `Db`) is the db source so the per-process
// `getScheduler()` can stay lazy: it wires `getServerDb()` (which reads the database
// URL from config and selects the in-process PGlite Queryable for a `pglite:` URL and
// the real pool for a `postgres://` one — the ONE composition root, keyed on the URL
// scheme) WITHOUT opening a database at construction time.
//
// ───────────────────────────────────────────────────────────────────────────────────
// Acceptance criteria → tests:
//
//   AC1 "With a job registered and a due row in the jobs table, one scheduler tick
//        claims the row and runs its handler, and a row already claimed by another tick
//        is not run a second time."
//          → "a tick claims a due row and dispatches it to its registered handler by
//            type, marking the row done",
//          → "a due row is never run a second time across repeated ticks (idempotent)",
//          → "a row already claimed by another tick is not run again".
//        A due row is enqueued OVERDUE (run_at well in the past) so `claim` — which
//        orders by run_at ASC — hands it out before any row a periodic enqueue may add
//        at `now`; and every "ran / not ran" assertion is scoped to that row's own id,
//        so it holds whether or not a tick also enqueues periodic rows of the same type
//        and whether a tick drains the queue or runs one row.
//
//   AC2 "The scheduler is a single memoised per-process instance (never re-instantiated
//        per call), reads the database URL from config, and uses the in-memory Queryable
//        when that URL starts with 'memory:' so the job loop is drivable under next dev."
//          → "getScheduler returns the same instance on every call (memoised)".
//        In THIS project the in-memory branch is NOT a `startsWith('memory:')` check in
//        the scheduler: the project addendum forbids `createDb` in composition code and
//        routes the database through `getServerDb()` → `createDb(loadConfig().databaseUrl)`,
//        which selects the in-process PGlite Queryable for a `pglite:` URL (see
//        src/server/db/index.ts, covered by its own tests). The behavioural heart of AC2
//        — "the job loop runs against the in-memory Queryable with no Postgres" — is what
//        every tick test below exercises: each drives `createScheduler({ getDb, ... })`
//        with an injected in-memory `Db` from `freshDb()`. (The 'memory:' wording is noted
//        as superseded by the project's getServerDb/`pglite:` convention.)
//
//   AC3 [obligation:secrets-from-env] (INV-103) "No secret value is present in source,
//        the client bundle, or the build context; config is read from env."
//          → "a tick folds no ambient env secret into the jobs it writes": the scheduler
//            runs purely from its injected db + clock + registry, reading the database URL
//            through config (never arbitrary `process.env`), so a decoy secret planted in
//            the environment never lands in an enqueued job row.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { createScheduler, getScheduler } from "./scheduler";

import { enqueue, claim, type Job } from "../db/jobs";
import { freshDb } from "../../test/db";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

// A fixed origin instant; time only moves when a test advances it, so "due" is
// deterministic with no wall-clock dependence.
const T0 = new Date("2026-03-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A clock whose "now" the test controls. `advance(ms)` moves it forward so a periodic
// job becomes due again and a scheduled-for-later row eventually fires.
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

// A handler that records every job it is dispatched. Scoped id checks against
// `received` survive any periodic rows a tick may also enqueue and run.
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

// ===========================================================================
// AC1 — a tick claims a due row and dispatches it to its registered handler.
// ===========================================================================

test("a tick claims a due row and dispatches it to its registered handler by type, marking the row done", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    // Two registered jobs so we also prove dispatch routes to the CORRECT handler by
    // type. Large intervals keep periodic enqueue from crowding the assertions (the
    // id-scoped checks would hold regardless).
    const recA = recorder();
    const recB = recorder();
    const jobs = [
      { name: "job-a", intervalMs: DAY_MS, handler: recA.handler },
      { name: "job-b", intervalMs: DAY_MS, handler: recB.handler },
    ];
    const scheduler = createScheduler({ getDb: async () => db, clock, jobs });

    // A due (overdue) row of type job-b: claim() orders by run_at ASC, so this row is
    // handed out before any row a periodic enqueue adds at `now`.
    const row = await enqueue(db, { type: "job-b", runAt: new Date(T0.getTime() - HOUR_MS) });

    await scheduler.tick();

    // The row's registered handler ran for it, exactly once...
    assert.equal(timesSeen(recB.received, row.id), 1, "job-b's handler ran for the due row once");
    const got = recB.received.find((j) => j.id === row.id);
    assert.equal(got?.type, "job-b", "the handler is dispatched the claimed job (routed by type)");

    // ...and the OTHER job's handler was never dispatched this row (routing is by type).
    assert.equal(timesSeen(recA.received, row.id), 0, "a different job's handler is not dispatched the row");

    // The claim/run library marked the processed row done, so it is never claimed again.
    assert.equal(await statusOf(db, row.id), "done", "the processed row is marked done");
  } finally {
    await db.close();
  }
});

test("a due row is never run a second time across repeated ticks (idempotent)", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const rec = recorder();
    const jobs = [{ name: "job-a", intervalMs: DAY_MS, handler: rec.handler }];
    const scheduler = createScheduler({ getDb: async () => db, clock, jobs });

    const row = await enqueue(db, { type: "job-a", runAt: new Date(T0.getTime() - HOUR_MS) });

    // Tick several times at the SAME instant: the row is claimed and run on the first
    // tick (marked done) and must never be claimed or run again on later ticks.
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
    const jobs = [{ name: "job-a", intervalMs: DAY_MS, handler: rec.handler }];
    const scheduler = createScheduler({ getDb: async () => db, clock, jobs });

    const row = await enqueue(db, { type: "job-a", runAt: new Date(T0.getTime() - HOUR_MS) });

    // Simulate another tick/worker having already claimed this row (FOR UPDATE SKIP
    // LOCKED marks it in the same statement that selects it, so it leaves 'pending').
    const claimed = await claim(db, clock);
    assert.equal(claimed?.id, row.id, "the overdue row is the one another tick claims");
    assert.equal(await statusOf(db, row.id), "claimed", "the row is now claimed by the other tick");

    await scheduler.tick();

    // Our scheduler never re-runs the already-claimed row: claim selects only pending
    // rows, so this row is skipped and its handler is not dispatched it a second time.
    assert.equal(timesSeen(rec.received, row.id), 0, "an already-claimed row's handler is not run again");
    assert.equal(await statusOf(db, row.id), "claimed", "the already-claimed row is left untouched");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1/What — a tick enqueues DUE PERIODIC jobs and runs them via claim/run.
// ===========================================================================

test("a tick enqueues a due periodic job into the table, then claims and runs its handler", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const rec = recorder();
    // A short interval so the job is due within the ticks below. The table starts
    // empty, so the ONLY way the handler can run is the scheduler enqueueing the
    // periodic job itself and then claiming + running it.
    const jobs = [{ name: "periodic-a", intervalMs: 60_000, handler: rec.handler }];
    const scheduler = createScheduler({ getDb: async () => db, clock: c.clock, jobs });

    // Tick across a generous span, advancing past the interval each time, so the
    // periodic job becomes due, is enqueued, and is claimed + run regardless of whether
    // the scheduler enqueues it due-now (same-tick) or due at the next interval.
    for (let i = 0; i < 5; i += 1) {
      await scheduler.tick();
      c.advance(60_000);
    }

    assert.ok(rec.received.length > 0, "the periodic job's handler ran at least once");
    assert.equal(
      rec.received[0]?.type,
      "periodic-a",
      "the handler is dispatched a job whose type is the periodic job's name",
    );

    // The scheduler enqueued a real row of that type (keyed on the job name) and the
    // claim/run library marked it done.
    const rows = await db.query("SELECT status FROM jobs WHERE type = $1", ["periodic-a"]);
    assert.ok(rows.rows.length > 0, "a periodic-a row was enqueued into the jobs table");
    assert.ok(
      rows.rows.some((r) => r.status === "done"),
      "a periodic-a row was claimed and run to done",
    );
  } finally {
    await db.close();
  }
});

test("a tick with nothing registered and an empty queue runs no handler and does not throw", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const scheduler = createScheduler({ getDb: async () => db, clock, jobs: [] });
    await scheduler.tick(); // an idle tick is a no-op, not an error
    const rows = await db.query("SELECT count(*)::int AS n FROM jobs");
    assert.equal(rows.rows[0]?.n, 0, "an idle tick with no jobs enqueues nothing");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a single memoised per-process instance.
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
// AC3 [obligation:secrets-from-env] (INV-103) — the scheduler reads no ambient
// env secret; a decoy planted in the environment never lands in a written job.
// ===========================================================================

test("a tick folds no ambient env secret into the jobs it writes (config is read from env, not arbitrary process.env)", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_scheduler";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const rec = recorder();
    const jobs = [{ name: "periodic-a", intervalMs: 60_000, handler: rec.handler }];
    const scheduler = createScheduler({ getDb: async () => db, clock: c.clock, jobs });

    // Drive the scheduler so it actually writes rows (periodic enqueue) and runs them.
    for (let i = 0; i < 3; i += 1) {
      await scheduler.tick();
      c.advance(60_000);
    }

    const all = await db.query("SELECT * FROM jobs");
    assert.ok(all.rows.length > 0, "the scheduler wrote jobs rows to scan");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        const text = typeof cell === "string" ? cell : JSON.stringify(cell);
        assert.ok(
          !text.includes(DECOY),
          "no ambient env value is folded into a job the scheduler writes",
        );
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
