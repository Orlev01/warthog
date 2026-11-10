import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { contentSecurityPolicy, createAuthIpLimiter } from "./server/http/production-policy";
import { processSingleton } from "./server/seams/process-singleton";

export function middleware(request: NextRequest) {
  // Framework environment flag, like next.config.mjs; no application secrets are
  // read here. Runtime application configuration remains in server/config.ts.
  const development = process.env.NODE_ENV !== "production";
  const path = request.nextUrl.pathname;
  // Next's streaming action cap still protects undeclared/chunked bodies, but
  // reports an oversized multipart form as 500. Reject declared file uploads
  // before that parser so normal HTTP clients receive an actionable 413.
  if (request.method === "POST" && (path === "/life-admin" || path === "/settings/data")
      && request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")
      && Number(request.headers.get("content-length")) > 26 * 1024 * 1024) {
    return NextResponse.json({ error: "The upload request is too large. Choose a smaller file." },
      { status: 413, headers: { "cache-control": "private, no-store" } });
  }
  if (request.method === "POST" && (path.startsWith("/api/auth/") || path === "/oauth/register")) {
    const limiter = processSingleton("http.authIpLimiter", () => createAuthIpLimiter());
    if (!limiter.allow(request.headers.get("x-forwarded-for"), Date.now())) {
      return NextResponse.json({ error: "Too many attempts. Please try again shortly." },
        { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
    }
  }
  const nonce = randomBytes(24).toString("base64");
  const csp = contentSecurityPolicy(nonce, development);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/).*)"],
};
