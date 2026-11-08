// E15-S15 — the testable sibling of the household-invite accept HTTP entry (brief
// "Household sharing": the owner invites members by email, the link is valid 7 days, up to
// 8 members, members join with their own accounts; design §4.1).
//
// A Next App-Router `route.ts` may export ONLY the known route keys (the HTTP verb(s) +
// framework config) or `next build` rejects it (OBS-025), so the injectable, unit-testable
// seam lives HERE, beside the entry; `route.ts` imports `createHouseholdJoinHandler` and
// exports only `GET` and `POST`.
//
// Opening the link NEVER joins by itself. The session cookie is SameSite=Lax, so it rides
// along on any cross-site top-level GET — a link or an auto-redirect from any site — and a
// GET that joined would let anyone silently enrol a signed-in person in their household
// (and then see their spending totals and set their limit). So:
//
// `GET /household/join/[token]` shows the CONFIRMATION, and changes nothing:
//   1. validate the token shape at the boundary (INV-102) — a malformed or oversized token
//      is a 4xx and never reaches the invite store.
//   2. resolve the session from the `__Host-wh_session` cookie (the real `verifySession`).
//      No session → redirect to sign-in with `next` set back to this link, and redeem
//      NOTHING, so the single-use token survives for after sign-in.
//   3. preview the token for the SESSION's user (the real `previewInvite`): a token that
//      would be refused (unknown/used, expired, sent to another account's email, or the
//      person is already in a household) redirects to the Household page with the plain
//      reason, before any confirmation is offered.
//   4. otherwise render a small page that says what joining shares, with a form that POSTs
//      back to this same path.
//
// `POST /household/join/[token]` performs the JOIN:
//   1. validate the token shape (a 4xx otherwise).
//   2. refuse (403) unless the request's Origin is Warthog's own configured origin — the
//      form is only ever submitted from the confirmation page, so a cross-site submission
//      (or one with no Origin) joins no one, independently of the cookie's SameSite.
//   3. resolve the session; none → sign-in (nothing redeemed).
//   4. redeem the token (the real `redeemInvite`) for the SESSION's user id — never a value
//      from the path/body: it re-checks everything the preview did, then adds the person
//      within the 8-member cap atomically and spends the token; any refusal adds no member
//      and redirects with its plain reason.
//   5. on success, redirect IN-APP to the Household page (`/household?notice=joined`).
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
import { previewInvite, redeemInvite } from "../../../../server/db/household-invites";
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

