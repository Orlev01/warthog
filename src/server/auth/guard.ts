// E06-S08 — the admin-area session guard (INV-101, design §5).
//
// Every admin route must require an authenticated operator session verified on the
// server, while the public routes stay usable with no auth (INV-101). This is the one
// place the portal's `(protected)` route group and any admin route delegate to: it
// turns "the `__Host-wh_session` cookie the browser presented" into "admit this
// operator, or send them to sign in". A `layout.tsx`/`route.ts` is an awkward unit-test
// target (reserved Next props, `redirect()` throws), so the decision lives in this
// server seam and the entry stays thin over it (conventions: thin entries over tested
// modules); `/oauth/authorize` already does this inline and this centralises it.
//
// Identity is read only from the presented session token (re-hashed and matched by
// `verifySession`), never from any other client-supplied value (INV-101). A null,
// unknown, tampered or expired token yields the redirect branch; a token `verifySession`
// accepts yields the admit branch carrying the resolved session, so an admin page can
// scope its reads by `session.userId`.

import { verifySession } from "./session";
import type { Session } from "./session";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

// Where an unauthenticated request is sent: the public sign-in page (the same target
// the `/oauth/authorize` entry redirects to when there is no session).
const SIGN_IN_PATH = "/signin";

// The outcome: a valid session to admit the operator, or a redirect to sign-in (a
// discriminated union, the repo idiom).
export type GuardResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly redirectTo: string };

// Admit an operator whose `__Host-wh_session` cookie resolves to a live session, or send
// them to sign in. `sessionToken` is the raw cookie value the entry extracted (null when
// the cookie is absent).
export async function requireSession(
  sessionToken: string | null,
  deps: { db: Db; clock: Clock },
): Promise<GuardResult> {
  if (sessionToken == null) return { ok: false, redirectTo: SIGN_IN_PATH };

  const session = await verifySession(deps.db, sessionToken, { clock: deps.clock });
  if (session == null) return { ok: false, redirectTo: SIGN_IN_PATH };

  return { ok: true, session };
}
