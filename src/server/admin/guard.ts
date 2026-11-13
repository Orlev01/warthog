// The admin-area guard (docs/design/admin-portal.md §2): the one place the `/admin` layout
// turns "the `__Host-wh_admin` cookie the browser presented" into "admit this admin, or
// send them back to the app's Settings to start again". A null, unknown, tampered, expired
// or revoked token (the app session gone, the person demoted or deleted) yields the
// redirect; a verified token yields the admin session. The decision lives here so a thin
// layout can delegate to a tested seam, exactly as the member portal's guard does.

import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";
import { verifyAdminSession, type AdminSession } from "./session";

export const ADMIN_SIGN_IN_NOTICE = "admin_signin_required";

export type AdminGuardResult =
  | { readonly ok: true; readonly session: AdminSession }
  | { readonly ok: false; readonly redirectTo: string };

export function adminSignInUrl(publicOrigin: string, notice: string = ADMIN_SIGN_IN_NOTICE): string {
  return `${publicOrigin}/settings?notice=${notice}`;
}

export async function requireAdminSession(
  token: string | null,
  deps: { db: Db; clock: Clock; publicOrigin: string },
): Promise<AdminGuardResult> {
  const redirectTo = adminSignInUrl(deps.publicOrigin);
  if (token == null || token === "") return { ok: false, redirectTo };
  const session = await verifyAdminSession(deps.db, token, { clock: deps.clock });
  return session ? { ok: true, session } : { ok: false, redirectTo };
}
