// POST /settings/data/export — the Data & privacy export download (review fix G2). Thin
// by design: config and the shared database are resolved per request (never at module
// load, so `next build` opens nothing), and all behaviour lives in the tested sibling
// `handler.ts`. A route.ts may export only route keys (OBS-025).

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { createExportHandler } from "./handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const config = loadConfig();
  const handle = createExportHandler({
    db: await getServerDb(),
    clock: systemClock,
    keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }),
    publicOrigin: new URL(config.publicBaseUrl).origin,
  });
  return handle(request);
}
