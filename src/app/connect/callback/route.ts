// The App-Router entry for the provider OAuth callback `/connect/callback`: thin by
// design. A `route.ts` may export ONLY the known route keys, so the injection factory
// stays in the sibling `handler.ts` (OBS-025); this file imports it and exports just
// `GET` (the provider's redirect lands as a GET).
//
// The factory's production defaults resolve config and the database lazily, per request,
// so constructing the handler here is side-effect-free — importing this entry boots no
// database and `next build` evaluates no runtime config.

import { createConnectCallbackHandler } from "./handler";

const handler = createConnectCallbackHandler();

export async function GET(request: Request): Promise<Response> {
  return handler.GET(request);
}
