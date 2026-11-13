// The way into the admin portal from the member app (docs/design/admin-portal.md §2, as
// amended on 13 November 2026). The app shows no admin entry anywhere: the operator starts
// at the admin host's sign-in page, signs in through the app's ordinary sign-in (passkeys
// are scoped to the app's RP ID, so only the app origin can check one), and lands on the
// unlinked `/handoff` route, which mints the handoff and sends the browser back. That
// route answers 404 to anyone who is not a signed-in live admin, exactly like a path that
// does not exist. Member-scoped by the session's user id, bound as a parameter; counts and
// flags only.

import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";
import { verifySession } from "../auth/session";

export interface AdminEntry {
  readonly isAdmin: boolean;
  readonly passkey: boolean;
  readonly authenticator: boolean;
}

// The app route that hands a signed-in admin over to the admin host. No page links to it.
export const HANDOFF_PATH = "/handoff";

// Where the admin host's "Sign in" goes: the app's ordinary sign-in, returning to the
// handoff. A visitor already signed in to the app is forwarded straight on by sign-in.
export function handoffSignInUrl(publicOrigin: string): string {
  return `${publicOrigin}/signin?next=${encodeURIComponent(HANDOFF_PATH)}`;
}

export async function adminEntryFor(db: Db, userId: string): Promise<AdminEntry> {
  const role = await db.query("SELECT role FROM users WHERE id = $1 AND wrapped_dek <> ''", [userId]);
  if (role.rows[0]?.role !== "admin") return { isAdmin: false, passkey: false, authenticator: false };
  const passkeys = await db.query("SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1", [userId]);
  const totp = await db.query("SELECT 1 FROM totp_secrets WHERE user_id = $1", [userId]);
  return { isAdmin: true, passkey: Number(passkeys.rows[0]?.n ?? 0) > 0, authenticator: totp.rows.length > 0 };
}

// Whether the presented app session may see the handoff route at all: a live session of a
// live admin yields their factors (so the inline step-up names only their own ways to
// confirm); anything else yields null, which the route turns into a plain 404. The fresh
// step-up is not checked here: minting the handoff enforces it.
export async function admitHandoff(token: string | null, deps: { db: Db; clock: Clock }): Promise<AdminEntry | null> {
  if (token == null || token === "") return null;
  const session = await verifySession(deps.db, token, { clock: deps.clock });
  if (!session) return null;
  const entry = await adminEntryFor(deps.db, session.userId);
  return entry.isAdmin ? entry : null;
}
