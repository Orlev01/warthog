// Who is an admin (docs/design/admin-portal.md §2): `users.role` in the database is the only
// thing the gates consult. This reconciliation is how the configured operator gets that
// role without manual SQL: the account whose normalised email is OPERATOR_EMAIL is promoted
// (never a tombstone). Promote only — never demote — so an admin granted by a reviewed
// migration later is not undone, and config is never consulted at request time. Runs on the
// hourly `operator-role` sweep (the first tick after boot included).

import type { Db } from "../db/index";
import { normaliseEmail } from "../db/users";

/** Promote the operator's account to admin; returns how many rows changed (0 or 1). */
export async function reconcileOperatorRole(db: Db, operatorEmail: string | undefined): Promise<number> {
  if (!operatorEmail || !operatorEmail.trim()) return 0;
  const result = await db.query(
    `UPDATE users SET role = 'admin'
      WHERE lower(email) = $1 AND role <> 'admin' AND wrapped_dek <> ''
      RETURNING id`,
    [normaliseEmail(operatorEmail)],
  );
  return result.rows.length;
}
