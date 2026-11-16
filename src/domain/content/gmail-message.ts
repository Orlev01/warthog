// Read-side protection — the checked view of one Gmail message an agent reads
// (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
//
// Gmail's own `messages.get` reply is base64 body parts inside JSON, plus every header the
// message carried. Agents read that badly (claude.ai cannot decode base64 reliably) and it
// carries things an agent should never see: sign-in codes, password links, hidden text.
// This builds what an agent actually needs — who, when, what, the readable text with its
// links numbered, attachment names — with those few things hidden, and turns a sign-in or
// password email into a short stub that tells the person where to find it.

import { base64Bytes, decodeBytes, decodeHeaderWords, previewOf, readableBody } from "./mail-body";
import { classifySecurityMail, withheldSentence, type SecurityMailKind } from "./security-mail";
import { addCounts, cleanText, emptyCounts, type FilterCounts } from "./text-filters";
import { stripInvisible } from "./untrusted";
import { parseInvitation } from "./ics";

interface GmailHeader {
  readonly name?: unknown;
  readonly value?: unknown;
}

interface GmailPart {
  readonly mimeType?: unknown;
  readonly filename?: unknown;
  readonly headers?: unknown;
  readonly body?: { readonly size?: unknown; readonly data?: unknown; readonly attachmentId?: unknown };
  readonly parts?: unknown;
}

/** The checked view of a message, what was hidden from it, and whether it became a stub. */
export interface MailView {
  readonly message: Record<string, unknown>;
  readonly counts: FilterCounts;
  readonly stubbed: boolean;
  readonly fallback: boolean;
}

export interface GmailViewOptions {
  /** The connected account's address, so the "open in Gmail" link opens the right mailbox. */
  readonly account?: string;
  /** Warthog fetched only the headers because the full message was too large to check. */
  readonly tooLarge?: boolean;
  /** The agent asked for headers only (format=metadata or minimal): no body is expected. */
  readonly headersOnly?: boolean;
}

// The most parts and nesting Warthog walks before treating the rest as unreadable.
const MAX_PARTS = 300;
const MAX_DEPTH = 12;
const MAX_HEADER = 2000;

function headerMap(headers: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(headers)) return map;
  for (const header of headers as GmailHeader[]) {
    if (typeof header?.name !== "string" || typeof header.value !== "string") continue;
    const key = header.name.toLowerCase();
    if (!map.has(key)) map.set(key, header.value);
  }
  return map;
}

function charsetOf(part: GmailPart): string | undefined {
  const type = headerMap(part.headers).get("content-type");
  return type ? /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1] : undefined;
}

interface Walk {
  plain?: GmailPart;
  html?: GmailPart;
  calendar?: GmailPart;
  attachments: { filename: string; mimeType?: string; size?: number }[];
  parts: number;
  capped: boolean;
}

function walk(part: GmailPart, depth: number, state: Walk): void {
  if (depth > MAX_DEPTH || state.parts >= MAX_PARTS) {
    state.capped = true;
    return;
  }
  state.parts += 1;
  const mime = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
  // An invitation's event, whether it comes as a body part or an .ics attachment.
  // The first one Warthog can read wins (an attachment-only copy has no data to decode).
  if (mime === "text/calendar" && !state.calendar && typeof part.body?.data === "string") state.calendar = part;
  if (typeof part.filename === "string" && part.filename !== "") {
    state.attachments.push({
      filename: stripInvisible(part.filename).text.slice(0, 300),
      ...(mime ? { mimeType: mime } : {}),
      ...(typeof part.body?.size === "number" ? { size: part.body.size } : {}),
    });
    return;
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts as GmailPart[]) walk(child ?? {}, depth + 1, state);
    return;
  }
  if (mime === "text/plain" && !state.plain) state.plain = part;
  else if (mime === "text/html" && !state.html) state.html = part;
}

/** The "open in Gmail" link for a thread, in the connected mailbox when its address is known. */
export function gmailThreadLink(threadId: string, account: string | undefined): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(threadId)) return undefined;
  const mailbox = account && /^[^\s@]+@[^\s@]+$/.test(account) ? `?authuser=${encodeURIComponent(account)}` : "0/";
  return `https://mail.google.com/mail/u/${mailbox}#all/${threadId}`;
}

function header(headers: Map<string, string>, name: string, counts: FilterCounts, clean = false): string | undefined {
  const raw = headers.get(name);
  if (raw === undefined) return undefined;
  // A long References chain keeps its END: the parent's Message-ID is last.
  const full = decodeHeaderWords(raw);
  const decoded = name === "references" ? full.slice(-MAX_HEADER) : full.slice(0, MAX_HEADER);
  if (clean) return cleanText(decoded, counts);
  const stripped = stripInvisible(decoded);
  counts.hiddenCharacters += stripped.removed;
  return stripped.text;
}

function dateOf(message: Record<string, unknown>, headers: Map<string, string>): string | undefined {
  const internal = typeof message.internalDate === "string" ? Number(message.internalDate) : Number.NaN;
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  return headers.get("date")?.slice(0, 200);
}

