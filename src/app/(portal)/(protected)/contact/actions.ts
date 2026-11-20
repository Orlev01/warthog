// "Contact us" page loader and send action (docs/adr/requests-for-members.md), kept out of
// `page.tsx` so it can be tested without Next. Every read and write is the SESSION person's
// (never an id from the client): the loader returns their own address, which is where the
// operator replies, and their own messages; `send` records a message for them and answers with
// the notice code the page shows.

import { getUserById } from "@/server/db/users";
import { listContactMessagesForUser, sendContactMessage, CONTACT_TOPIC_LABELS } from "@/server/contact/messages";
import { timeZoneFor } from "@/server/spending/time-zone";
import { formatAccountTime } from "@/server/display-time";
import type { ContactMessageItem } from "@/components/contact/contact-view";
import type { Db } from "@/server/db/index";
import type { Clock } from "@/server/seams/clock";
import type { Session } from "@/server/auth/session";

export interface ContactActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  // The person's own data key, for their time zone (dates show in it); without it dates are
  // shown in the account default.
  readonly dekFor?: (userId: string) => Promise<Uint8Array>;
}

export type ContactSendOutcome = "sent" | "empty" | "too-long" | "topic" | "too-many";

const EXCERPT_MAX = 160;
function excerptOf(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
}

export function createContactActions(deps: ContactActionsDeps) {
  const { db, clock } = deps;

  async function load(session: Session): Promise<{ email: string; messages: ContactMessageItem[] }> {
    const user = await getUserById(db, session.userId);
    const timeZone = deps.dekFor ? await timeZoneFor(db, session.userId, await deps.dekFor(session.userId)) : undefined;
    const messages = (await listContactMessagesForUser(db, session.userId)).map((message): ContactMessageItem => ({
      id: message.id,
      topic: message.topic ? CONTACT_TOPIC_LABELS[message.topic] : message.serviceName,
      excerpt: excerptOf(message.message ?? ""),
      sentAt: formatAccountTime(message.requestedAt, timeZone, { dateOnly: true }),
      answered: message.handledAt !== null,
    }));
    return { email: user?.email ?? "", messages };
  }

  async function send(session: Session, input: { topic: string; message: string }): Promise<ContactSendOutcome> {
    const result = await sendContactMessage({ userId: session.userId, topic: input.topic, message: input.message }, { db, clock });
    if (result.ok) return "sent";
    return result.reason === "too_long" ? "too-long" : result.reason === "too_many" ? "too-many" : result.reason;
  }

  return { load, send };
}
