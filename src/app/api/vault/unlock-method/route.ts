// The App-Router entry for POST /api/vault/unlock-method: thin by design. The browser saves a
// wrapped vault key for a method. A `route.ts` may export ONLY the known route keys (OBS-025),
// so the injectable factory stays in `src/server/vault/unlock-http.ts`; this file imports it
// and exports just `POST`.
//
// The factory's production defaults resolve config, the database and the session lazily, per
// request, so constructing the handlers here is side-effect-free — importing this entry boots
// no database and `next build` evaluates no runtime config.

import { createVaultUnlockHttpHandlers } from "../../../../server/vault/unlock-http";

const handlers = createVaultUnlockHttpHandlers();

export async function POST(request: Request): Promise<Response> {
  return handlers.saveMethod(request);
}
