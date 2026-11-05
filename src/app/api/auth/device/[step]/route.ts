// The App-Router entry for POST /api/auth/device/[step]: thin by design. It reads the
// `[step]` dynamic segment and delegates to the sibling dispatcher, which builds the
// new-device handler from the auth composition root on the first known request. A
// `route.ts` may export ONLY the known route keys (OBS-025), so the injection seam
// stays in `handler.ts`; this file exports just `POST`.
//
// The dispatcher is constructed at module load, but building it touches no config or
// database (the handler is built lazily on the first known request) — so this module
// stays importable under `next build`, where runtime config is absent, and never calls
// createDb or reads process.env.

import { createDeviceStepHandler } from "./handler";

const dispatch = createDeviceStepHandler();

export async function POST(
  request: Request,
  context: { params: Promise<{ step: string }> },
): Promise<Response> {
  const { step } = await context.params;
  return dispatch(request, step);
}
