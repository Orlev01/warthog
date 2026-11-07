// The App-Router entry for POST /dev/sign-in-as (E17-S09): thin by design. A `route.ts`
// may export ONLY the known route keys (OBS-025), so the injectable, unit-testable factory
// lives in the sibling `handler.ts`; this file imports it and exports just `POST`.
//
// Constructing the handler at module load touches no config or database — the factory
// resolves config and the db lazily inside `POST` — so this module stays importable under
// `next build`, where runtime config is absent.

import { createSignInAsHandler } from "./handler";

const handler = createSignInAsHandler();

export async function POST(request: Request): Promise<Response> {
  return handler.POST(request);
}
