// E01-S10 — notification sender interfaces and config-driven selection
// (design §10). Every outbound notification channel sits behind its own
// interface so the correspondence loop depends only on the bundle, never on a
// concrete provider sender. In dev/test the single process-wide outbox stands in
// for all three channels; in production the real senders (built by later tasks)
// are injected. Selection is driven by config alone.

import { outbox } from "./outbox";

// One outbound message, the same shape for every channel. `link` is optional: a
// push may carry only a body, while an email/SMS usually carries the deep link
// to the approval. Redaction happens in the caller (a different module) before
// anything reaches a sender — a sender receives already-safe content.
export interface OutgoingMessage {
  readonly recipient: string;
  readonly body: string;
  readonly link?: string;
}

export interface PushSender {
  sendPush(message: OutgoingMessage): Promise<void>;
  // Used by the notification test action after it has loaded an owned device.
  sendDevicePush?(subscription: import("./web-push").PushDeviceSubscription): Promise<void>;
}

export interface EmailSender {
  sendEmail(message: OutgoingMessage): Promise<void>;
}

export interface SmsSender {
  sendSms(message: OutgoingMessage): Promise<void>;
}

// A full set of senders, one per channel. Both the real provider senders and the
// dev/test outbox satisfy this bundle, so the correspondence loop depends only
// on it.
export interface Senders {
  readonly push: PushSender;
  readonly email: EmailSender;
  readonly sms: SmsSender;
}

// Selection is driven by config: with dev tooling on (WARTHOG_DEV_TOOLS=1) every
// channel routes to the one process-wide outbox, so the correspondence loop is
// drivable without Azure; otherwise the injected real senders are used.
export function selectSenders(config: { readonly devTools: boolean }, real: Senders): Senders {
  if (config.devTools) {
    return { push: outbox, email: outbox, sms: outbox };
  }
  return real;
}
