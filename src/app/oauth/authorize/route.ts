// The App-Router entry for `/oauth/authorize`: thin by design. It reads config at the
// composition root (`loadConfig()` — the one env seam), takes the process-wide db (`getServerDb()`), resolves the
// signed-in session from the `__Host-wh_session` cookie (→ `verifySession`), reads the
// agent's query, and delegates the authorization rules and code issuance to the tested
// `authorize` seam. A `route.ts` may export ONLY the known route keys, so the testable
// logic stays in the sibling server module `src/server/oauth/authorize.ts` (OBS-025);
// this file exports just `GET`.
//
// The connection the person consented to is created by the consent decision wired in
// later (E10-S03), which will supply its id here. Until then the entry mints a fresh
// server-side opaque uuid as the binding target — never a value taken from the request
// (the connection is never client-supplied).

import { randomUUID } from "node:crypto";

import { loadConfig } from "../../../server/config";
import { getServerDb } from "../../../server/db/server";
import { verifySession } from "../../../server/auth/session";
import { authorize } from "../../../server/oauth/authorize";
import { systemClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";

// Mirrors the host-locked cookie name set by the session module.
const SESSION_COOKIE = "__Host-wh_session";

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

export async function GET(request: Request): Promise<Response> {
  const config = loadConfig();
  const db = await getServerDb();
  const token = readCookie(request, SESSION_COOKIE);
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  const params = new URL(request.url).searchParams;

  const result = await authorize(
    { params, session, connectionId: randomUUID() },
    { db, config, clock: systemClock, random: systemRandom },
  );

  if (result.ok) {
    return new Response(null, { status: 302, headers: { Location: result.redirectTo } });
  }
  // Not signed in → send the person to sign in; any other rejection is a bad request.
  if (result.error === "login_required") {
    return new Response(null, { status: 302, headers: { Location: "/signin" } });
  }
  return new Response(result.error, { status: 400 });
}
