// Approval-card truth — Warthog builds the email an agent drafts or sends, from plain fields
// (docs/adr/approval-card-truth.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
//
// Agents used to hand Warthog a base64 RFC 2822 message (`raw`). Models build those badly
// (claude.ai can't base64-encode reliably), and the person approved "send email to X" without
// seeing what X would get. Now an agent gives `to`, `cc`, `bcc`, `subject` and `text` (and
// optionally `html`), and Warthog builds the message itself — so what the person approves is
// exactly what is sent, recipients are unambiguous, and nothing can hide in headers.

import { htmlToText } from "./html-text";
import { stripInvisible } from "./untrusted";

/** What an agent writes: who it goes to and what it says. */
export interface MailDraft {
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string;
  readonly text: string;
  readonly html?: string;
}

/** The headers of the message being replied to, so the reply lands in its thread. */
export interface ReplyTarget {
  readonly messageId?: string;
  readonly references?: string;
  readonly subject?: string;
}

/** A draft Warthog can't build (an address it can't read, a header with a line break). */
export class MailComposeError extends Error {}

// One mailbox: a bare address or "Name <address>". Display names are plain text only.
const BARE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
const NAMED_ADDRESS = /^([^<>"\r\n]{0,120}?)\s*<([^<>\s]+)>$/;

/** The address part of a mailbox, lower-cased; throws on anything else. */
export function mailboxAddress(mailbox: string): string {
  const trimmed = mailbox.trim();
  const named = NAMED_ADDRESS.exec(trimmed);
  const address = named ? named[2]! : trimmed;
  if (!BARE_ADDRESS.test(address) || address.length > 254) throw new MailComposeError(`"${trimmed.slice(0, 80)}" isn't an email address Warthog can send to.`);
  return address.toLowerCase();
}

function noLineBreaks(value: string, field: string): string {
  if (/[\r\n]/.test(value)) throw new MailComposeError(`${field} can't contain a line break.`);
  return stripInvisible(value).text;
}

// RFC 2047 "B" encoding for a header word with non-ASCII characters.
function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  // Encoded words are at most 75 characters: split the UTF-8 bytes without cutting a character.
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + 45);
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    words.push(`=?UTF-8?B?${base64(bytes.subarray(start, end))}?=`);
    start = end;
  }
  return words.join(" ");
}

function encodeMailbox(mailbox: string): string {
  const trimmed = noLineBreaks(mailbox.trim(), "An address");
  const named = NAMED_ADDRESS.exec(trimmed);
  if (!named || !named[1]!.trim()) return mailboxAddress(trimmed);
  const name = named[1]!.trim().replace(/^"|"$/g, "");
  const address = mailboxAddress(named[2]!);
  return /^[\x20-\x7E]*$/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}" <${address}>` : `${encodeHeaderText(name)} <${address}>`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

// A body part's bytes as base64, in 76-character lines (RFC 2045).
function bodyBase64(text: string): string {
  return (base64(new TextEncoder().encode(text)).match(/.{1,76}/g) ?? [""]).join("\r\n");
}

/** The reply subject: "Re: <original>" unless it already reads as a reply. */
export function replySubject(original: string | undefined): string {
  const subject = (original ?? "").trim();
  if (!subject) return "Re:";
  return /^(?:re|aw|sv|antw)\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

// A References chain: the original's chain plus its own Message-ID, at most 20 ids.
function referencesFor(target: ReplyTarget): string | undefined {
  const ids = `${target.references ?? ""} ${target.messageId ?? ""}`.match(/<[^<>\s]{1,250}>/g) ?? [];
  return ids.length ? ids.slice(-20).join(" ") : undefined;
}

/** Every recipient address of a draft (to, cc, bcc), lower-cased and de-duplicated. */
export function draftRecipients(draft: MailDraft): string[] {
  const out = new Set<string>();
  for (const mailbox of [...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])]) out.add(mailboxAddress(mailbox));
  return [...out];
}

/** The subject a draft goes out with (a reply's "Re: …" when it has none of its own). */
export function draftSubject(draft: MailDraft, reply?: ReplyTarget): string {
  const own = draft.subject?.trim();
  if (own) return noLineBreaks(own, "The subject");
  return reply ? replySubject(reply.subject) : "";
}

/**
 * The RFC 2822 message for a draft, base64url-encoded for Gmail's `raw`. Plain text only, or
 * text plus HTML as multipart/alternative; UTF-8 throughout; threaded when it is a reply.
 */
export function buildMimeMessage(draft: MailDraft, reply?: ReplyTarget): string {
  const headers: string[] = [];
  const list = (name: string, mailboxes: readonly string[] | undefined) => {
    if (mailboxes && mailboxes.length) headers.push(`${name}: ${mailboxes.map(encodeMailbox).join(", ")}`);
  };
  list("To", draft.to);
  list("Cc", draft.cc);
  list("Bcc", draft.bcc);
  const subject = draftSubject(draft, reply);
  if (subject) headers.push(`Subject: ${encodeHeaderText(subject)}`);
  if (reply?.messageId && /^<[^<>\s]{1,250}>$/.test(reply.messageId)) headers.push(`In-Reply-To: ${reply.messageId}`);
  const references = reply ? referencesFor(reply) : undefined;
  if (references) headers.push(`References: ${references}`);
  headers.push("MIME-Version: 1.0");

  const text = stripInvisible(draft.text).text;
  let body: string;
  if (draft.html !== undefined) {
    const boundary = "warthog-alt-boundary";
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      bodyBase64(text),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      bodyBase64(draft.html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
    body = bodyBase64(text);
  }
  const message = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return base64(new TextEncoder().encode(message)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What the person sees about an outgoing email on the approval card. */
export interface OutgoingMail {
  readonly subject: string;
  readonly excerpt: string;
  /** Characters or elements in the HTML version the recipient won't see. */
  readonly hiddenFromRecipient: number;
  /** The domains the email links to. */
  readonly linkDomains: readonly string[];
}

const EXCERPT_CHARS = 280;

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** The approval card's summary of a draft: subject, a short excerpt, hidden content and link domains. */
export function outgoingMail(draft: MailDraft, reply?: ReplyTarget): OutgoingMail {
  const visible = stripInvisible(draft.text);
  let hidden = visible.removed;
  const links = new Set<string>();
  for (const match of visible.text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
    const domain = domainOf(match[0]);
    if (domain) links.add(domain);
  }
  if (draft.html !== undefined) {
    const html = htmlToText(draft.html);
    hidden += html.hiddenElements + stripInvisible(html.text).removed;
    for (const link of html.links) {
      const domain = domainOf(link);
      if (domain) links.add(domain);
    }
  }
  const flat = visible.text.replace(/\s+/g, " ").trim();
  return {
    subject: draftSubject(draft, reply),
    excerpt: flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat,
    hiddenFromRecipient: hidden,
    linkDomains: [...links].slice(0, 20),
  };
}
