// The App-Router entry for the DCR `/oauth/register` endpoint: thin by design. It
// reads config at the composition root (`loadConfig()` — the one env seam), opens the
// database through the driver seam, and delegates to the testable sibling handler. A
// `route.ts` may export ONLY the known route keys, so the injection factory stays in
// `handler.ts` (OBS-025); this file exports just `POST`.

import { loadConfig } from "../../../server/config";
import { createDb } from "../../../server/db/index";
import { createRegisterHandler } from "./handler";

// Open the db once and reuse it across requests (the process is long-lived). Kept as
// a promise so the first request awaits bring-up and later ones reuse the handler.
let handlerPromise: Promise<(request: Request) => Promise<Response>> | undefined;

function getHandler(): Promise<(request: Request) => Promise<Response>> {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const db = await createDb(loadConfig().databaseUrl);
      return createRegisterHandler({ db });
    })();
  }
  return handlerPromise;
}

export async function POST(request: Request): Promise<Response> {
  const handler = await getHandler();
  return handler(request);
}
