// E01-S10 — the dev/test notification outbox (design §10). The outbox is the
// single dev/test implementation of every notification channel: it satisfies
// PushSender, EmailSender and SmsSender and records every sent message into ONE
// process-wide list that dev surfaces (the `/dev/outbox` viewer) read back. It
// is a dumb recorder — redaction happens in the caller, so the outbox stores
// what it is handed, verbatim.

import type { OutgoingMessage, PushSender, EmailSender, SmsSender } from "./senders";
import type { EmailContent } from "./email";
import { processSingleton } from "../seams/process-singleton";

// A recorded message: an OutgoingMessage stamped with the channel it was sent
// on, so the single combined list stays readable per channel. `email` is the branded
// content the message carried (present only when it carried some), so `/dev/outbox` can
// preview the email exactly as a real sender would render it.
export interface SentMessage {
  readonly channel: "push" | "email" | "sms";
  readonly recipient: string;
  readonly body: string;
  readonly link?: string;
  readonly email?: EmailContent;
}

// The outbox serves as all three channel senders and exposes the recorded list
// for dev to read back.
export interface Outbox extends PushSender, EmailSender, SmsSender {
  list(): readonly SentMessage[];
}

// Build a fresh, empty outbox. Each send records one message, stamped with its
// channel, into a single in-memory list in send order.
export function createOutbox(): Outbox {
  const sent: SentMessage[] = [];

  function record(channel: SentMessage["channel"], message: OutgoingMessage): void {
    sent.push({
      channel,
      recipient: message.recipient,
      body: message.body,
      link: message.link,
      ...(message.email ? { email: message.email } : {}),
    });
  }

  return {
    async sendPush(message: OutgoingMessage): Promise<void> {
      record("push", message);
    },
    async sendEmail(message: OutgoingMessage): Promise<void> {
      record("email", message);
    },
    async sendSms(message: OutgoingMessage): Promise<void> {
      record("sms", message);
    },
    list(): readonly SentMessage[] {
      return sent.slice();
    },
  };
}

// The process-wide singleton (design §10: one per process, not re-instantiated
// per request), mirroring the release-store contract. Held through processSingleton
// (globalThis), because Next bundles route handlers and pages into separate module
// graphs: a plain module-level instance would split, and /dev/outbox would read an
// empty copy while the sign-up route wrote to another.
export const outbox: Outbox = processSingleton("notify.outbox", createOutbox);
