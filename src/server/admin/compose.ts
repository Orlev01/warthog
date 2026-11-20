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

// The seams the admin pages' loaders run from (docs/design/admin-portal.md §5). The portal
// shows every instant in the operator's established default zone and reads no data key.
import { DEFAULT_TIME_ZONE } from "../../domain/time-zone";
import { getProcessCatalogue } from "../connectors/catalogue";
import { connectableMatchFor, onGoogleEarlyAccessFor } from "../connectors/request-match";
import type { AdminPageDeps } from "./page-data";
import type { CatalogueIndex } from "../connectors/catalogue";

// Azure's own ingress metrics (status codes, latency) are not visible to the app; the
// Traffic page links to the Container Apps blade instead of extending the app's identity.
export const AZURE_CONTAINER_APPS_URL = "https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.App%2FcontainerApps";

// The catalogue name a requested service now has for this person: a connectable entry whose
// name or alias matches, and for a Google entry only when they are on the early-access list.
export function catalogueMatchFor(catalogue: CatalogueIndex, googleEarlyAccess: readonly string[]): NonNullable<AdminPageDeps["catalogueMatch"]> {
  const match = connectableMatchFor(catalogue, googleEarlyAccess);
  return (name, email) => match(name, email)?.name;
}

export async function getAdminPageDeps(overrides: AdminComposeOverrides = {}): Promise<AdminPageDeps> {
  const config = overrides.config ?? loadConfig();
  const db = await (overrides.getDb ?? getServerDb)();
  return {
    db,
    clock: systemClock,
    timeZone: DEFAULT_TIME_ZONE,
    smsEnabled: config.smsEnabled,
    azureMetricsUrl: config.nodeEnv === "production" ? AZURE_CONTAINER_APPS_URL : null,
    recordMetric: metricSeamFor(db, systemClock),
    connectorName: (id) => getProcessCatalogue(config).get(id)?.name,
    catalogueMatch: catalogueMatchFor(getProcessCatalogue(config), config.googleEarlyAccess),
    onGoogleEarlyAccess: onGoogleEarlyAccessFor(config.googleEarlyAccess),
  };
}
