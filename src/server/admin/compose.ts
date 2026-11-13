// The admin portal's composition root (docs/design/admin-portal.md §2): the real seams the
// handoff action, the exchange and sign-out routes and the guard run from, built from
// validated config at call time (never at module load — `next build` evaluates route
// modules with runtime config absent). Config and the db are injectable so the roots stay
// testable without a real environment. No key material: the portal reads only plaintext
// operational metadata and never needs a data key.

import { loadConfig, type Config } from "../config";
import { getServerDb } from "../db/server";
import { systemClock, type Clock } from "../seams/clock";
import { systemRandom, type Random } from "../seams/random";
import { metricSeamFor, type MetricSeam } from "../metrics/seam";
import type { Db } from "../db/index";

export interface AdminDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  // The origin the app is served from (where the portal sends people back to).
  readonly publicOrigin: string;
  // The origin the portal is served from (where the handoff is exchanged).
  readonly adminOrigin: string;
  readonly recordMetric: MetricSeam;
}

export interface AdminComposeOverrides {
  readonly config?: Config;
  readonly getDb?: () => Promise<Db>;
}

export async function getAdminDeps(overrides: AdminComposeOverrides = {}): Promise<AdminDeps> {
  const config = overrides.config ?? loadConfig();
  const db = await (overrides.getDb ?? getServerDb)();
  return {
    db,
    clock: systemClock,
    random: systemRandom,
    publicOrigin: new URL(config.publicBaseUrl).origin,
    adminOrigin: new URL(config.adminBaseUrl).origin,
    recordMetric: metricSeamFor(db, systemClock),
  };
}
