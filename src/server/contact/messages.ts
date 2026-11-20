// "Contact us" in the app (docs/adr/requests-for-members.md). A signed-in person sends the
// operator a message, recorded for them as a request of kind 'contact' (migration 0116). The
// operator reads it, with who asked, on the admin portal's Requests page and replies by email;
// nothing is emailed to the operator.
//
// Project hard rule: nothing stored may carry a code, card number or token in plain text, so a
// message is cleaned before it is kept: invisible characters are stripped, sign-in codes and
// one-off passwords are masked, and card numbers are masked to their last four digits by the
// redaction module. A reference number ("Booking code 482913") stays readable.
//
// The person's id is always the session's (never a client value), and a person reads back only
// their own messages.

import { stripInvisible } from "../../domain/content/untrusted";
import { emptyCounts, maskSignInCodes } from "../../domain/content/text-filters";
import { redact } from "../../domain/redaction/redact";
import { CONTACT_DAILY_LIMIT, CONTACT_MESSAGE_MAX, CONTACT_TOPIC_LABELS, isContactTopic } from "../../domain/contact/topics";
import {
  countContactMessagesSince,
  createConnectorRequest,
  listConnectorRequestsForUser,
  type ConnectorRequest,
} from "../db/connector-requests";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

export { CONTACT_DAILY_LIMIT, CONTACT_MESSAGE_MAX, CONTACT_TOPIC_LABELS, isContactTopic } from "../../domain/contact/topics";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ContactMessageInput {
  readonly userId: string;
  readonly topic: string;
  readonly message: string;
}

export interface ContactMessageDeps {
  readonly db: Db;
  readonly clock: Clock;
}

export type SendContactResult =
  | { readonly ok: true; readonly request: ConnectorRequest }
  | { readonly ok: false; readonly reason: "empty" | "too_long" | "topic" | "too_many" };

// The text as it is kept: invisible characters out, line endings normalised, blank-line runs
// folded, trimmed, then sign-in codes and card numbers masked.
export function cleanContactMessage(text: string): string {
  const visible = stripInvisible(text).text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const masked = maskSignInCodes(visible, emptyCounts());
  return redact(masked, () => false) as string;
}

// Record a message for the person, or say why it wasn't sent.
export async function sendContactMessage(input: ContactMessageInput, deps: ContactMessageDeps): Promise<SendContactResult> {
  if (!isContactTopic(input.topic)) return { ok: false, reason: "topic" };
  const visible = stripInvisible(input.message).text.trim();
  if (visible === "") return { ok: false, reason: "empty" };
  if (visible.length > CONTACT_MESSAGE_MAX) return { ok: false, reason: "too_long" };
  const since = new Date(deps.clock.now().getTime() - DAY_MS);
  if ((await countContactMessagesSince(deps.db, input.userId, since)) >= CONTACT_DAILY_LIMIT) {
    return { ok: false, reason: "too_many" };
  }
  const request = await createConnectorRequest(
    deps.db,
    {
      userId: input.userId,
      kind: "contact",
      serviceName: CONTACT_TOPIC_LABELS[input.topic],
      topic: input.topic,
      message: cleanContactMessage(input.message),
    },
    deps.clock,
  );
  return { ok: true, request };
}

// The person's own messages, newest first (member-scoped).
export async function listContactMessagesForUser(db: Db, userId: string): Promise<ConnectorRequest[]> {
  return (await listConnectorRequestsForUser(db, userId))
    .filter((request) => request.kind === "contact")
    .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
}
