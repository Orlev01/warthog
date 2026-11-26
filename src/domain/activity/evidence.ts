import { redact } from "../redaction/redact";
import { isReadLevel, readLevelLabel } from "../content/read-levels";
import { outcomeLabel } from "./category";
import { entryTitle, humanise, toolLabel } from "./describe";

// What an activity entry's evidence reads as, for the Activity page, the agent's Activity
// section and Home (UI/UX pass, content-01). An entry's payload is a developer record: camelCase
// keys, the member's own ids, request/attempt ids, a SHA-256 policy version and quoted enum
// values. A member reads it here as LABELLED PLAIN-ENGLISH LINES ("What it asked for",
// "Warthog's decision", "Result", "Agent's reason"), while the identifiers that make the record
// checkable (entry number, request and attempt ids, policy version, record fingerprint) stay
// available, unchanged, in a separate "Technical details" list the screens show collapsed.
// Nothing about the stored record changes: this is presentation only.
//
// Pure domain module: no React, no DB, no clock. The payload is run through redaction again
// before any of it is read. Unknown payload fields are never dumped: a new event kind opts into
// safe detail by being described here. The member's own user id and connection ids are never
// shown, even under Technical details.

export interface EvidenceEntry {
  kind: string;
  tool?: string;
  outcome?: string;
  merchant?: string;
  agentId?: string;
  connectorId?: string;
  seq?: number;
  entryHash?: string;
  payload: unknown;
}

/** One labelled line. A value may span several lines ("\n"). */
export interface EvidenceLine {
  readonly label: string;
  readonly value: string;
}

export interface ActivityEvidence {
  // One line for the collapsed row.
  summary: string;
  // The plain-English lines as text, for search and for screens that show one block.
  detail: string;
  // Labelled plain-English lines, in reading order.
  facts: EvidenceLine[];
  // Identifiers and measurements that make the entry checkable, shown collapsed.
  technical: EvidenceLine[];
  // "you" when the entry records the account owner's own change.
  changedBy?: "you";
  // Pairs an intent record ("Started: …") with the result entry written for the same attempt.
  attemptId?: string;
  intent?: true;
  // The agent conversation (run) the entry was recorded under, and the product the request
  // came through, both as reported (docs/adr/agent-runs.md).
  conversation?: { id: string; label?: string };
  via?: string;
}

// The kinds that only ever record the account owner's own change.
const OWNER_KINDS: readonly string[] = [
  "agent_renamed",
  "connection_change",
  "permission_change",
  "agent_defaults_change",
  "skill_access_change",
  "memory_scope_change",
  "approval_decision",
  "account_imported",
];

// Why Warthog blocked a request before it ran, by the stable code it records.
const REJECTION_REASONS: Record<string, string> = {
  invalid_input: "The request wasn't in a form Warthog accepts.",
  tool_unavailable: "That tool isn't available to this agent.",
};

// An agent's access, in the words its Permissions page uses. `accounts` is the accounts an agent
// may use, each with its own settings (docs/adr/several-accounts-per-agent.md); the three
// service-keyed fields before it are what older entries stored, and keep their labels.
const GRANT_LABELS: Record<string, string> = {
  identityAccess: "Everyday details",
  highTierAccess: "Protected details",
  memoryRead: "Read shared memories",
  memoryWrite: "Save memories",
  sharing: "Share what it saves",
  learningSharing: "Share what it saves",
  tasksAccess: "Tasks",
  recordsAccess: "Records",
  readTools: "Read from services",
  changeTools: "Make changes in services",
  grantedConnectors: "Services",
  accounts: "Service accounts",
  connectorAccounts: "Service accounts",
  connectorPolicies: "Service rules",
  identityFields: "Everyday details it can read",
  resourceControls: "Task, record and skill controls",
  skillsScope: "Skills",
  rulesScope: "Rules",
  cardAccess: "Card requests",
  cardBudget: "Card budget",
  rateLimit: "Requests a minute",
  requestLimit: "Requests a minute",
};

