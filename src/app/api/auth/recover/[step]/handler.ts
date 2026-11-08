// E04-S30 — the testable sibling of the account-recovery HTTP entry. A Next
// App-Router `route.ts` may export ONLY the known route keys (the HTTP verbs) or
// `next build` rejects it (OBS-025), so the injectable, unit-testable seam lives HERE,
// beside the entry; `route.ts` imports `createRecoverStepHandler` and exports only
// `POST`.
//
// `createRecoverStepHandler` returns a step dispatcher. It builds the recovery handler
// ONCE from the auth composition root (`getRecoverDeps` → `createRecoverHandler`) and
// reuses it across requests, mapping the `[step]` segment to the matching handler
// method. The build is LAZY — nothing is touched until the first KNOWN request — so
// merely constructing the dispatcher, or answering an unknown step, reads no config and
// opens no database, which keeps the route entry importable under `next build` (runtime
// config absent; the server-composition-roots addendum) and is why the route never
// calls createDb or reads process.env.
//
// Both seams default to the real composition root; the unit tests inject fakes to prove
// dispatch without a database, Azure, config or network. The map is a Map (not an
// object), so it is exact-match only and carries no inherited keys: an unknown step
// (including the RecoverView UI step names) reaches no handler method and is a 404.

import {
  createRecoverHandler,
  type RecoverHandler,
  type RecoverHandlerDeps,
} from "../../../../(auth)/recover/handler";
import { getRecoverDeps } from "../../../../../server/auth/compose";

// The step -> handler-method contract this route implements (the handler-method kebab
// slugs, as signin/signup map theirs — NOT the RecoverView UI step names). A Map is
// exact-match and carries no inherited keys, so a step like "constructor" cannot
// resolve to a method.
const STEP_METHOD = new Map<string, keyof RecoverHandler>([
  ["identify", "identify"],
  ["verify-email", "verifyEmail"],
  ["verify-code", "verifyCode"],
  ["register-passkey", "registerPasskey"],
  ["finish", "finish"],
]);

export interface RecoverStepSeams {
  readonly getDeps?: () => Promise<RecoverHandlerDeps>;
  readonly createHandler?: (deps: RecoverHandlerDeps) => RecoverHandler;
}

export function createRecoverStepHandler(
  seams: RecoverStepSeams = {},
): (request: Request, step: string) => Promise<Response> {
  const getDeps = seams.getDeps ?? getRecoverDeps;
  const createHandler = seams.createHandler ?? createRecoverHandler;

  // Build the handler once, lazily, on the first known request and reuse it. Kept as a
  // promise so the first request awaits bring-up and later ones reuse the handler; a
  // failed bring-up forgets the rejected promise so the next request retries.
  let handlerPromise: Promise<RecoverHandler> | undefined;
  function getHandler(): Promise<RecoverHandler> {
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
