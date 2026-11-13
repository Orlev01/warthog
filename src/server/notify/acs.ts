import { createHash, createHmac } from "node:crypto";
import { EmailClient } from "@azure/communication-email";
import type { EmailSender, OutgoingMessage, SmsSender } from "./senders";
import { systemClock } from "../seams/clock";
import { renderMessageEmail } from "./email";

const PHONE = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
import { smsSegments } from "./sms-content";
export { smsSegments } from "./sms-content";

function content(message: OutgoingMessage): string {
  return message.link ? `${message.body}\n${message.link}` : message.body;
}

function smsCredentials(value: string): { endpoint: URL; key: Buffer } {
  const fields = new Map(value.split(";").filter(Boolean).map((field) => {
    const at = field.indexOf("=");
    return [field.slice(0, at).toLowerCase(), field.slice(at + 1)] as const;
  }));
  try {
    const endpoint = new URL(fields.get("endpoint") ?? "");
    const rawKey = fields.get("accesskey") ?? "";
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".communication.azure.com") ||
        endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash ||
        endpoint.pathname !== "/" || !/^[A-Za-z0-9+/]+={0,2}$/.test(rawKey) || rawKey.length % 4 !== 0) throw new Error();
    const key = Buffer.from(rawKey, "base64");
    if (key.length < 32) throw new Error();
    return { endpoint, key };
  } catch {
    throw new Error("Invalid ACS SMS configuration");
  }
}

export function validateAcsConnectionString(value: string): void {
  const credentials = smsCredentials(value);
  credentials.key.fill(0);
}

export function createAcsSmsSender(deps: {
  connectionString: string;
  from: string;
  allowedCallingCodes?: readonly string[];
  reserve: (recipient: string, segments: number) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
}): SmsSender {
  const { endpoint, key } = smsCredentials(deps.connectionString);
  if (!PHONE.test(deps.from)) throw new Error("Invalid ACS SMS sender configuration");
  const url = new URL("/sms?api-version=2021-03-07", endpoint);
  return { async sendSms(message) {
    if (!PHONE.test(message.recipient)) throw new Error("Invalid SMS recipient");
    if (!(deps.allowedCallingCodes ?? []).some((code) => /^\+[1-9]\d{0,2}$/.test(code) && message.recipient.startsWith(code))) {
      throw new Error("SMS destination is not enabled");
    }
    const text = content(message);
    await deps.reserve(message.recipient, smsSegments(text));
    // Reservations are not refunded on ambiguous failures: ACS may have accepted
    // the message before a timeout. No automatic retry can duplicate paid sends.
    try {
      const body = JSON.stringify({ from: deps.from, message: text,
        smsRecipients: [{ to: message.recipient }], smsSendOptions: { enableDeliveryReport: false } });
      const timestamp = (deps.now?.() ?? systemClock.now()).toUTCString();
      const hash = createHash("sha256").update(body).digest("base64");
      const signature = createHmac("sha256", key)
        .update(`POST\n${url.pathname}${url.search}\n${timestamp};${url.host};${hash}`).digest("base64");
      const response = await (deps.fetch ?? fetch)(url.href, { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(20_000), body, headers: {
          "content-type": "application/json", "x-ms-date": timestamp, "x-ms-content-sha256": hash,
          Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
        } });
      if (!response.ok) throw new Error();
      const result = await response.json() as { value?: { to?: string; successful?: boolean }[] };
      if (result.value?.length !== 1 || result.value[0]?.to !== message.recipient || result.value[0]?.successful !== true) throw new Error();
    } catch {
      // SDK/provider errors may include the code, phone or signed request. Keep
      // them out of exception causes, framework logs and job failure records.
      throw new Error("SMS delivery failed");
    }
  } };
}

interface EmailTransport {
  beginSend(message: { senderAddress: string; recipients: { to: { address: string }[] }; content: { subject: string; plainText: string; html: string } },
    options?: { abortSignal: AbortSignal }): Promise<{ pollUntilDone(): Promise<{ status?: string }> }>;
}

// Not wired into production (Resend sends email there); kept consistent with it: every email
// is the branded HTML and text from ./email.
export function createAcsEmailSender(deps: {
  senderAddress: string; connectionString?: string; client?: EmailTransport; logoUrl?: string;
}): EmailSender {
  if (!EMAIL.test(deps.senderAddress)) throw new Error("Invalid ACS email sender configuration");
  let client = deps.client;
  return { async sendEmail(message) {
    if (!EMAIL.test(message.recipient) || message.recipient.length > 320) throw new Error("Invalid email recipient");
    const { subject, html, text } = renderMessageEmail(message, { logoUrl: deps.logoUrl });
    try {
      if (!client) {
        if (!deps.connectionString) throw new Error();
        client = new EmailClient(deps.connectionString, { retryOptions: { maxRetries: 0 } });
      }
      const poller = await client.beginSend({ senderAddress: deps.senderAddress,
        recipients: { to: [{ address: message.recipient }] },
        content: { subject, plainText: text, html } }, { abortSignal: AbortSignal.timeout(30_000) });
      const result = await poller.pollUntilDone();
      if (result.status !== "Succeeded") throw new Error();
    } catch {
      throw new Error("Email delivery failed");
    }
  } };
}
