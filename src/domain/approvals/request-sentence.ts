// What an approval reads as in the inbox (brief "Approval inbox": each request shows
// "what it wants to do in plain words, the exact details (recipient, amount, field
// requested)"). The pipeline stores this sentence on the approval when it asks, and the
// inbox formats the exact amounts with the same helper, so the two never disagree.
//
// Pure domain module: no React, no DB, no clock. The view renders "<agent> <sentence>",
// so every sentence starts with a verb ("wants to …"). A connected service's tool reads by
// its human names ("wants to use “Send” in Gmail"), never its internal ids (UI/UX pass
// content-02): the caller passes the service's display name when it knows it.

import { humanise, toolLabel } from "../activity/describe";
import type { OutgoingDetail } from "./outgoing";

/** The fields of a held call a sentence is built from. */
export interface RequestSummary {
  readonly tool: string;
  readonly connector?: string | null;
  // The connected service's display name ("Gmail"), when the caller can resolve it from the
  // connector catalogue. Absent, the connector id is tidied into words.
  readonly service?: string;
  readonly request?: "card" | "high_tier";
  readonly amount?: number;
  readonly currency?: string;
  readonly merchant?: string;
  readonly field?: string;
  // Who an email or invitation goes to, and what it is (approval-card truth): the sentence
  // names the real recipient, the subject or the event, never just the tool.
  readonly recipients?: string | readonly string[] | null;
  readonly outgoing?: OutgoingDetail;
}

// Australian English money, e.g. "$149.99" for AUD (brief: AUD by default).
const LOCALE = "en-AU";

/**
 * An amount in its ISO 4217 currency, formatted the Australian way ("$149.99" for AUD,
 * "USD 100.00" for US dollars). An unknown code never throws: it falls back to the
 * amount with two decimals and the code.
 */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// The brief's four default high-tier field types in words; anything else (a custom
// field's own label) is shown as it is.
const HIGH_TIER_FIELD_WORDS: Record<string, string> = {
  date_of_birth: "date of birth",
  passport: "passport",
  driver_licence: "driver licence",
  car_registration: "car registration",
};

/** A high-tier field code in plain words ("driver_licence" → "driver licence"). */
export function highTierFieldLabel(field: string): string {
  return HIGH_TIER_FIELD_WORDS[field] ?? field;
}

// Warthog's own change-making core tools in plain words.
const CORE_TOOL_WORDS: Record<string, string> = {
  remember: "save a memory",
  create_task: "add a task",
  update_task: "update a task",
  complete_task: "mark a task done",
  save_record: "save a record",
  update_record: "update a record",
  log_activity: "add a note to your activity",
};

/** The plain-words request, e.g. "wants to use your card for $149.99 at JB Hi-Fi". */
export function requestSentence(call: RequestSummary): string {
  if (call.request === "card") {
    const amount =
      call.amount !== undefined && call.currency !== undefined ? ` for ${formatMoney(call.amount, call.currency)}` : "";
    const merchant = call.merchant ? ` at ${call.merchant}` : "";
    return `wants to use your card${amount}${merchant}`;
  }
  if (call.request === "high_tier") {
    return call.field
      ? `wants to see your ${highTierFieldLabel(call.field)}`
      : "wants to see one of your protected details";
  }
  const specific = outgoingSentence(call);
  if (specific) return specific;
  const core = CORE_TOOL_WORDS[call.tool];
  if (core && !call.connector) return `wants to ${core}`;
  const tool = `“${toolLabel(call.tool)}”`;
  if (!call.connector) return `wants to use ${tool}`;
  const service = call.service?.trim() || humanise(call.connector);
  return `wants to use ${tool} in ${service}`;
}

function recipientList(recipients: RequestSummary["recipients"]): string[] {
  if (Array.isArray(recipients)) return recipients.filter((r): r is string => typeof r === "string" && r !== "");
  return typeof recipients === "string" && recipients ? [recipients] : [];
}

// "sam@example.com", "sam@example.com and tom@example.com", "sam@example.com and 2 others".
function whoText(recipients: readonly string[]): string {
  if (recipients.length === 0) return "";
  if (recipients.length === 1) return recipients[0]!;
  if (recipients.length === 2) return `${recipients[0]} and ${recipients[1]}`;
  return `${recipients[0]} and ${recipients.length - 1} others`;
}

// The sentence for an email or a calendar invitation, naming who it goes to or what it is.
function outgoingSentence(call: RequestSummary): string | undefined {
  const outgoing = call.outgoing;
  if (!outgoing) return undefined;
  const who = whoText(recipientList(call.recipients));
  if (outgoing.kind === "email") {
    const sending = call.tool.endsWith("__send");
    if (outgoing.reply) return sending ? `wants to reply to ${who || "an email"}` : `wants to save a draft reply${who ? ` to ${who}` : ""}`;
    return sending ? `wants to send an email to ${who || "someone"}` : `wants to save a draft email${who ? ` to ${who}` : ""}`;
  }
  if (outgoing.kind === "invite" && outgoing.title) {
    return call.tool.endsWith("__update") ? `wants to change “${outgoing.title}” in your calendar` : `wants to add “${outgoing.title}” to your calendar`;
  }
  return undefined;
}
