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
//   • does NOTHING when the approval is no longer armed — already opened, or already
//     decided (approved / denied / expired) — so a person who got there in time is
//     never messaged;
//   • does NOTHING a second time — once it has fired for an approval (a single-use
//     link has been issued) a re-run sends no further SMS, email or link, so the job
//     is idempotent even while the approval is still unopened;
//   • otherwise issues ONE single-use link (a 256-bit token, 10-minute expiry) and
//     sends ONE SMS to the owner's VERIFIED number (if any) AND ONE email to the
//     owner's address (unless they switched email fallback off), each carrying that
//     one link.
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

import { isUnopened } from "../approvals/opened";
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

// The owner resolved from the approval row, plus whether the fallback has already
// fired for it (a single-use link already issued — the idempotency marker).
interface ApprovalFallbackState {
  readonly userId: string;
  readonly email: string;
  readonly linkIssued: boolean;
}

// Resolve the approval's OWNER (user id + email) and the idempotency marker in one
// parameterized read: the approval id is BOUND as a parameter (INV-102), never woven
// into the SQL text. The owner comes from the approval's own row (member scope is taken
// from the approval, never from a client value), so the SMS and email can only reach
// the owner. Returns null when no such approval exists.
async function loadState(db: Db, approvalId: string): Promise<ApprovalFallbackState | null> {
  const result = await db.query(
    `SELECT a.user_id AS user_id,
            u.email    AS email,
            EXISTS (SELECT 1 FROM approval_links l WHERE l.approval_id = a.id) AS link_issued
       FROM approvals a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = $1`,
    [approvalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id as string,
    email: row.email as string,
    linkIssued: row.link_issued as boolean,
  };
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

  // Still armed? The fallback fires ONLY while the approval is unopened AND pending;
  // once it has been opened or decided, send nothing (and issue no link).
  if (!(await isUnopened(db, approvalId))) return;

  // Resolve the owner and the idempotency marker. No row ⇒ nothing to do (defensive;
  // `isUnopened` already proved a pending approval exists).
  const state = await loadState(db, approvalId);
  if (!state) return;

  // Idempotent: if a single-use link has already been issued for this approval, the
  // fallback has already fired — send nothing more. The MARKER (a prior link), not
  // `isUnopened`, is what suppresses the second run while the approval is unchanged.
  if (state.linkIssued) return;

  // Fire: issue ONE single-use link (256-bit token, 10-minute expiry from clock.now())
  // and build the address the person opens it at.
  const issued = await issueApprovalLink(db, { approvalId }, { clock, random });
  const link = buildLink(publicBaseUrl, issued.token);

  // ONE SMS to the owner's VERIFIED number, if they have one (an unverified number is
  // never texted). Member-scoped read by the owner's id.
  const verified = (await listMobileNumbers(db, state.userId)).find((number) => number.verified);
  if (verified) {
    await senders.sms.sendSms({ recipient: verified.number, body: SMS_BODY, link });
  }

  // ONE email to the owner's address, unless they switched email fallback off.
  const { emailFallback } = await getNotificationPrefs(db, state.userId);
  if (emailFallback) {
    await senders.email.sendEmail({ recipient: state.email, body: EMAIL_BODY, link });
  }
}
