import { createHmac } from "node:crypto";
import { withTransaction, type Db } from "../db/index";

export interface SmsLimits { readonly monthly: number; readonly daily: number; readonly recipientHourly: number; readonly recipientDailyMessages: number }

export async function reserveSmsSegments(db: Db, hmacKey: Uint8Array, limits: SmsLimits,
  recipient: string, segments: number, now: Date): Promise<void> {
  if (!Number.isSafeInteger(segments) || segments < 1 || Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1)) {
    throw new Error("SMS limits are not configured");
  }
  const stamp = now.toISOString();
  const recipientKey = createHmac("sha256", hmacKey).update(`sms-recipient:${recipient}`).digest("hex");
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const hourEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1));
  const buckets: [string, number, Date, number][] = [
    [`month:${stamp.slice(0, 7)}`, limits.monthly, monthEnd, segments],
    [`day:${stamp.slice(0, 10)}`, limits.daily, dayEnd, segments],
    [`recipient:${recipientKey}:${stamp.slice(0, 13)}`, limits.recipientHourly, hourEnd, segments],
    [`recipient-day:${recipientKey}:${stamp.slice(0, 10)}`, limits.recipientDailyMessages, dayEnd, 1],
  ];
  await withTransaction(db, async (tx) => {
    await tx.query("DELETE FROM sms_usage_buckets WHERE expires_at <= $1::timestamptz", [stamp]);
    for (const [bucket, limit, expiry, increment] of buckets) {
      if (increment > limit) throw new Error("SMS limit reached");
      const result = await tx.query(
        `INSERT INTO sms_usage_buckets (bucket, used, expires_at) VALUES ($1, $2, $4::timestamptz)
         ON CONFLICT (bucket) DO UPDATE SET used = sms_usage_buckets.used + $2
         WHERE sms_usage_buckets.used + $2 <= $3 RETURNING used`,
        [bucket, increment, limit, expiry.toISOString()],
      );
      if (result.rows.length !== 1) throw new Error("SMS limit reached");
    }
  });
}
