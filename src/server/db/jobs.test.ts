// E01-S11 — Background jobs table + claim/run library (`src/server/db/jobs.ts`,
// `db/migrations/0002_jobs.sql`).
//
// RED-first: neither the library module nor the migration exists yet, so importing
// `./jobs` throws and `freshDb()` has no `jobs` table — every test here fails until
// the builder adds them. That absence IS the point of test-first; do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR (what claim/run DO and what the migration produces),
// never the source text of the module or the SQL file.
//
// The contract this task's tests define:
//   enqueue(db, { type, payload?, runAt }): Promise<Job>
//     • inserts a background job due at `runAt`, returns the created job (with id).
//       `payload` is optional (a job may carry no data).
//   claim(db, clock): Promise<Job | null>
//     • selects ONE due job (run_at <= clock.now()) and marks it claimed, so a
//       later/concurrent claim never returns the same job (FOR UPDATE SKIP LOCKED);
//       returns the claimed job, or null when nothing is due/claimable.
//   run(db, clock, handler): Promise<Job | null>
//     • claims the next due job and runs `handler(job)`. A job that throws stays
//       retryable (it is claimed again on a later run); a job that succeeds is never
//       run again (idempotent). Returns the processed job, or null if none was due.
//   Job = { id: string; type: string; payload?: unknown; ... }
//
// Acceptance criteria → tests:
//   AC1 "claim() selects one due job with FOR UPDATE SKIP LOCKED so two concurrent
//        claims never return the same job." PGlite is a single in-process connection,
//        so true cross-connection concurrency cannot be exercised offline; the
//        GUARANTEE is characterized behaviourally — claim marks the job it hands out,
//        so serial claims return distinct jobs and a claimed job is never re-handed.
//        (Cross-connection SKIP LOCKED is exercised only against a real Postgres.)
//   AC2 "A job that throws is retried and a successful job is not re-run (idempotent)."
//   AC3 "The migration second run changes nothing." — proven through the real runner:
//        after the project migrations the `jobs` relation exists, and re-running every
//        migration over the same database applies nothing new and does not throw.
//
// All db handles are closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.
import { test } from "node:test";
import assert from "node:assert/strict";

import { enqueue, claim, run } from "./jobs";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations } from "./index";
import type { Clock } from "../seams/clock";

// A fixed origin instant; time only moves when a test advances it.
const T0 = new Date("2026-01-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

// A clock whose "now" the test controls. `advance(ms)` moves it forward so a
// retried job becomes due again and a scheduled-for-later job eventually fires —
// deterministically, with no wall-clock dependence and no backoff flakiness.
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

// --- claim: selects a due job, skips jobs not yet due -------------------------------

test("claim returns null when there are no jobs", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    assert.ok((await claim(db, clock)) == null, "an empty queue yields no claim");
  } finally {
    await db.close();
  }
});

test("claim returns a due job with its id and type", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const created = await enqueue(db, { type: "purge", runAt: clock.now() });
    const claimed = await claim(db, clock);

    assert.ok(claimed != null, "a due job must be claimable");
    assert.equal(typeof claimed?.id, "string", "a claimed job carries a string id");
    assert.equal(claimed?.id, created.id, "claim returns the job that was enqueued");
    assert.equal(claimed?.type, "purge", "claim returns the job's type");
  } finally {
    await db.close();
  }
});

test("claim selects only DUE jobs — a job scheduled in the future is skipped until its time", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const future = new Date(c.clock.now().getTime() + HOUR_MS); // +1h
    const created = await enqueue(db, { type: "fallback", runAt: future });

    const tooEarly = await claim(db, c.clock);
    assert.ok(tooEarly == null, "a job whose run_at is in the future is not yet due");

    c.advance(2 * HOUR_MS); // now past the scheduled time
    const nowDue = await claim(db, c.clock);
    assert.ok(nowDue != null, "once its run_at has passed, the job becomes claimable");
    assert.equal(nowDue?.id, created.id);
  } finally {
    await db.close();
  }
});

// --- AC1: two claims never return the same job (claimed = not re-handed) ------------

