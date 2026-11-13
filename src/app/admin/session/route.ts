// The App-Router entry for GET /admin/session (the admin host's /session after the proxy's
// rewrite): thin by design. It delegates to the sibling dispatcher, which builds the
// exchange handler from the admin composition root on the first request. A `route.ts` may
// export ONLY the known route keys, so the injection seam stays in `exchange-handler.ts`.

import { createAdminExchangeRouteHandler } from "../../../server/admin/exchange-handler";

export const dynamic = "force-dynamic";

const dispatch = createAdminExchangeRouteHandler();

export async function GET(request: Request): Promise<Response> {
  return dispatch(request);
}
