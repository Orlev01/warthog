// Review fix D5 — connector tool exposure and routing (design §6.2 "Tool list for an agent
// = Warthog core tools + the connector tools it is permitted, namespaced <connector>__<tool>";
// §7 "Connector engine"; constitution 15 "agents reach services only through Warthog").
//
// Two halves of the one job of putting a person's connected services on the MCP surface:
//
//   1. `connectorToolsetFor` — WHICH connector tools a connection is served: for every one
//      of the person's CONNECTED services that this agent is granted and that the catalogue
//      knows, either its curated tools (Gmail, Google Calendar/Drive, Outlook mail/calendar,
//      OneDrive — each with its declared read/change class and sends-a-message flag) or, for
//      a service with no curated tools, the one general request tool `<id>__request`. A
//      curated service gets NO general request tool, so an agent cannot reach it around the
//      declarations the rules engine reads (e.g. send mail through a raw POST that no
//      "sends email" rule would see).
//
//   2. `createConnectorToolExecutor` — HOW an allowed connector call is carried out, once
//      the pipeline's policy gate has passed it: the person's live connection to that service
//      is resolved member-scoped by the SESSION user id (never a client value), its
//      credentials are decrypted under the owner's DEK by the engine, and the call goes to the
//      catalogue entry's host only (`sendConnectorRequest` / the curated tool functions).
//
// A SERVER module built from injected seams (db, catalogue, fetch, the per-user DEK lookup):
// it reads no `process.env` and holds no secret (INV-103). Every input is validated at the
// boundary with zod (INV-102) and every store binds its values as parameters.

import { z } from "zod";

import { listConnectionsForUser, type Connection } from "../db/connections";
import type { Db } from "../db/index";
import { HttpError, parseParams } from "../http/validate";
import type { CatalogueIndex } from "./catalogue";
import { callGoogleTool, GOOGLE_CURATED_TOOLS, type CuratedTool } from "./curated/google";
import { callMicrosoftTool, MICROSOFT_CURATED_TOOLS } from "./curated/microsoft";
import { sendConnectorRequest } from "./request-tool";
import type { ConnectorToolDeclaration, ConnectorToolset } from "../mcp/tools/registry";

// The general request tool's verb: `<id>__request {method, path, query, body}`.
export const REQUEST_TOOL = "request";

// The `<connector>__<tool>` namespace separator (design §6.2).
const NAMESPACE = "__";

// Field caps, so a grossly oversized value is refused at the boundary (INV-102).
const MAX_REASON = 2000;
const MAX_PATH = 2048;
const MAX_BODY = 100_000;
const MAX_QUERY_KEY = 200;
const MAX_QUERY_VALUE = 2000;

const reason = z.string().max(MAX_REASON).optional();
const query = z
  .record(z.string().max(MAX_QUERY_KEY), z.string().max(MAX_QUERY_VALUE))
  .optional()
  .describe("Query-string parameters (for curated tools, also the resource id such as id or eventId).");
const body = z.string().max(MAX_BODY).optional().describe("The request body as text, usually JSON.");

// `<id>__request`'s input: the HTTP method, a path RELATIVE to the service's API (the host
// always comes from the catalogue), optional query and body, plus the universal reason.
export const connectorRequestSchema = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).describe("The HTTP method."),
  path: z.string().min(1).max(MAX_PATH).describe("The path relative to the service's API, e.g. /v1/items."),
  query,
  body,
  reason,
});

// A curated (or unknown) connector tool's input: its query and body plus the reason.
export const connectorToolSchema = z.object({ query, body, reason });

// The curated tools of every provider that has them, by connector id.
const CURATED_BY_CONNECTOR: ReadonlyMap<string, readonly CuratedTool[]> = groupByConnector([
  ...GOOGLE_CURATED_TOOLS,
  ...MICROSOFT_CURATED_TOOLS,
]);
const GOOGLE_TOOL_NAMES = new Set(GOOGLE_CURATED_TOOLS.map((tool) => tool.name));
const MICROSOFT_TOOL_NAMES = new Set(MICROSOFT_CURATED_TOOLS.map((tool) => tool.name));

function groupByConnector(tools: readonly CuratedTool[]): Map<string, CuratedTool[]> {
  const grouped = new Map<string, CuratedTool[]>();
  for (const tool of tools) {
    const bucket = grouped.get(tool.connectorId);
    if (bucket) bucket.push(tool);
    else grouped.set(tool.connectorId, [tool]);
  }
  return grouped;
}

