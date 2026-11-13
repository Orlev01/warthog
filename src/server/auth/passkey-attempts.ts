import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { EmailSender } from "../notify/senders";
import { deliverAlert } from "./alerts";
import { SECURITY_ALERT_FOOTNOTE } from "../notify/email";

const WINDOW = 15 * 60_000;
export async function checkPasskeyAttempt(db: Db, userId: string, verify: () => Promise<boolean>,
  deps: { clock: Clock; emailSender: EmailSender }): Promise<{ ok: boolean; reason?: "invalid" | "throttled"; retryAfterMs?: number }> {
  const now = deps.clock.now(), floor = new Date(now.getTime() - WINDOW);
  await db.query("DELETE FROM passkey_attempts WHERE user_id = $1 AND attempted_at <= $2::timestamptz", [userId, floor.toISOString()]);
  const attempt = await db.query("INSERT INTO passkey_attempts (user_id, attempted_at) VALUES ($1, $2::timestamptz) RETURNING id", [userId, now.toISOString()]);
  const id = attempt.rows[0]?.id;
  const count = await db.query("SELECT count(*)::int AS n, min(attempted_at) AS oldest FROM passkey_attempts WHERE user_id = $1 AND attempted_at > $2::timestamptz", [userId, floor.toISOString()]);
  const attempts = Number(count.rows[0]?.n);
  if (attempts > 5) {
    await db.query("DELETE FROM passkey_attempts WHERE id = $1", [id]);
    return { ok: false, reason: "throttled", retryAfterMs: Math.max(1000, new Date(count.rows[0]?.oldest as string).getTime() + WINDOW - now.getTime()) };
  }
  let ok = false;
  try { ok = await verify(); } catch { /* A malformed assertion is a failed attempt. */ }
  if (ok) {
    await db.query("DELETE FROM passkey_attempts WHERE id = $1", [id]);
    return { ok: true };
  }
  if (attempts >= 5) {
    const claimed = await db.query(`INSERT INTO passkey_alerts (user_id, sent_at) VALUES ($1, $2::timestamptz)
      ON CONFLICT (user_id) DO UPDATE SET sent_at = EXCLUDED.sent_at
      WHERE passkey_alerts.sent_at <= $3::timestamptz RETURNING user_id`, [userId, now.toISOString(), floor.toISOString()]);
    if (claimed.rows.length) {
      const user = await db.query("SELECT email FROM users WHERE id = $1", [userId]);
      if (user.rows[0]) await deliverAlert("passkey-failures", () => deps.emailSender.sendEmail({ recipient: user.rows[0]!.email as string,
        body: "Several passkey sign-in attempts failed. We have temporarily limited further attempts. No failed attempt signed in to your account.",
        email: {
          subject: "Passkey sign-in attempts limited",
          heading: "Several passkey sign-ins failed",
          paragraphs: [
            "Several attempts to sign in to your Warthog account with a passkey failed, so we've temporarily limited further attempts.",
            "None of the failed attempts signed in to your account.",
          ],
          footnote: SECURITY_ALERT_FOOTNOTE,
        } }));
    }
  }
  return { ok: false, reason: "invalid" };
}
