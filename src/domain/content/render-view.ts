// Read-side protection — the readable text an agent is handed for a checked mail view
// (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now. Models read
// plain lines far better (and in far fewer tokens) than escaped JSON, and many clients show a
// model only the text block. The structured view travels alongside as structuredContent.

/** The longest link written out in full; a longer one is shown by its domain, fetchable by number. */
export const LONG_LINK_CHARS = 300;

type View = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function size(bytes: unknown): string {
  if (typeof bytes !== "number") return "";
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function messageLines(message: View): string[] {
  const lines: string[] = [];
  if (message.withheld === true) {
    lines.push(`Withheld: ${str(message.kind) ?? "this message"} from ${str(message.from) ?? "a sender"}${str(message.date) ? ` · ${message.date}` : ""}`);
    if (str(message.subject)) lines.push(`Subject: ${message.subject}`);
    if (str(message.tellThePerson)) lines.push(String(message.tellThePerson));
    else if (str(message.note)) lines.push(String(message.note));
    if (str(message.id)) lines.push(`id ${message.id}${str(message.threadId) ? ` · thread ${message.threadId}` : ""}`);
    return lines;
  }
  const field = (label: string, value: unknown) => { if (str(value)) lines.push(`${label}: ${value}`); };
  field("From", message.from);
  field("Sender", message.sender);
  field("To", message.to);
  field("Cc", message.cc);
  field("Reply-To", message.replyTo);
  field("Date", message.date ?? message.receivedDateTime);
  field("Subject", message.subject);
  const ids = [str(message.id) ? `id ${message.id}` : "", str(message.threadId) ? `thread ${message.threadId}` : "", str(message.conversationId) ? `conversation ${message.conversationId}` : ""].filter(Boolean);
  if (ids.length) lines.push(ids.join(" · "));
  field("Message-ID", message.messageId ?? message.internetMessageId);
  const invitation = message.invitation as View | undefined;
  if (invitation) {
    lines.push(`Invitation: ${[str(invitation.title), [str(invitation.start), str(invitation.end)].filter(Boolean).join(" – "), str(invitation.location), str(invitation.organizer) ? `from ${invitation.organizer}` : ""].filter(Boolean).join(" · ")}`);
  }
  const attachments = Array.isArray(message.attachments) ? (message.attachments as View[]) : [];
  if (attachments.length) {
    lines.push(`Attachments: ${attachments.map((a) => `${str(a.filename) ?? "file"} (${[str(a.mimeType), size(a.size)].filter(Boolean).join(", ")}; contents not available yet)`).join("; ")}`);
  }
  field("Note", message.bodyNote);
  if (str(message.text)) {
    lines.push("", String(message.text));
  } else if (str(message.preview)) {
    lines.push("", `Preview: ${message.preview}`);
  }
  const links = Array.isArray(message.links) ? (message.links as unknown[]).filter((l): l is string => typeof l === "string") : [];
  if (links.length) {
    lines.push("", "Links:");
    links.forEach((link, index) => {
      lines.push(link.length > LONG_LINK_CHARS ? `[${index + 1}] ${domainOf(link)}/… (a long link: read the message again with query.link=${index + 1} for the full address)` : `[${index + 1}] ${link}`);
    });
  }
  field("Unsubscribe", message.listUnsubscribe);
  field("Open in mail", message.openInMail);
  return lines;
}

function summaryLine(message: View, index: number): string {
  if (message.withheld === true) {
    return `${index + 1}. Withheld ${str(message.kind) ?? "message"} from ${str(message.from) ?? "a sender"}${str(message.date) ? ` · ${message.date}` : ""} — ${str(message.tellThePerson) ?? str(message.note) ?? ""}${str(message.id) ? ` (id ${message.id})` : ""}`;
  }
  const head = [str(message.date) ?? str(message.receivedDateTime), str(message.from), str(message.subject) ? `“${message.subject}”` : ""].filter(Boolean).join(" · ");
  const flags = message.unread === true || message.isRead === false ? " [unread]" : "";
  const preview = str(message.preview) ? ` — ${message.preview}` : "";
  return `${index + 1}. ${head}${flags}${preview} (id ${str(message.id) ?? "?"})`;
}

/** The readable text of a checked mail view (one message, a search, or a single link), or null for anything else. */
export function renderCheckedView(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const view = result as View;
  if (!str(view.notice)) return null;
  const lines: string[] = [String(view.notice)];
  if (view.message && typeof view.message === "object") {
    const message = view.message as View;
    if (str(message.url)) {
      lines.push(`Link ${message.link} of message ${message.id}: ${message.url}`);
      return lines.join("\n");
    }
    lines.push(...messageLines(message));
    return lines.join("\n");
  }
  if (Array.isArray(view.messages)) {
    const messages = view.messages as View[];
    if (!messages.length) lines.push("No messages found.");
    messages.forEach((message, index) => lines.push(summaryLine(message, index)));
    if (str(view.nextPageToken)) lines.push(`More results: search again with query.pageToken=${view.nextPageToken}`);
    if (str(view.nextLink)) lines.push(`More results: ${view.nextLink}`);
    if (str(view.note) && messages.length) lines.push(String(view.note));
    return lines.join("\n");
  }
  return null;
}
