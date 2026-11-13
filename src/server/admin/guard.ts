// The admin-area guard (docs/design/admin-portal.md §2): the one place the `/admin` layout
// turns "the `__Host-wh_admin` cookie the browser presented" into "admit this admin, or
// send them to the admin host's own sign-in page". A null, unknown, tampered, expired or
// revoked token (the app session gone, the person demoted or deleted) yields the redirect;
// a verified token yields the admin session. The decision lives here so a thin layout can
// delegate to a tested seam, exactly as the member portal's guard does.
//
// The redirect is a path on the admin host itself, never the app: the member app carries
// no trace of the portal (amendment of 13 November 2026).

import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";
import { verifyAdminSession, type AdminSession } from "./session";

// The admin host's sign-in page (served as /admin/signin after the proxy's rewrite).
export const ADMIN_SIGN_IN_PATH = "/signin";

// Why someone was sent to sign in, shown there as one plain sentence.
export const ADMIN_SIGN_IN_NOTICES = {
  expired: "That sign-in link has expired or was already used. Sign in again.",
  signed_out: "You've signed out of the admin portal.",
} as const;
export type AdminSignInNotice = keyof typeof ADMIN_SIGN_IN_NOTICES;

export function adminSignInUrl(notice?: AdminSignInNotice): string {
  return notice ? `${ADMIN_SIGN_IN_PATH}?notice=${notice}` : ADMIN_SIGN_IN_PATH;
}

export function adminSignInNoticeFrom(value: string | string[] | undefined): AdminSignInNotice | null {
  const key = Array.isArray(value) ? value[0] : value;
  return key && Object.hasOwn(ADMIN_SIGN_IN_NOTICES, key) ? (key as AdminSignInNotice) : null;
}

export type AdminGuardResult =
  | { readonly ok: true; readonly session: AdminSession }
  | { readonly ok: false; readonly redirectTo: string };

export async function requireAdminSession(
  token: string | null,
  deps: { db: Db; clock: Clock },
): Promise<AdminGuardResult> {
  const redirectTo = adminSignInUrl();
  if (token == null || token === "") return { ok: false, redirectTo };
  const session = await verifyAdminSession(deps.db, token, { clock: deps.clock });
  return session ? { ok: true, session } : { ok: false, redirectTo };
}
