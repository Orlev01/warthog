// Signing out of the admin portal (docs/design/admin-portal.md §2): POST /signout on the
// admin host (served as /admin/signout). The request Origin must be exactly the admin
// origin — a missing or foreign Origin is 403 and ends nothing. The presented admin token is
// deleted by its hash (only that admin session ends; the app session stays), the cookie is
// cleared, and the person returns to the app's Settings with a notice.

import { getAdminDeps, type AdminDeps } from "./compose";
import { ADMIN_COOKIE_NAME, clearedAdminCookie, deleteAdminSession } from "./session";
import { adminSignInUrl } from "./guard";
import { ADMIN_SIGNOUT } from "../metrics/names";
import { tryRecord } from "../metrics/seam";

export const ADMIN_SIGNED_OUT_NOTICE = "admin_signed_out";

export type AdminSignoutHandler = (request: Request) => Promise<Response>;

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createAdminSignoutHandler(deps: Pick<AdminDeps, "db" | "publicOrigin" | "adminOrigin" | "recordMetric">): AdminSignoutHandler {
  const { db, publicOrigin, adminOrigin, recordMetric } = deps;
  return async function signout(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== adminOrigin) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const token = readCookie(request, ADMIN_COOKIE_NAME);
    if (token) await deleteAdminSession(db, token);
    await tryRecord(recordMetric, { name: ADMIN_SIGNOUT, value: 1 });
    const headers = new Headers({ location: adminSignInUrl(publicOrigin, ADMIN_SIGNED_OUT_NOTICE), "cache-control": "no-store" });
    headers.append("set-cookie", clearedAdminCookie());
    return new Response(null, { status: 303, headers });
  };
}

export function createAdminSignoutRouteHandler(seams: { getDeps?: () => Promise<AdminDeps> } = {}): AdminSignoutHandler {
  let handler: Promise<AdminSignoutHandler> | undefined;
  return (request) => {
    handler ??= (seams.getDeps ?? getAdminDeps)().then(createAdminSignoutHandler);
    handler.catch(() => { handler = undefined; });
    return handler.then((h) => h(request));
  };
}
