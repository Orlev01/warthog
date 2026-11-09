import { withTransaction, type Db } from "../db/index";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function cleanupOAuth(db: Db, now: Date): Promise<void> {
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  await withTransaction(db, async (tx) => {
    await tx.query("DELETE FROM oauth_auth_codes WHERE expires_at <= $1::timestamptz", [stamp]);
    // Expired refresh rows are also replay evidence. Keep the whole family while
    // any refresh is current, and keep a 30-day tail for abandoned families.
    await tx.query(`DELETE FROM oauth_tokens AS expired
      WHERE (kind = 'access' AND expires_at <= $1::timestamptz)
         OR (kind = 'refresh' AND expires_at < $2::timestamptz
          AND NOT EXISTS (SELECT 1 FROM oauth_tokens AS live
            WHERE live.connection_id = expired.connection_id
              AND live.kind = 'refresh' AND live.expires_at > $1::timestamptz))`, [stamp, cutoff]);
    await tx.query(`DELETE FROM oauth_clients AS client
      WHERE registration = 'dcr' AND first_used_at IS NULL AND created_at < $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM oauth_auth_codes AS code WHERE code.client_id = client.client_id)`, [cutoff]);
  });
}
