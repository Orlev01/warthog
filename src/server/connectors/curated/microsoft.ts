// E09-S11 — Curated Microsoft tools (design §7 "Connector engine": "Curated tools
// (declared reads/changes + reversal + 'sends a message' flag)"). Microsoft is the second
// founder-registered provider and gets the same curated coverage as Google (E09-S10):
// Outlook mail (search, read, draft, send), Outlook calendar (list, create↔delete, update)
// and OneDrive (search, read).
//
// Each tool DECLARES whether it reads or makes a change (so a change follows the agent's
// change-making setting), a reversal link (create event is undone by delete event) the Undo
// flow reads, and a "sends a message" flag the rules engine reads. Only Outlook mail send +
// draft send a message; only create-event carries a reversal (YAGNI — just the one the task
// asks for).
//
// A tool reaches Microsoft ONLY through the person's Microsoft OAuth connection: the stored
// Bearer access token is presented to the entry's HOST (`base_url`, never a caller value) at
// the tool's endpoint, with a READ method (GET) for a read tool and a CHANGE method
// (POST/PATCH/DELETE) for a change tool. All three Microsoft services sit on the shared
// Microsoft Graph host; the base_url's path prefix (`/v1.0`) is carried in each tool's
// endpoint here, so the request lands on the right Graph resource while the HOST stays the
// entry's. The transport — member-scoped credential read, host resolution, Bearer
// presentation, 20 s timeout and ~100 KB truncation — is the connector engine's own
// `sendConnectorRequest` (E09-S09), reused rather than re-implemented (one-source-of-truth).
// This module adds only the curated DECLARATIONS, the per-tool endpoint, and the
// connection-status gate on top.
//
// A connection that needs reconnecting is REFUSED with NO request; a connection that is not
// the session user's is refused with no request (`getConnectionById` is member-scoped by the
// session `userId`, bound as a parameter — INV-102); an unknown tool name is refused before
// any lookup or request. The DB and HTTP fetch are injected seams, so this module reads no
// `process.env` and holds no ambient secret (INV-103). The shared `Curated*` declaration
// types are the SAME facts the sibling `./google` module already defines, so they are
// imported (and re-exported) from there rather than redeclared (one-source-of-truth).

import { getConnectionById } from "../../db/connections";
import { HttpError } from "../../http/validate";
import { sendConnectorRequest } from "../request-tool";
import type {
  CuratedTool,
  CuratedToolCallInput,
  CuratedToolDeps,
  CuratedToolResult,
} from "./google";

export type {
  CuratedTool,
  CuratedToolCallInput,
  CuratedToolDeps,
  CuratedToolResult,
} from "./google";

// The internal richer declaration: the public fields plus how the tool is dispatched — its
// HTTP method and the relative endpoint (+ forwarded query) it resolves to. The host is
// NEVER part of this; it comes only from the entry's `base_url`.
interface CuratedToolDef extends CuratedTool {
  readonly method: string;
  readonly resolve: (input: CuratedToolCallInput) => { path: string; query?: Record<string, string> };
}

// Build a resolver that takes a resource id from `query[key]`, URL-encodes it into the path,
// and forwards the remaining query params. The `/v1.0` base-path prefix is part of `prefix`.
function byId(prefix: string, key: string): CuratedToolDef["resolve"] {
  return (input) => {
    const { [key]: id, ...rest } = input.query ?? {};
    return { path: `${prefix}/${encodeURIComponent(id ?? "")}`, query: rest };
  };
}

// The exact curated tool set this task adds (design §7). Read tools use GET; change tools use
// the matching REST verb (POST to create/send, PATCH to update, DELETE to delete). Every path
// carries the Graph `/v1.0` prefix.
const CURATED_DEFS: readonly CuratedToolDef[] = [
  // Outlook mail — search / read are reads; draft / send make changes AND send a message.
  {
    name: "microsoft-outlook-mail__search",
    connectorId: "microsoft-outlook-mail",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: (i) => ({ path: "/v1.0/me/messages", query: i.query }),
  },
  {
    name: "microsoft-outlook-mail__read",
    connectorId: "microsoft-outlook-mail",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: byId("/v1.0/me/messages", "id"),
  },
  {
    name: "microsoft-outlook-mail__draft",
    connectorId: "microsoft-outlook-mail",
    makesChange: true,
    sendsMessage: true,
    method: "POST",
    resolve: () => ({ path: "/v1.0/me/messages" }),
  },
  {
    name: "microsoft-outlook-mail__send",
    connectorId: "microsoft-outlook-mail",
    makesChange: true,
    sendsMessage: true,
    method: "POST",
    resolve: () => ({ path: "/v1.0/me/sendMail" }),
  },
  // Outlook calendar — list is a read; create / delete / update make changes; create is
  // undone by delete.
  {
    name: "microsoft-outlook-calendar__list",
    connectorId: "microsoft-outlook-calendar",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: (i) => ({ path: "/v1.0/me/events", query: i.query }),
  },
  {
    name: "microsoft-outlook-calendar__create",
    connectorId: "microsoft-outlook-calendar",
    makesChange: true,
    sendsMessage: false,
    reversalTool: "microsoft-outlook-calendar__delete",
    method: "POST",
    resolve: () => ({ path: "/v1.0/me/events" }),
  },
  {
    name: "microsoft-outlook-calendar__delete",
    connectorId: "microsoft-outlook-calendar",
    makesChange: true,
    sendsMessage: false,
    method: "DELETE",
    resolve: byId("/v1.0/me/events", "eventId"),
  },
  {
    name: "microsoft-outlook-calendar__update",
    connectorId: "microsoft-outlook-calendar",
    makesChange: true,
    sendsMessage: false,
    method: "PATCH",
    resolve: byId("/v1.0/me/events", "eventId"),
  },
  // OneDrive — both are reads: search by text, read one drive item.
  {
    name: "microsoft-onedrive__search",
    connectorId: "microsoft-onedrive",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: (i) => {
      const { q, ...rest } = i.query ?? {};
      return { path: `/v1.0/me/drive/root/search(q='${encodeURIComponent(q ?? "")}')`, query: rest };
    },
  },
  {
    name: "microsoft-onedrive__read",
    connectorId: "microsoft-onedrive",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: byId("/v1.0/me/drive/items", "itemId"),
  },
];

// The curated Microsoft tool declarations (the public view the rules engine and Undo flow
// read). Same objects as the internal defs, narrowed to the declaration surface.
export const MICROSOFT_CURATED_TOOLS: readonly CuratedTool[] = CURATED_DEFS;

const TOOLS_BY_NAME: ReadonlyMap<string, CuratedToolDef> = new Map(
  CURATED_DEFS.map((t) => [t.name, t]),
);

// Call one curated Microsoft tool through the person's Microsoft OAuth connection.
//   • An UNKNOWN tool name is refused before any lookup or request.
//   • The OWNED connection is resolved member-scoped by `userId` (the session's id, bound as
//     a parameter); a connection that is not the session user's is refused — no request.
//   • A connection whose status is not "connected" (it needs reconnecting) is refused — no
//     request.
//   • For a "connected" connection, the stored Bearer access token is presented to the
//     entry's host at the tool's endpoint with a read method for a read tool and a change
//     method for a change tool, and the upstream status + body are returned.
export async function callMicrosoftTool(
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
    // A failed refresh leaves the connection needing the person to reconnect it (design §7)
    // — refuse the tool with NO upstream request.
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
