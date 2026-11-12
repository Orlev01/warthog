// Recovery evidence lives outside PostgreSQL backups. Only opaque account IDs,
// event kinds and times belong here; never email addresses, keys or account data.
// A request precedes the database mutation. A completion follows its commit.
// A request without a completion is deliberately ambiguous and blocks recovery.
export interface DeletionJournal {
  requested(userId: string): Promise<void>;
  completed(userId: string): Promise<void>;
}

export interface JournalRecord {
  readonly version: 1;
  readonly userId: string;
  readonly event: "requested" | "completed";
  readonly at: string;
}

export interface JournalSnapshot {
  readonly coverageFrom: string;
  readonly capturedAt: string;
  readonly retentionDays: number;
  readonly records: readonly JournalRecord[];
}

export interface JournalWriter {
  // Atomically create if absent; never overwrite an existing marker.
  create(name: string, body: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 86_400_000;

function accountId(value: string): void {
  if (!UUID.test(value)) throw new Error("Invalid deletion journal account");
}

function instant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("Invalid deletion journal time");
  }
  return time;
}

export function createDeletionJournal(writer: JournalWriter, now = () => new Date()): DeletionJournal & { initialize(): Promise<void> } {
  async function record(userId: string, event: JournalRecord["event"]): Promise<void> {
    accountId(userId);
    const entry: JournalRecord = { version: 1, userId, event, at: now().toISOString() };
    await writer.create(`v1/${userId}/${event}.json`, JSON.stringify(entry));
  }
  return {
    // Called after exclusive production ownership and before scheduler/requests.
    // Existing markers survive restarts; never backdate coverage to an old backup.
    initialize: () => writer.create("coverage.json", JSON.stringify({ version: 1, coverageFrom: now().toISOString(), retentionDays: 42 })),
    requested: id => record(id, "requested"), completed: id => record(id, "completed"),
  };
}

export interface JournalReader {
  read(name: string): Promise<string>;
  list(prefix: string): AsyncIterable<string>;
}

// Operator-only reader, used with read access to the ORIGINAL protected container.
// The SDK iterator must follow every page. No application identity gets read/list.
export async function captureDeletionJournal(reader: JournalReader, now = () => new Date()): Promise<JournalSnapshot> {
  const capturedAt = now().toISOString();
  function object(body: string, keys: string[]): Record<string, unknown> {
    if (typeof body !== "string" || Buffer.byteLength(body) > 1024) throw new Error("Invalid deletion journal object size");
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new Error("Invalid deletion journal object fields");
    return value as Record<string, unknown>;
  }
  const header = object(await reader.read("coverage.json"), ["version", "coverageFrom", "retentionDays"]);
  if (header.version !== 1 || typeof header.coverageFrom !== "string" || header.retentionDays !== 42
      || instant(header.coverageFrom) > instant(capturedAt)) throw new Error("Invalid deletion journal coverage");
  const records: JournalRecord[] = [];
  const paths = new Set<string>();
  for await (const path of reader.list("v1/")) {
    if (paths.has(path) || paths.size >= 100_000) throw new Error("Deletion journal inventory limit or duplicate");
    paths.add(path);
    const row = object(await reader.read(path), ["version", "userId", "event", "at"]);
    if (typeof row.userId !== "string" || typeof row.at !== "string" || row.version !== 1
        || (row.event !== "requested" && row.event !== "completed")) throw new Error("Invalid deletion journal record");
    accountId(row.userId);
    if (path !== `v1/${row.userId}/${row.event}.json`) throw new Error("Deletion journal object path differs");
    if (instant(row.at) < instant(header.coverageFrom) || instant(row.at) > instant(capturedAt)) {
      throw new Error("Journal changed during capture or predates coverage; keep recovery closed");
    }
    records.push(row as unknown as JournalRecord);
  }
  return { coverageFrom: header.coverageFrom, capturedAt, retentionDays: 42, records };
}

// This plan is only valid after the operator has stopped all application writers
// and read the ORIGINAL journal, not a restored copy. The executable recovery
// boundary must independently verify the isolated destination and stopped writers.
// A successful plan is not authorization to reopen production traffic.
export function planDeletionReconciliation(
  snapshot: JournalSnapshot, restorePoint: Date, now: Date,
): string[] {
  const start = instant(snapshot.coverageFrom), captured = instant(snapshot.capturedAt);
  const point = restorePoint.getTime(), current = now.getTime();
  if (!Number.isFinite(point) || !Number.isFinite(current)
      || !Number.isInteger(snapshot.retentionDays) || snapshot.retentionDays < 42
      || point < start || point > captured || captured > current || current - captured > 300_000
      || current - point > Math.min(35, snapshot.retentionDays - 7) * DAY) {
    throw new Error("Deletion journal does not cover this restore point with fresh evidence");
  }
  const requests = new Map<string, number>(), completions = new Map<string, number>();
  for (const row of snapshot.records) {
    accountId(row.userId);
    const at = instant(row.at);
    if (row.version !== 1 || !["requested", "completed"].includes(row.event)
        || at < start || at > captured) throw new Error("Invalid deletion journal record");
    const target = row.event === "requested" ? requests : completions;
    if (target.has(row.userId)) throw new Error("Duplicate deletion journal record");
    target.set(row.userId, at);
  }
  for (const [id, time] of requests) {
    const done = completions.get(id);
    if (done === undefined) throw new Error("Unresolved deletion intent: recovery must remain closed");
    if (done < time) throw new Error("Deletion completion precedes its request");
  }
  for (const id of completions.keys()) {
    if (!requests.has(id)) throw new Error("Missing deletion request: recovery must remain closed");
  }
  return [...completions.keys()].sort();
}
