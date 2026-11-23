// How the audit log organises itself: what TYPE of activity an entry is (a read, a change,
// an approval or release, an agent's own report …) and which OUTCOME group its outcome
// falls in (done, waiting, blocked, failed). The Activity page groups and filters by these,
// Home and the agent workspace summarise by them.
//
// Classification reads ONLY the plaintext metadata columns (kind, source, tool, outcome),
// never the encrypted payload, so the same rules run in SQL (`server/activity/category-sql`)
// to filter and count over a person's whole record without decrypting anything. One rule
// table backs both, so the TypeScript and the SQL can never classify an entry differently.
// Nothing here is stored: history is reclassified consistently when the lists change, and
// the append-only hash chain is untouched.
//
// Pure domain module: no React, no DB, no clock. Which tools are read-only comes from the
// caller (the server's tool-effect index), so this module holds no tool registry.

export const ACTIVITY_CATEGORIES = [
  "read",
  "change",
  "approval",
  "report",
  "rejected",
  "access",
  "account",
  "other",
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<ActivityCategory, string>> = {
  read: "Reads",
  change: "Changes",
  approval: "Approvals & releases",
  report: "Agent reports",
  rejected: "Rejected requests",
  access: "Connections & access",
  account: "Account changes",
  other: "Other",
};

// One line under each type on the "By type" view, so a person knows what is counted where.
export const CATEGORY_DESCRIPTIONS: Readonly<Record<ActivityCategory, string>> = {
  read: "Requests Warthog knows only read information, such as searching memory or email.",
  change: "Requests that can change something, including any tool whose effect Warthog cannot confirm.",
  approval: "Card and identity requests, approval decisions and one-time releases.",
  report: "Summaries agents submitted about their own work. Warthog did not observe these.",
  rejected: "Requests refused before reaching a tool, such as a tool the agent may not use.",
  access: "Agents and services connected or disconnected, keys, permissions and defaults.",
  account: "Rules, memories and imports changed in your account.",
  other: "Anything else Warthog recorded.",
};

// The kinds an agent call writes. A call is a read or a change by its tool.
export const TOOL_KINDS: readonly string[] = ["tool_call", "tool_attempt"];

// Agent-reported activity, including the Warthog-recorded rows of the `log_activity` call
// that carries the report: an agent's own claim is never counted as a read or change.
export const REPORT_TOOLS: readonly string[] = ["log_activity"];
export const REPORT_KINDS: readonly string[] = ["agent_report"];

// Approval decisions, sensitive releases and the tools that request or collect them.
export const APPROVAL_KINDS: readonly string[] = ["approval_decision", "card_release", "identity_release"];
export const APPROVAL_TOOLS: readonly string[] = [
  "request_card",
  "request_identity_detail",
  "check_approval",
  "collect_release",
];

export const REJECTED_KINDS: readonly string[] = ["tool_rejected", "protocol_rejected"];

export const ACCESS_KINDS: readonly string[] = [
  "agent_connected",
  "agent_key_revoked",
  "agent_key_replaced",
  "connection_change",
  "permission_change",
  "agent_defaults_change",
  "skill_access_change",
  "memory_scope_change",
  "client_observed",
];

export const ACCOUNT_KINDS: readonly string[] = [
  "rule_created",
  "rule_updated",
  "rule_paused",
  "rule_deleted",
  // The person's approval expiry, set with their rules on Rules & budgets.
  "approval_expiry_change",
  "memory_created",
  "memory_updated",
  "memory_deleted",
  "account_imported",
  // Recovery with the recovery code (it removed the old passkeys and authenticator app).
  "account_recovered",
  // The person's own life-admin changes (docs/adr/life-admin-journal.md).
  "life_admin_record_saved",
  "life_admin_record_changed",
  "life_admin_record_confirmed",
  "life_admin_record_dismissed",
  "life_admin_record_deleted",
  "life_admin_change_accepted",
  "life_admin_change_declined",
  "life_admin_file_attached",
  "life_admin_reminders_changed",
  "life_admin_journal_added",
  "life_admin_next_done",
  "life_admin_steward_set",
  "life_admin_category_kept",
  "life_admin_category_declined",
  "life_admin_category_setting",
];

// The metadata classification reads. `source` "agent_reported" is always a report.
export interface CategoryInput {
  readonly kind: string;
  readonly source: string;
  readonly tool?: string | null;
}

/**
 * The type of activity an entry is. Rules apply in order: an agent's own report wins over
 * everything, then approvals and releases, rejected requests, connection/access and account
 * changes; an agent call is a read only when its tool is KNOWN to be read-only
 * (`isReadOnlyTool`), otherwise a change — an unknown effect is never shown as a read.
 */
export function activityCategory(
  entry: CategoryInput,
  isReadOnlyTool: (tool: string) => boolean,
): ActivityCategory {
  const tool = entry.tool ?? undefined;
  if (entry.source === "agent_reported" || REPORT_KINDS.includes(entry.kind)) return "report";
  if (TOOL_KINDS.includes(entry.kind) && tool !== undefined && REPORT_TOOLS.includes(tool)) return "report";
  if (APPROVAL_KINDS.includes(entry.kind)) return "approval";
  if (TOOL_KINDS.includes(entry.kind) && tool !== undefined && APPROVAL_TOOLS.includes(tool)) return "approval";
  if (REJECTED_KINDS.includes(entry.kind)) return "rejected";
  if (ACCESS_KINDS.includes(entry.kind)) return "access";
  if (ACCOUNT_KINDS.includes(entry.kind)) return "account";
  if (TOOL_KINDS.includes(entry.kind)) return tool !== undefined && isReadOnlyTool(tool) ? "read" : "change";
  return "other";
}

export const OUTCOME_GROUPS = ["done", "waiting", "blocked", "failed", "other"] as const;
export type OutcomeGroup = (typeof OUTCOME_GROUPS)[number];

export const OUTCOME_GROUP_LABELS: Readonly<Record<OutcomeGroup, string>> = {
  done: "Done",
  waiting: "Waiting",
  blocked: "Blocked",
  failed: "Failed",
  other: "Other",
};

// The stored outcome codes in each group. Anything unrecognised (including the sentences
// older Undo entries stored) is "other": never counted as done, never as a problem.
export const OUTCOME_CODES: Readonly<Record<Exclude<OutcomeGroup, "other">, readonly string[]>> = {
  done: ["executed", "ok", "approved", "released", "saved", "connected", "reconnected", "disconnected", "reported", "reversed", "done"],
  waiting: ["pending_approval", "attempted", "more_detail", "pending"],
  blocked: ["denied", "refused", "rate_limited", "expired"],
  failed: ["failed", "unknown", "error", "needs_reconnect"],
};

export function outcomeGroup(outcome: string | null | undefined): OutcomeGroup {
  if (outcome === null || outcome === undefined || outcome === "") return "other";
  for (const group of ["done", "waiting", "blocked", "failed"] as const) {
    if (OUTCOME_CODES[group].includes(outcome)) return group;
  }
  return "other";
}

// Each stored outcome code in the words a person uses (UI/UX pass, content-04): one small
// vocabulary — Done, Waiting for you, Blocked, Failed, Undone — instead of the engine's own
// codes ("Executed", "Attempted", "Saved"). Connection and approval outcomes keep the verb
// that says what happened ("Connected", "Approved"). An intent record ("attempted") is "Not
// confirmed": the entry itself never confirms that the change finished.
export const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  executed: "Done",
  ok: "Done",
  saved: "Done",
  reported: "Done",
  done: "Done",
  approved: "Approved",
  released: "Released",
  connected: "Connected",
  reconnected: "Reconnected",
  disconnected: "Disconnected",
  reversed: "Undone",
  pending_approval: "Waiting for you",
  pending: "Waiting",
  attempted: "Not confirmed",
  more_detail: "Asked for detail",
  denied: "Denied",
  refused: "Blocked",
  rate_limited: "Too many requests",
  expired: "Expired",
  failed: "Failed",
  error: "Failed",
  unknown: "Result unknown",
  needs_reconnect: "Reconnect needed",
};

