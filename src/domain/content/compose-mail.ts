// Approval-card truth — Warthog builds the email an agent drafts or sends, from plain fields
// (docs/adr/approval-card-truth.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
//
// Agents used to hand Warthog a base64 RFC 2822 message (`raw`). Models build those badly
// (claude.ai can't base64-encode reliably), and the person approved "send email to X" without
// seeing what X would get. Now an agent gives `to`, `cc`, `bcc`, `subject` and `text`, and
// Warthog builds a plain-text message itself, with invisible and direction-changing
// characters removed. What the person approves is exactly what is sent: there is no second
// (HTML) version the card can't show, recipients are unambiguous, and nothing can hide in
// headers.

import { stripInvisible } from "./untrusted";

/** What an agent writes: who it goes to and what it says. */
export interface MailDraft {
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string;
  readonly text: string;
}

/** The headers of the message being replied to, so the reply lands in its thread. */
export interface ReplyTarget {
  readonly messageId?: string;
  readonly references?: string;
  readonly subject?: string;
}

/** A draft Warthog can't build (an address it can't read, a header with a line break). */
export class MailComposeError extends Error {}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
// "Name <address>", or a quoted name ("Lee, Sam" <address>) as mail headers write it.
const NAMED = /^([^<>"\r\n]{0,120}?)\s*<([^<>\s]+)>$/;
const QUOTED_NAMED = /^"((?:[^"\\\r\n]|\\.){0,120})"\s*<([^<>\s]+)>$/;

/** A mailbox read apart: an optional display name and its address (case kept). */
export interface Mailbox {
  readonly name?: string;
  readonly address: string;
}

/** Read one mailbox — a bare address, "Name <address>" or "\"Quoted, Name\" <address>" — or throw. */
export function parseMailbox(mailbox: string): Mailbox {
  const trimmed = mailbox.trim();
  if (/[\r\n]/.test(trimmed)) throw new MailComposeError("An address can't contain a line break.");
  const quoted = QUOTED_NAMED.exec(trimmed);
  const named = quoted ? null : NAMED.exec(trimmed);
  const address = quoted ? quoted[2]! : named ? named[2]! : trimmed;
  if (!ADDRESS.test(address) || address.length > 254) throw new MailComposeError(`"${trimmed.slice(0, 80)}" isn't an email address Warthog can send to.`);
  const rawName = quoted ? quoted[1]!.replace(/\\(.)/g, "$1") : named ? named[1]!.trim() : "";
  const name = stripInvisible(rawName).text.trim();
  return name ? { name, address } : { address };
}

/** The address part of a mailbox, lower-cased (for comparing and rules); throws on anything else. */
export function mailboxAddress(mailbox: string): string {
  return parseMailbox(mailbox).address.toLowerCase();
}

function noLineBreaks(value: string, field: string): string {
  if (/[\r\n]/.test(value)) throw new MailComposeError(`${field} can't contain a line break.`);
  return stripInvisible(value).text;
}

// RFC 2047 "B" encoding for a header value with non-ASCII characters, or one that already
// looks like an encoded word (so a recipient's client never decodes text the card showed
// literally). Encoded words are at most 75 characters each.
function encodedWords(value: string): string[] | null {
  if (/^[\x20-\x7E]*$/.test(value) && !value.includes("=?")) return null;
  const bytes = new TextEncoder().encode(value);
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + 42);
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    words.push(`=?UTF-8?B?${base64(bytes.subarray(start, end))}?=`);
    start = end;
  }
  return words;
}

// A header line folded (CRLF + space) between items so no line runs past about 76 characters
// (RFC 5322 allows 998). `separator` follows every item but the last ("," between addresses;
// nothing between encoded words or message ids, which are space-separated).
function foldHeader(name: string, items: readonly string[], separator: string): string {
  const lines: string[] = [];
  let line = `${name}:`;
  items.forEach((item, index) => {
    const token = index < items.length - 1 ? `${item}${separator}` : item;
    if (line.length + 1 + token.length > 76 && line.length > name.length + 1) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  });
  lines.push(line);
  return lines.join("\r\n");
}

function encodeMailbox(mailbox: string): string {
  const { name, address } = parseMailbox(mailbox);
  if (!name) return address;
  const words = encodedWords(name);
  return words ? `${words.join(" ")} <${address}>` : `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;
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
  const subject = (original ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!subject) return "Re:";
  return /^(?:re|aw|sv|antw)\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

// A message id: printable ASCII in angle brackets, no spaces or control characters.
const MESSAGE_ID = /<[\x21-\x3B\x3D\x3F-\x7E]{1,250}>/g;

// A References chain: the original's chain plus its own Message-ID, at most 20 ids.
function referencesFor(target: ReplyTarget): string[] {
  const ids = `${target.references ?? ""} ${target.messageId ?? ""}`.match(MESSAGE_ID) ?? [];
  return ids.slice(-20);
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

/** The text a draft goes out with: exactly what the card shows (invisible characters removed). */
export function draftText(draft: MailDraft): string {
  return stripInvisible(draft.text).text;
}

/**
 * The RFC 2822 message for a draft, base64url-encoded for Gmail's `raw`: plain text, UTF-8,
 * headers folded, threaded when it is a reply.
 */
export function buildMimeMessage(draft: MailDraft, reply?: ReplyTarget): string {
  const headers: string[] = [];
  const list = (name: string, mailboxes: readonly string[] | undefined) => {
    if (mailboxes && mailboxes.length) headers.push(foldHeader(name, mailboxes.map(encodeMailbox), ","));
  };
  list("To", draft.to);
  list("Cc", draft.cc);
  list("Bcc", draft.bcc);
  const subject = draftSubject(draft, reply);
  if (subject) {
    const words = encodedWords(subject);
    headers.push(words ? foldHeader("Subject", words, "") : `Subject: ${subject}`);
  }
  const messageId = reply?.messageId?.match(MESSAGE_ID)?.[0];
  if (messageId && messageId === reply?.messageId?.trim()) headers.push(`In-Reply-To: ${messageId}`);
  const references = reply ? referencesFor(reply) : [];
  if (references.length) headers.push(foldHeader("References", references, ""));
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  const message = `${headers.join("\r\n")}\r\n\r\n${bodyBase64(draftText(draft))}`;
  return base64(new TextEncoder().encode(message)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What the person sees about an outgoing email on the approval card. */
export interface OutgoingMail {
  readonly subject: string;
  readonly excerpt: string;
  /** The whole text (up to FULL_TEXT_CHARS), for the card's Details. */
  readonly text: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  /** The domains the email links to. */
  readonly linkDomains: readonly string[];
}

const EXCERPT_CHARS = 280;
const FULL_TEXT_CHARS = 5000;

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function addresses(mailboxes: readonly string[] | undefined): string[] {
  return (mailboxes ?? []).map(mailboxAddress);
}

/** The approval card's summary of a draft: subject, opening words, whole text, who gets it, and the domains it links to. */
export function outgoingMail(draft: MailDraft, reply?: ReplyTarget): OutgoingMail {
  const text = draftText(draft);
  const links = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
    const domain = domainOf(match[0]);
    if (domain) links.add(domain);
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return {
    subject: draftSubject(draft, reply),
    excerpt: flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat,
    text: text.length > FULL_TEXT_CHARS ? `${text.slice(0, FULL_TEXT_CHARS - 1)}…` : text,
    to: addresses(draft.to),
    cc: addresses(draft.cc),
    bcc: addresses(draft.bcc),
    linkDomains: [...links].slice(0, 20),
  };
}
