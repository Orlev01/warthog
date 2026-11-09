// The notification-preferences aggregate's data access (design §10 Notifications /
// "Fallback job"; brief "Notification settings"). One person's preferences live in
// exactly one place here (constitution: one-source-of-truth): the fallback job reads
// them to decide whether to also send by email and how long to wait before firing.
//
// A person's preferences are PLAINTEXT METADATA (design §4.1: a boolean and a small
// integer the fallback job reads) — so, unlike approval detail or released values,
// they are NOT DEK-encrypted and this module holds no key and reads no `process.env`
// (config flows from `src/server/config.ts` alone, INV-103).
//
// Every statement is parameterized through the `Db` seam (INV-102): the user id, the
// email-fallback choice and the delay travel as BOUND values, never concatenated into
// the SQL text, so a value shaped like SQL is stored as data and cannot alter the
// query. Every read and write is member-scoped by the `userId` the caller passes —
// the session's id, never a client value — so one person can never read or change
// another's preferences.

import type { Db, Row } from "./index";

// A person's notification preferences. `emailFallback` is whether fallback messages
// also go by email (on by default); `fallbackDelayMinutes` is how long to wait before
// the fallback fires (default 2, within the inclusive 1–30 range).
export interface NotificationPrefs {
  readonly userId: string;
  readonly emailFallback: boolean;
  readonly smsFallback?: boolean;
  readonly fallbackDelayMinutes: number;
}

// What saveNotificationPrefs takes: the person (the SESSION's id, never a client
// value) and the two chosen settings. A delay outside 1–30 is rejected.
export interface SaveNotificationPrefsInput {
  readonly userId: string;
  readonly emailFallback: boolean;
  readonly smsFallback?: boolean;
  readonly fallbackDelayMinutes: number;
}

// The outcome of a save: the persisted preferences, or a refusal because the delay
// fell outside the inclusive 1–30 range (in which case NOTHING was written).
export type SaveNotificationPrefsResult =
  | { ok: true; prefs: NotificationPrefs }
  | { ok: false; reason: "delay_out_of_range" };

// The brief's defaults for a person who has saved nothing: email fallback on, a
// 2-minute delay. Assembled in code (carrying the queried user id) rather than read
// from a row.
const DEFAULT_EMAIL_FALLBACK = true;
const DEFAULT_FALLBACK_DELAY_MINUTES = 2;

// The brief's inclusive delay bounds (minutes). A save outside this range is refused.
const MIN_FALLBACK_DELAY_MINUTES = 1;
const MAX_FALLBACK_DELAY_MINUTES = 30;

// Map a raw row to the preferences shape, translating the snake_case columns to the
// module's camelCase fields; the delay comes back as a number, the flag as a boolean.
function toPrefs(userId: string, row: Row): NotificationPrefs {
  return {
    userId,
    emailFallback: row.email_fallback as boolean,
    smsFallback: row.sms_fallback === true,
    fallbackDelayMinutes: Number(row.fallback_delay_minutes),
  };
}

// Read the preferences for the person with this id (member-scoped: user_id bound as a
// parameter). When the person has saved none, returns the brief's defaults assembled
// in code and carrying the queried id — never another person's preferences.
export async function getNotificationPrefs(db: Db, userId: string): Promise<NotificationPrefs> {
  const result = await db.query(
    "SELECT email_fallback, sms_fallback, fallback_delay_minutes FROM notification_prefs WHERE user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      userId,
      emailFallback: DEFAULT_EMAIL_FALLBACK,
      smsFallback: false,
      fallbackDelayMinutes: DEFAULT_FALLBACK_DELAY_MINUTES,
    };
  }
  return toPrefs(userId, row);
}

// Write the ONE preferences row for input.userId, INSERTing it or UPDATEing the one
// already there — keyed on user_id, so a second save overwrites in place and never
// duplicates. Member-scoped: the user id is bound, so a save writes the caller's OWN
// row and leaves every other person's untouched.
//
// REFUSES (returns { ok: false, reason: "delay_out_of_range" }, never silently) when
// the delay falls outside the inclusive 1–30 range — the check runs BEFORE any query,
// so a refused save writes no row (the previously stored value, or the default, is
// left untouched and is NOT clamped into range). On success returns { ok: true, prefs }
// with prefs assembled from the inputs (it does not depend on a RETURNING read).
export async function saveNotificationPrefs(
  db: Db,
  input: SaveNotificationPrefsInput,
): Promise<SaveNotificationPrefsResult> {
  if (
    !Number.isInteger(input.fallbackDelayMinutes) ||
    input.fallbackDelayMinutes < MIN_FALLBACK_DELAY_MINUTES ||
    input.fallbackDelayMinutes > MAX_FALLBACK_DELAY_MINUTES
  ) {
    return { ok: false, reason: "delay_out_of_range" };
  }

  await db.query(
    `INSERT INTO notification_prefs (user_id, email_fallback, fallback_delay_minutes, sms_fallback, sms_consent_updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET
       email_fallback         = EXCLUDED.email_fallback,
       sms_fallback = EXCLUDED.sms_fallback,
       sms_consent_updated_at = CASE WHEN notification_prefs.sms_fallback IS DISTINCT FROM EXCLUDED.sms_fallback THEN now() ELSE notification_prefs.sms_consent_updated_at END,
       fallback_delay_minutes = EXCLUDED.fallback_delay_minutes`,
    [input.userId, input.emailFallback, input.fallbackDelayMinutes, input.smsFallback === true],
  );

  return {
    ok: true,
    prefs: {
      userId: input.userId,
      emailFallback: input.emailFallback,
      smsFallback: input.smsFallback === true,
      fallbackDelayMinutes: input.fallbackDelayMinutes,
    },
  };
}
