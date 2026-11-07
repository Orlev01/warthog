// The in-process job scheduler (E18-S21). A tick does two things:
//
//   1. Runs every periodic sweep whose interval has elapsed, DIRECTLY — no job row is
//      ever enqueued for a sweep. A sweep that throws is logged (redacted) and stops
//      neither the other sweeps nor the drain.
//   2. Drains the runnable queue rows through the claim/run library, which dispatches
//      each claimed row by its enqueued `type`. A row whose type has no handler is
//      dead-lettered and a throwing handler is retried with backoff then failed (both by
//      the library); either way the failure is logged (redacted) and the drain carries on
//      with the other due rows.
//
// Every failure reaches `log` only after redaction, so a card number or token in an error
// message never lands in a log. `getScheduler()` is the process-wide instance built from
// the real seams (src/server/jobs/compose.ts); `createScheduler()` takes injected deps.

import { run, type DispatchTable } from "../db/jobs";
import { redact } from "../../domain/redaction/redact";
import { processSingleton } from "../seams/process-singleton";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";
import type { PeriodicSweep } from "./registry";

export type { PeriodicSweep } from "./registry";

export interface SchedulerDeps {
  // Resolved per tick, so constructing a scheduler touches no database.
  readonly getDb: () => Promise<Db>;
  readonly clock: Clock;
  readonly sweeps: readonly PeriodicSweep[];
  readonly dispatch: DispatchTable;
  // Receives every failure, already redacted.
  readonly log: (entry: unknown) => void;
}

export interface Scheduler {
  tick(): Promise<unknown>;
}

// A drain processes at most this many rows per tick, so a misbehaving queue can never
// pin a tick in an endless loop.
const MAX_ROWS_PER_TICK = 500;

// A failure as a plain, redacted log entry. Released-value matching is not available
// here, so only the pattern rules apply (card numbers, codes, tokens, secret fields).
function failureEntry(where: string, name: string, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return redact({ level: "error", where, name, error: message }, () => false);
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { getDb, clock, sweeps, dispatch, log } = deps;
  const nextRunAt = new Map<string, number>();

  async function runDueSweeps(): Promise<void> {
    const nowMs = clock.now().getTime();
    for (const sweep of sweeps) {
      const dueAt = nextRunAt.get(sweep.name) ?? nowMs;
      if (nowMs < dueAt) continue;
      nextRunAt.set(sweep.name, nowMs + sweep.intervalMs);
      try {
        await sweep.run();
      } catch (error) {
        log(failureEntry("sweep", sweep.name, error));
      }
    }
  }

  async function drain(db: Db): Promise<void> {
    for (let processed = 0; processed < MAX_ROWS_PER_TICK; processed++) {
      try {
        if ((await run(db, clock, dispatch)) === null) return;
      } catch (error) {
        // The library has already dead-lettered or re-queued the row; log and carry on.
        log(failureEntry("drain", "job", error));
      }
    }
  }

  return {
    async tick(): Promise<void> {
      await runDueSweeps();
      await drain(await getDb());
    },
  };
}

// The process-wide scheduler over the real seams (kept on globalThis, so every module
// graph Next builds shares one). Its seams are composed lazily on the first tick.
export function getScheduler(): Scheduler {
  return processSingleton("jobs.scheduler", () => {
    let inner: Scheduler | undefined;
    return {
      async tick(): Promise<unknown> {
        if (!inner) {
          const { composeScheduler } = await import("./compose");
          inner = await composeScheduler();
        }
        return inner.tick();
      },
    };
  });
}
