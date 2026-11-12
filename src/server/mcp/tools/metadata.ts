// MCP hints describe effects to clients; they never grant access or replace the
// server's policy pipeline. In particular, a polling/wrapper tool can execute a
// held write even when its internal policy classification is a read.
export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

function read(title: string): ToolAnnotations {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function change(title: string, destructiveHint = false, openWorldHint = false): ToolAnnotations {
  return { title, readOnlyHint: false, destructiveHint, idempotentHint: false, openWorldHint };
}

const CORE: Readonly<Record<string, ToolAnnotations>> = {
  get_context: read("Get granted context"),
  get_skill: read("Read a skill"),
  search_memory: read("Search memory"),
  list_tasks: read("List tasks"),
  list_records: read("List life-admin records"),
  remember: change("Save a memory"),
  create_task: change("Create a task"),
  update_task: change("Update a task", true),
  complete_task: change("Complete a task", true),
  save_record: change("Create a life-admin record"),
  update_record: change("Update a life-admin record", true),
  log_activity: change("Record agent-reported activity"),
  // These create an approval and can notify the person; they are not pure reads.
  request_identity_detail: change("Request protected identity details", false, true),
  request_card: change("Request card details for a purchase", false, true),
  // Polling can execute any approved held action, including sending a message.
  check_approval: change("Check approval and execute the approved request", true, true),
  // Collection consumes a single-use release, so retry is not a repeatable read.
  collect_release: change("Collect approved sensitive details once", true),
  find_tools: read("Find permitted service tools"),
  call_tool: change("Call a permitted service tool", true, true),
};

export function coreToolMetadata(name: string) {
  const annotations = CORE[name];
  if (!annotations) throw new Error(`Missing MCP effect metadata for ${name}`);
  return { title: annotations.title, annotations: { ...annotations } };
}

export function connectorToolMetadata(title: string, readOnly: boolean) {
  return {
    title,
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: true,
    } satisfies ToolAnnotations,
  };
}
