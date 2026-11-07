// E15-S15 — the testable sibling of the household-invite accept HTTP entry (brief
// "Household sharing": the owner invites members by email, the link is valid 7 days, up to
// 8 members, members join with their own accounts; design §4.1).
//
// A Next App-Router `route.ts` may export ONLY the known route keys (the HTTP verb(s) +
// framework config) or `next build` rejects it (OBS-025), so the injectable, unit-testable
// seam lives HERE, beside the entry; `route.ts` imports `createHouseholdJoinHandler` and
// exports only `GET`.
//
// `GET /household/join/[token]` redeems the single-use household-invite token for the
// SIGNED-IN invited person and opens the Household page in-app. The link carries NO
// authority of its own beyond adding the signed-in user once: it adds nobody until the
// person is signed in. The order (mirroring the approval-link route `/a/[token]`, E12-S14):
//   1. validate the token shape at the boundary (INV-102) — a malformed or oversized token
//      is a 4xx and never reaches the invite store.
//   2. resolve the session from the `__Host-wh_session` cookie (the real `verifySession`).
//      No session → redirect to sign-in and redeem NOTHING, so the single-use token
//      survives for after sign-in and the link adds no member by itself.
//   3. redeem the token (the real `redeemInvite`) for the SESSION's user id — never a value
//      from the path/body: a live, unexpired, unused token adds the signed-in person to the
//      bound household ONCE; a reused, expired or unknown token is rejected and adds no
//      member; a redemption that would exceed the 8-member cap is refused with a plain
//      reason.
//   4. on success, redirect IN-APP to the Household page (`/household`), built from the
//      CONFIGURED public base URL — never the request host.
//
// Config flows in through the injected seam, defaulting to the one env reader `loadConfig`
// (INV-103): the redirect targets are built from the CONFIGURED public base URL, never from
// the request host, so a forged Host header cannot bounce the person off Warthog. The db,
// clock and config are resolved lazily inside the handler, so merely constructing the
// factory (as the route entry does at module load) reads no config and opens no database —
// which keeps the entry importable under `next build`.

import { z } from "zod";

import { HttpError, parseParams } from "../../../../server/http/validate";
import { COOKIE_NAME, verifySession } from "../../../../server/auth/session";
import { redeemInvite } from "../../../../server/db/household-invites";
import { loadConfig, type Config } from "../../../../server/config";
import { getServerDb } from "../../../../server/db/server";
import { systemClock, type Clock } from "../../../../server/seams/clock";
import type { Db } from "../../../../server/db/index";

// The injection seams, each defaulting to the real composition root. All three are optional
// so the route entry can build the handler with `createHouseholdJoinHandler()` and leave
// every default in place; the tests inject a test db + a fixed clock + an explicit config.
export interface HouseholdJoinSeams {
  readonly db?: Db;
  readonly clock?: Clock;
  readonly config?: Config;
}

// The route handlers this factory produces — only the HTTP verb the entry re-exports.
export interface HouseholdJoinRouteHandlers {
  GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response>;
}

// An invite token rides inside a URL, so it is a short, URL-safe opaque string (base64url of
// 256 bits — 43 characters). A value laced with SQL punctuation, or one far beyond any sane
// opaque-link length, fails this shape check and is rejected at the boundary before it can
// reach the invite store (INV-102) — the store binds the token's hash regardless, so this is
// the outer of two guards, not the only one.
const MAX_TOKEN_CHARS = 64;
const tokenSchema = z
  .string()
  .min(1)
  .max(MAX_TOKEN_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/);

// The Household page the link opens in-app, and the sign-in page an unauthenticated click is
// sent to.
const HOUSEHOLD_PATH = "/household";
const SIGNIN_PATH = "/signin";

// Pull one cookie's value out of the request's Cookie header, or null when absent (so the
// session token is read out of a real `a=…; __Host-wh_session=…; b=…` header rather than
// assuming the whole header is the token).
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

// A same-origin, in-app redirect to `path` (optionally carrying a `notice` reason), built
// from the CONFIGURED public base URL — never the request host — so the link always lands on
// Warthog. A refusal carries its reason as `?notice=`, the repo's plain-reason idiom.
function redirectTo(baseUrl: string, path: string, notice?: string): Response {
  const target = new URL(path, baseUrl);
  if (notice !== undefined) target.searchParams.set("notice", notice);
  return new Response(null, { status: 303, headers: { location: target.toString() } });
}

export function createHouseholdJoinHandler(
  seams: HouseholdJoinSeams = {},
): HouseholdJoinRouteHandlers {
  async function GET(
    request: Request,
    context: { params: Promise<{ token: string }> },
  ): Promise<Response> {
    const clock = seams.clock ?? systemClock;
    const config = seams.config ?? loadConfig();
    const baseUrl = config.publicBaseUrl;

    // 1. Validate the token shape at the boundary; a malformed/oversized token is a 4xx and
    //    never reaches the invite store.
    let token: string;
    try {
      const params = await context.params;
      token = parseParams(tokenSchema, params.token);
    } catch (error) {
      if (error instanceof HttpError) {
        return new Response(null, { status: error.status });
      }
      throw error;
    }

    const db = seams.db ?? (await getServerDb());

    // 2. Resolve the session. No session → sign-in; the token is NOT redeemed, so it
    //    survives for after sign-in and the link adds no member by itself.
    const sessionToken = readCookie(request, COOKIE_NAME);
    const session = sessionToken ? await verifySession(db, sessionToken, { clock }) : null;
    if (!session) {
      return redirectTo(baseUrl, SIGNIN_PATH);
    }

    // 3. Redeem the single-use token for the SESSION's user id (never a value from the
    //    path/body). A live, unused, unexpired token adds this person to the bound household
    //    ONCE; a reused/expired/unknown token is rejected and adds no member; a full
    //    household is refused with a plain reason.
    const redeemed = await redeemInvite(db, { token, userId: session.userId }, { clock });
    if (!redeemed.ok) {
      return redirectTo(baseUrl, HOUSEHOLD_PATH, redeemed.reason);
    }

    // 4. On success, open the Household page in-app.
    return redirectTo(baseUrl, HOUSEHOLD_PATH, "joined");
  }

  return { GET };
}
