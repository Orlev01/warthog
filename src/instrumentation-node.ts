// The Node-runtime half of src/instrumentation.ts, imported only when NEXT_RUNTIME is "nodejs"
// (Next also compiles instrumentation for the edge runtime, where pg's fs/net imports cannot
// resolve). It wires the job scheduler loop over the tested createRegister seam.

import { createRegister } from "./server/jobs/start";
import { getScheduler } from "./server/jobs/scheduler";

// The loop fires on this interval; each periodic sweep gates itself on its own longer interval,
// so a one-minute tick serves every sweep and drains the queue promptly.
const TICK_INTERVAL_MS = 60 * 1000;

export const registerNode = createRegister({
  runtime: process.env.NEXT_RUNTIME,
  createScheduler: getScheduler,
  setInterval: (onTick, ms) => setInterval(onTick, ms),
  intervalMs: TICK_INTERVAL_MS,
  log: (entry) => console.error("[warthog jobs]", JSON.stringify(entry)),
});
