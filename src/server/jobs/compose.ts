// The job runtime's composition root (E18-S21): the real seams the registry's handlers and
// sweeps run from, built from validated config on the scheduler's first tick. Pieces that
// need operator setup not done yet fail loudly when used (the not-configured idiom), and
// the scheduler logs each failure redacted rather than swallowing it:
//   • connector token refresh needs the operator OAuth clients (Google / Microsoft);
//   • the account-reset executor (erase vault data, revoke agents and connections) is a
//     follow-up task.
// Exchange rates come from the free Frankfurter (ECB) reference-rate API.

import { loadConfig } from "../config";
import { getServerDb } from "../db/server";
import { systemClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { selectSenders } from "../notify/senders";
import { keyWrapperFor, notConfiguredSenders } from "../auth/compose";
import { createFrankfurterRateSource } from "../currency/rate-source";
import { buildDispatchTable, buildPeriodicSweeps, type JobSeams } from "./registry";
import { createScheduler, type Scheduler } from "./scheduler";

const FRANKFURTER_BASE_URL = "https://api.frankfurter.app";

export async function composeJobSeams(): Promise<JobSeams> {
  const config = loadConfig();
  const senders = selectSenders(config, notConfiguredSenders());
  return {
    db: await getServerDb(),
    clock: systemClock,
    keyWrapper: keyWrapperFor(config),
    random: systemRandom,
    senders,
    push: senders.push,
    refresh: async () => {
      throw new Error("connector token refresh is not configured (operator OAuth clients pending)");
    },
    resetExecutor: {
      eraseVaultData: async () => {
        throw new Error("account reset execution is not configured");
      },
      revokeAgentsAndConnections: async () => {
        throw new Error("account reset execution is not configured");
      },
    },
    rateSource: createFrankfurterRateSource({ baseUrl: FRANKFURTER_BASE_URL, fetchImpl: fetch }),
    publicBaseUrl: config.publicBaseUrl,
  };
}

// The production scheduler: the registry's sweeps and dispatch table over the real seams,
// logging every (already redacted) failure to stderr.
export async function composeScheduler(): Promise<Scheduler> {
  const seams = await composeJobSeams();
  return createScheduler({
    getDb: getServerDb,
    clock: systemClock,
    sweeps: buildPeriodicSweeps(seams),
    dispatch: buildDispatchTable(seams),
    log: (entry) => console.error("[warthog jobs]", JSON.stringify(entry)),
  });
}
