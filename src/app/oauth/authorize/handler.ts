// The GET `/oauth/authorize` endpoint's testable handler. The App-Router `route.ts` may
// export ONLY the known route keys (OBS-025), so the injection seam that lets the handler
// be unit-tested with an explicit db, clock and client resolver lives HERE; `route.ts`
// wires the real seams and exports only `GET` (the `/oauth/register` pattern).
//
// E10-S12 — consent before code. A valid, signed-in request is CARRIED SERVER-SIDE (the
// pending store) and the person is sent to the internal `/oauth/consent` screen. The opaque
// handle to that pending request rides in a host-locked cookie (never a URL/form field), so
// the consent page and the decision read the request back server-side. The code is minted
// only once the person approves.
//
// Review fix A1 — a request that fails validation (an unknown client, a redirect URI the
// client did not register, a hostile scheme, bad PKCE, the wrong resource) is answered with
// Warthog's OWN 400 page: never a redirect (RFC 6749 §4.1.2.1 — an unvalidated redirect URI
// is never followed) and no cookie.
//
// Review fix A4 — a VALID request from a signed-out browser is sent to sign-in with a
// relative return path, `/signin?next=/oauth/authorize?<the same query>`, so connecting an
// agent resumes after sign-in instead of stranding the person on Home. Validation runs
// before the session check, so only a request that will succeed is bounced through sign-in.

import { verifySession } from "../../../server/auth/session";
import { beginAuthorization } from "../../../server/oauth/authorize";
import type { ClientResolver } from "../../../server/oauth/clients";
import type { Config } from "../../../server/config";
import type { Db } from "../../../server/db/index";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import { standaloneResponse } from "../../../components/public/standalone-html";

// Mirrors the host-locked cookie name set by the session module.
const SESSION_COOKIE = "__Host-wh_session";
// The host-locked cookie that carries the pending authorize request's opaque handle to
// the consent screen and the decision (never a URL/form field).
const CONSENT_COOKIE = "__Host-wh_consent";

// The seams the handler composes: the same ones `beginAuthorization` takes.
export interface AuthorizeHandlerDeps {
  readonly db: Db;
  readonly config: Config;
  readonly clock: Clock;
  readonly random: Random;
  readonly resolveClient: ClientResolver;
}

// Pull one cookie's value out of the request's Cookie header, or null when absent.
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// The Set-Cookie value that carries the pending handle: host-locked (`__Host-`),
// unreadable to script (HttpOnly), HTTPS-only (Secure), SameSite=Lax, Path=/ and no
// Domain — the same shape the session cookie uses.
function consentCookie(handle: string): string {
  // Lives as long as the pending request it names (ten minutes).
  return `${CONSENT_COOKIE}=${handle}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

// Where a signed-out person signs in before coming back to this exact authorize request:
// a RELATIVE path (always `/oauth/authorize?…`, built from the request's own path and
// query — never a host), so sign-in's `next` check can accept it as same-origin.
function signInLocation(url: URL): string {
  return `/signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
}

// Warthog's own page for a request it will not carry forward. Fixed copy in plain words
// (no protocol jargon on a primary screen); nothing from the request is echoed, so a
// hostile redirect or client id never reaches the page.
// It uses the shared standalone page (Warthog's tokens, both colour schemes, a brand bar and
// one panel), and its way forward works signed in or out: "/" opens Home for a member and,
// for anyone else, sign-in when the front door has its own host, else the front door
// (public-09, visual-03).
function invalidRequestPage(): Response {
  return standaloneResponse({
    title: "Connection request not valid",
    eyebrow: "Connect an agent",
    heading: "We can't connect this agent",
    paragraphs: [
      "This connection request isn't valid, so nothing was connected and you haven't been sent anywhere.",
      "Start connecting again from your agent. If it keeps happening, the agent may not be set up for Warthog.",
    ],
    actions: [
      { href: "/", label: "Go to Warthog", primary: true },
      { href: "/help/compatibility", label: "How to connect an agent" },
    ],
  }, 400);
}

export function createAuthorizeHandler(
  deps: AuthorizeHandlerDeps,
): (request: Request) => Promise<Response> {
  const { db, clock } = deps;

  return async function handleAuthorize(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = readCookie(request, SESSION_COOKIE);
    const session = token ? await verifySession(db, token, { clock }) : null;

    const result = await beginAuthorization({ params: url.searchParams, session }, deps);

    if (result.ok) {
      // Carry the pending request's handle in a host-locked cookie and send the person to
      // the consent screen — no code is issued and nothing is sent to the client yet.
      return new Response(null, {
        status: 302,
        headers: { Location: result.redirectTo, "Set-Cookie": consentCookie(result.handle) },
      });
    }
    // A valid request from a signed-out browser → sign in, then come back here.
    if (result.error === "login_required") {
      return new Response(null, { status: 302, headers: { Location: signInLocation(url) } });
    }
    // Any other rejection is a bad request, answered here and never redirected.
    return invalidRequestPage();
  };
}
