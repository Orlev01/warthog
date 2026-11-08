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

/**
 * The headline an entry reads as: an agent call is titled by the tool it used ("Save a
 * memory"); every other entry (a connection change, a release, an approval decision) by
 * its kind, which already says what happened.
 */
export function entryTitle(entry: { readonly kind: string; readonly tool?: string }): string {
  if (entry.kind === "tool_call" && entry.tool) return toolLabel(entry.tool);
  return humanise(entry.kind);
}

// How much of an unknown id is shown, so two unknown agents can still be told apart
// without a raw uuid on the screen.
const SHORT_ID = 8;

/**
 * The agent an entry names, by the name the person gave it (`names` holds the person's
 * own agents, keyed by agent id and connection id). An entry with no agent names none; an
 * id with no agent of theirs behind it reads as "Unknown agent", never as the raw id.
 */
export function agentLabel(names: ReadonlyMap<string, string>, id: string | undefined): string | undefined {
  if (id === undefined || id === "") return undefined;
  return names.get(id) ?? `Unknown agent (${id.slice(0, SHORT_ID)})`;
}
