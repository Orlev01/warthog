// E12-S14 — the testable sibling of the single-use approval-link HTTP entry (design §10
// Notifications / SMS-email fallback; brief "SMS fallback"; constitution 18 — approvals
// only inside the signed-in app).
//
// A Next App-Router `route.ts` may export ONLY the known route keys (the HTTP verb(s) +
// framework config) or `next build` rejects it (OBS-025), so the injectable, unit-testable
// seam lives HERE, beside the entry; `route.ts` imports `createApprovalLinkHandler` and
// exports only `GET`.
//
// `GET /a/[token]` redeems the single-use link token for the SIGNED-IN OWNER and opens the
// approval in-app. The link carries NO authority of its own (constitution 18): it never
// records a decision and it opens nothing until the person is signed in. The order is:
//   1. validate the token shape at the boundary (INV-102) — a malformed or oversized token
//      is a 4xx and never reaches the link store.
//   2. resolve the session from the `__Host-wh_session` cookie (the real `verifySession`).
//      No session → redirect to sign-in and redeem NOTHING, so the single-use token
//      survives for after sign-in and the link records no decision by itself.
//   3. redeem the token (the real `redeemApprovalLink`): a reused, expired or unknown token
//      is rejected and opens nothing.
//   4. member-scope the resolved approval to `session.userId` (never a value from the path)
//      through `markOpened`, which marks the approval opened ONLY when it is owned by the
//      signed-in person — so a token that resolves to ANOTHER person's approval opens
//      nothing. Opening the approval never changes its decision status.
//   5. on success, redirect IN-APP to the approval (the inbox, carrying the approval id).
//
// Config flows in through the injected seam, defaulting to the one env reader `loadConfig`
// (INV-103): the redirect targets are built from the CONFIGURED public base URL, never from
// the request host, so a forged Host header cannot bounce the person off Warthog. The db,
// clock and config are resolved lazily inside the handler, so merely constructing the
// factory (as the route entry does at module load) reads no config and opens no database —
// which keeps the entry importable under `next build`.

import { z } from "zod";

import { HttpError, parseParams } from "../../../server/http/validate";
import { COOKIE_NAME, verifySession } from "../../../server/auth/session";
import { redeemApprovalLink } from "../../../server/db/approval-links";
import { markOpened } from "../../../server/approvals/opened";
import { loadConfig, type Config } from "../../../server/config";
import { getServerDb } from "../../../server/db/server";
import { systemClock, type Clock } from "../../../server/seams/clock";
import type { Db } from "../../../server/db/index";

// The injection seams, each defaulting to the real composition root. All three are optional
// so the route entry can build the handler with `createApprovalLinkHandler()` and leave
// every default in place; the tests inject a test db + a fixed clock + an explicit config.
export interface ApprovalLinkSeams {
  readonly db?: Db;
  readonly clock?: Clock;
  readonly config?: Config;
}

// The route handlers this factory produces — only the HTTP verb the entry re-exports.
export interface ApprovalLinkRouteHandlers {
  GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response>;
}

// A link token rides inside a URL, so it is a short, URL-safe opaque string (base64url of
// 256 bits — 43 characters). A value laced with SQL punctuation, or one far beyond any sane
// opaque-link length, fails this shape check and is rejected at the boundary before it can
// reach the link store (INV-102) — the store binds the token's hash regardless, so this is
// the outer of two guards, not the only one.
const MAX_TOKEN_CHARS = 64;
const tokenSchema = z
  .string()
  .min(1)
  .max(MAX_TOKEN_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/);

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

// A same-origin, in-app redirect to `path` (optionally carrying `approval`), built from the
// CONFIGURED public base URL — never the request host — so the link always lands on Warthog.
function redirectTo(baseUrl: string, path: string, approvalId?: string): Response {
  const target = new URL(path, baseUrl);
  if (approvalId !== undefined) target.searchParams.set("approval", approvalId);
  return new Response(null, { status: 303, headers: { location: target.toString() } });
}

export function createApprovalLinkHandler(
  seams: ApprovalLinkSeams = {},
): ApprovalLinkRouteHandlers {
  async function GET(
    request: Request,
    context: { params: Promise<{ token: string }> },
  ): Promise<Response> {
    const clock = seams.clock ?? systemClock;
    const config = seams.config ?? loadConfig();
    const baseUrl = config.publicBaseUrl;

    // 1. Validate the token shape at the boundary; a malformed/oversized token is a 4xx and
    //    never reaches the link store.
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
    //    survives for after sign-in and the link records no decision by itself.
    const sessionToken = readCookie(request, COOKIE_NAME);
    const session = sessionToken ? await verifySession(db, sessionToken, { clock }) : null;
    if (!session) {
      return redirectTo(baseUrl, "/signin");
    }

    // 3. Redeem the single-use token. A reused, expired or unknown token opens nothing.
    const redeemed = await redeemApprovalLink(db, { token }, { clock });
    if (!redeemed.ok) {
      return redirectTo(baseUrl, "/inbox");
    }

    // 4. Member-scope the resolved approval to the SESSION's user id (never the path). Marks
    //    the approval opened only when it is this person's; a non-owner marks nothing and
    //    opens nothing. Marking opened changes no decision status.
    const owned = await markOpened(db, { id: redeemed.approvalId, userId: session.userId }, clock);
    if (!owned) {
      return redirectTo(baseUrl, "/inbox");
    }

    // 5. Open the approval in-app.
    return redirectTo(baseUrl, "/inbox", redeemed.approvalId);
  }

  return { GET };
}
