// The App-Router entry for POST <internal prefix>/signout (the admin host's /signout): thin by design,
// over the sibling dispatcher in `signout-handler.ts`.

import { createAdminSignoutRouteHandler } from "../../../server/admin/signout-handler";

export const dynamic = "force-dynamic";

const dispatch = createAdminSignoutRouteHandler();

export async function POST(request: Request): Promise<Response> {
  return dispatch(request);
}
