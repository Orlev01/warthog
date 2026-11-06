// The App-Router entry for POST /api/approvals/[id]/release: thin by design. The
// browser decrypts an approved high-tier value / card and POSTs the plaintext here.
// A `route.ts` may export ONLY the known route keys (OBS-025), so the injectable
// factory stays in the sibling `handler.ts`; this file imports it and exports just
// `POST` (the approval id rides in the `[id]` dynamic segment).
//
// The factory's production defaults resolve config, the database, the KeyWrapper and
// the session lazily, per request, so constructing the handler here is side-effect-free
// — importing this entry boots no database and `next build` evaluates no runtime config.

import { createReleaseHandler } from "./handler";

const handler = createReleaseHandler();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handler.POST(request, id);
}
