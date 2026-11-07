// Next calls register() once at server start-up (per runtime). On the Node server runtime this
// boots the in-process job scheduler loop exactly once, wired to the full registry — the
// approval, notification, connector-health, currency, reminder, metrics, integrity and purge
// loops — so they actually run in the deployed app. Off the Node runtime (the edge runtime)
// nothing starts.
//
// The bootable logic lives in the sibling seam src/server/jobs/start.ts; this entry only wires
// the real deps in. The database is NOT read from the environment here: getScheduler composes
// it from validated config (compose.ts → getServerDb → loadConfig().databaseUrl, branching the
// pglite:/postgres scheme). The only env this entry reads is the framework runtime
// discriminator NEXT_RUNTIME, which the config module does not own.

import { createRegister } from "./server/jobs/start";
import { getScheduler } from "./server/jobs/scheduler";

// The loop fires on this interval; each periodic sweep gates itself on its own longer interval,
// so a one-minute tick serves every sweep and drains the queue promptly.
const TICK_INTERVAL_MS = 60 * 1000;

export const register = createRegister({
  runtime: process.env.NEXT_RUNTIME,
  createScheduler: getScheduler,
  setInterval: (onTick, ms) => setInterval(onTick, ms),
  intervalMs: TICK_INTERVAL_MS,
  log: (entry) => console.error("[warthog jobs]", JSON.stringify(entry)),
});
