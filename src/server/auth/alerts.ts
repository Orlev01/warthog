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
import { mapEmailText, SECURITY_ALERT_FOOTNOTE, type EmailContent } from "../notify/email";
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

// An alert is its plain-text body (the outbox's and any plain reader's copy) plus the
// branded email it renders as. An alert email never carries a code or a button: it tells
// the person to sign in themselves rather than follow a link (anti-phishing).
interface Alert {
  readonly body: string;
  readonly email: Omit<EmailContent, "code" | "action">;
}

// Untrusted free text (an agent's name, a device label) shown in an alert email: on one
// line and shortened, so it can't push the fixed copy around or fake a line of its own.
const ALERT_NAME_CHARS = 60;
function shortName(name: string): string {
  const plain = name.replace(/\s+/g, " ").trim();
  return plain.length > ALERT_NAME_CHARS ? `${plain.slice(0, ALERT_NAME_CHARS).trimEnd()}…` : plain;
}

// An agent's name is also quoted, so it can't pass for our own words.
function quotedAgentName(name: string): string {
  return `"${shortName(name.replaceAll('"', "'"))}"`;
}

// Resolve the person by the session's `userId` and send exactly one email to
// that person's own address, with the body and every text field of the email scrubbed
// through redaction first. A missing person is a programming error (the id comes from an
// authenticated session), reported rather than failing silently.
async function sendAlert(db: Db, userId: string, alert: Alert, deps: AlertDeps): Promise<void> {
  const person = await getUserById(db, userId);
  if (!person) throw new Error("alert: no person for the session userId");
  const email = mapEmailText({ ...alert.email, footnote: alert.email.footnote ?? SECURITY_ALERT_FOOTNOTE }, scrub);
  await deps.emailSender.sendEmail({ recipient: person.email, body: scrub(alert.body), email });
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
  await sendAlert(db, userId, {
    body:
      "A new passkey was added to your Warthog account. " +
      "If this wasn't you, sign in and remove it, then contact support.",
    email: {
      subject: "New passkey added",
      heading: "A new passkey was added",
      paragraphs: [
        "A new passkey was added to your Warthog account.",
        `If this wasn't you, sign in and remove it, then email ${SUPPORT_EMAIL}.`,
      ],
    },
  }, deps);
}

