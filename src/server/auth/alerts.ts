// E04-S16 — Auth email alerts (design: "email alerts for a new passkey, a new
// agent connection and a sign-in from a new device"). People are told about
// security-relevant events. Unlike the one-time-code email — which legitimately
// carries its code — these ALERTS carry no code, token or credential.
//
// The recipient is ALWAYS the address resolved from the session's `userId`
// (member-scoped — design security rules): these functions take no recipient
// argument, so a caller can never redirect an alert to another address. The id
// is looked up through the person aggregate, never trusted from a client value.
//
// Project hard rule (a reviewer veto): everything that reaches an email passes
// through `src/domain/redaction` first. Each alert body is scrubbed before it
// reaches the sender, so any untrusted free text it carries (an agent's name, a
// device label) has a planted card number masked to its last four digits and
// never leaves plain text. Alerts have no released-value context — a released
// high-tier value or card has no business in a security alert — so the redaction
// pass is asked to match no released values; the card-masking and truncation
// rules still apply.
//
// Alerts report a security event that has ALREADY happened (a session minted, a
// passkey stored). A delivery failure must not undo or fail that event, so callers
// send through `deliverAlert`, which reports a failed send to the operator log (the
// alert kind only — never the recipient or body) instead of throwing.

import { redact } from "../../domain/redaction/redact";
import { getUserById } from "../db/users";
import type { EmailSender } from "../notify/senders";
import type { Db } from "../db/index";
import { SUPPORT_EMAIL } from "../../components/public/operator";

// Email alerts only (the brief says "email alerts"); the dev/test outbox
// satisfies EmailSender, so tests pass it directly.
export interface AlertDeps {
  readonly emailSender: EmailSender;
}

// Run a body through the redaction module before it reaches the sender. A string
// is scrubbed by the card-masking and truncation rules; there is no released
// value to match, so the matcher reports false.
function scrub(body: string): string {
  return redact(body, () => false) as string;
}

// Resolve the person by the session's `userId` and send exactly one email to
// that person's own address, with the body scrubbed through redaction first. A
// missing person is a programming error (the id comes from an authenticated
// session), reported rather than failing silently.
async function sendAlert(db: Db, userId: string, body: string, deps: AlertDeps): Promise<void> {
  const person = await getUserById(db, userId);
  if (!person) throw new Error("alert: no person for the session userId");
  await deps.emailSender.sendEmail({ recipient: person.email, body: scrub(body) });
}

// Send an alert without letting a delivery failure fail the security event it reports.
// The failure is still surfaced (never silently dropped): the operator log gets the
// alert kind and the error's class, never the recipient, body or error message.
export async function deliverAlert(kind: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error(`[warthog alerts] ${kind} alert not delivered (${name})`);
  }
}

// A new passkey was added. Fixed copy — carries no code, token or credential.
export async function alertNewPasskey(
  db: Db,
  { userId }: { userId: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(
    db,
    userId,
    "A new passkey was added to your Warthog account. " +
      "If this wasn't you, sign in and remove it, then contact support.",
    deps,
  );
}

// A new agent connected. `agentName` is untrusted free text, so the scrub pass
// masks any card number planted in it before the body is delivered.
export async function alertNewAgentConnection(
  db: Db,
  { userId, agentName }: { userId: string; agentName: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(
    db,
    userId,
    `A new agent connected to your Warthog account: ${agentName}. ` +
      "If you didn't connect it, sign in and revoke it.",
    deps,
  );
}

// A sign-in from a new device. `deviceLabel` is untrusted free text, so the
// scrub pass masks any card number planted in it before delivery.
export async function alertNewDeviceSignIn(
  db: Db,
  { userId, deviceLabel }: { userId: string; deviceLabel: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(
    db,
    userId,
    `Your Warthog account was signed in to from a new device: ${deviceLabel}. ` +
      "If this wasn't you, sign in and sign out all devices.",
    deps,
  );
}

// The account was recovered with its recovery code (the brief's recovery: email code
// plus recovery code, then a new passkey and a new recovery code). Fixed copy —
// carries no code, token or credential.
export async function alertAccountRecovered(
  db: Db,
  { userId }: { userId: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(
    db,
    userId,
    "Your Warthog account was recovered using your recovery code. A new passkey was added " +
      "and a new recovery code was issued, so your old recovery code no longer works. " +
      `If this wasn't you, email ${SUPPORT_EMAIL} straight away.`,
    deps,
  );
}

// A new passkey was set up after a completed account reset (review fix W5). The reset
// already erased the protected details; re-enrolment removed the old passkeys and the
// authenticator app, signed every device out and issued a new recovery code. Fixed
// copy — carries no code, token or credential.
export async function alertAccountReenrolled(
  db: Db,
  { userId }: { userId: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(
    db,
    userId,
    "A new passkey was set up on your Warthog account after its reset. Your old passkeys and " +
      "old recovery code no longer work, every other device was signed out and a new recovery " +
      "code was issued. If this wasn't you, contact support straight away.",
    deps,
  );
}
