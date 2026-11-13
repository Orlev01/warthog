import { domainToASCII } from "node:url";
import { randomUUID } from "node:crypto";
import type { EmailSender } from "./senders";
import { renderMessageEmail } from "./email";

// International destinations are allowed. SMTPUTF8 local parts are not supported
// by this adapter; use an ASCII mailbox local part (IDN domains are normalized).
export function normaliseMessagingEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0 || value.length > 320 || /[\s<>(),;:\\[\]\"]/.test(value)) throw new Error("Invalid email recipient");
  const local = value.slice(0, at), domain = domainToASCII(value.slice(at + 1));
  const address = `${local}@${domain}`;
  if (local.length > 64 || !/^[\x21-\x7e]+$/.test(local) || local.includes("@") ||
    !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9-]{2,63}$/.test(domain) || address.length > 254) throw new Error("Invalid email recipient");
  return address;
}
export function isMessagingEmail(value: string | undefined): boolean {
  try { normaliseMessagingEmail(value ?? ""); return true; } catch { return false; }
}

// Every email is branded: the message's own `email` content, or the generic layout built
// from its body and link (./email). `logoUrl` is the hosted Warthog mark; without it the
// header is the text wordmark alone.
export function createResendEmailSender(deps: {
  apiKey?: string; from?: string; sendingDomain?: string; replyTo?: string; fetch?: typeof fetch; logoUrl?: string;
}): EmailSender {
  if (!isMessagingEmail(deps.from)) throw new Error("Invalid configuration: RESEND_FROM_ADDRESS");
  // A provider-verified sender domain is independent of the passkey RP ID. Only
  // this exact configured domain may send; no wildcard or implicit subdomains.
  if (!deps.sendingDomain || deps.sendingDomain.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(deps.sendingDomain)) {
    throw new Error("Invalid configuration: RESEND_SENDING_DOMAIN");
  }
  const from = normaliseMessagingEmail(deps.from!);
  if (from.split("@")[1] !== deps.sendingDomain.toLowerCase()) throw new Error("Invalid configuration: RESEND_FROM_ADDRESS");
  if (!isMessagingEmail(deps.replyTo)) throw new Error("Invalid configuration: RESEND_REPLY_TO_ADDRESS");
  const replyTo = normaliseMessagingEmail(deps.replyTo!);
  if (!deps.apiKey || /\s/.test(deps.apiKey)) throw new Error("Invalid configuration: RESEND_API_KEY");
  return { async sendEmail(message) {
    const recipient = normaliseMessagingEmail(message.recipient);
    const { subject, html, text } = renderMessageEmail(message, { logoUrl: deps.logoUrl });
    try {
      const response = await (deps.fetch ?? fetch)("https://api.resend.com/emails", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ from: `Warthog <${from}>`, reply_to: replyTo, to: [recipient], subject, html, text }),
      });
      if (!response.ok) throw new Error();
      const result = await response.json() as { id?: unknown };
      if (typeof result.id !== "string" || !result.id) throw new Error();
    } catch { throw new Error("Email delivery failed"); }
  } };
}
