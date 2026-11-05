// The App-Router entry for POST /api/auth/step-up/[step] (begin, finish): thin by
// design. It reads the `[step]` dynamic segment and delegates to the sibling dispatcher,
// which builds the step-up handler from the auth composition root on the first request.
// A `route.ts` may export ONLY the known route keys (OBS-025), so the injection seam
// stays in `step-up-handler.ts`; this file exports just `POST`.
//
// The dispatcher is constructed at module load, but building it touches no config or
// database (the handler is built lazily on the first request) — so this module stays
// importable under `next build`, where runtime config is absent.

import { createStepUpStepHandler } from "../../../../../server/auth/step-up-handler";

const dispatch = createStepUpStepHandler();

export async function POST(
  request: Request,
  context: { params: Promise<{ step: string }> },
): Promise<Response> {
  const { step } = await context.params;
  return dispatch(request, step);
}