// The recipients of an outgoing message, read from a mail tool's body so recipient rules
// can match: a Gmail `raw` MIME message (top level or under `message`) contributes its
// To/Cc/Bcc headers; an Outlook message (top level or under `message`) its to/cc/bcc
// recipient addresses. An unreadable body yields none.
export function messageRecipients(rawBody: string | undefined): string[] {
  if (rawBody === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const message of [parsed, (parsed as { message?: unknown } | null)?.message]) {
    if (message === null || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (typeof record.raw === "string") out.push(...mimeRecipients(record.raw));
    for (const key of ["toRecipients", "ccRecipients", "bccRecipients"]) {
      const list = record[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const address = (item as { emailAddress?: { address?: unknown } } | null)?.emailAddress?.address;
        if (typeof address === "string") out.push(address);
      }
    }
  }
  return out;
}

// The addresses in a base64url MIME message's To/Cc/Bcc headers (the header block ends at
// the first blank line; folded continuation lines belong to the header above them).
function mimeRecipients(raw: string): string[] {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const out: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^(to|cc|bcc):(.*)$/i.exec(line);
    if (!match) continue;
    out.push(...(match[2]!.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? []));
  }
  return out;
}

// One curated tool as the registry's declaration: its verb (the namespace is added by the
// registry), its declared class, and — for a tool that sends a message — the channel (every
// curated message tool today sends email) plus how to read its recipients.
function declarationOf(tool: CuratedTool, serviceName: string): ConnectorToolDeclaration {
  const verb = tool.name.slice(tool.connectorId.length + NAMESPACE.length);
  return {
    name: verb,
    description: `${serviceName}: ${verb.replace(/_/g, " ")} (${tool.makesChange ? "makes a change" : "reads only"}).`,
    makesChange: tool.makesChange,
    ...(tool.sendsMessage ? { messageChannel: "email" as const, recipients: messageRecipients } : {}),
  };
}

// The connector tools a connection is served: for each of the person's CONNECTED services
// that is granted to this agent and known to the catalogue, its curated tools, or the
// general request tool when it has none.
export function connectorToolsetFor(
  connections: readonly Connection[],
  grantedConnectors: readonly string[],
  catalogue: CatalogueIndex,
): ConnectorToolset {
  const toolset: Record<string, readonly ConnectorToolDeclaration[]> = {};
  for (const connection of connections) {
    const id = connection.connectorId;
    if (connection.status !== "connected" || !grantedConnectors.includes(id) || toolset[id]) continue;
    const entry = catalogue.get(id);
    if (!entry) continue;
    const curated = CURATED_BY_CONNECTOR.get(id);
    toolset[id] = curated
      ? curated.map((tool) => declarationOf(tool, entry.name))
      : [
          {
            name: REQUEST_TOOL,
            description: `Send one authenticated request to the person's ${entry.name} account (paths are relative to its API). GET and HEAD read; any other method makes a change.`,
          },
        ];
  }
  return toolset;
}

// The seams the executor runs on.
export interface ConnectorToolExecutorDeps {
  readonly db: Db;
  readonly catalogue: CatalogueIndex;
  readonly fetch: typeof fetch;
  readonly dekFor: (userId: string) => Promise<Uint8Array>;
}

// The policy-relevant identity of an allowed connector call (the pipeline's AgentCall).
export interface ConnectorCall {
  readonly connector: string;
  readonly tool: string;
  readonly params?: unknown;
}

// Carry out an allowed connector call for `userId` (the SESSION's / the verified
// connection's owner, never a client value). Refuses an unknown service or tool, and a
// service the person has no live connection to, before any credential is read or any
// request is sent.
export function createConnectorToolExecutor(
  deps: ConnectorToolExecutorDeps,
): (call: ConnectorCall, userId: string) => Promise<unknown> {
  return async function executeConnectorTool(call: ConnectorCall, userId: string): Promise<unknown> {
    const entry = deps.catalogue.get(call.connector);
    const prefix = `${call.connector}${NAMESPACE}`;
    if (!entry || !call.tool.startsWith(prefix)) {
      throw new HttpError(400, "This service tool is not available.");
    }
    const verb = call.tool.slice(prefix.length);

    // The person's live connection to this service (member-scoped by the session user).
    const connections = await listConnectionsForUser(deps.db, userId);
    const connection = connections.find(
      (candidate) => candidate.connectorId === call.connector && candidate.status === "connected",
    );
    if (!connection) {
      throw new HttpError(409, "This service is not connected.");
    }
    const dek = await deps.dekFor(userId);
    const transport = { db: deps.db, fetch: deps.fetch };

    if (verb === REQUEST_TOOL && !CURATED_BY_CONNECTOR.has(call.connector)) {
      const params = parseParams(connectorRequestSchema, call.params);
      return sendConnectorRequest(
        {
          entry,
          userId,
          connectionId: connection.id,
          dek,
          method: params.method,
          path: params.path,
          query: params.query,
          body: params.body,
        },
        transport,
      );
    }

    const params = parseParams(connectorToolSchema, call.params);
    const input = {
      tool: call.tool,
      entry,
      userId,
      connectionId: connection.id,
      dek,
      query: params.query,
      body: params.body,
    };
    if (GOOGLE_TOOL_NAMES.has(call.tool)) return callGoogleTool(input, transport);
    if (MICROSOFT_TOOL_NAMES.has(call.tool)) return callMicrosoftTool(input, transport);
    throw new HttpError(400, "This service tool is not available.");
  };
}