function tidy(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * An outcome in words: "executed" → "Done", "pending_approval" → "Waiting for you". Accepts the
 * stored code or its tidied form ("Pending approval", which older loaders hand over), so it
 * can be applied at any boundary; anything unrecognised (including the sentences older Undo
 * entries stored) reads as itself, tidied.
 */
export function outcomeLabel(outcome: string | null | undefined): string {
  if (outcome === null || outcome === undefined) return "";
  const code = outcome.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return Object.hasOwn(OUTCOME_LABELS, code) ? OUTCOME_LABELS[code]! : tidy(outcome);
}

// What one entry of each type is called, for counts in a sentence ("1 read", "2 rejected
// requests") — the plural type labels above read wrongly after "1" (content-38).
export const CATEGORY_NOUNS: Readonly<Record<ActivityCategory, readonly [string, string]>> = {
  read: ["read", "reads"],
  change: ["change", "changes"],
  approval: ["approval or release", "approvals and releases"],
  report: ["agent report", "agent reports"],
  rejected: ["rejected request", "rejected requests"],
  access: ["connection or access change", "connection and access changes"],
  account: ["account change", "account changes"],
  other: ["other entry", "other entries"],
};

/** "1 read", "3 rejected requests". */
export function categoryCount(category: ActivityCategory, count: number): string {
  const [one, many] = CATEGORY_NOUNS[category];
  return `${count} ${count === 1 ? one : many}`;
}

// The outcomes a person should look at: requests that were blocked or failed. Disputed
// entries are added to "Needs attention" separately (a dispute is not an outcome).
export const ATTENTION_OUTCOMES: readonly string[] = [...OUTCOME_CODES.blocked, ...OUTCOME_CODES.failed];

/**
 * Whether the entry's agent ACTED (an agent call, its report, a rejected request) or was the
 * SUBJECT of something the person or Warthog did (a permission change, an approval decision,
 * a disconnect). The timeline must not present an owner's action as the agent's.
 */
export function agentRole(kind: string): "actor" | "subject" {
  return TOOL_KINDS.includes(kind) || REJECTED_KINDS.includes(kind) || REPORT_KINDS.includes(kind) || kind === "client_observed"
    ? "actor"
    : "subject";
}

export function isActivityCategory(value: string | undefined): value is ActivityCategory {
  return value !== undefined && (ACTIVITY_CATEGORIES as readonly string[]).includes(value);
}
