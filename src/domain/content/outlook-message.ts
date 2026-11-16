// Read-side protection — the checked view of Outlook (Microsoft Graph) messages an agent
// reads (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
//
// Graph returns full message resources — HTML bodies included — for both a search and a
// read. Each message becomes the same checked view as Gmail's: who, when, what, readable
// text with links numbered, and a short stub for a sign-in or password email.

import type { MailView } from "./gmail-message";
import { readableBody } from "./mail-body";
import { classifySecurityMail, withheldSentence } from "./security-mail";
import { cleanText, emptyCounts, type FilterCounts } from "./text-filters";
import { stripInvisible } from "./untrusted";

interface GraphAddress {
  readonly emailAddress?: { readonly name?: unknown; readonly address?: unknown };
}

const MAX_HEADER = 2000;

function plain(value: unknown, counts: FilterCounts, max = MAX_HEADER): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const stripped = stripInvisible(value.slice(0, max));
  counts.hiddenCharacters += stripped.removed;
  return stripped.text;
}

function address(value: unknown, counts: FilterCounts): string | undefined {
  const email = (value as GraphAddress | null)?.emailAddress;
  if (!email) return undefined;
  const name = plain(email.name, counts, 200);
  const addr = plain(email.address, counts, 320);
  if (!addr) return name;
  return name && name !== addr ? `${name} <${addr}>` : addr;
}

function addresses(value: unknown, counts: FilterCounts): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.slice(0, 100).flatMap((item) => address(item, counts) ?? []);
  return list.length ? list.join(", ") : undefined;
}

// Only Outlook's own web links: anything else in this field is not passed on.
function webLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(?:^|\.)(?:outlook\.office(?:365)?\.com|outlook\.live\.com)$/.test(url.hostname) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The checked view of one Graph message resource, or null when it isn't one. */
export function outlookMessageView(input: unknown): MailView | null {
  if (input === null || typeof input !== "object" || typeof (input as { id?: unknown }).id !== "string") return null;
  const message = input as Record<string, unknown>;
  const counts = emptyCounts();
  const subject = plain(message.subject, counts);
  const from = address(message.from, counts);
  const link = webLink(message.webLink);

  const base: Record<string, unknown> = { id: message.id };
  const add = (target: Record<string, unknown>, key: string, value: unknown) => {
    if (value !== undefined && value !== "") target[key] = value;
  };
  add(base, "conversationId", plain(message.conversationId, counts, 400));
  add(base, "receivedDateTime", plain(message.receivedDateTime, counts, 64));
  add(base, "from", from);

  const kind = classifySecurityMail(subject);
  if (kind) {
    return {
      message: {
        ...base,
        ...(subject === undefined ? {} : { subject: cleanText(subject, counts, { signInMail: true }) }),
        withheld: true,
        kind,
        ...(link ? { openInMail: link } : {}),
        tellThePerson: withheldSentence(kind, from, "Outlook", link),
      },
      counts,
      stubbed: true,
      fallback: false,
    };
  }

  const view: Record<string, unknown> = { ...base };
  const sender = address(message.sender, counts);
  if (sender && sender !== from) view.sender = sender;
  add(view, "to", addresses(message.toRecipients, counts));
  add(view, "cc", addresses(message.ccRecipients, counts));
  add(view, "replyTo", addresses(message.replyTo, counts));
  add(view, "subject", subject === undefined ? undefined : cleanText(subject, counts));
  add(view, "internetMessageId", plain(message.internetMessageId, counts, 998));
  if (typeof message.isRead === "boolean") view.isRead = message.isRead;
  if (typeof message.hasAttachments === "boolean") view.hasAttachments = message.hasAttachments;
  add(view, "importance", plain(message.importance, counts, 20));
  if (typeof message.bodyPreview === "string" && message.bodyPreview !== "") {
    view.preview = cleanText(message.bodyPreview, counts);
  }
  const body = message.body as { contentType?: unknown; content?: unknown } | undefined;
  if (body && typeof body.content === "string") {
    const readable = readableBody(body.content, String(body.contentType).toLowerCase() === "html", counts);
    view.text = readable.text;
    if (readable.links.length) view.links = readable.links;
    if (readable.shortened) view.shortened = true;
  }
  if (link) view.openInMail = link;
  return { message: view, counts, stubbed: false, fallback: false };
}
