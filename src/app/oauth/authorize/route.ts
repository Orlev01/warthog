// The App-Router entry for `/oauth/authorize`: thin by design. It reads config at the
// composition root (`loadConfig()` — the one env seam), takes the process-wide db
// (`getServerDb()`) and the production client resolver (DCR rows + the process-wide
// SSRF-guarded CIMD fetcher), and delegates to the tested handler in `./handler`. A
// `route.ts` may export ONLY the known route keys, so the testable logic stays in the
// sibling modules (OBS-025); this file exports just `GET`.

import { loadConfig } from "../../../server/config";
import { getServerDb } from "../../../server/db/server";
import { systemClientResolver } from "../../../server/oauth/clients";
import { systemClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";
import { createAuthorizeHandler } from "./handler";

export async function GET(request: Request): Promise<Response> {
  const db = await getServerDb();
  const handler = createAuthorizeHandler({
    db,
    config: loadConfig(),
    clock: systemClock,
    random: systemRandom,
    resolveClient: systemClientResolver(db),
  });
  return handler(request);
}
