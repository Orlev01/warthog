import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { contentSecurityPolicy, createAuthIpLimiter } from "./server/http/production-policy";
import { ADMIN_EXCHANGE_PATH, routeForHost } from "./server/http/admin-routing";
import { classifyRoute, getTrafficCounter, requestKind } from "./server/http/traffic";
import { requestHostname } from "./server/admin/origin";
import { adminHostFromEnv, websiteFromEnv } from "./server/config";
import { redirectTarget, routeForWebsite } from "./server/http/website";
import { processSingleton } from "./server/seams/process-singleton";
import type { HostClass } from "./server/metrics/names";

// The original path on the admin host, forwarded to the admin layout so its chrome lights
// the current section (a rewritten request would otherwise hydrate with another path).
export const ADMIN_PATH_HEADER = "x-admin-pathname";

const NO_STORE = { "cache-control": "no-store" } as const;

export function proxy(request: NextRequest) {
  // Framework environment flag, like next.config.mjs; no application secrets are
  // read here. Runtime application configuration remains in server/config.ts, which
  // also derives the admin hostname (a non-throwing read, never loadConfig per request).
  const development = process.env.NODE_ENV !== "production";
  const path = request.nextUrl.pathname;
  // Which host this request arrived on decides what is served (docs/design/admin-portal.md §1):
  // the admin origin serves only the portal; the app origin serves none of the portal's
  // internal paths except the handoff, and `/admin` there is an ordinary path.
  // The public website host (docs/adr/website-root-domain.md), when the app has one, serves
  // only the front door and the public pages; its www. name and every other path forward to
  // the website or the app with a permanent redirect to a configured origin. A redirect is not
  // counted: the request it leads to is, so a visit counts once.
  // The host comes from the request's headers, which a non-browser client can set (the ingress
  // passes X-Forwarded-Host through), so it only chooses which host's routing a request gets;
  // nothing that protects an account or the portal depends on it.
  const hostname = requestHostname(request.headers);
  const site = routeForWebsite(hostname, websiteFromEnv(), path);
  if (site.kind === "passthrough") return NextResponse.next();
  if (site.kind === "redirect") {
    return NextResponse.redirect(redirectTarget(site.origin, path, request.nextUrl.search), { status: 308, headers: NO_STORE });
  }
  const adminHost = adminHostFromEnv();
  const route = site.kind === "website" ? ({ kind: "app" } as const) : routeForHost(hostname, adminHost, path);
  const hostClass: HostClass = site.kind === "website" ? "site"
    : route.kind === "admin" || route.kind === "passthrough" ? "admin" : "app";
  const traffic = getTrafficCounter();
  const count = (limited: boolean) =>
    traffic.count(hostClass, route.kind === "admin" ? "admin" : classifyRoute(path), requestKind(request.headers, limited));

  if (route.kind === "not-found") {
    count(false);
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  }
  if (route.kind === "passthrough") {
    return NextResponse.next();
  }
  // Next's streaming action cap still protects undeclared/chunked bodies, but
  // reports an oversized multipart form as 500. Reject declared file uploads
  // before that parser so normal HTTP clients receive an actionable 413.
  if (route.kind === "app" && request.method === "POST" && (path === "/life-admin" || path === "/settings/data")
      && request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")
      && Number(request.headers.get("content-length")) > 26 * 1024 * 1024) {
    count(false);
    return NextResponse.json({ error: "The upload request is too large. Choose a smaller file." },
      { status: 413, headers: { "cache-control": "private, no-store" } });
  }
  // The auth endpoints, client registration and the admin handoff exchange share one
  // per-address limiter, so a flood of guesses is refused before any database work.
  const limited = (route.kind === "app" && request.method === "POST" && (path.startsWith("/api/auth/") || path === "/oauth/register"))
    || (route.kind === "admin" && request.method === "GET" && path === ADMIN_EXCHANGE_PATH);
  if (limited) {
    const limiter = processSingleton("http.authIpLimiter", () => createAuthIpLimiter());
    if (!limiter.allow(request.headers.get("x-forwarded-for"), Date.now())) {
      count(true);
      return NextResponse.json({ error: "Too many attempts. Please try again shortly." },
        { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
    }
  }
  count(false);
  const nonce = randomBytes(24).toString("base64");
  const csp = contentSecurityPolicy(nonce, development);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  let response: NextResponse;
  if (route.kind === "admin") {
    headers.set(ADMIN_PATH_HEADER, path);
    const target = request.nextUrl.clone();
    target.pathname = route.rewriteTo;
    response = NextResponse.rewrite(target, { request: { headers } });
    response.headers.set("x-robots-tag", "noindex, nofollow");
  } else {
    response = NextResponse.next({ request: { headers } });
  }
  response.headers.set("content-security-policy", csp);
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/).*)"],
};
