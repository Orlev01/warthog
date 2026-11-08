// The App-Router entry for POST /api/auth/reset/[step] (review fix W3.3): thin by design.
// It reads the `[step]` segment and delegates to the sibling dispatcher, which builds the
// reset handler from the auth composition root on the first known request — so this
// module touches no config or database at import and stays importable under `next build`.

import { createResetStepHandler } from "./handler";

const dispatch = createResetStepHandler();

export async function POST(
  request: Request,
  context: { params: Promise<{ step: string }> },
): Promise<Response> {
  const { step } = await context.params;
  return dispatch(request, step);
}
