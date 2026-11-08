// The App-Router entry for GET + POST /household/join/[token] (the single-use
// household-invite link: GET shows the confirmation, POST performs the join): thin by design. It builds the handler from the sibling factory, leaving every seam
// at its real default (db → getServerDb, clock → systemClock, config → loadConfig), and
// forwards the request and its awaited `[token]` param. A `route.ts` may export ONLY the
// known route keys (OBS-025), so the injectable factory stays in `handler.ts`; this file
// exports just `GET` and `POST`.
//
// Constructing the handler touches no config or database — those are resolved lazily inside
// the request handler — so merely importing this module reads no config, which keeps it
// importable under `next build`, where runtime config is absent.

import { createHouseholdJoinHandler } from "./handler";

const handlers = createHouseholdJoinHandler();

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return handlers.GET(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return handlers.POST(request, context);
}
