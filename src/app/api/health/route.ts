// The App-Router entry for `/api/health` — the readiness probe: thin by design. It wires the
// real config loader and the process-wide database into the tested handler (`./handler`); a
// `route.ts` may export only the known route keys (OBS-025). Config is read per request, never
// at module load, so importing this file is side-effect free.

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { createHealthHandler } from "./handler";
import { assertProductionReleaseConfiguration } from "@/server/production-readiness";

// Always evaluated per request: a probe answer must never be prerendered or cached.
export const dynamic = "force-dynamic";

const handler = createHealthHandler({ loadConfig: () => assertProductionReleaseConfiguration(loadConfig()), getDb: getServerDb });

export async function GET(): Promise<Response> {
  return handler.ready();
}
