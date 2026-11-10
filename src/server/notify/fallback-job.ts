// E12-S08 — the approval fallback job (design §10 Notifications). The brief's NFR:
// "IF a person has no registered push device, or an approval has not been opened
// within the person's fallback delay (default 2 minutes), THEN THE SYSTEM SHALL send
// one SMS to the verified mobile number (if any) and one email (unless the person
// switched email fallback off), each containing a single-use link that expires after
// 10 minutes and opens the approval only after sign-in."
//
// `runApprovalFallback` is what the background worker runs when the fallback job it
// claimed (`approval.fallback`, scheduled by the notifier at created_at + the person's
// delay) comes due. At that moment, for the one approval the job carries, it:
//   • does NOTHING when the approval is no longer armed — already opened, already
//     decided (approved / denied / expired), or past its expiry even if the expiry
//     sweep has not marked it yet — so nobody is told about an approval they can no
//     longer act on, and a person who got there in time is never messaged;
//   • sends each channel at most ONCE — a channel is recorded as sent
//     (`approval_fallback_sends`) only after its send succeeds, so a re-run sends only
//     the channels that have not gone yet, and nothing once both have (idempotent even
//     while the approval is still unopened);
//   • otherwise issues ONE single-use link (a 256-bit token, 10-minute expiry) and
//     sends ONE SMS to the owner's VERIFIED number (if any) AND ONE email to the
//     owner's address (unless they switched email fallback off) — whichever of those
//     has not gone yet — each carrying that one link. One channel's failure never
//     stops the other: both are attempted, and the failure is then rethrown so the
//     job is retried (with a fresh link) for just the channel that failed.
//
// The message carries the single-use link but NO approval detail: the detail is the
// person's own (DEK-encrypted) personal content, and this job never loads it, so it
// cannot leak into a body or a link. The link token is a credential, but THIS is the
// single message that delivers it to the person (project redaction rule's explicit
// exception), so it rides in clear here and nowhere else.
//
// A SERVER module built purely from its INJECTED seams (db, clock, random, senders,
// publicBaseUrl) plus its input: it reads no `process.env` and holds no secret
// (INV-103) — the ACS email/SMS connection strings live in the senders it is handed,
// the link entropy in the injected random, and the public address is passed in, never
// read from the environment here. The one untrusted-shaped field (the approval id) is
// validated AND shape-guarded at the boundary (a UUID → a 4xx `HttpError` before any
// query runs, OBS-049/INV-102), so an injection-shaped id never reaches `WHERE id = $1`
// and cannot alter a query; every real value is bound as a parameter, never
// concatenated.

import { z } from "zod";

import { issueApprovalLink } from "../db/approval-links";
import { listMobileNumbers } from "../db/mobile-numbers";
import { getNotificationPrefs } from "../db/notification-prefs";
import { parseParams } from "../http/validate";
import type { Senders } from "./senders";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Db } from "../db/index";

// The injected seams — no process.env (INV-103). `senders` is the CONFIGURED bundle;
// only `.email` / `.sms` are used here (the push channel is the notifier's concern).
export interface ApprovalFallbackDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly senders: Senders;
  // The configured public address (warthog.com.au) the single-use link is rooted at
  // (project rule 21) — passed in, never hard-coded in this module (INV-103).
  readonly publicBaseUrl: string;
}

export interface ApprovalFallbackInput {
  // The approval the enqueued job carries (its `payload.approvalId`).
  readonly approvalId: string;
}

// Every approval id is a UUID (created with `randomUUID` / `gen_random_uuid`), and the
// `approvals.id` column is uuid-typed. A malformed, oversized or otherwise non-UUID id
// — e.g. a SQL-injection probe — can match no approval, so we refuse it at the boundary
// with a 4xx rather than feed it to a query where the uuid cast would fail (OBS-049).
const approvalIdSchema = z.uuid();

// The copy the fallback messages carry. Plain Australian English, no protocol jargon,
// and — critically — NO approval detail: the personal content never reaches a message.
const SMS_BODY =
  "You have an approval waiting in Warthog. Open the secure link to sign in and " +
  "decide. The link works once and expires in 10 minutes.";
const EMAIL_BODY =
  "You have an approval waiting in Warthog. Open the secure link to sign in and " +
  "decide. The link works once and expires 10 minutes after it was sent. If you did " +
  "not expect this, you can ignore this message.";