function stub(base: Record<string, unknown>, kind: SecurityMailKind, subject: string | undefined, link: string | undefined, counts: FilterCounts): MailView {
  const from = typeof base.from === "string" ? base.from : undefined;
  const maskedSubject = subject === undefined ? undefined : cleanText(subject, counts, { signInMail: true });
  return {
    message: {
      ...base,
      ...(maskedSubject === undefined ? {} : { subject: maskedSubject }),
      withheld: true,
      kind,
      ...(link ? { openInMail: link } : {}),
      tellThePerson: withheldSentence(kind, from, "Gmail", link),
    },
    counts,
    stubbed: true,
    fallback: false,
  };
}

/** The checked view of a Gmail `messages.get` reply, or null when it isn't one. */
export function gmailMessageView(input: unknown, options: GmailViewOptions = {}): MailView | null {
  if (input === null || typeof input !== "object" || typeof (input as { id?: unknown }).id !== "string") return null;
  const message = input as Record<string, unknown>;
  const counts = emptyCounts();
  const payload = (message.payload ?? {}) as GmailPart;
  const headers = headerMap(payload.headers);
  const threadId = typeof message.threadId === "string" ? message.threadId : undefined;
  const subject = header(headers, "subject", counts);
  const link = threadId ? gmailThreadLink(threadId, options.account) : undefined;
  const date = dateOf(message, headers);
  const from = header(headers, "from", counts);

  const base: Record<string, unknown> = {
    id: message.id,
    ...(threadId ? { threadId } : {}),
    ...(Array.isArray(message.labelIds) ? { labelIds: message.labelIds.filter((label) => typeof label === "string") } : {}),
    ...(date ? { date } : {}),
    ...(from ? { from } : {}),
  };

  const kind = classifySecurityMail(subject);
  if (kind) return stub(base, kind, subject, link, counts);

  const view: Record<string, unknown> = { ...base };
  const add = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== "") view[key] = value;
  };
  add("to", header(headers, "to", counts));
  add("cc", header(headers, "cc", counts));
  add("replyTo", header(headers, "reply-to", counts));
  add("subject", subject === undefined ? undefined : cleanText(subject, counts));
  add("messageId", header(headers, "message-id", counts));
  add("inReplyTo", header(headers, "in-reply-to", counts));
  add("references", header(headers, "references", counts));
  add("listUnsubscribe", header(headers, "list-unsubscribe", counts));
  add("listId", header(headers, "list-id", counts));
  // Gmail's snippet is what the person sees in their inbox list. It can carry a preheader the
  // HTML hides, so once the checked text is read it gives way to that (and isn't counted).
  const snippetCounts = emptyCounts();
  if (typeof message.snippet === "string" && message.snippet !== "") {
    view.preview = cleanText(decodeEntitiesInSnippet(message.snippet), snippetCounts);
  }
  if (link) view.openInMail = link;

  if (options.tooLarge) {
    view.bodyNote = "This email is too large for Warthog to check, so its text isn't shown. The person can open it in Gmail.";
    return { message: view, counts: addCounts(counts, snippetCounts), stubbed: false, fallback: true };
  }
  if (options.headersOnly) return { message: view, counts: addCounts(counts, snippetCounts), stubbed: false, fallback: false };

  const state: Walk = { attachments: [], parts: 0, capped: false };
  walk(payload, 0, state);
  if (state.attachments.length) {
    view.attachments = state.attachments.map((attachment) => ({ ...attachment, contents: "not available yet" }));
  }

  // The HTML part is what the person sees; a plain-text part can say something else entirely.
  const chosen = state.html ?? state.plain;
  const data = chosen?.body?.data;
  if (chosen && typeof data === "string") {
    const raw = decodeBytes(base64Bytes(data), charsetOf(chosen));
    const body = readableBody(raw, chosen === state.html, counts);
    view.text = body.text;
    if (view.preview !== undefined) view.preview = previewOf(body.text);
    if (body.links.length) view.links = body.links;
    if (body.shortened) view.shortened = true;
    if (body.unlistedLinks > 0) view.linksNote = `${body.unlistedLinks} more links aren't listed.`;
  } else {
    addCounts(counts, snippetCounts);
    if (chosen && typeof chosen.body?.attachmentId === "string") {
      view.bodyNote = "This email's text is too large for Warthog to check, so it isn't shown. The person can open it in Gmail.";
    } else if (!chosen) {
      view.bodyNote = "This email has no readable text.";
    }
  }
  const calendarData = state.calendar?.body?.data;
  if (typeof calendarData === "string") {
    const invitation = parseInvitation(decodeBytes(base64Bytes(calendarData), charsetOf(state.calendar!)), counts);
    if (invitation) view.invitation = invitation;
  }
  if (state.capped) view.bodyNote = "Part of this email is too complex for Warthog to check, so some of it isn't shown.";
  return { message: view, counts, stubbed: false, fallback: false };
}

// Gmail's snippet is HTML-escaped plain text ("&#39;", "&amp;").
function decodeEntitiesInSnippet(snippet: string): string {
  return snippet
    .replace(/&#(\d{1,7});/g, (whole, code: string) => {
      const n = Number(code);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
    })
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