// Never shown, not even as technical detail: the member's own ids and internal row ids.
const HIDDEN_KEYS = new Set(["userId", "connectionId", "id"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{32,}$/i;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && (UUID.test(value) || LONG_HEX.test(value));
}

/** "dueDate" → "Due date", "connector_account_id" → "Connector account ID". */
function words(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\bid\b/g, "ID");
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A stored value in words; nested objects become "Name: value; …". */
function plain(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const items = value.map(plain).filter((item): item is string => item !== undefined);
    return items.length > 0 ? items.join(", ") : "None";
  }
  if (isRecord(value)) {
    const parts = Object.entries(value)
      .filter(([key, item]) => !HIDDEN_KEYS.has(key) && !isIdentifier(item))
      .map(([key, item]) => {
        const shown = plain(item);
        return shown === undefined ? undefined : `${words(key)}: ${shown}`;
      })
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  return undefined;
}

/** A setting's value as its Permissions page would say it. */
function setting(value: unknown): string {
  if (value === true) return "on";
  if (value === false) return "off";
  if (value === null || value === undefined) return "none";
  if (value === "ask_first") return "ask me first";
  if (value === "allow") return "on";
  if (value === "off") return "off";
  if (Array.isArray(value)) return value.length === 0 ? "none" : String(value.length);
  if (isRecord(value)) {
    if (typeof value.amount === "number" && typeof value.currency === "string") {
      return `${value.currency} ${value.amount}${typeof value.period === "string" ? ` a ${value.period}` : ""}`;
    }
    return Object.keys(value).length === 0 ? "none" : "set";
  }
  return String(value);
}

/** "Everyday details on · Save memories on · 120 requests a minute". */
function accessSentence(grants: Record<string, unknown>): string {
  const parts: string[] = [];
  const detailed = new Set(["learningSharing", "requestLimit", "connectorAccounts", "connectorPolicies", "resourceControls", "identityFields"]);
  for (const [key, label] of Object.entries(GRANT_LABELS)) {
    if (!(key in grants) || detailed.has(key)) continue;
    const value = grants[key];
    if (key === "rateLimit") {
      if (typeof value === "number") parts.push(`${value} requests a minute`);
      continue;
    }
    parts.push(`${label} ${setting(value)}`);
  }
  return parts.join(" · ");
}

/** The settings that differ between two snapshots, one line each: "Tasks: off → on". */
function changedSettings(before: unknown, after: unknown): string[] {
  const from = isRecord(before) ? before : {};
  const to = isRecord(after) ? after : {};
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((key) => !HIDDEN_KEYS.has(key));
  const lines: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(from[key]) === JSON.stringify(to[key])) continue;
    if (isIdentifier(to[key]) || isIdentifier(from[key])) continue;
    const label = GRANT_LABELS[key] ?? words(key);
    if (key === "accounts" && Array.isArray(from[key]) && Array.isArray(to[key])) {
      lines.push(`${label}: ${accountChanges(from[key] as unknown[], to[key] as unknown[])}`);
      continue;
    }
    lines.push(key in from ? `${label}: ${setting(from[key])} → ${setting(to[key])}` : `${label}: ${setting(to[key])}`);
  }
  return lines;
}

/**
 * What changed in the accounts an agent may use, counted: "1 added, 2 with new settings". An
 * account is matched by its id, which is never shown.
 */
function accountChanges(before: readonly unknown[], after: readonly unknown[]): string {
  const byAccount = (list: readonly unknown[]) =>
    new Map(list.map((grant, i) => [isRecord(grant) && typeof grant.accountId === "string" ? grant.accountId : `#${i}`, grant]));
  const from = byAccount(before);
  const to = byAccount(after);
  const added = [...to.keys()].filter((id) => !from.has(id)).length;
  const removed = [...from.keys()].filter((id) => !to.has(id)).length;
  const changed = [...to].filter(([id, grant]) => from.has(id) && !sameSettings(from.get(id), grant)).length;
  const parts = [
    added > 0 ? `${added} added` : "",
    removed > 0 ? `${removed} removed` : "",
    changed > 0 ? `${changed} with new settings` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "changed";
}

// Two stored grants are the same whatever order their fields were written in.
function sameSettings(a: unknown, b: unknown): boolean {
  const sorted = (value: unknown) =>
    isRecord(value) ? JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]])) : JSON.stringify(value);
  return sorted(a) === sorted(b);
}

