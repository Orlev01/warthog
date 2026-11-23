// Approval-card truth — what a held request would send or change, as the person reads it on
// the approval card (docs/adr/approval-card-truth.md).
//
// Pure domain module: no React, no DB, no clock. The pipeline stores this summary on the
// approval (DEK-encrypted, like the rest of the detail); the inbox renders it. It is built
// from the SAME input the tool runs with, so the card shows exactly what will go out.

import { outgoingMail, type MailDraft } from "../content/compose-mail";
import { outgoingPost, outgoingPostDeletion, type OutgoingPost, type OutgoingPostDeletion, type PostVisibility } from "../content/linkedin-post";
import { cleanShortText } from "../content/untrusted";

/** What a held call would send or change, by kind. */
export type OutgoingDetail =
  | { kind: "email"; subject: string; excerpt: string; text: string; reply: boolean; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; linkDomains: readonly string[] }
  | { kind: "invite"; title: string; start?: string; guests: readonly string[] }
  | { kind: "request"; method: string; path: string; queryKeys: readonly string[] }
  | { kind: "provider"; arguments: readonly { key: string; preview: string }[] }
  | OutgoingPost
  | OutgoingPostDeletion
  // One of Warthog's own tools (a task, a record, a memory, an activity note): what it would
  // add or change. `title` names the one thing it adds; `count` how many records a batch saves.
  | { kind: "core"; title?: string; count?: number; lines: readonly { key: string; preview: string }[] };

/** The fields of a held call the summary is read from. */
export interface OutgoingCall {
  readonly tool: string;
  readonly connector: string | null;
  readonly params?: unknown;
  readonly recipients?: string | readonly string[] | null;
  readonly requiresApproval?: boolean;
}

const MAIL_TOOLS = /^(?:google-gmail|microsoft-outlook-mail)__(?:draft|send)$/;
const INVITE_TOOLS = /^(?:google-calendar|microsoft-outlook-calendar)__(?:create|update)$/;
const POST_TOOLS = new Set(["linkedin__create_post"]);

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function guestsOf(recipients: OutgoingCall["recipients"]): string[] {
  if (Array.isArray(recipients)) return recipients.filter((item): item is string => typeof item === "string");
  return typeof recipients === "string" && recipients ? [recipients] : [];
}

// A field name as a person reads it ("due_date" → "Due date").
function fieldLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

function shortText(value: unknown, max = 200): string {
  if (typeof value === "string") return cleanShortText(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Up to three of a record's fields beyond its name (and the currency, which reads with the amount).
function recordFieldLines(fields: Record<string, unknown>): { key: string; preview: string }[] {
  return Object.entries(fields)
    .filter(([key]) => key !== "name" && key !== "currency")
    .map(([key, value]) => ({ key: fieldLabel(cleanShortText(key, 60)), preview: shortText(value, 120) }))
    .filter((line) => line.preview !== "")
    .slice(0, 3);
}

function namesText(names: readonly string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

// UI/UX audit 2026-11-23 W-01: a held call to Warthog's own tools says what it would add or
// change, read from the same arguments the tool runs with.
function coreDetail(tool: string, params: Record<string, unknown>): OutgoingDetail | undefined {
  const lines: { key: string; preview: string }[] = [];
  const push = (key: string, value: unknown, max?: number) => {
    const preview = shortText(value, max);
    if (preview) lines.push({ key, preview });
  };
  switch (tool) {
    case "create_task": {
      const title = shortText(params.title);
      if (params.assignee === "any") lines.push({ key: "For", preview: "Any agent" });
      return title ? { kind: "core", title, lines } : undefined;
    }
    case "remember":
      push("Memory", params.content, 300);
      return lines.length ? { kind: "core", lines } : undefined;
    case "save_record": {
      if (Array.isArray(params.records) && params.records.length) {
        const names = params.records.map((r) => shortText(fieldsOf(fieldsOf(r).fields).name, 80)).filter(Boolean);
        if (params.records.length === 1 && names[0]) {
          return { kind: "core", title: names[0], lines: recordFieldLines(fieldsOf(fieldsOf(params.records[0]).fields)) };
        }
        return { kind: "core", count: params.records.length, lines: names.length ? [{ key: "Records", preview: namesText(names) }] : [] };
      }
      const fields = fieldsOf(params.fields);
      const title = shortText(fields.name);
      if (!title && !Object.keys(fields).length) return undefined;
      return { kind: "core", ...(title ? { title } : {}), lines: recordFieldLines(fields) };
    }
    case "update_record": {
      // `fields` (the older form) replaces every field; `set` changes some, and null removes one.
      const replacing = params.fields !== undefined && params.fields !== null;
      if (replacing) lines.push({ key: "Replaces", preview: "All of its details" });
      const changes = { ...fieldsOf(params.fields), ...fieldsOf(params.set) };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) lines.push({ key: fieldLabel(cleanShortText(key, 60)), preview: "Removed" });
      }
      lines.push(...recordFieldLines(Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null))));
      push("Status", params.status);
      if (params.dueDate === null) lines.push({ key: "Due", preview: "Removed" });
      else push("Due", params.dueDate);
      return lines.length ? { kind: "core", lines } : undefined;
    }
    case "update_task":
      push("Status", params.status);
      push("Note", params.note, 300);
      return lines.length ? { kind: "core", lines } : undefined;
    case "log_activity":
      push("Note", params.reason, 300);
      if (typeof params.amount === "number") lines.push({ key: "Amount", preview: `${params.amount}${typeof params.currency === "string" ? ` ${cleanShortText(params.currency, 10)}` : ""}` });
      return lines.length ? { kind: "core", lines } : undefined;
    default:
      return undefined;
  }
}

