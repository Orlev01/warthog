import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { encrypt, decrypt } from "../crypto/envelope";
import { withTransaction, type Db } from "../db/index";
import type { AgentConnection } from "./context";
import type { ActivityRecorder } from "../activity/recorder";
import type { RunRef } from "../agents/runs";
import { redact } from "../../domain/redaction/redact";
import { releasedValueMatcher } from "../crypto/hmac";
import { lookupForUser } from "../db/release-fingerprints";
import { fixedClock } from "../seams/clock";

export interface ClientObservation {
  name?: string;
  version?: string;
  protocol?: string;
  capabilities?: string[];
  source: "client_reported";
}
// One app report as the agent's record keeps it, with when it was last seen.
export interface SeenClient extends ClientObservation { observedAt: string }
// The agent's record: the latest report at the top level (the shape older releases read),
// and `seen`, the distinct reports of its recent apps, latest first.
export interface StoredClientObservation extends SeenClient { seen: SeenClient[] }
// One MCP request's context. `agentId` is the verified connection's agent. `via` is the
// product the request came through, as the client reported it (`clientSurface`). `run` is
// set once the call names a run Warthog issued to that agent, or when get_context starts
// one (docs/adr/agent-runs.md); entries recorded during the request are linked to it.
// The dispatch checks a tool call against its agent's request limit before anything else:
// `rateCounted` says it was counted and is within the limit (the pipeline doesn't count it
// again), and `overLimit` names the connection whose call is over it (the per-request server
// then only refuses it).
// `signal` is the tool call's own cancellation (its stream closed), for a tool that waits.
export interface RequestObservation { requestId: string; body: unknown; client?: ClientObservation; reportedRunId?: string; boundaryRecorded?: boolean; agentId?: string; via?: string; run?: RunRef; rateCounted?: boolean; overLimit?: AgentConnection; signal?: AbortSignal }
export const requestObservation = new AsyncLocalStorage<RequestObservation>();
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const bounded = (v: unknown, max = 120): string | undefined => typeof v === "string" && v.length <= max ? v.replace(/[\u0000-\u001f]/g, "") : undefined;

// How many distinct app reports one agent's record keeps. One connection is often used from
// several apps (the claude.ai connector reports four: Claude Code, claude.ai chats and two of
// claude.ai's own checks), so a switch between them is not news.
export const RECENT_CLIENTS = 8;
// An unchanged report is written again at most this often, so "last seen" stays roughly
// current without a database write and a key unwrap on every request.
export const CLIENT_REFRESH_MS = 10 * 60_000;
// After a failure to remember a report, the next try waits this long.
export const CLIENT_RETRY_MS = 60_000;
// The most agents one dispatch keeps write times for.
const MAX_TRACKED_AGENTS = 1000;

// The request's `_meta`. A 2026-07-28 client sends it in `params._meta` on every request
// (measured 16 Nov 2026); a top-level `_meta` is read only when the params carry none.
function envelopeMeta(message: Record<string, unknown>): Record<string, unknown> {
  const params = object(message.params);
  return params._meta !== undefined ? object(params._meta) : object(message._meta);
}

/** Read only documented protocol metadata, not arbitrary headers, prompts or tokens. */
export function clientObservation(body: unknown, headers: Headers): ClientObservation | undefined {
  const message = object(body), params = object(message.params), meta = envelopeMeta(message);
  const legacy = message.method === "initialize";
  const info = object(legacy ? params.clientInfo : meta["io.modelcontextprotocol/clientInfo"]);
  const capabilities = object(legacy ? params.capabilities : meta["io.modelcontextprotocol/clientCapabilities"]);
  const name = bounded(info.name), version = bounded(info.version);
  const protocol = bounded(legacy ? params.protocolVersion : meta["io.modelcontextprotocol/protocolVersion"] ?? headers.get("mcp-protocol-version"), 40);
  const keys = Object.keys(capabilities).filter(key => /^[a-zA-Z][a-zA-Z0-9_/-]{0,79}$/.test(key)).slice(0, 30).sort();
  // Routine calls commonly carry only a protocol header. It is not a new client
  // declaration and must not erase the identity reported during initialization.
  if (!legacy && !name && !version && !keys.length) return undefined;
  return name || version || protocol || keys.length ? { name, version, protocol, ...(keys.length ? { capabilities: keys } : {}), source: "client_reported" } : undefined;
}

/** The agent's own run reference from the request's `_meta` (client-reported correlation only). */
export function reportedRunId(body: unknown): string | undefined {
  const run = envelopeMeta(object(body))["app.warthog/runId"];
  return typeof run === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(run) ? run : undefined;
}

// What makes two reports the same app: its name, version, protocol and capabilities, after
// redaction with the person's released-value matcher, the redaction the stored report went
// through, so a stored report matches the report it came from.
function clientKey(client: ClientObservation, matchesReleased: (token: string) => boolean = () => false): string {
  const safe = object(redact({ name: client.name, version: client.version, protocol: client.protocol, capabilities: client.capabilities }, matchesReleased));
  return createHash("sha256").update(JSON.stringify([safe.name ?? null, safe.version ?? null, safe.protocol ?? null, safe.capabilities ?? []])).digest("hex");
}

