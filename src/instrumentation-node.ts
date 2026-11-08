// The Node-runtime half of src/instrumentation.ts, imported only when NEXT_RUNTIME is "nodejs"
// (Next also compiles instrumentation for the edge runtime, where pg's fs/net imports cannot
// resolve). It checks the runtime config, then wires the job scheduler loop over the tested
// createRegister seam.

import { loadConfig } from "./server/config";
import { createRegister } from "./server/jobs/start";
import { getScheduler } from "./server/jobs/scheduler";

// The loop fires on this interval; each periodic sweep gates itself on its own longer interval,
// so a one-minute tick serves every sweep and drains the queue promptly.
const TICK_INTERVAL_MS = 60 * 1000;

const startScheduler = createRegister({
  runtime: process.env.NEXT_RUNTIME,
  createScheduler: getScheduler,
  setInterval: (onTick, ms) => setInterval(onTick, ms),
  intervalMs: TICK_INTERVAL_MS,
  log: (entry) => console.error("[warthog jobs]", JSON.stringify(entry)),
});

// Refuse to start on unsafe or incomplete production config (review fix F8): the same check
// /api/health makes, at boot, so a bad revision fails loudly instead of serving errors.
export function registerNode(): void {
  loadConfig();
  startScheduler();
}
