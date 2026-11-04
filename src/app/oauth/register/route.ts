// The App-Router entry for the DCR `/oauth/register` endpoint: thin by design. It
// takes the process-wide database (`getServerDb()`, which reads config and applies
// migrations once), and delegates to the testable sibling handler. A
// `route.ts` may export ONLY the known route keys, so the injection factory stays in
// `handler.ts` (OBS-025); this file exports just `POST`.

import { getServerDb } from "../../../server/db/server";
import { createRegisterHandler } from "./handler";

// Build the handler once over the shared db and reuse it across requests. Kept as
// a promise so the first request awaits bring-up and later ones reuse the handler.
let handlerPromise: Promise<(request: Request) => Promise<Response>> | undefined;

function getHandler(): Promise<(request: Request) => Promise<Response>> {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const db = await getServerDb();
      return createRegisterHandler({ db });
    })();
    // A failed bring-up (e.g. a transient database error) must not brick the route until
    // restart: forget the rejected promise so the next request retries.
    handlerPromise.catch(() => {
      handlerPromise = undefined;
    });
  }
  return handlerPromise;
}

export async function POST(request: Request): Promise<Response> {
  const handler = await getHandler();
  return handler(request);
}
