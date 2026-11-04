// E04-S23 — the testable sibling of the sign-in HTTP entry. A Next App-Router
// `route.ts` may export ONLY the known route keys (the HTTP verbs) or `next build`
// rejects it (OBS-025), so the injectable, unit-testable seam lives HERE, beside the
// entry; `route.ts` imports `createSigninStepHandler` and exports only `POST`.
//
// `createSigninStepHandler` returns a step dispatcher. It builds the sign-in handler
// ONCE from the auth composition root (`getSigninDeps` → `createSigninHandler`) and
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
  createSigninHandler,
  type SigninHandler,
  type SigninHandlerDeps,
} from "../../../../(auth)/signin/handler";
import { getSigninDeps } from "../../../../../server/auth/compose";

// The step -> handler-method contract this route implements. A Map is exact-match and
// carries no inherited keys, so a step like "constructor" cannot resolve to a method.
const STEP_METHOD = new Map<string, keyof SigninHandler>([
  ["begin-passkey", "beginPasskey"],
  ["finish-passkey", "finishPasskey"],
  ["totp", "signInWithTotp"],
]);

export interface SigninStepSeams {
  readonly getDeps?: () => Promise<SigninHandlerDeps>;
  readonly createHandler?: (deps: SigninHandlerDeps) => SigninHandler;
}

export function createSigninStepHandler(
  seams: SigninStepSeams = {},
): (request: Request, step: string) => Promise<Response> {
  const getDeps = seams.getDeps ?? getSigninDeps;
  const createHandler = seams.createHandler ?? createSigninHandler;

  // Build the handler once, lazily, on the first request and reuse it. Kept as a
  // promise so the first request awaits bring-up and later ones reuse the handler; a
  // failed bring-up forgets the rejected promise so the next request retries.
  let handlerPromise: Promise<SigninHandler> | undefined;
  function getHandler(): Promise<SigninHandler> {
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
