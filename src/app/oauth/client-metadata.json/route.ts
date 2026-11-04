// The App-Router entry for `/oauth/client-metadata.json`: thin by design. It reads
// config at the composition root (`loadConfig()` — the one env seam) and delegates to
// the testable sibling handler. A `route.ts` may export ONLY the known route keys, so
// the injection factory stays in `handler.ts` (OBS-025); this file exports just `GET`.

import { loadConfig } from "../../../server/config";
import { createClientMetadataHandler } from "./handler";

const handler = createClientMetadataHandler({ config: loadConfig() });

export function GET(request: Request): Response {
  return handler(request);
}
