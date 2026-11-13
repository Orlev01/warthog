// What the member app's Settings needs to offer the admin entry (docs/design/admin-portal.md §2):
// whether the signed-in person is a live admin, and which second factors they hold so the
// inline step-up names only the ways they can confirm. Member-scoped by the session's user
// id, bound as a parameter; counts and flags only.

import type { Db } from "../db/index";

export interface AdminEntry {
  readonly isAdmin: boolean;
  readonly passkey: boolean;
  readonly authenticator: boolean;
}

export async function adminEntryFor(db: Db, userId: string): Promise<AdminEntry> {
  const role = await db.query("SELECT role FROM users WHERE id = $1 AND wrapped_dek <> ''", [userId]);
  if (role.rows[0]?.role !== "admin") return { isAdmin: false, passkey: false, authenticator: false };
  const passkeys = await db.query("SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1", [userId]);
  const totp = await db.query("SELECT 1 FROM totp_secrets WHERE user_id = $1", [userId]);
  return { isAdmin: true, passkey: Number(passkeys.rows[0]?.n ?? 0) > 0, authenticator: totp.rows.length > 0 };
}

// The notices the portal sends a person back to Settings with, in plain words.
export const ADMIN_NOTICES = {
  admin_handoff_expired: { tone: "warning", text: "That admin portal link has expired. Open the admin portal again." },
  admin_signin_required: { tone: "info", text: "Open the admin portal from here to sign in to it." },
  admin_signed_out: { tone: "success", text: "You've signed out of the admin portal." },
} as const;
export type AdminNoticeKey = keyof typeof ADMIN_NOTICES;

export function adminNoticeFrom(value: string | string[] | undefined): AdminNoticeKey | null {
  const key = Array.isArray(value) ? value[0] : value;
  return key && Object.hasOwn(ADMIN_NOTICES, key) ? (key as AdminNoticeKey) : null;
}
