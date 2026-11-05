// E04-S38 — Sign out: the injectable sign-out handler plus the route dispatcher that
// wraps it (the testable sibling seam of `src/app/api/auth/signout/route.ts`).
//
// A signed-in person ends the session on the device they are using: POST
// /api/auth/signout deletes exactly that session server-side, clears the host-locked
// `__Host-wh_session` cookie and redirects to /signin (design §5).
//
// Two seams live here because a Next App-Router `route.ts` may export ONLY the known
// route keys (the HTTP verbs) or `next build` rejects it (OBS-025):
//   • createSignoutHandler(deps)      — the pure request handler, unit-tested with a
//                                       real session seam over an in-memory db.
//   • createSignoutRouteHandler(seams) — the dispatcher the thin entry constructs at
//                                       module load; it builds the handler LAZILY from
//                                       the auth composition root on the first request
//                                       and reuses it, so merely importing the entry
//                                       reads no config and opens no database (the
//                                       server-composition-roots addendum).
//
// Security (each a reviewer veto): the request `Origin` is checked against the
// configured `publicOrigin` FIRST — a missing or foreign Origin is 403 and ends
// nothing (no row deleted, no cookie cleared), so a cross-site request cannot sign
// anyone out (design §5). The presented token is deleted through the real session seam
// (`deleteSession`), bound as its hash (parameterized, INV-102), so only that one
// session ends and a SQL-shaped token matches nothing rather than altering a statement.

import { getSignoutDeps } from "./compose";
import { COOKIE_NAME, clearedSessionCookie, deleteSession } from "./session";
import type { Db } from "../db/index";

// The dependency bundle the composition root builds: the shared db and the origin the
// Origin check accepts (the origin of the configured public base URL).
export interface SignoutHandlerDeps {
  readonly db: Db;
  readonly publicOrigin: string;
}

// The request handler the route forwards to.
export type SignoutHandler = (request: Request) => Promise<Response>;

// Pull one cookie's value out of the request's Cookie header, or null when absent (so
// the handler reads the right value out of a real `a=…; __Host-wh_session=…; b=…`
// header rather than assuming the whole header is the token).
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

// Build the sign-out handler. The request is same-origin only when it carries exactly
// the configured Origin; a missing (`null`) or foreign Origin cannot be proven
// same-origin, so it is refused and nothing changes.
export function createSignoutHandler(deps: SignoutHandlerDeps): SignoutHandler {
  const { db, publicOrigin } = deps;

  return async function signout(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== publicOrigin) {
      return new Response(null, { status: 403 });
    }

    const token = readCookie(request, COOKIE_NAME);
    if (token != null) await deleteSession(db, token);

    // Clear the cookie and land on /signin whether or not a session was found (a
    // request with no session still clears the cookie and redirects).
    return new Response(null, {
      status: 303,
      headers: { location: "/signin", "set-cookie": clearedSessionCookie() },
    });
  };
}

// The injection seams the route entry leaves at their defaults: the composition root
// that produces the deps, and the handler factory that consumes them.
export interface SignoutRouteSeams {
  getDeps?: () => Promise<SignoutHandlerDeps>;
  createHandler?: (deps: SignoutHandlerDeps) => SignoutHandler;
}

// Build the route dispatcher. Constructing it touches no config or database: the
// handler is built on the FIRST request (so the entry stays importable under
// `next build`) and then reused for every later request.
export function createSignoutRouteHandler(
  seams: SignoutRouteSeams = {},
): (request: Request) => Promise<Response> {
  const getDeps = seams.getDeps ?? getSignoutDeps;
  const createHandler = seams.createHandler ?? createSignoutHandler;

  let handlerPromise: Promise<SignoutHandler> | undefined;
  function handler(): Promise<SignoutHandler> {
    if (handlerPromise === undefined) {
      handlerPromise = getDeps().then((deps) => createHandler(deps));
      // A failed bring-up (e.g. a briefly unreachable database) must not brick sign-out for
      // the life of the process: forget the rejected promise so the next request retries.
      handlerPromise.catch(() => {
        handlerPromise = undefined;
      });
    }
    return handlerPromise;
  }

  return async function dispatch(request: Request): Promise<Response> {
    return (await handler())(request);
  };
}
