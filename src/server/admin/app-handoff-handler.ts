// The app-host handoff route (docs/design/admin-portal.md §2, as amended on 13 November
// 2026): GET `<internal prefix>/handoff` on the app host, the `next` of the sign-in that the
// admin host's "Sign in" starts. No page and no client code, so nothing about the portal
// reaches a member's browser:
//
//   • a signed-in live admin with a step-up fresher than five minutes (a fresh sign-in
//     records one) gets a single-use handoff and a 303 to the admin host's exchange;
//   • a stale step-up gets a 303 to a fresh sign-in (`fresh=1`) that returns here;
//   • anyone else (signed out, a member, demoted, deleted) gets a bare 404.
//
// No cross-site check is needed: the session cookie is SameSite=Lax, so a request another
// site embeds arrives signed out (a 404 like everyone's), and a cross-site link can at most
// take an admin's own browser into their own portal, with nothing the other site can read.
//
// The decision is `startAdminHandoff`'s; this adds only the HTTP shape. Identity comes
// from the `__Host-wh_session` cookie alone. Two seams, like the other routes: the pure
// handler (unit-tested over an in-memory db) and the lazy dispatcher the thin route.ts
// constructs at module load.

import { COOKIE_NAME } from "../auth/session";
import { APP_HANDOFF_PATH } from "../http/admin-routing";
import { getAdminDeps, type AdminDeps } from "./compose";
import { startAdminHandoff, type HandoffDeps } from "./handoff";
import { readCookie } from "./signout-handler";

export type AppHandoffHandler = (request: Request) => Promise<Response>;

const NO_STORE = { "cache-control": "no-store" } as const;
const FRESH_SIGN_IN = `/signin?next=${encodeURIComponent(APP_HANDOFF_PATH)}&fresh=1`;

const notFound = () => new Response(null, { status: 404, headers: NO_STORE });
const seeOther = (location: string) => new Response(null, { status: 303, headers: { ...NO_STORE, location } });

export function createAppHandoffHandler(deps: HandoffDeps): AppHandoffHandler {
  return async function handoff(request: Request): Promise<Response> {
    const result = await startAdminHandoff(readCookie(request, COOKIE_NAME), deps);
    if (result.ok) return seeOther(result.url);
    if (result.reason === "step_up_required") return seeOther(FRESH_SIGN_IN);
    return notFound();
  };
}

// The dispatcher the thin route constructs at module load; the handler is built lazily from
// the composition root on the first request and reused.
export function createAppHandoffRouteHandler(seams: { getDeps?: () => Promise<AdminDeps> } = {}): AppHandoffHandler {
  let handler: Promise<AppHandoffHandler> | undefined;
  return (request) => {
    handler ??= (seams.getDeps ?? getAdminDeps)().then(createAppHandoffHandler);
    handler.catch(() => { handler = undefined; });
    return handler.then((h) => h(request));
  };
}
