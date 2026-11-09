// E09-S10 — Curated Google tools (design §7 "Connector engine": "Curated tools
// (declared reads/changes + reversal + 'sends a message' flag): Gmail (search, read,
// draft, send), Google Calendar (list, create↔delete, update), Google Drive (search,
// read text, metadata)").
//
// The most-used Google services get CLEAR curated tools. Each tool DECLARES whether it
// reads or makes a change (so a change follows the agent's change-making setting), a
// reversal link (create event is undone by delete event) the Undo flow reads, and a
// "sends a message" flag the rules engine reads. Only Gmail send + draft send a message;
// only create-event carries a reversal (YAGNI — just the one the task asks for).
//
// A tool reaches Google ONLY through the person's Google OAuth connection: the stored
// Bearer access token is presented to the entry's HOST (`base_url`, never a caller value)
// at the tool's endpoint, with a READ method (GET) for a read tool and a CHANGE method
// (POST/PATCH/DELETE) for a change tool. The transport — member-scoped credential read,
// host resolution, Bearer presentation, 20 s timeout and ~100 KB truncation — is the
// connector engine's own `sendConnectorRequest` (E09-S09), reused rather than
// re-implemented (one-source-of-truth). This module adds only the curated DECLARATIONS,
// the per-tool endpoint, and the connection-status gate on top.
//
// A connection that needs reconnecting is REFUSED with NO request; a connection that is
// not the session user's is refused with no request (`getConnectionById` is member-scoped
// by the session `userId`, bound as a parameter — INV-102); an unknown tool name is
// refused before any lookup or request. The DB and HTTP fetch are injected seams, so this
// module reads no `process.env` and holds no ambient secret (INV-103).

import type { CatalogueEntry } from "../../../domain/catalogue/schema";
import { getConnectionById } from "../../db/connections";
import type { Db } from "../../db/index";
import { HttpError } from "../../http/validate";
import { sendConnectorRequest } from "../request-tool";

// One curated tool's declaration. The rules engine and the Undo flow read these.
export interface CuratedTool {
  // "<connectorId>__<verb>" (matches the `<id>__request` convention): e.g.
  // "google-calendar__create".
  readonly name: string;
  // "google-gmail" | "google-calendar" | "google-drive".
  readonly connectorId: string;
  // false = a read; true = makes a change (follows the agent's change-making setting).
  readonly makesChange: boolean;
  // the "sends a message" flag the rules engine reads.
  readonly sendsMessage: boolean;
  // the curated tool that undoes this one (create → delete), when one is declared.
  readonly reversalTool?: string;
}

// The injected seams: the parameterizing data access (member-scoped reads) and the HTTP
// fetch (SSRF-guarded in production, recorded in tests).
export interface CuratedToolDeps {
  readonly db: Db;
  readonly fetch: typeof fetch;
}

// What one curated-tool call needs. The HOST (base_url) comes from `entry`, never a
// caller; `userId` is always the session's id (never a client value); `connectionId`
// names which OWNED Google connection's token to present.
export interface CuratedToolCallInput {
  readonly tool: string;
  readonly entry: CatalogueEntry;
  readonly userId: string;
  readonly connectionId: string;
  readonly dek: Uint8Array;
  readonly query?: Record<string, string>;
  readonly body?: string;
}

// The upstream status and body (truncated to ~100 KB by the transport), passed back.
export interface CuratedToolResult {
  readonly status: number;
  readonly body: string;
  readonly truncated: boolean;
}

// The internal richer declaration: the public fields plus how the tool is dispatched —
// its HTTP method and the relative endpoint (+ forwarded query) it resolves to. The host
// is NEVER part of this; it comes only from the entry's `base_url`.
interface CuratedToolDef extends CuratedTool {
  readonly method: string;
  readonly resolve: (input: CuratedToolCallInput) => { path: string; query?: Record<string, string> };
}

// Build a resolver that takes a resource id from `query[key]`, URL-encodes it into the
// path, and forwards the remaining query params (plus any fixed `extra`, e.g. alt=media).
function byId(
  prefix: string,
  key: string,
  extra?: Record<string, string>,
): CuratedToolDef["resolve"] {
  return (input) => {
    const { [key]: id, ...rest } = input.query ?? {};
    return {
      path: `${prefix}/${encodeURIComponent(id ?? "")}`,
      query: { ...rest, ...(extra ?? {}) },
    };
  };
}