/** Each field of a stored object as "Label: value" lines, identifiers moved to `ids`. */
function fieldLines(value: unknown, ids: EvidenceLine[], skip: readonly unknown[] = []): string[] {
  if (!isRecord(value)) return [];
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (HIDDEN_KEYS.has(key) || skip.includes(item)) continue;
    if (isIdentifier(item)) {
      ids.push({ label: words(key), value: item });
      continue;
    }
    if (isRecord(item)) {
      lines.push(...fieldLines(item, ids, skip));
      continue;
    }
    const shown = plain(item);
    if (shown !== undefined) lines.push(`${words(key)}: ${shown}`);
  }
  return lines;
}

function choices(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const granted = value.filter((item) => isRecord(item) && item.granted === true).length;
  return `${granted} allowed, ${value.length - granted} not allowed`;
}

function decisionLine(value: unknown, ids: EvidenceLine[]): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.ruleId === "string") ids.push({ label: "Rule ID", value: value.ruleId });
  const reason = typeof value.reason === "string" && value.reason !== "Allowed." ? value.reason : "";
  if (value.decision === "allow") return reason ? `Allowed. ${reason}` : "Allowed";
  if (value.decision === "ask") return reason ? `Asked you first. ${reason}` : "Asked you first";
  if (value.decision === "deny") return reason ? `Blocked. ${reason}` : "Blocked";
  return reason || undefined;
}

