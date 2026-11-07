// The App-Router entry for GET /api/vault/unlock-material/[method]: thin by design. The
// browser reads the non-secret unlock material for a method (the method rides in the
// `[method]` dynamic segment). A `route.ts` may export ONLY the known route keys (OBS-025),
// so the injectable factory stays in `src/server/vault/unlock-http.ts`; this file imports it
// and exports just `GET`.
//
// The factory's production defaults resolve config, the database and the session lazily, per
// request, so constructing the handlers here is side-effect-free — importing this entry boots
// no database and `next build` evaluates no runtime config.

import { createVaultUnlockHttpHandlers } from "../../../../../server/vault/unlock-http";

const handlers = createVaultUnlockHttpHandlers();

export async function GET(
  request: Request,
  context: { params: Promise<{ method: string }> },
): Promise<Response> {
  const { method } = await context.params;
  return handlers.getMaterial(request, method);
}
