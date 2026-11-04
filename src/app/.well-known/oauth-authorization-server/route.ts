// The App-Router entry for `/.well-known/oauth-authorization-server`: thin by design.
// It reads config at the composition root (`loadConfig()` — the one env seam) and
// delegates to the testable sibling handler. A `route.ts` may export ONLY the known
// route keys, so the injection factory stays in `handler.ts` (OBS-025); this file
// exports just `GET`.

import { loadConfig } from "../../../server/config";
import { createAuthServerMetadataHandler } from "./handler";

const handler = createAuthServerMetadataHandler({ config: loadConfig() });

export function GET(request: Request): Response {
  return handler(request);
}