test("two claims never return the same job; a claimed job is not handed out again (FOR UPDATE SKIP LOCKED)", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const a = await enqueue(db, { type: "integrity", runAt: clock.now() });
    const b = await enqueue(db, { type: "integrity", runAt: clock.now() });

    const first = await claim(db, clock);
    const second = await claim(db, clock);

    assert.ok(first != null && second != null, "both due jobs must be claimable");
    assert.notEqual(first?.id, second?.id, "two claims must never return the same job");
    assert.deepEqual(
      new Set([first?.id, second?.id]),
      new Set([a.id, b.id]),
      "the two claims return the two enqueued jobs, each exactly once",
    );

    // Both jobs are now claimed; a third claim has nothing left to hand out.
    const third = await claim(db, clock);
    assert.ok(third == null, "a claimed job must not be handed out to a second claimer");
  } finally {
    await db.close();
  }
});

// --- run: executes the handler for the claimed job ----------------------------------

test("run claims the next due job and executes the handler with it; run on an idle queue returns null", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const created = await enqueue(db, { type: "refresh", runAt: clock.now() });

    let received: { id?: string; type?: string } | undefined;
    const processed = await run(db, clock, async (job) => {
      received = job;
    });

    assert.ok(processed != null, "run must process the one due job");
    assert.ok(received, "the handler must be invoked for the claimed job");
    assert.equal(received?.type, "refresh", "the handler receives the claimed job's type");
    assert.equal(received?.id, created.id, "the handler receives the job that was enqueued");

    // Nothing is due now: a second run finds no job and runs no handler.
    let ranAgain = false;
    const idle = await run(db, clock, async () => {
      ranAgain = true;
    });
    assert.ok(idle == null, "run returns null when no job is due");
    assert.equal(ranAgain, false, "run must not invoke the handler when nothing is due");
  } finally {
    await db.close();
  }
});

// --- AC2: a throw is retried; a success is not re-run (idempotent) ------------------

test("a job that throws is retried, and a job that succeeds is not re-run (idempotent)", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    await enqueue(db, { type: "reminder", runAt: c.clock.now() });

    let calls = 0;
    const handler = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) throw new Error("transient failure on the first attempt");
    };

    // First attempt: the handler throws. The job must not be lost — whether run
    // records the failure or surfaces it, the job stays retryable. Tolerate either
    // error-propagation style by ignoring a throw here; the retry assertion is the
    // real contract.
    try {
      await run(db, c.clock, handler);
    } catch {
      /* a surfaced failure is acceptable */
    }
    assert.equal(calls, 1, "the failing job's handler ran exactly once on the first attempt");

    // Time passes, generously, to clear any retry backoff the runner may apply.
    c.advance(24 * HOUR_MS);

    // Second attempt: the job is retried and now succeeds.
    const retried = await run(db, c.clock, handler);
    assert.ok(retried != null, "the failed job must be retried on a later run");
    assert.equal(calls, 2, "the retried job's handler ran a second time");

    // More time passes; the job already succeeded, so it must never run again.
    c.advance(24 * HOUR_MS);
    const afterSuccess = await run(db, c.clock, handler);
    assert.ok(afterSuccess == null, "a succeeded job is not claimed again (nothing due)");
    assert.equal(calls, 2, "a succeeded job's handler is never invoked again (idempotent)");
  } finally {
    await db.close();
  }
});

// --- payload round-trips through the queue ------------------------------------------

test("a job's structured payload round-trips through enqueue and claim", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const payload = { connectionId: "11111111-1111-1111-1111-111111111111", attempt: 1 };
    await enqueue(db, { type: "refresh", payload, runAt: clock.now() });

    const claimed = await claim(db, clock);
    assert.ok(claimed != null, "the due job must be claimable");
    assert.deepEqual(
      claimed?.payload,
      payload,
      "the payload is stored and returned structurally (jsonb), not mangled or dropped",
    );
  } finally {
    await db.close();
  }
});

// --- AC3: the migration applies and a second run changes nothing --------------------

test("the jobs migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // 0002_jobs applied: the `jobs` relation exists. `to_regclass` yields the relation
    // name when it exists and NULL otherwise — a non-throwing probe scoped to the one
    // table under test (behaviour, not source text).
    const probe = await db.query("SELECT to_regclass('jobs') AS t");
    assert.ok(probe.rows[0]?.t != null, "the jobs table must exist after the project migrations");

    // The project migration set includes the jobs migration (its recorded name is the
    // task's named deliverable, stable once applied).
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0002_jobs"),
      "db/migrations/0002_jobs.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0002's CREATE would throw "already exists", so an empty result
    // AND no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
