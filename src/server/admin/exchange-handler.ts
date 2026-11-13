// The admin host's handoff exchange (docs/design/admin-portal.md §2): GET /session?handoff=…
// (served as /admin/session after the proxy's rewrite). The token is consumed exactly once
// through the store's conditional UPDATE; success sets the host-locked admin cookie and
// 303-redirects to the portal root so the token leaves the address bar at once. Every other
// outcome — missing, malformed, expired, reused, demoted — is the SAME 303 back to the app's
// Settings with one notice, so the admin host never reveals whether a token ever existed.
// Nothing here reads the body or trusts any other client value.
//
// Two seams, like the auth routes: the pure handler (unit-tested over an in-memory db) and
// the lazy route dispatcher the thin `route.ts` constructs at module load.

import { getAdminDeps, type AdminDeps } from "./compose";
import { exchangeHandoff } from "./session";
import { adminSignInUrl } from "./guard";
import { ADMIN_SESSION, ADMIN_SESSION_OUTCOMES } from "../metrics/names";
import { tryRecord } from "../metrics/seam";

export const HANDOFF_EXPIRED_NOTICE = "admin_handoff_expired";
const HANDOFF_TOKEN = /^[0-9a-f]{64}$/;

export type AdminExchangeHandler = (request: Request) => Promise<Response>;

export function createAdminExchangeHandler(deps: Pick<AdminDeps, "db" | "clock" | "random" | "publicOrigin" | "recordMetric">): AdminExchangeHandler {
  const { db, clock, random, publicOrigin, recordMetric } = deps;
  const headersFor = (location: string, cookie?: string): Headers => {
    const headers = new Headers({ location, "cache-control": "no-store" });
    if (cookie) headers.append("set-cookie", cookie);
    return headers;
  };
  return async function exchange(request: Request): Promise<Response> {
    const handoff = new URL(request.url).searchParams.get("handoff");
    const exchanged = handoff && HANDOFF_TOKEN.test(handoff) ? await exchangeHandoff(db, handoff, { clock, random }) : null;
    if (!exchanged) {
      await tryRecord(recordMetric, { name: ADMIN_SESSION, value: 1, dimensions: { outcome: ADMIN_SESSION_OUTCOMES.rejected } });
      return new Response(null, { status: 303, headers: headersFor(adminSignInUrl(publicOrigin, HANDOFF_EXPIRED_NOTICE)) });
    }
    await tryRecord(recordMetric, { name: ADMIN_SESSION, value: 1, dimensions: { outcome: ADMIN_SESSION_OUTCOMES.exchanged } });
    return new Response(null, { status: 303, headers: headersFor("/", exchanged.cookie) });
  };
}

// The dispatcher the thin route constructs at module load; the handler is built lazily from
// the composition root on the first request and reused.
export function createAdminExchangeRouteHandler(seams: { getDeps?: () => Promise<AdminDeps> } = {}): AdminExchangeHandler {
  let handler: Promise<AdminExchangeHandler> | undefined;
  return (request) => {
    handler ??= (seams.getDeps ?? getAdminDeps)().then(createAdminExchangeHandler);
    handler.catch(() => { handler = undefined; });
    return handler.then((h) => h(request));
  };
}
