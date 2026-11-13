// Review fix W3.3 — the testable sibling of the account-reset HTTP entry. A Next
// App-Router `route.ts` may export ONLY the HTTP verbs (OBS-025), so the injectable seam
// lives HERE and `route.ts` exports just `POST`.
//
// `createResetStepHandler` returns a step dispatcher. It builds the reset handler ONCE
// from the auth composition root (`getResetDeps` → `createResetHandler`) on the first KNOWN
// request and reuses it, so constructing the dispatcher or answering an unknown step reads
// no config and opens no database (the route stays importable under `next build`). The
// step map is a Map, exact-match only with no inherited keys, so an unknown step (or one
// like "constructor") reaches no handler method and is a 404.

import {
  createResetHandler,
  type ResetHandler,
  type ResetHandlerDeps,
} from "../../../../(auth)/reset/handler";
import { getResetDeps } from "../../../../../server/auth/compose";

const STEP_METHOD = new Map<string, keyof ResetHandler>([
  ["send-code", "sendCode"],
  ["request", "request"],
  ["cancel", "cancel"],
  // Review fix W5 — "Reset finished? Set up a new passkey".
  ["setup-send-code", "setupSendCode"],
  ["setup-verify", "setupVerify"],
  ["setup-finish", "setupFinish"],
  // Sign-in audit — "This wasn't me — close re-enrolment" on a completed reset.
  ["close", "close"],
]);

export interface ResetStepSeams {
  readonly getDeps?: () => Promise<ResetHandlerDeps>;
  readonly createHandler?: (deps: ResetHandlerDeps) => ResetHandler;
}

export function createResetStepHandler(
  seams: ResetStepSeams = {},
): (request: Request, step: string) => Promise<Response> {
  const getDeps = seams.getDeps ?? getResetDeps;
  const createHandler = seams.createHandler ?? createResetHandler;

  // Built once, lazily; a failed bring-up forgets the rejected promise so the next request
  // retries.
  let handlerPromise: Promise<ResetHandler> | undefined;
  function getHandler(): Promise<ResetHandler> {
    if (!handlerPromise) {
      handlerPromise = (async () => createHandler(await getDeps()))();
      handlerPromise.catch(() => {
        handlerPromise = undefined;
      });
    }
    return handlerPromise;
  }

  return async function dispatch(request: Request, step: string): Promise<Response> {
    const method = STEP_METHOD.get(step);
    if (!method) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const handler = await getHandler();
    return handler[method](request);
  };
}
