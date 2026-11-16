// Approval-card truth — what a held request would send or change, as the person reads it on
// the approval card (docs/adr/approval-card-truth.md).
//
// Pure domain module: no React, no DB, no clock. The pipeline stores this summary on the
// approval (DEK-encrypted, like the rest of the detail); the inbox renders it. It is built
// from the SAME input the tool runs with, so the card shows exactly what will go out.

import { outgoingMail, type MailDraft } from "../content/compose-mail";
import { cleanShortText } from "../content/untrusted";

/** What a held call would send or change, by kind. */
export type OutgoingDetail =
  | { kind: "email"; subject: string; excerpt: string; reply: boolean; hiddenFromRecipient: number; linkDomains: readonly string[] }
  | { kind: "invite"; title: string; start?: string; guests: readonly string[] }
  | { kind: "request"; method: string; path: string; queryKeys: readonly string[] }
  | { kind: "provider"; arguments: readonly { key: string; preview: string }[] };

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

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function guestsOf(recipients: OutgoingCall["recipients"]): string[] {
  if (Array.isArray(recipients)) return recipients.filter((item): item is string => typeof item === "string");
  return typeof recipients === "string" && recipients ? [recipients] : [];
}

/** The approval card's summary of what a held call would send or change, or undefined when there is nothing to show. */
export function outgoingDetail(call: OutgoingCall): OutgoingDetail | undefined {
  const params = (call.params ?? {}) as Record<string, unknown>;
  if (MAIL_TOOLS.test(call.tool) && typeof params.text === "string") {
    const draft: MailDraft = {
      ...(strings(params.to) ? { to: strings(params.to) } : {}),
      ...(strings(params.cc) ? { cc: strings(params.cc) } : {}),
      ...(strings(params.bcc) ? { bcc: strings(params.bcc) } : {}),
      ...(typeof params.subject === "string" ? { subject: params.subject } : {}),
      text: params.text,
      ...(typeof params.html === "string" ? { html: params.html } : {}),
    };
    const reply = params.reply !== null && typeof params.reply === "object";
    const summary = outgoingMail(draft);
    return { kind: "email", ...summary, reply };
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
