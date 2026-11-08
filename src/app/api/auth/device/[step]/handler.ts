// E04-S32 — the testable sibling of the new-device sign-in HTTP entry. A Next
// App-Router `route.ts` may export ONLY the known route keys (the HTTP verbs) or
// `next build` rejects it (OBS-025), so the injectable, unit-testable seam lives HERE,
// beside the entry; `route.ts` imports `createDeviceStepHandler` and exports only
// `POST`.
//
// `createDeviceStepHandler` returns a step dispatcher. It builds the new-device handler
// (E04-S31 `createDeviceHandler`) ONCE from the auth composition root
// (`getDeviceDeps` → `createDeviceHandler`) and reuses it across requests, mapping the
// `[step]` segment to the matching handler method (request → requestApproval,
// approve → approve, collect → collect). The build is LAZY — nothing is touched until
// the first KNOWN request — so merely constructing the dispatcher, or answering an
// unknown step, reads no config and opens no database, which keeps the route entry
// importable under `next build` (runtime config absent; the server-composition-roots
// addendum) and is why the route never calls createDb or reads process.env.
//
// Both seams default to the real composition root; the unit tests inject fakes to prove
// dispatch without a database, Azure, config or network. The map is a Map (not an
// object), so it is exact-match only and carries no inherited keys: an unknown step
// (including the handler's own camelCase method spellings) reaches no handler method and
// is a 404.

import {
  createDeviceHandler,
  type DeviceHandler,
  type DeviceHandlerDeps,
} from "../../../../(auth)/device/handler";
import { getDeviceDeps } from "../../../../../server/auth/compose";

// The step -> handler-method contract this route implements: the three handshake steps
// the task names. A Map is exact-match and carries no inherited keys, so a step like
// "constructor" or "requestApproval" cannot resolve to a method.
const STEP_METHOD = new Map<string, keyof DeviceHandler>([
  ["send-code", "sendCode"],
  ["request", "requestApproval"],
  ["approve", "approve"],
  ["collect", "collect"],
]);

export interface DeviceStepSeams {
  readonly getDeps?: () => Promise<DeviceHandlerDeps>;
  readonly createHandler?: (deps: DeviceHandlerDeps) => DeviceHandler;
}

export function createDeviceStepHandler(
  seams: DeviceStepSeams = {},
): (request: Request, step: string) => Promise<Response> {
  const getDeps = seams.getDeps ?? getDeviceDeps;
  const createHandler = seams.createHandler ?? createDeviceHandler;

  // Build the handler once, lazily, on the first known request and reuse it. Kept as a
  // promise so the first request awaits bring-up and later ones reuse the handler; a
  // failed bring-up forgets the rejected promise so the next request retries.
  let handlerPromise: Promise<DeviceHandler> | undefined;
  function getHandler(): Promise<DeviceHandler> {
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
