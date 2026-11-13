// The App-Router entry for GET <internal prefix>/handoff on the APP host (the proxy serves
// this one internal path there, where the session cookie lives): thin by design. It
// delegates to the sibling dispatcher, which builds the handler from the admin composition
// root on the first request. A `route.ts` may export ONLY the known route keys, so the
// injection seam stays in `app-handoff-handler.ts`.

import { createAppHandoffRouteHandler } from "../../../server/admin/app-handoff-handler";

export const dynamic = "force-dynamic";

const dispatch = createAppHandoffRouteHandler();

export async function GET(request: Request): Promise<Response> {
  return dispatch(request);
}
