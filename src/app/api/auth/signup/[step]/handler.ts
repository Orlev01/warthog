// E04-S23 — the testable sibling of the sign-up HTTP entry. A Next App-Router
// `route.ts` may export ONLY the known route keys (the HTTP verbs) or `next build`
// rejects it (OBS-025), so the injectable, unit-testable seam lives HERE, beside the
// entry; `route.ts` imports `createSignupStepHandler` and exports only `POST`.
//
// `createSignupStepHandler` returns a step dispatcher. It builds the sign-up handler
// ONCE from the auth composition root (`getSignupDeps` → `createSignupHandler`) and
// reuses it across requests, mapping the `[step]` segment to the matching handler
// method. The build is LAZY — nothing is touched until the first request — so merely
// constructing the dispatcher reads no config and opens no database, which keeps the
// route entry importable under `next build` (runtime config absent; the
// server-composition-roots addendum).
//
// Both seams default to the real composition root; the unit tests inject fakes to
// prove dispatch without a database, Azure, config or network. The exact map, with a
// Map (not an object), is exact-match only: an unknown step reaches no handler method
// and is a 404.

import {
  createSignupHandler,
  type SignupHandler,
  type SignupHandlerDeps,
} from "../../../../(auth)/signup/handler";
import { getSignupDeps } from "../../../../../server/auth/compose";

// The step -> handler-method contract this route implements. A Map is exact-match and
// carries no inherited keys, so a step like "constructor" cannot resolve to a method.
const STEP_METHOD = new Map<string, keyof SignupHandler>([
  ["send-code", "sendCode"],
  ["verify-email", "verifyEmail"],
  ["register-passkey", "registerPasskey"],
  ["confirm", "confirmSignup"],
]);

export interface SignupStepSeams {
  readonly getDeps?: () => Promise<SignupHandlerDeps>;
  readonly createHandler?: (deps: SignupHandlerDeps) => SignupHandler;
}

export function createSignupStepHandler(
  seams: SignupStepSeams = {},
): (request: Request, step: string) => Promise<Response> {
  const getDeps = seams.getDeps ?? getSignupDeps;
  const createHandler = seams.createHandler ?? createSignupHandler;

  // Build the handler once, lazily, on the first request and reuse it. Kept as a
  // promise so the first request awaits bring-up and later ones reuse the handler; a
  // failed bring-up forgets the rejected promise so the next request retries.
  let handlerPromise: Promise<SignupHandler> | undefined;
  function getHandler(): Promise<SignupHandler> {
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