// The route handlers this factory produces — only the HTTP verbs the entry re-exports.
export interface HouseholdJoinRouteHandlers {
  GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response>;
  POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response>;
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

// The path of this link for a (shape-validated) token — where the confirmation form posts
// and where sign-in returns to. Relative, starting with a single "/", as `next` requires.
function joinPath(token: string): string {
  return `/household/join/${token}`;
}

// The sign-in redirect for a person who is not signed in, asking sign-in to come back to
// this link afterwards so the invite still works once they have.
function toSignin(baseUrl: string, token: string): Response {
  const target = new URL(SIGNIN_PATH, baseUrl);
  target.searchParams.set("next", joinPath(token));
  return new Response(null, { status: 303, headers: { location: target.toString() } });
}

// Escape a value for an HTML attribute or text node. The only dynamic value on the page is
// the token, already restricted to [A-Za-z0-9_-] by the schema; escaping anyway keeps the
// page safe if that ever loosens.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The confirmation page: what joining shares (the brief's household rules, in plain words)
// and one button that POSTs back to this link. Self-contained (no script); never cached,
// and never framed.
function confirmationPage(token: string): Response {
  const action = escapeHtml(joinPath(token));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join a household · Warthog</title>
<style>
  :root { color-scheme: light dark; --fg: #18181b; --muted: #52525b; --bg: #fafafa; --card: #ffffff; --line: #d4d4d8; --accent: #4338ca; --on-accent: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #fafafa; --muted: #a1a1aa; --bg: #09090b; --card: #18181b; --line: #3f3f46; --accent: #a5b4fc; --on-accent: #09090b; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 32rem; margin: 0 auto; padding: 48px 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.375rem; margin: 0 0 8px; }
  p, li { color: var(--muted); }
  ul { padding-left: 1.25rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 24px; }
  button { font: inherit; font-weight: 600; background: var(--accent); color: var(--on-accent); border: 0; border-radius: 8px; padding: 10px 20px; min-height: 44px; cursor: pointer; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Join this household?</h1>
    <p>You've been invited to join a household on Warthog. If you join:</p>
    <ul>
      <li>members see the shared address, the member list and the household budget totals;</li>
      <li>the household owner sets your monthly spending limit, and your agents' card requests count against it and the household budget;</li>
      <li>nobody sees your vault, cards, memory, agents or activity.</li>
    </ul>
    <form method="post" action="${action}">
      <div class="actions">
        <button type="submit">Join household</button>
        <a href="/home">Not now</a>
      </div>
    </form>
  </div>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

// Whether a POST came from Warthog's own pages: its Origin header must be exactly the
// configured public origin. A missing Origin, or the opaque "null", is refused — every
// browser sends Origin on a form POST, so only a non-browser or a cross-site submission
// lacks a matching one (fail closed).
function isSameOrigin(request: Request, baseUrl: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(baseUrl).origin;
}

export function createHouseholdJoinHandler(
  seams: HouseholdJoinSeams = {},
): HouseholdJoinRouteHandlers {
  // Validate the `[token]` param at the boundary: the token, or the 4xx Response to send.
  async function tokenFrom(context: { params: Promise<{ token: string }> }): Promise<string | Response> {
    try {
      const params = await context.params;
      return parseParams(tokenSchema, params.token);
    } catch (error) {
      if (error instanceof HttpError) {
        return new Response(null, { status: error.status });
      }
      throw error;
    }
  }

  // The verified session's user id for this request, or null (no cookie, or one the real
  // verifySession does not admit).
  async function sessionUserId(request: Request, db: Db, clock: Clock): Promise<string | null> {
    const sessionToken = readCookie(request, COOKIE_NAME);
    const session = sessionToken ? await verifySession(db, sessionToken, { clock }) : null;
    return session ? session.userId : null;
  }

  async function GET(
    request: Request,
    context: { params: Promise<{ token: string }> },
  ): Promise<Response> {
    const clock = seams.clock ?? systemClock;
    const config = seams.config ?? loadConfig();
    const baseUrl = config.publicBaseUrl;

    // 1. Validate the token shape at the boundary.
    const token = await tokenFrom(context);
    if (token instanceof Response) return token;

    const db = seams.db ?? (await getServerDb());

    // 2. No session → sign-in, coming back here; the token is NOT redeemed.
    const userId = await sessionUserId(request, db, clock);
    if (!userId) return toSignin(baseUrl, token);

    // 3. A token this person could not redeem is refused now, with its plain reason.
    const preview = await previewInvite(db, { token, userId }, { clock });
    if (!preview.ok) {
      return redirectTo(baseUrl, HOUSEHOLD_PATH, preview.reason);
    }

    // 4. Ask them to confirm. Nothing has changed.
    return confirmationPage(token);
  }

  async function POST(
    request: Request,
    context: { params: Promise<{ token: string }> },
  ): Promise<Response> {
    const clock = seams.clock ?? systemClock;
    const config = seams.config ?? loadConfig();
    const baseUrl = config.publicBaseUrl;

    // 1. Validate the token shape at the boundary.
    const token = await tokenFrom(context);
    if (token instanceof Response) return token;

    // 2. Only Warthog's own confirmation form may confirm a join.
    if (!isSameOrigin(request, baseUrl)) {
      return new Response(null, { status: 403 });
    }

    const db = seams.db ?? (await getServerDb());

    // 3. No session → sign-in; nothing is redeemed.
    const userId = await sessionUserId(request, db, clock);
    if (!userId) return toSignin(baseUrl, token);

    // 4. Redeem for the SESSION's user id; any refusal adds no member.
    const redeemed = await redeemInvite(db, { token, userId }, { clock });
    if (!redeemed.ok) {
      return redirectTo(baseUrl, HOUSEHOLD_PATH, redeemed.reason);
    }

    // 5. Joined: open the Household page in-app.
    return redirectTo(baseUrl, HOUSEHOLD_PATH, "joined");
  }

  return { GET, POST };
}