function report(input: unknown): ClientObservation {
  const value = object(input);
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities.filter((item): item is string => typeof item === "string") : [];
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.protocol === "string" ? { protocol: value.protocol } : {}),
    ...(capabilities.length ? { capabilities } : {}),
    source: "client_reported",
  };
}

function seenClient(value: unknown): SeenClient {
  const item = object(value);
  return { ...report(value), observedAt: typeof item.observedAt === "string" ? item.observedAt : "" };
}

export async function readClientObservation(db: Db, userId: string, agentId: string, dek: Uint8Array): Promise<StoredClientObservation | null> {
  const row = (await db.query("SELECT client_observation_ct FROM agents WHERE user_id = $1 AND id = $2", [userId, agentId])).rows[0];
  if (!row?.client_observation_ct) return null;
  const stored = object(JSON.parse(await decrypt(dek, "agents", "client_observation_ct", agentId, String(row.client_observation_ct))));
  const latest = seenClient(stored);
  // A record from before `seen` holds one report: the latest.
  const seen = Array.isArray(stored.seen) ? stored.seen.map(seenClient) : [latest];
  return { ...latest, seen };
}

/**
 * Remember the app this agent's request came through. Activity records "Client information
 * reported" only for an app (or version) that is not among the agent's recent apps, so moving
 * between apps it already uses records nothing new.
 */
export async function rememberClient(db: Db, connection: AgentConnection, client: ClientObservation, observedAt: string, dek: Uint8Array, recorder: ActivityRecorder): Promise<void> {
  await withTransaction(db, async tx => {
  await tx.query("SELECT id FROM agents WHERE user_id=$1 AND id=$2 FOR UPDATE", [connection.userId, connection.agentId]);
  const matches = releasedValueMatcher(dek, await lookupForUser(tx, connection.userId, fixedClock(new Date(observedAt))));
  const keyOf = (item: ClientObservation) => clientKey(item, matches);
  const key = keyOf(client);
  const previous = await readClientObservation(tx, connection.userId, connection.agentId, dek);
  const seen = previous?.seen ?? [];
  const known = seen.find(item => keyOf(item) === key);
  let safe: ClientObservation;
  if (known) safe = report(known);
  else {
    const entry = await (recorder.forTransaction?.(tx, async () => dek) ?? recorder).record({ userId: connection.userId, agentId: connection.agentId, kind: "client_observed", source: "warthog", outcome: "reported", payload: { summary: "Client information reported", client } });
    safe = report((entry.payload as { client?: unknown }).client);
  }
  const latest: SeenClient = { ...safe, observedAt };
  const next = [latest, ...seen.filter(item => keyOf(item) !== key && keyOf(item) !== keyOf(safe))].slice(0, RECENT_CLIENTS);
  const ct = await encrypt(dek, "agents", "client_observation_ct", connection.agentId, JSON.stringify({ ...latest, seen: next }));
  await tx.query("UPDATE agents SET client_observation_ct = $3 WHERE user_id = $1 AND id = $2", [connection.userId, connection.agentId, ct]);
  });
}

/**
 * A 2026-07-28 client reports itself on every request. This remembers each agent's report
 * once per CLIENT_REFRESH_MS: a repeat inside that window, or while the same report is being
 * written, needs no database write and no key unwrap. A failure is handed to `onError`, is
 * retried after CLIENT_RETRY_MS, and never fails the agent's call.
 */
export function createClientMemory(deps: { db: Db; recorder: ActivityRecorder; onError: (err: unknown) => void; refreshMs?: number; retryMs?: number }) {
  const refreshMs = deps.refreshMs ?? CLIENT_REFRESH_MS;
  const retryMs = deps.retryMs ?? CLIENT_RETRY_MS;
  // Per agent, each report's next due time, at most RECENT_CLIENTS reports per agent, so an
  // agent that varies its report can't push other agents out.
  const due = new Map<string, Map<string, number>>();
  const writing = new Map<string, Promise<void>>();
  return async function observe(connection: AgentConnection, client: ClientObservation, now: Date, dekFor: () => Promise<Uint8Array>): Promise<void> {
    const agent = `${connection.userId}:${connection.agentId}`, key = clientKey(client), slot = `${agent}:${key}`;
    const next = due.get(agent)?.get(key);
    // A clock that stepped back past the last write counts as due.
    if (next !== undefined && now.getTime() < next && next - now.getTime() <= refreshMs) return;
    const inFlight = writing.get(slot);
    if (inFlight) return inFlight;
    const attempt = (async () => {
      let wait = refreshMs;
      try {
        await rememberClient(deps.db, connection, client, now.toISOString(), await dekFor(), deps.recorder);
      } catch (err) {
        deps.onError(err);
        wait = retryMs;
      }
      const reports = due.get(agent) ?? new Map<string, number>();
      due.delete(agent);
      due.set(agent, reports);
      reports.delete(key);
      reports.set(key, now.getTime() + wait);
      if (reports.size > RECENT_CLIENTS) reports.delete(reports.keys().next().value!);
      if (due.size > MAX_TRACKED_AGENTS) due.delete(due.keys().next().value!);
    })();
    writing.set(slot, attempt);
    try { await attempt; } finally { writing.delete(slot); }
  };
}