/** The approval card's summary of what a held call would send or change, or undefined when there is nothing to show. */
export function outgoingDetail(call: OutgoingCall): OutgoingDetail | undefined {
  const params = (call.params ?? {}) as Record<string, unknown>;
  if (!call.connector) return coreDetail(call.tool, params);
  if (MAIL_TOOLS.test(call.tool) && typeof params.text === "string") {
    const draft: MailDraft = {
      ...(strings(params.to) ? { to: strings(params.to) } : {}),
      ...(strings(params.cc) ? { cc: strings(params.cc) } : {}),
      ...(strings(params.bcc) ? { bcc: strings(params.bcc) } : {}),
      ...(typeof params.subject === "string" ? { subject: params.subject } : {}),
      text: params.text,
    };
    const reply = params.reply !== null && typeof params.reply === "object";
    try {
      return { kind: "email", ...outgoingMail(draft), reply };
    } catch {
      // A draft Warthog can't build is refused before it is held; never fail the hold here.
      return undefined;
    }
  }
  if (POST_TOOLS.has(call.tool) && typeof params.text === "string") {
    const link = params.link !== null && typeof params.link === "object" ? params.link as Record<string, unknown> : undefined;
    return outgoingPost({
      text: params.text,
      ...(params.visibility === "PUBLIC" || params.visibility === "CONNECTIONS" ? { visibility: params.visibility as PostVisibility } : {}),
      ...(typeof link?.url === "string"
        ? { link: {
          url: link.url,
          ...(typeof link.title === "string" ? { title: link.title } : {}),
          ...(typeof link.description === "string" ? { description: link.description } : {}),
        } }
        : {}),
    });
  }
  if (call.tool === "linkedin__delete_post") {
    const query = params.query !== null && typeof params.query === "object" ? params.query as Record<string, unknown> : {};
    return outgoingPostDeletion(query.id);
  }
  if (INVITE_TOOLS.test(call.tool)) {
    let event: Record<string, unknown> = {};
    try {
      event = typeof params.body === "string" ? JSON.parse(params.body) as Record<string, unknown> : {};
    } catch {
      event = {};
    }
    const title = typeof event.summary === "string" ? event.summary : typeof event.subject === "string" ? event.subject : "";
    const start = event.start as { dateTime?: unknown; date?: unknown } | undefined;
    const when = typeof start?.dateTime === "string" ? start.dateTime : typeof start?.date === "string" ? start.date : undefined;
    return { kind: "invite", title: cleanShortText(title, 200), ...(when ? { start: when.slice(0, 40) } : {}), guests: guestsOf(call.recipients).slice(0, 50) };
  }
  if (call.connector && call.tool === `${call.connector}__request`) {
    const query = params.query !== null && typeof params.query === "object" ? Object.keys(params.query as object) : [];
    return {
      kind: "request",
      method: cleanShortText(String(params.method ?? ""), 10),
      path: cleanShortText(String(params.path ?? ""), 300),
      queryKeys: query.slice(0, 20).map((key) => cleanShortText(key, 60)),
    };
  }
  if (call.requiresApproval) {
    const args = params.arguments !== null && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? Object.entries(params.arguments as Record<string, unknown>) : [];
    if (!args.length) return undefined;
    return {
      kind: "provider",
      arguments: args.slice(0, 12).map(([key, value]) => ({
        key: cleanShortText(key, 60),
        preview: cleanShortText(typeof value === "string" ? value : JSON.stringify(value) ?? "", 120),
      })),
    };
  }
  return undefined;
}
