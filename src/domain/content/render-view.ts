// Read-side protection — the readable text an agent is handed for a checked mail view
// (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now. Models read
// plain lines far better (and in far fewer tokens) than escaped JSON, and many clients show a
// model only the text block. The structured view travels alongside as structuredContent.

/** The longest link written out in full; a longer one is shown by its domain, fetchable by number. */
export const LONG_LINK_CHARS = 300;

type View = Record<string, unknown>;

// A sender-written value on one line, so a subject or name can't fake a line of its own (a
// second search result, a "Note:" from Warthog).
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ") : undefined;
}

// The body is the one multi-line value; it sits between these two lines, and a body can't
// write the closing one itself.
const TEXT_START = "Message text:";
const TEXT_END = "End of message text.";

function bodyLines(text: string): string[] {
  return [TEXT_START, text.split(TEXT_END).join("End of message text"), TEXT_END];
}

const FLAG_LABELS: Readonly<Record<string, string>> = { SPAM: "spam", TRASH: "bin" };

function flagsOf(message: View): string[] {
  const flags: string[] = [];
  if (message.unread === true || message.isRead === false) flags.push("unread");
  for (const label of Array.isArray(message.labelIds) ? message.labelIds : []) {
    if (typeof label === "string" && FLAG_LABELS[label]) flags.push(`in ${FLAG_LABELS[label]}`);
  }
  if (message.importance === "high") flags.push("marked important");
  return flags;
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

function idsOf(message: View): string {
  return [str(message.id) ? `id ${str(message.id)}` : "", str(message.threadId) ? `thread ${str(message.threadId)}` : "", str(message.conversationId) ? `conversation ${str(message.conversationId)}` : ""].filter(Boolean).join(" · ");
}

function messageLines(message: View): string[] {
  const lines: string[] = [];
  if (message.withheld === true) {
    lines.push(`Withheld: ${str(message.kind) ?? "this message"} from ${str(message.from) ?? "a sender"}${str(message.date) ? ` · ${str(message.date)}` : ""}`);
    if (str(message.subject)) lines.push(`Subject: ${str(message.subject)}`);
    if (str(message.tellThePerson)) lines.push(str(message.tellThePerson)!);
    else if (str(message.note)) lines.push(str(message.note)!);
    if (idsOf(message)) lines.push(idsOf(message));
    return lines;
  }
  const field = (label: string, value: unknown) => { if (str(value)) lines.push(`${label}: ${str(value)}`); };
  field("From", message.from);
  field("Sender", message.sender);
  field("To", message.to);
  field("Cc", message.cc);
  field("Reply-To", message.replyTo);
  field("Date", message.date ?? message.receivedDateTime);
  field("Subject", message.subject);
  const flags = flagsOf(message);
  if (flags.length) lines.push(`Flags: ${flags.join(", ")}`);
  if (idsOf(message)) lines.push(idsOf(message));
  field("Message-ID", message.messageId ?? message.internetMessageId);
  const invitation = message.invitation as View | undefined;
  if (invitation) {
    const time = [str(invitation.start), str(invitation.end)].filter(Boolean).join(" – ");
    lines.push(`Invitation: ${[str(invitation.title), time, str(invitation.location), str(invitation.organizer) ? `from ${str(invitation.organizer)}` : "", str(invitation.uid) ? `uid ${str(invitation.uid)}` : ""].filter(Boolean).join(" · ")}`);
  }
  const attachments = Array.isArray(message.attachments) ? (message.attachments as View[]) : [];
  if (attachments.length) {
    lines.push(`Attachments: ${attachments.map((a) => `${str(a.filename) ?? "file"} (${[str(a.mimeType), size(a.size)].filter(Boolean).join(", ")}; contents not available yet)`).join("; ")}`);
  } else if (message.hasAttachments === true) {
    lines.push("Attachments: yes (names not listed; contents not available yet)");
  }
  field("Note", message.bodyNote);
  if (typeof message.text === "string" && message.text !== "") {
    lines.push("", ...bodyLines(message.text));
    if (message.shortened === true) lines.push("This email is long, so only the start is shown. The person can open it in their mail.");
  } else if (str(message.preview)) {
    lines.push("", `Preview: ${str(message.preview)}`);
  }
  const links = Array.isArray(message.links) ? (message.links as unknown[]).filter((l): l is string => typeof l === "string") : [];
  if (links.length) {
    lines.push("", "Links:");
    links.forEach((link, index) => {
      lines.push(link.length > LONG_LINK_CHARS ? `[${index + 1}] ${domainOf(link)}/… (a long link: read the message again with query.link=${index + 1} for the full address)` : `[${index + 1}] ${str(link)}`);
    });
  }
  field("Links note", message.linksNote);
  field("Unsubscribe", message.listUnsubscribe);
  field("Open in mail", message.openInMail);
  return lines;
}

function summaryLine(message: View, index: number): string {
  if (message.withheld === true) {
    return `${index + 1}. Withheld ${str(message.kind) ?? "message"} from ${str(message.from) ?? "a sender"}${str(message.date) ? ` · ${str(message.date)}` : ""} — ${str(message.tellThePerson) ?? str(message.note) ?? ""}${idsOf(message) ? ` (${idsOf(message)})` : ""}`;
  }
  const head = [str(message.date) ?? str(message.receivedDateTime), str(message.from), str(message.subject) ? `“${str(message.subject)}”` : ""].filter(Boolean).join(" · ");
  const preview = str(message.preview) ? ` — ${str(message.preview)}` : str(message.note) ? ` — ${str(message.note)}` : "";
  const flags = flagsOf(message);
  return `${index + 1}. ${head || "Message"}${flags.length ? ` [${flags.join(", ")}]` : ""}${preview} (${idsOf(message) || "id ?"})`;
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
      lines.push(`Link ${str(String(message.link))} of message ${str(message.id)}: ${str(message.url)}`);
      return lines.join("\n");
    }
    if (message.link !== undefined && str(message.note)) {
      lines.push(`${str(message.note)} (message ${str(message.id) ?? "?"}, link ${str(String(message.link))})`);
      return lines.join("\n");
    }
    lines.push(...messageLines(message));
    return lines.join("\n");
  }
  if (Array.isArray(view.messages)) {
    const messages = view.messages as View[];
    if (!messages.length) lines.push("No messages found.");
    messages.forEach((message, index) => lines.push(summaryLine(message, index)));
    if (str(view.nextPageToken)) lines.push(`More results: search again with the same query.q and query.pageToken=${str(view.nextPageToken)}`);
    if (str(view.nextLink)) lines.push(`More results: ${str(view.nextLink)}`);
    if (str(view.note) && messages.length) lines.push(str(view.note)!);
    return lines.join("\n");
  }
  return null;
}
