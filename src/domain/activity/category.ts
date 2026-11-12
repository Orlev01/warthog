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
  "memory_created",
  "memory_updated",
  "memory_deleted",
  "account_imported",
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