// An authenticator app was set up from Settings › Security (follow-up S1): the same kind of
// new-sign-in-method alert as a new passkey. Fixed copy — carries no secret, code or token.
export async function alertNewAuthenticator(
  db: Db,
  { userId }: { userId: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(db, userId, {
    body:
      "An authenticator app was added to your Warthog account. You can now sign in with your email " +
      "and a code from the app. If this wasn't you, sign in, sign out every device you don't " +
      `recognise and email ${SUPPORT_EMAIL} straight away.`,
    email: {
      subject: "Authenticator app added",
      heading: "An authenticator app was added",
      paragraphs: [
        "An authenticator app was added to your Warthog account. You can now sign in with your " +
          "email and a code from the app.",
        "If this wasn't you, sign in, sign out every device you don't recognise and email " +
          `${SUPPORT_EMAIL} straight away.`,
      ],
    },
  }, deps);
}

// The authenticator app was removed from Settings › Security (sign-in audit, founder
// decision 13 November 2026): the counterpart of the "authenticator added" alert. Fixed
// copy — carries no secret, code or token.
export async function alertAuthenticatorRemoved(
  db: Db,
  { userId }: { userId: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(db, userId, {
    body:
      "An authenticator app was removed from your Warthog account. Codes from it no longer sign you " +
      "in or confirm it's you; your passkeys still do. If this wasn't you, sign in, sign out every " +
      `device you don't recognise and email ${SUPPORT_EMAIL} straight away.`,
    email: {
      subject: "Authenticator app removed",
      heading: "An authenticator app was removed",
      paragraphs: [
        "An authenticator app was removed from your Warthog account. Codes from it no longer sign " +
          "you in or confirm it's you, but your passkeys still do.",
        "If this wasn't you, sign in, sign out every device you don't recognise and email " +
          `${SUPPORT_EMAIL} straight away.`,
      ],
    },
  }, deps);
}

// A new agent connected. `agentName` is untrusted free text, so the scrub pass
// masks any card number planted in it before the body is delivered.
export async function alertNewAgentConnection(
  db: Db,
  { userId, agentName }: { userId: string; agentName: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(db, userId, {
    body:
      `A new agent connected to your Warthog account: ${agentName}. ` +
      "If you didn't connect it, sign in and revoke it.",
    email: {
      subject: "New agent connected",
      heading: "A new agent connected",
      paragraphs: [
        `A new agent connected to your Warthog account: ${quotedAgentName(agentName)}.`,
        "If you didn't connect it, sign in and revoke it.",
      ],
    },
  }, deps);
}

// A sign-in from a new device. `deviceLabel` is untrusted free text, so the
// scrub pass masks any card number planted in it before delivery.
// A new access key for an existing agent (security audit 2026-11-13): whoever holds it can
// act as that agent, so the person hears about every replacement. `agentName` is untrusted
// free text, scrubbed like the new-agent alert's. Never carries the key.
export async function alertAccessKeyReplaced(
  db: Db,
  { userId, agentName }: { userId: string; agentName: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(db, userId, {
    body:
      `A new access key was made for ${agentName} on your Warthog account, and its old key ` +
      "stopped working. If you didn't do this, sign in and revoke the key.",
    email: {
      subject: "Agent access key replaced",
      heading: "An agent's access key was replaced",
      paragraphs: [
        `A new access key was made for ${quotedAgentName(agentName)} on your Warthog account, and its ` +
          "old key stopped working.",
        "If you didn't do this, sign in and revoke the key.",
      ],
    },
  }, deps);
}

export async function alertNewDeviceSignIn(
  db: Db,
  { userId, deviceLabel }: { userId: string; deviceLabel: string },
  deps: AlertDeps,
): Promise<void> {
  await sendAlert(db, userId, {
    body:
      `Your Warthog account was signed in to from a new device: ${deviceLabel}. ` +
      "If this wasn't you, sign in and sign out all devices.",
    email: {
      subject: "New device signed in",
      heading: "A new device signed in",
      paragraphs: [
        `Your Warthog account was signed in to from a new device: ${shortName(deviceLabel)}.`,
        "If this wasn't you, sign in and sign out all devices.",
      ],
    },
  }, deps);
}

// The account was recovered with its recovery code (the brief's recovery: email code
// plus recovery code, then a new passkey and a new recovery code). Sent once, when the new
// passkey is saved (sign-in audit, founder decision 13 November 2026). Recovery removed the
// old passkeys and authenticator app and signed every device out, but it KEEPS agents and
// their keys, so the alert names every agent still connected, never implying Warthog
// removed one. `agentNames` is untrusted free text (scrubbed like the new-agent alert's),
// possibly chosen by whoever holds the lost device: the fixed copy and support address come
// first, and the names are quoted, shortened and capped so they can't crowd either out.
// Carries no code, token or credential.
const RECOVERY_ALERT_AGENTS = 5;

export async function alertAccountRecovered(
  db: Db,
  { userId, agentNames }: { userId: string; agentNames: readonly string[] },
  deps: AlertDeps,
): Promise<void> {
  const shown = agentNames.slice(0, RECOVERY_ALERT_AGENTS).map(quotedAgentName).join(", ");
  const more = agentNames.length - RECOVERY_ALERT_AGENTS;
  const agents = agentNames.length > 0
    ? `These agents are still connected and can still use your account: ${shown}${more > 0 ? ` and ${more} more` : ""}. ` +
      "If you don't recognise one, sign in and disconnect it from Agents, or replace its key in its settings."
    : "No agents are connected to your account.";
  // The email keeps the body's order: what happened and the support address first, the
  // (untrusted, quoted, capped) agent names last.
  await sendAlert(db, userId, {
    body:
      "Your Warthog account was recovered using your recovery code. A new passkey was added, your " +
      "old passkeys and authenticator app were removed, and every device was signed out. A new " +
      "recovery code was issued, so your old recovery code no longer works. " +
      `If this wasn't you, email ${SUPPORT_EMAIL} straight away. ` +
      agents,
    email: {
      subject: "Your Warthog account was recovered",
      heading: "Your account was recovered",
      paragraphs: [
        "Your Warthog account was recovered using your recovery code. A new passkey was added, " +
          "your old passkeys and authenticator app were removed, and every device was signed out. " +
          "A new recovery code was issued, so your old recovery code no longer works.",
        `If this wasn't you, email ${SUPPORT_EMAIL} straight away.`,
        agents,
      ],
    },
  }, deps);
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
  await sendAlert(db, userId, {
    body:
      "A new passkey was set up on your Warthog account after its reset. Your old passkeys and " +
      "old recovery code no longer work, every other device was signed out and a new recovery " +
      "code was issued. If this wasn't you, contact support straight away.",
    email: {
      subject: "New passkey set up after your reset",
      heading: "A new passkey was set up after your reset",
      paragraphs: [
        "A new passkey was set up on your Warthog account after its reset. Your old passkeys and " +
          "old recovery code no longer work, every other device was signed out and a new " +
          "recovery code was issued.",
        `If this wasn't you, email ${SUPPORT_EMAIL} straight away.`,
      ],
    },
  }, deps);
}
