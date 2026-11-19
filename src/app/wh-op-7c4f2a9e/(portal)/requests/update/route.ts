// The App-Router entry for POST <internal prefix>/requests/update (the admin host's
// /requests/update): thin by design, over `src/server/admin/request-handler.ts`, which guards
// itself (route handlers are not wrapped by the portal layout).

import { createAdminRequestUpdateRouteHandler } from "../../../../../server/admin/request-handler";

export const dynamic = "force-dynamic";

const dispatch = createAdminRequestUpdateRouteHandler();

export async function POST(request: Request): Promise<Response> {
  return dispatch(request);
}
