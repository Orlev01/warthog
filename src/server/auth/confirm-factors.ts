import type { Db } from "../db/index";

// Which ways this member can confirm it's you, so an inline "Confirm it's you" control offers
// only those (enrolment metadata only: no secret is read). Scoped to the session person.
export async function confirmFactors(db: Db, userId: string): Promise<{ passkey: boolean; authenticator: boolean }> {
  const result = await db.query(
    `SELECT EXISTS (SELECT 1 FROM passkeys WHERE user_id = $1) AS passkey,
            EXISTS (SELECT 1 FROM totp_secrets WHERE user_id = $1) AS authenticator`,
    [userId],
  );
  return { passkey: result.rows[0]?.passkey === true, authenticator: result.rows[0]?.authenticator === true };
}