// The exact curated tool set this task adds (design §7). Read tools use GET; change tools
// use the matching REST verb (POST to create, PATCH to update, DELETE to delete).
const CURATED_DEFS: readonly CuratedToolDef[] = [
  // Gmail — search / read are reads; draft / send make changes AND send a message.
  {
    name: "google-gmail__search",
    connectorId: "google-gmail",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: (i) => ({ path: "/gmail/v1/users/me/messages", query: i.query }),
  },
  {
    name: "google-gmail__read",
    connectorId: "google-gmail",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: byId("/gmail/v1/users/me/messages", "id"),
  },
  {
    name: "google-gmail__draft",
    connectorId: "google-gmail",
    makesChange: true,
    sendsMessage: true,
    method: "POST",
    resolve: () => ({ path: "/gmail/v1/users/me/drafts" }),
  },
  {
    name: "google-gmail__send",
    connectorId: "google-gmail",
    makesChange: true,
    sendsMessage: true,
    method: "POST",
    resolve: () => ({ path: "/gmail/v1/users/me/messages/send" }),
  },
  // Google Calendar — list is a read; create / delete / update make changes; create is
  // undone by delete.
  {
    name: "google-calendar__list",
    connectorId: "google-calendar",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: (i) => ({ path: "/calendar/v3/calendars/primary/events", query: i.query }),
  },
  {
    name: "google-calendar__create",
    connectorId: "google-calendar",
    makesChange: true,
    sendsMessage: false,
    reversalTool: "google-calendar__delete",
    method: "POST",
    resolve: () => ({ path: "/calendar/v3/calendars/primary/events" }),
  },
  {
    name: "google-calendar__delete",
    connectorId: "google-calendar",
    makesChange: true,
    sendsMessage: false,
    method: "DELETE",
    resolve: byId("/calendar/v3/calendars/primary/events", "eventId"),
  },
  {
    name: "google-calendar__update",
    connectorId: "google-calendar",
    makesChange: true,
    sendsMessage: false,
    method: "PATCH",
    resolve: byId("/calendar/v3/calendars/primary/events", "eventId"),
  },
  // Google Drive — all three are reads.
  {
    name: "google-drive__search",
    connectorId: "google-drive",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: (i) => ({ path: "/drive/v3/files", query: i.query }),
  },
  {
    name: "google-drive__read_text",
    connectorId: "google-drive",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: byId("/drive/v3/files", "fileId", { alt: "media" }),
  },
  {
    name: "google-drive__metadata",
    connectorId: "google-drive",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: byId("/drive/v3/files", "fileId"),
  },
];

// The curated Google tool declarations (the public view the rules engine and Undo flow
// read). Same objects as the internal defs, narrowed to the declaration surface.
export const GOOGLE_CURATED_TOOLS: readonly CuratedTool[] = CURATED_DEFS;

const TOOLS_BY_NAME: ReadonlyMap<string, CuratedToolDef> = new Map(
  CURATED_DEFS.map((t) => [t.name, t]),
);

// Call one curated Google tool through the person's Google OAuth connection.
//   • An UNKNOWN tool name is refused before any lookup or request.
//   • The OWNED connection is resolved member-scoped by `userId` (the session's id, bound
//     as a parameter); a connection that is not the session user's is refused — no request.
//   • A connection whose status is not "connected" (it needs reconnecting) is refused — no
//     request.
//   • For a "connected" connection, the stored Bearer access token is presented to the
//     entry's host at the tool's endpoint with a read method for a read tool and a change
//     method for a change tool, and the upstream status + body are returned.
export async function callGoogleTool(
  input: CuratedToolCallInput,
  deps: CuratedToolDeps,
): Promise<CuratedToolResult> {
  const def = TOOLS_BY_NAME.get(input.tool);
  if (!def) {
    throw new HttpError(400, "unknown curated tool");
  }

  // Member-scoped status + ownership read: `userId` is the session's id, bound as a
  // parameter. A connection that is not this person's resolves null → refuse, send nothing.
  const connection = await getConnectionById(deps.db, input.userId, input.connectionId);
  if (!connection) {
    throw new HttpError(404, "connection not found");
  }
  if (connection.status !== "connected") {
    // A failed refresh leaves the connection needing the person to reconnect it (design
    // §7) — refuse the tool with NO upstream request.
    throw new HttpError(409, "connection needs reconnecting");
  }

  const { path, query } = def.resolve(input);
  return sendConnectorRequest(
    {
      entry: input.entry,
      userId: input.userId,
      connectionId: input.connectionId,
      dek: input.dek,
      method: def.method,
      path,
      query,
      body: input.body,
      contentType: "application/json",
    },
    deps,
  );
}
