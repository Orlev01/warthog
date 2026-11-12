import { notificationSenders } from "../notify/production";
// The job runtime's composition root (E18-S21): the real seams the registry's handlers and
// sweeps run from, built from validated config on the scheduler's first tick. Pieces that
// need operator setup not done yet fail loudly when used (the not-configured idiom), and
// the scheduler logs each failure redacted rather than swallowing it:
//   • connector token refresh needs the operator OAuth clients (Google / Microsoft).
// The account-reset executor (erase vault data, revoke agents and connections) is now the
// real db-backed one (E04-S40). Exchange rates come from the free Frankfurter (ECB)
// reference-rate API.
//
// Config and the db are injectable (defaulting, in production, to loadConfig() /
// getServerDb()), mirroring the auth composition root (`../auth/compose`), so the root
// stays testable without a real environment, the process-wide server database or Azure.

import { loadConfig, type Config } from "../config";
import { getServerDb, getPurgeDb } from "../db/server";
import { systemClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { selectSenders } from "../notify/senders";
import { keyWrapperFor } from "../auth/compose";
import { createFrankfurterRateSource } from "../currency/rate-source";
import { createResetExecutor } from "../account/reset-executor";
import { selectBlobStore } from "../storage/blob";
import { selectDeletionJournal } from "../storage/deletion-journal";
import { buildDispatchTable, buildPeriodicSweeps, type JobSeams } from "./registry";
import { createScheduler, type Scheduler } from "./scheduler";
import type { Db } from "../db/index";
import { createConnectorRuntime } from "../connectors/runtime";

const FRANKFURTER_BASE_URL = "https://api.frankfurter.app";

export async function composeJobSeams(
  overrides: { config?: Config; getDb?: () => Promise<Db> } = {},
): Promise<JobSeams> {
  const config = overrides.config ?? loadConfig();
  const db = await (overrides.getDb ?? getServerDb)();
  const senders = notificationSenders(config, db);
  return {
    db,
    getPurgeDb: config.nodeEnv === "production" ? getPurgeDb : async () => db,
    clock: systemClock,
    keyWrapper: keyWrapperFor(config),
    random: systemRandom,
    senders,
    push: senders.push,
    refresh: (target) => createConnectorRuntime({ config, db }).refresh(target),
    resetExecutor: createResetExecutor(db),
    deletionJournal: selectDeletionJournal({ nodeEnv: config.nodeEnv, account: config.blob.account,
      container: config.blob.deletionJournalContainer }),
    rateSource: createFrankfurterRateSource({ baseUrl: config.exchangeRateBaseUrl ?? FRANKFURTER_BASE_URL, fetchImpl: fetch }),
    // The same receipt store the life-admin page writes (built lazily: it opens the
    // container on the first delete, so a purge with no receipts never touches Azure).
    blobStore: selectBlobStore({
      nodeEnv: config.nodeEnv,
      account: config.blob.account,
      container: config.blob.container,
    }),
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