// Build the single-use link the SMS and email carry: the configured public address
// (trailing slash trimmed) + the approval-open path + the raw token (base64url, so it
// rides in a URL without escaping).
function buildLink(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/approvals/open?token=${token}`;
}

// The two fallback channels, as recorded in approval_fallback_sends.
type FallbackChannel = "sms" | "email";

// The owner resolved from a still-ARMED approval row, plus the channels that have
// already gone out for it.
interface ApprovalFallbackState {
  readonly userId: string;
  readonly email: string;
  readonly sent: ReadonlySet<FallbackChannel>;
}

// Resolve the approval's OWNER (user id + email) and the channels already sent, in one
// parameterized read — but only while the approval is still ARMED: pending, unopened and
// not past its expiry at `now`. The approval id and the instant are BOUND as parameters
// (INV-102), never woven into the SQL text. The owner comes from the approval's own row
// (member scope is taken from the approval, never from a client value), so the SMS and
// email can only reach the owner. Returns null when there is no such armed approval.
async function loadArmedState(
  db: Db,
  approvalId: string,
  now: Date,
): Promise<ApprovalFallbackState | null> {
  const result = await db.query(
    `SELECT a.user_id AS user_id,
            u.email    AS email,
            ARRAY(SELECT s.channel FROM approval_fallback_sends s
                   WHERE s.approval_id = a.id) AS sent
       FROM approvals a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = $1
        AND a.status = 'pending'
        AND a.opened_at IS NULL
        AND a.expires_at > $2::timestamptz`,
    [approvalId, now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id as string,
    email: row.email as string,
    sent: new Set((row.sent as string[] | null) ?? []) as ReadonlySet<FallbackChannel>,
  };
}

// Record that `channel` has gone out for the approval (after its send succeeded).
// Idempotent: recording an already-recorded channel changes nothing.
async function markSent(db: Db, approvalId: string, channel: FallbackChannel, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO approval_fallback_sends (approval_id, channel, sent_at)
     VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (approval_id, channel) DO NOTHING`,
    [approvalId, channel, now.toISOString()],
  );
}

export async function runApprovalFallback(
  deps: ApprovalFallbackDeps,
  input: ApprovalFallbackInput,
): Promise<void> {
  const { db, clock, random, senders, publicBaseUrl } = deps;

  // VALIDATE + shape-guard at the boundary: a malformed / oversized / non-UUID id
  // throws a 4xx `HttpError` BEFORE any query runs, so nothing is sent and no link is
  // issued, and an injection-shaped id never reaches a query (OBS-049).
  const approvalId = parseParams(approvalIdSchema, input.approvalId);

  // Still armed (pending, unopened, unexpired)? Otherwise send nothing and issue no link.
  const now = clock.now();
  const state = await loadArmedState(db, approvalId, now);
  if (!state) return;

  // The channels still to send: an SMS only to a VERIFIED number (an unverified number is
  // never texted), an email unless the person switched email fallback off — each only if
  // it has not already gone. Member-scoped reads by the owner's id.
  const verified = senders.sms.enabled === false ? undefined
    : (await listMobileNumbers(db, state.userId)).find((number) => number.verified);
  const { emailFallback, smsFallback } = await getNotificationPrefs(db, state.userId);
  const due: FallbackChannel[] = [];
  if (smsFallback && verified && !state.sent.has("sms")) due.push("sms");
  if (emailFallback && !state.sent.has("email")) due.push("email");
  if (due.length === 0) return;

  // Fire: issue ONE single-use link (256-bit token, 10-minute expiry from clock.now())
  // for this attempt's messages and build the address the person opens it at.
  const issued = await issueApprovalLink(db, { approvalId }, { clock, random });
  const link = buildLink(publicBaseUrl, issued.token);

  // Send every due channel, recording each one that goes; a failure on one never stops
  // the other. Failures surface for monitoring. Email may retry; the SMS claim prevents duplicate paid attempts.
  let failure: unknown;
  for (const channel of due) {
    try {
      if (channel === "sms" && verified) {
        const claim = await db.query(
          `INSERT INTO approval_sms_attempts (approval_id, attempted_at) VALUES ($1, $2::timestamptz)
           ON CONFLICT (approval_id) DO NOTHING RETURNING approval_id`, [approvalId, now.toISOString()],
        );
        if (claim.rows.length === 0) continue;
        await senders.sms.sendSms({ recipient: verified.number, body: SMS_BODY, link });
      } else if (channel === "email") {
        await senders.email.sendEmail({ recipient: state.email, body: EMAIL_BODY, link });
      }
      await markSent(db, approvalId, channel, now);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}