function resultLine(value: unknown, ids: EvidenceLine[]): string | undefined {
  if (!isRecord(value)) return undefined;
  const lines: string[] = [];
  if (typeof value.outcome === "string") lines.push(outcomeLabel(value.outcome));
  for (const [key, item] of Object.entries(value)) {
    if (key === "outcome" || HIDDEN_KEYS.has(key)) continue;
    if (key === "reference" && typeof item === "string") {
      ids.push({ label: "Result reference", value: item });
      continue;
    }
    if (isIdentifier(item)) {
      ids.push({ label: words(key), value: item });
      continue;
    }
    if (key === "counts" && isRecord(item)) {
      const counts = Object.entries(item).map(([name, count]) => `${words(name)} ${plain(count) ?? "0"}`);
      if (counts.length > 0) lines.push(`Found: ${counts.join(", ")}`);
      continue;
    }
    if (key === "guard" && isRecord(item)) {
      const kept = guardLine(item);
      if (kept) lines.push(kept);
      continue;
    }
    if (key === "references" && isRecord(item)) {
      // The ids a result named (records saved, messages found) are identifiers: technical details.
      for (const [name, list] of Object.entries(item)) {
        if (Array.isArray(list) && list.length > 0) ids.push({ label: `${words(name)} ids`, value: list.map(String).join(", ") });
      }
      continue;
    }
    if (key === "effects" && isRecord(item)) {
      // What a life-admin save did, counted (docs/adr/life-admin-journal.md).
      const effects = Object.entries(EFFECT_WORDS).flatMap(([effect, label]) => {
        const n = typeof item[effect] === "number" ? (item[effect] as number) : 0;
        return n > 0 ? [`${n} ${label}`] : [];
      });
      if (effects.length > 0) lines.push(`Records: ${effects.join(", ")}`);
      continue;
    }
    if (key === "profileFields" && Array.isArray(item)) {
      lines.push(`Profile details shared: ${item.length > 0 ? item.map((field) => words(String(field)).toLowerCase()).join(", ") : "none"}`);
      continue;
    }
    const shown = plain(item);
    if (shown !== undefined) lines.push(`${words(key)}: ${shown}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

const EFFECT_WORDS: Readonly<Record<string, string>> = {
  created: "added",
  updated: "updated",
  proposed: "proposed (waiting for you to accept)",
  unchanged: "unchanged",
  skipped: "skipped",
};

// What Warthog's read check kept from the agent (docs/adr/read-side-protection.md), in words:
// "Kept from the agent: 1 sign-in code, 2 sign-in links". Counts only, never the values.
const KEPT_WORDS: Readonly<Record<string, [string, string]>> = {
  codes: ["sign-in code", "sign-in codes"],
  signInLinks: ["sign-in link", "sign-in links"],
  cards: ["card number", "card numbers"],
  identifiers: ["account or ID number", "account or ID numbers"],
  downloadLinks: ["download link", "download links"],
  stubs: ["sign-in or password email", "sign-in or password emails"],
};

// The person's "what agents see" level, when the check ran at one other than the default
// (docs/adr/read-side-protection.md, amendment 24 November 2026). Only a known level is named.
const LEVEL_WORDS: Readonly<Record<string, string>> = { private: "Private", open: "Everything" };

function guardLine(guard: Record<string, unknown>): string | undefined {
  if (guard.outcome === "withheld") return "Warthog couldn't check this, so the agent wasn't shown it";
  if (guard.outcome === "fallback") return "Too large for Warthog to check, so the agent was shown the headers only";
  const counts = isRecord(guard.counts) ? guard.counts : {};
  const kept = Object.entries(KEPT_WORDS).flatMap(([key, [one, many]]) => {
    const n = typeof counts[key] === "number" ? (counts[key] as number) : 0;
    return n > 0 ? [`${n} ${n === 1 ? one : many}`] : [];
  });
  const level = typeof guard.level === "string" && Object.hasOwn(LEVEL_WORDS, guard.level) ? LEVEL_WORDS[guard.level] : undefined;
  if (!kept.length) return level === "Everything" ? "Shown as written: your setting is Everything" : undefined;
  return `Kept from the agent: ${kept.join(", ")}${level ? ` (your setting is ${level})` : ""}`;
}

// "levyoren1@gmail.com, booking@example.com (needs reconnecting)".
function accountSetLine(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const accounts = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string" || item.label === "") return [];
    const outcome = typeof item.outcome === "string" && item.outcome !== "searched" ? ` (${item.outcome})` : "";
    return [`${item.label}${outcome}`];
  });
  return accounts.length > 0 ? accounts.join(", ") : undefined;
}

function clientLine(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = [value.name, value.version].filter((part) => typeof part === "string" && part.length > 0).join(" ");
  const extra = [
    typeof value.protocol === "string" ? `protocol ${value.protocol}` : "",
    Array.isArray(value.capabilities) && value.capabilities.length > 0 ? `supports ${value.capabilities.join(", ")}` : "",
  ].filter(Boolean);
  const text = [name, ...extra].filter(Boolean).join(" · ");
  return text.length > 0 ? text : undefined;
}

const SCOPE_WORDS: Record<string, string> = {
  shared: "Shared with your agents",
  kept: "Private to the agent that saved it",
};

/**
 * One presentation contract for historical and current, already-redacted events: a one-line
 * summary, labelled plain-English facts and the technical identifiers, kept apart.
 */
export function activityEvidence(entry: EvidenceEntry): ActivityEvidence {
  const safe = redact(entry.payload, () => false) as Record<string, unknown> | null;
  const payload: Record<string, unknown> = safe && typeof safe === "object" && !Array.isArray(safe) ? safe : {};
  const text = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  const facts: EvidenceLine[] = [];
  const technical: EvidenceLine[] = [];
  const ids: EvidenceLine[] = [];
  const fact = (label: string, value: string | undefined) => {
    if (value !== undefined && value.length > 0) facts.push({ label, value });
  };
  const id = (label: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) technical.push({ label, value });
    else if (typeof value === "number") technical.push({ label, value: String(value) });
  };

  const rejected = entry.kind === "tool_rejected" || entry.kind === "protocol_rejected";
  const reversal = typeof payload.undoneSeq === "number";
  const reason = text("reason");
  const rejection = entry.kind === "protocol_rejected"
    ? "Warthog couldn't read the request."
    : REJECTION_REASONS[reason] ?? (reason || "Warthog refused the request before it reached a tool.");

  // The one-line summary. An agent's reason is its own claim, never Warthog's account of what
  // happened, so a summary built from it says whose it is.
  let summary: string;
  if (rejected) summary = `Blocked before it ran: ${rejection.charAt(0).toLowerCase()}${rejection.slice(1)}`;
  else if (reversal && text("outcome")) summary = text("outcome");
  else if (text("summary")) summary = text("summary");
  else if (entry.kind === "agent_report" && reason) summary = reason;
  else if (entry.kind === "run_status" && runOf(payload.run)?.label) summary = `Changed what it says it’s working on to “${runOf(payload.run)!.label}”`;
  else if (reason && !reversal) summary = `Agent's reason: ${reason}`;
  else summary = entryTitle(entry);

  // What was asked for: the agent's request, or the sentence an approval showed you.
  if (isRecord(payload.params)) {
    const lines = fieldLines(payload.params, ids, [reason]);
    fact("What it asked for", lines.join("\n"));
  }
  fact("What it asked for", text("sentence"));
  fact("Question you asked", text("question"));

  // Warthog's own record of what it decided and what came back.
  fact("Warthog's decision", decisionLine(payload.decision, ids));
  if (isRecord(payload.resultEvidence)) fact("Result", resultLine(payload.resultEvidence, ids));
  if (reversal) {
    fact("Undoes", `Entry ${payload.undoneSeq as number}`);
    if (typeof payload.reversalTool === "string") fact("How it was undone", toolLabel(payload.reversalTool));
  }

  // Where and who. A search across inboxes names each one, and how it went when it wasn't
  // searched (docs/adr/several-accounts-per-agent.md); never their ids.
  fact("Service accounts", accountSetLine(payload.connectorAccountSet));
  if (text("connectorAccountLabel")) fact("Service account", text("connectorAccountLabel"));
  else if (text("connectorAccountId") && !isIdentifier(text("connectorAccountId"))) fact("Service account", text("connectorAccountId"));
  else if (text("connectorAccountId")) ids.push({ label: "Service account ID", value: text("connectorAccountId") });
  fact("Service", text("service"));
  fact("Account", text("account") || text("accountLabel"));
  if (payload.providerRevoked === true) fact("Service's confirmation", "The service confirmed Warthog's access was removed.");
  if (payload.providerRevoked === false) fact("Service's confirmation", "The service didn't confirm it removed Warthog's access. You can also remove it from the service's own settings.");
  fact("Agent", text("displayName"));
  fact("Platform", text("platform"));
  const conversation = runOf(payload.run);
  fact("Conversation (as the agent described it)", conversation?.label);
  if (entry.kind === "run_status") fact("Before (as the agent described it)", text("previous"));
  fact("Came through (as the app reported it)", text("via"));

  // An agent's reason (the agent's claim) — shown here only when the summary doesn't already.
  if (reason && !rejected && !summary.includes(reason)) fact(reversal ? "Your reason" : "Agent's reason", reason);

  // A card or identity release, or an amount an agent reported.
  if (typeof payload.amount === "number" && typeof payload.currency === "string") {
    fact(entry.kind === "agent_report" ? "Amount (as the agent reported it)" : "Amount", `${payload.currency} ${payload.amount.toFixed(2)}`);
  }
  if (entry.merchant) fact("Merchant", entry.merchant);
  if (text("field")) fact("Detail released", humanise(text("field")));
  fact("Purpose", text("purpose"));

  // The owner's own changes: a new agent's access, or what changed in a setting.
  if (isRecord(payload.changes)) {
    const changes = payload.changes;
    if (changes.credentialKind === "access_key") fact("How it connects", "Access key");
    if (changes.credentialKind === "oauth") fact("How it connects", "Signed in through its own app (OAuth)");
    if (isRecord(changes.grants)) fact("Access it was given", accessSentence(changes.grants));
    if (typeof changes.clientId === "string") ids.push({ label: "OAuth client ID", value: changes.clientId });
    // A renamed agent: its old name and its new one.
    if (isRecord(changes.name) && typeof changes.name.from === "string" && typeof changes.name.to === "string") {
      fact("Name", `${changes.name.from} → ${changes.name.to}`);
    }
    // The person's "what agents see" level, and which way it moved.
    if (Array.isArray(changes.fields) && changes.fields.includes("readLevel")) {
      const moved = isReadLevel(changes.from) && isReadLevel(changes.to) ? `: ${readLevelLabel(changes.from)} → ${readLevelLabel(changes.to)}` : "";
      fact("What changed", `What agents see in your email and files${moved}`);
    }
  }
  if (payload.before !== undefined || (payload.after !== undefined && entry.kind !== "rule_created")) {
    const lines = changedSettings(payload.before, payload.after);
    fact("What changed", lines.length > 0 ? lines.join("\n") : "Nothing changed");
  } else if (isRecord(payload.after)) {
    fact("Details", fieldLines(payload.after, ids).join("\n"));
  }
  fact("Skill choices", choices(payload.skillChoices));
  fact("Memory choices", choices(payload.memoryChoices));
  if (typeof payload.scope === "string") fact(entry.kind === "memory_scope_change" ? "Now" : "Who can read it", SCOPE_WORDS[payload.scope] ?? humanise(payload.scope));
  if (payload.replacedAgentOverrides === true) fact("Per-agent choices", "Any per-agent choices for this memory were replaced.");
  if (payload.contentChanged === true) fact("Content", "Its wording was changed.");
  if (typeof payload.parts === "number") fact("Items imported", String(payload.parts));
  if (isRecord(payload.client) && entry.kind === "client_observed") fact("Agent software (as it reported it)", clientLine(payload.client));

  // What an intent record is, and an older entry that kept no result.
  if (entry.kind === "tool_attempt") {
    fact("About this entry", "Warthog writes this just before a change runs. It doesn't confirm the change finished: look for the matching result entry, and check the service before repeating an unfinished change.");
  }
  if (entry.kind === "tool_call" && payload.resultEvidence === undefined && !reversal) {
    fact("Result", entry.outcome === "executed"
      ? "Done, as recorded at the time. Warthog didn't keep the service's response for this older entry."
      : `${outcomeLabel(entry.outcome ?? "unknown") || "Result unknown"}. Warthog didn't keep result details for this older entry.`);
  }

  // Technical details: the identifiers that make the entry checkable against the record.
  id("Entry number", entry.seq);
  id("Request ID", payload.requestId);
  id("Attempt ID", payload.attemptId);
  id("Conversation ID", conversation?.id);
  id("Agent's run ID", payload.reportedRunId);
  id("Approval ID", payload.approvalId);
  id("Memory ID", payload.memoryId);
  id("Rule ID", payload.ruleId);
  id("Policy version", payload.policyFingerprint);
  technical.push(...ids);
  if (isRecord(payload.client) && entry.kind !== "client_observed") id("Agent software (as it reported it)", clientLine(payload.client));
  if (typeof payload.cardRelease === "string") id("Card release reference", payload.cardRelease);
  if (typeof payload.status === "number") id("Response status", payload.status);
  if (typeof payload.durationMs === "number") id("Time taken", `${payload.durationMs} ms`);
  id("Record fingerprint", entry.entryHash);

  const detail = facts.length > 0
    ? facts.map((line) => `${line.label}: ${line.value}`).join("\n")
    : "No other details were recorded for this entry.";
  const changedBy = payload.actor === "account_owner" || OWNER_KINDS.includes(entry.kind) ? "you" as const : undefined;
  const attemptId = text("attemptId") || undefined;
  return {
    summary,
    detail,
    facts,
    technical,
    ...(changedBy ? { changedBy } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(entry.kind === "tool_attempt" ? { intent: true as const } : {}),
    ...(conversation ? { conversation } : {}),
    ...(text("via") ? { via: text("via") } : {}),
  };
}

// A stored run reference ({ id, label? }) as the conversation it names, or undefined.
function runOf(value: unknown): { id: string; label?: string } | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
  return typeof value.label === "string" && value.label !== "" ? { id: value.id, label: value.label } : { id: value.id };
}

/**
 * The rows a list shows when each change should appear once: an intent record ("Started: …")
 * is dropped when the result entry written for the same attempt is in the same list, and kept
 * otherwise (it then reads "Not confirmed"). `keep` keeps a row regardless (a disputed one).
 */
export function withoutMatchedIntents<T extends { readonly attemptId?: string; readonly intent?: true }>(
  rows: readonly T[],
  keep: (row: T) => boolean = () => false,
): T[] {
  const finished = new Set(rows.filter((row) => !row.intent && row.attemptId).map((row) => row.attemptId));
  return rows.filter((row) => !row.intent || !row.attemptId || !finished.has(row.attemptId) || keep(row));
}
