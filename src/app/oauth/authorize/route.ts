// The App-Router entry for `/oauth/authorize`: thin by design. It reads config at the
// composition root (`loadConfig()` — the one env seam), takes the process-wide db
// (`getServerDb()`), resolves the signed-in session from the `__Host-wh_session` cookie
// (→ `verifySession`), reads the agent's query, and delegates to the tested
// `beginAuthorization` seam. A `route.ts` may export ONLY the known route keys, so the
// testable logic stays in the sibling server module `src/server/oauth/authorize.ts`
// (OBS-025); this file exports just `GET`.
//
// E10-S12 — consent before code. The route no longer issues a code outright: a valid,
// signed-in request is CARRIED SERVER-SIDE (the pending store) and the person is sent to
// the internal `/oauth/consent` screen. The opaque handle to that pending request rides
// in a host-locked cookie (never a URL/form field), so the consent page and the decision
// read the request back server-side. The code is minted only once the person approves.

import { loadConfig } from "../../../server/config";
import { getServerDb } from "../../../server/db/server";
import { verifySession } from "../../../server/auth/session";
import { beginAuthorization } from "../../../server/oauth/authorize";
import { systemClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";

// Mirrors the host-locked cookie name set by the session module.
const SESSION_COOKIE = "__Host-wh_session";
// The host-locked cookie that carries the pending authorize request's opaque handle to
// the consent screen and the decision (never a URL/form field).
const CONSENT_COOKIE = "__Host-wh_consent";

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
  return `${CONSENT_COOKIE}=${handle}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function GET(request: Request): Promise<Response> {
  const config = loadConfig();
  const db = await getServerDb();
  const token = readCookie(request, SESSION_COOKIE);
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  const params = new URL(request.url).searchParams;

  const result = await beginAuthorization(
    { params, session },
    { db, config, clock: systemClock, random: systemRandom },
  );

  if (result.ok) {
    // Carry the pending request's handle in a host-locked cookie and send the person to
    // the consent screen — no code is issued and nothing is sent to the client yet.
    return new Response(null, {
      status: 302,
      headers: { Location: result.redirectTo, "Set-Cookie": consentCookie(result.handle) },
    });
  }
  // Not signed in → send the person to sign in; any other rejection is a bad request.
  if (result.error === "login_required") {
    return new Response(null, { status: 302, headers: { Location: "/signin" } });
  }
  return new Response(result.error, { status: 400 });
}
