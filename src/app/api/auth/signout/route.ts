// The App-Router entry for POST /api/auth/signout: thin by design. It delegates to the
// sibling dispatcher, which builds the sign-out handler from the auth composition root
// on the first request. A `route.ts` may export ONLY the known route keys (OBS-025), so
// the injection seam stays in `signout-handler.ts`; this file exports just `POST`.
//
// The dispatcher is constructed at module load, but building it touches no config or
// database (the handler is built lazily on the first request) — so this module stays
// importable under `next build`, where runtime config is absent.

import { createSignoutRouteHandler } from "../../../../server/auth/signout-handler";

const dispatch = createSignoutRouteHandler();

export async function POST(request: Request): Promise<Response> {
  return dispatch(request);
}
