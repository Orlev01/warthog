// E18-S11 — the recurring-loop composition root the Next instrumentation entry delegates to.
//
// A Next instrumentation ENTRY file (src/instrumentation.ts) may export only its framework
// fields (`register`, `onRequestError`), so the bootable logic lives here, wired from injected
// deps: boot the in-process scheduler loop AT MOST ONCE and ONLY on the Node server runtime,
// so the approval, notification, connector-health, currency, reminder, metrics, integrity and
// purge loops actually run in the deployed app. This module reads no `process.env`: the entry
// supplies the runtime discriminator and the real seams (its database comes from config, via
// the scheduler the entry injects — never a raw env read at this root).
//
// Every tick failure is redacted before it reaches `log`, so a card number or token in an
// error message never lands in a log, and the failure is never swallowed.

import { redact } from "../../domain/redaction/redact";

export interface SchedulerLoopDeps {
  // process.env.NEXT_RUNTIME, supplied by the entry — "nodejs" on the Node server runtime.
  readonly runtime: string | undefined;
  // Builds the full-registry scheduler once (never rebuilt per tick).
  readonly createScheduler: () => { tick(): Promise<unknown> };
  // The timer seam (the real `setInterval` in production).
  readonly setInterval: (onTick: () => unknown, ms: number) => unknown;
  readonly intervalMs: number;
  // Receives every failure, already redacted.
  readonly log: (entry: unknown) => void;
}

const NODE_RUNTIME = "nodejs";

// A tick failure as a plain, redacted log entry. Released-value matching is not available
// here, so only the pattern rules apply (card numbers, codes, tokens, secret fields).
function failureEntry(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return redact({ level: "error", where: "job-scheduler-tick", error: message }, () => false);
}

// Returns the register() the entry exports: it starts the loop at most once and only on the
// Node server runtime; a repeat call starts no second scheduler.
export function createRegister(deps: SchedulerLoopDeps): () => void {
  const { runtime, createScheduler, setInterval, intervalMs, log } = deps;
  let started = false;

  return function register(): void {
    if (runtime !== NODE_RUNTIME) return;
    if (started) return;
    started = true;

    const scheduler = createScheduler();
    setInterval(
      () =>
        // Drive one tick per firing; redact and log any failure, never swallow it, and never
        // reject the timer callback.
        (async () => {
          try {
            await scheduler.tick();
          } catch (error) {
            log(failureEntry(error));
          }
        })(),
      intervalMs,
    );
  };
}
