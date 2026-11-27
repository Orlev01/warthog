// A held call as an MCP task (the Tasks extension, `io.modelcontextprotocol/tasks`, protocol
// 2026-07-28; docs/adr/approval-continuation.md). A client that declares the extension on a
// request gets a task for a call Warthog holds for the person's approval, instead of
// `pending_approval`. The client then polls `tasks/get` itself until the person decides, and
// hands the result to its model, so the agent carries on even after its reply ended.
//
// The task id IS the approval id: an unguessable UUID, read back only for the person and agent
// that made the request, exactly as check_approval reads it. Nothing new is stored. Approval
// still happens only in Warthog's signed-in app, and the held call still runs once.
//
// Pure: no DB, no fetch, no process.env. The composition root (./compose.ts) registers the
// task methods and maps each outcome to the tool result the agent reads.

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

// How often the client is asked to poll (advisory). The person decides in seconds to minutes.
export const TASK_POLL_INTERVAL_MS = 5_000;

// What a working task says while the person hasn't decided; the client may show it.
export const WAITING_MESSAGE = "Waiting for the person to approve this in Warthog.";

// The task methods, and the one result each JSON-RPC error carries (the spec's own wording).
export const TASK_METHODS = ["tasks/get", "tasks/update", "tasks/cancel"] as const;
export const TASK_NOT_FOUND = "Failed to retrieve task: Task not found";

// The capability a client must declare to be given a task or to read one (`-32021`'s data).
export const TASKS_REQUIRED = { extensions: { [TASKS_EXTENSION]: {} } };

// Whether the request's own envelope declares the Tasks extension. The spec: a server MUST
// NOT return a task to a client that did not include it on that request.
export function declaresTasks(envelope: unknown): boolean {
  const capabilities = record(record(envelope)[CLIENT_CAPABILITIES]);
  const extension = record(capabilities.extensions)[TASKS_EXTENSION];
  return extension !== null && typeof extension === "object" && !Array.isArray(extension);
}

interface TaskFields {
  readonly taskId: string;
  readonly status: "working" | "completed";
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  // From creation; null is unlimited. Approvals are kept, and every one ends (decided, or
  // expired at its own time), so the task is never discarded.
  readonly ttlMs: null;
  readonly pollIntervalMs: number;
}

// The task a held call answers with. `content: []` keeps it a valid tool result for the SDK;
// a client reads `resultType` first.
export function createdTask(approvalId: string, now: Date): TaskFields & { resultType: "task"; content: [] } {
  const at = now.toISOString();
  return { resultType: "task", taskId: approvalId, status: "working", statusMessage: WAITING_MESSAGE, createdAt: at, lastUpdatedAt: at, ttlMs: null, pollIntervalMs: TASK_POLL_INTERVAL_MS, content: [] };
}

// A task as `tasks/get` reports it: still working, or completed with the tool result the agent
// reads. A refusal is `completed` with an error result: the spec keeps `failed` for protocol
// errors, never a tool result with `isError`.
export function taskOf(
  approval: { readonly id: string; readonly createdAt: Date; readonly decidedAt?: Date },
  result: Record<string, unknown> | null,
): TaskFields & { result?: Record<string, unknown> } {
  const base = {
    taskId: approval.id,
    createdAt: approval.createdAt.toISOString(),
    lastUpdatedAt: (approval.decidedAt ?? approval.createdAt).toISOString(),
    ttlMs: null,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  };
  return result === null
    ? { ...base, status: "working", statusMessage: WAITING_MESSAGE }
    : { ...base, status: "completed", result };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
