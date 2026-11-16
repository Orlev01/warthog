import { AsyncLocalStorage } from "node:async_hooks";
import { encrypt, decrypt } from "../crypto/envelope";
import { withTransaction, type Db } from "../db/index";
import type { AgentConnection } from "./context";
import type { ActivityRecorder } from "../activity/recorder";
import type { RunRef } from "../agents/runs";

export interface ClientObservation {
  name?: string;
  version?: string;
  protocol?: string;
  capabilities?: string[];
  source: "client_reported";
}
// One MCP request's context. `agentId` is the verified connection's agent. `via` is the
// product the request came through, as the client reported it (`clientSurface`). `run` is
// set once the call names a run Warthog issued to that agent, or when get_context starts
// one (docs/adr/agent-runs.md); entries recorded during the request are linked to it.
export interface RequestObservation { requestId: string; body: unknown; client?: ClientObservation; reportedRunId?: string; boundaryRecorded?: boolean; agentId?: string; via?: string; run?: RunRef }
export const requestObservation = new AsyncLocalStorage<RequestObservation>();
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const bounded = (v: unknown, max = 120): string | undefined => typeof v === "string" && v.length <= max ? v.replace(/[\u0000-\u001f]/g, "") : undefined;

/** Read only documented protocol metadata, not arbitrary headers, prompts or tokens. */
export function clientObservation(body: unknown, headers: Headers): ClientObservation | undefined {
  const message = object(body), params = object(message.params), meta = object(message._meta);
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

/**
 * The client's own name from a 2026-07-28 request envelope, which carries it in
 * `params._meta` on every request (measured 16 Nov 2026), or from a 2025 initialize. Used
 * only to say which product a request came through (docs/adr/agent-runs.md).
 */
export function envelopeClientName(body: unknown): string | undefined {
  const message = object(body), params = object(message.params);
  const info = object(message.method === "initialize" ? params.clientInfo : object(params._meta)["io.modelcontextprotocol/clientInfo"]);
  return bounded(info.name);
}

export async function readClientObservation(db: Db, userId: string, agentId: string, dek: Uint8Array): Promise<(ClientObservation & { observedAt: string }) | null> {
  const row = (await db.query("SELECT client_observation_ct FROM agents WHERE user_id = $1 AND id = $2", [userId, agentId])).rows[0];
  if (!row?.client_observation_ct) return null;
  return JSON.parse(await decrypt(dek, "agents", "client_observation_ct", agentId, String(row.client_observation_ct)));
}

export async function rememberClient(db: Db, connection: AgentConnection, client: ClientObservation, observedAt: string, dek: Uint8Array, recorder: ActivityRecorder): Promise<void> {
  await withTransaction(db, async tx => {
  await tx.query("SELECT id FROM agents WHERE user_id=$1 AND id=$2 FOR UPDATE", [connection.userId, connection.agentId]);
  const previous = await readClientObservation(tx, connection.userId, connection.agentId, dek);
  const comparable = previous ? { ...previous, observedAt: undefined } : null;
  let safe: unknown = client;
  if (JSON.stringify(comparable) !== JSON.stringify(client)) {
    const entry = await (recorder.forTransaction?.(tx, async () => dek) ?? recorder).record({ userId: connection.userId, agentId: connection.agentId, kind: "client_observed", source: "warthog", outcome: "reported", payload: { summary: "Client information reported", client } });
    safe = (entry.payload as { client: unknown }).client;
  } else safe = comparable;
  const ct = await encrypt(dek, "agents", "client_observation_ct", connection.agentId, JSON.stringify({ ...object(safe), observedAt }));
  await tx.query("UPDATE agents SET client_observation_ct = $3 WHERE user_id = $1 AND id = $2", [connection.userId, connection.agentId, ct]);
  });
}
