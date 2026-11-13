// What an activity entry reads as on the Activity page and the Home feed (review fix
// W2.1; brief "Activity feed": a timeline a person can read). An entry stores codes — its
// kind ("tool_call"), its tool ("search_memory", "google_calendar__create_event") and the
// id of the agent that acted — and the screens show plain words: what the agent did, and
// the name the person gave that agent.
//
// Pure domain module: no React, no DB, no clock. The agent names come from the caller (the
// person's own agents, read member-scoped), so this module never decides who is whose.

// Warthog's own core tools in plain words, as a person reads them on the timeline.
const CORE_TOOL_LABELS: Record<string, string> = {
  get_context: "Read its context",
  get_skill: "Read a skill",
  request_identity_detail: "Ask for an identity detail",
  request_card: "Ask to use a card",
  check_approval: "Check on an approval",
  collect_release: "Collect a released detail",
  remember: "Save a memory",
  search_memory: "Search memory",
  list_tasks: "List tasks",
  create_task: "Add a task",
  update_task: "Update a task",
  complete_task: "Mark a task done",
  list_records: "List records",
  save_record: "Save a record",
  update_record: "Update a record",
  log_activity: "Add a note to activity",
  find_tools: "Find tools",
  call_tool: "Use a tool",
};

// A connected service's tool is namespaced `<connector>__<tool>` (design §6.2); the
// service is shown on its own, so the label is the tool part alone.
const NAMESPACE = "__";

/** A stored code in words: "create_event" → "Create event", "pending_approval" → "Pending approval". */
export function humanise(code: string): string {
  const spaced = code.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A tool's plain name: "remember" → "Save a memory", "gmail__send" → "Send". */
export function toolLabel(tool: string): string {
  const core = CORE_TOOL_LABELS[tool];
  if (core) return core;
  const at = tool.indexOf(NAMESPACE);
  return humanise(at >= 0 ? tool.slice(at + NAMESPACE.length) : tool);
}

// What each recorded kind is, in words, for entry titles, the Event filter and its chip. A
// kind not listed reads as its tidied code.
const KIND_LABELS: Record<string, string> = {
  tool_call: "Agent request",
  tool_attempt: "Change started",
  tool_rejected: "Request blocked",
  protocol_rejected: "Request couldn't be read",
  agent_report: "Agent report",
  client_observed: "Client details reported",
  approval_decision: "Approval decision",
  card_release: "Card release",
  identity_release: "Identity detail release",
  agent_connected: "Agent connected",
  agent_key_revoked: "Access key revoked",
  agent_key_replaced: "Access key replaced",
  connection_change: "Connection change",
  permission_change: "Permission change",
  agent_defaults_change: "Agent defaults change",
  skill_access_change: "Skill access change",
  memory_scope_change: "Memory sharing change",
  rule_created: "Rule created",
  rule_updated: "Rule updated",
  rule_paused: "Rule paused",
  rule_deleted: "Rule deleted",
  approval_expiry_change: "Approval expiry change",
  memory_created: "Memory added",
  memory_updated: "Memory edited",
  memory_deleted: "Memory deleted",
  account_imported: "Account import",
  account_recovered: "Account recovered",
};

/** A recorded kind in words: "tool_call" → "Agent request". */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? humanise(kind);
}

// A connection change says what happened to it ("Service connected"); an agent's own
// disconnection names the agent instead of a service.
const CONNECTION_TITLES: Record<string, string> = {
  connected: "Service connected",
  reconnected: "Service reconnected",
  disconnected: "Service disconnected",
};

/**
 * The headline an entry reads as: an agent call is titled by the tool it used ("Save a
 * memory"); every other entry (a connection change, a release, an approval decision) by its
 * kind's label ("Access key replaced"), which already says what happened. The intent record
 * written just before a change runs reads "Started: <tool>"; its result is its own entry.
 */
export function entryTitle(entry: {
  readonly kind: string;
  readonly tool?: string;
  readonly outcome?: string;
  readonly agentId?: string;
  readonly connectorId?: string;
}): string {
  if (entry.kind === "tool_call" && entry.tool) return toolLabel(entry.tool);
  if (entry.kind === "tool_attempt" && entry.tool) return `Started: ${toolLabel(entry.tool)}`;
  if (entry.kind === "connection_change" && entry.outcome) {
    if (entry.outcome === "disconnected" && entry.agentId && !entry.connectorId) return "Agent disconnected";
    const title = CONNECTION_TITLES[entry.outcome];
    if (title) return title;
  }
  return kindLabel(entry.kind);
}

/**
 * The agent an entry names, by the name the person gave it (`names` holds the person's
 * own agents, keyed by agent id and connection id). An entry with no agent names none; an
 * id with no agent of theirs behind it reads as "Removed agent", never as the raw id or a
 * fragment of it (content-53).
 */
export function agentLabel(names: ReadonlyMap<string, string>, id: string | undefined): string | undefined {
  if (id === undefined || id === "") return undefined;
  return names.get(id) ?? "Removed agent";
}
