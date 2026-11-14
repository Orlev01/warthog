// Which host a request arrived on decides what the process serves (docs/design/admin-portal.md §1).
// A pure decision over (request hostname, admin hostname, pathname), so the proxy stays a
// thin caller and the matrix is unit-tested without Next:
//
//   admin host:  static assets pass through; a path already under the internal prefix is
//                404 (no double prefix, no second way to reach a page); everything else is
//                rewritten under the prefix (`/` → `<prefix>`, `/usage` → `<prefix>/usage`,
//                `/api/auth/x` → `<prefix>/api/auth/x`, which no route serves), so the
//                member app, auth, OAuth, MCP and dev routes do not exist on the admin origin.
//   app host (or an unknown host, or no admin host configured): the internal prefix is 404
//                except the handoff route, which must run on the app host where the session
//                cookie lives; everything else, `/admin` included, is the member app,
//                unchanged.
//
// The portal's pages live under an internal prefix that is not a guessable word (amendment
// of 13 November 2026): the member app gives no sign that a portal exists, so `/admin` on
// the app host is just a path the app does not have, answered by the ordinary not-found
// page with nothing to tell it apart. The prefix is visible only to visitors of the admin
// host, who already know the portal exists.
//
// Only the proxy branches on the host, and only to NARROW what is served; nothing builds a
// URL from it (every absolute URL still comes from config), so a spoofed Host header can at
// most reach a 404.

export const ADMIN_PREFIX = "/wh-op-7c4f2a9e";
export const ADMIN_EXCHANGE_PATH = "/session";
// The app-host route that hands a signed-in admin over to the admin host. No page links to it.
export const APP_HANDOFF_PATH = `${ADMIN_PREFIX}/handoff`;

// Paths every host serves as-is: the build's assets and the installable app's files. The
// proxy matcher already excludes most of them; these guards cover the rest.
const PASSTHROUGH_PREFIXES = ["/_next/", "/icons/", "/brands/", "/brand/", "/fonts/"];
const PASSTHROUGH_PATHS = new Set(["/favicon.ico", "/manifest.webmanifest", "/sw.js", "/robots.txt"]);

export type HostRoute =
  | { readonly kind: "app" }
  | { readonly kind: "passthrough" }
  | { readonly kind: "not-found" }
  | { readonly kind: "admin"; readonly rewriteTo: string };

/** A build asset or installable-app file, served as-is on every host. */
export function isAssetPath(pathname: string): boolean {
  return PASSTHROUGH_PATHS.has(pathname) || PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

export function routeForHost(hostname: string | null, adminHost: string | null, pathname: string): HostRoute {
  const onAdminHost = adminHost !== null && hostname !== null && hostname === adminHost;
  if (!onAdminHost) return isAdminPath(pathname) && pathname !== APP_HANDOFF_PATH ? { kind: "not-found" } : { kind: "app" };
  if (isAssetPath(pathname)) return { kind: "passthrough" };
  if (isAdminPath(pathname)) return { kind: "not-found" };
  return { kind: "admin", rewriteTo: pathname === "/" ? ADMIN_PREFIX : `${ADMIN_PREFIX}${pathname}` };
}
