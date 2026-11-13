// Which host a request arrived on decides what the process serves (docs/design/admin-portal.md §1).
// A pure decision over (request hostname, admin hostname, pathname), so the proxy stays a
// thin caller and the matrix is unit-tested without Next:
//
//   admin host:  static assets pass through; a path already under /admin is 404 (no double
//                prefix, no second way to reach a page); everything else is rewritten under
//                /admin (`/` → `/admin`, `/usage` → `/admin/usage`, `/api/auth/x` →
//                `/admin/api/auth/x`, which no route serves), so the member app, auth,
//                OAuth, MCP and dev routes do not exist on the admin origin.
//   app host (or an unknown host, or no admin host configured): /admin and /admin/* are 404;
//                everything else is the member app, unchanged.
//
// Only the proxy branches on the host, and only to NARROW what is served; nothing builds a
// URL from it (every absolute URL still comes from config), so a spoofed Host header can at
// most reach a 404.

export const ADMIN_PREFIX = "/admin";
export const ADMIN_EXCHANGE_PATH = "/session";

// Paths every host serves as-is: the build's assets and the installable app's files. The
// proxy matcher already excludes most of them; these guards cover the rest.
const PASSTHROUGH_PREFIXES = ["/_next/", "/icons/", "/brands/", "/brand/", "/fonts/"];
const PASSTHROUGH_PATHS = new Set(["/favicon.ico", "/manifest.webmanifest", "/sw.js", "/robots.txt"]);

export type HostRoute =
  | { readonly kind: "app" }
  | { readonly kind: "passthrough" }
  | { readonly kind: "not-found" }
  | { readonly kind: "admin"; readonly rewriteTo: string };

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

export function routeForHost(hostname: string | null, adminHost: string | null, pathname: string): HostRoute {
  const onAdminHost = adminHost !== null && hostname !== null && hostname === adminHost;
  if (!onAdminHost) return isAdminPath(pathname) ? { kind: "not-found" } : { kind: "app" };
  if (PASSTHROUGH_PATHS.has(pathname) || PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return { kind: "passthrough" };
  }
  if (isAdminPath(pathname)) return { kind: "not-found" };
  return { kind: "admin", rewriteTo: pathname === "/" ? ADMIN_PREFIX : `${ADMIN_PREFIX}${pathname}` };
}
