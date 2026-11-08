// What an approval reads as in the inbox (brief "Approval inbox": each request shows
// "what it wants to do in plain words, the exact details (recipient, amount, field
// requested)"). The pipeline stores this sentence on the approval when it asks, and the
// inbox formats the exact amounts with the same helper, so the two never disagree.
//
// Pure domain module: no React, no DB, no clock. The view renders "<agent> <sentence>",
// so every sentence starts with a verb ("wants to …").

/** The fields of a held call a sentence is built from. */
export interface RequestSummary {
  readonly tool: string;
  readonly connector?: string | null;
  readonly request?: "card" | "high_tier";
  readonly amount?: number;
  readonly currency?: string;
  readonly merchant?: string;
  readonly field?: string;
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
      : "wants to see one of your high-tier identity details";
  }
  const core = CORE_TOOL_WORDS[call.tool];
  if (core && !call.connector) return `wants to ${core}`;
  return call.connector ? `wants to run ${call.tool} on ${call.connector}` : `wants to run ${call.tool}`;
}
