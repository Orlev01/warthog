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
import { draftSubject, draftText, parseMailbox, MailComposeError, type MailDraft } from "../../../domain/content/compose-mail";
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

// Read-side protection (docs/adr/read-side-protection.md): Outlook message reads are checked
// before an agent sees them, so a request may not reach around the checked view. Graph
// accepts query options with or without their `$`, in any case, so they are normalised and
// allowlisted: a search may filter, sort and page (and always returns headers and previews,
// at most 25 a page, 10 by default); a read takes no options at all (so no `$select` can drop
// the subject the sign-in check reads, and no `$expand` can inline attachment contents). An
// id that is really a sub-path (`/$value` is the raw message source) is refused.
const OUTLOOK_MESSAGE_ID = /^[A-Za-z0-9=_+-]{1,512}$/;
export const MAX_OUTLOOK_TOP = 25;
export const DEFAULT_OUTLOOK_TOP = 10;
// A whole message (or a page of them) is read so it can be checked; agents see ~100 KB at most.
const MESSAGE_READ_BYTES = 2 * 1024 * 1024;
// The message fields a search returns: who, what, when and a preview. Read one by id for its text.
const OUTLOOK_HEADERS_ONLY = "id,conversationId,internetMessageId,subject,from,sender,toRecipients,ccRecipients,replyTo,receivedDateTime,isRead,hasAttachments,importance,bodyPreview,webLink";
const OUTLOOK_SEARCH_OPTIONS = new Set(["search", "filter", "orderby", "skip", "top", "count"]);

function outlookSearchQuery(query: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    const option = key.replace(/^\$/, "").toLowerCase();
    if (!OUTLOOK_SEARCH_OPTIONS.has(option)) continue;
    if (option === "top") {
      const top = Number.parseInt(value, 10);
      out.$top = String(Number.isFinite(top) && top > 0 ? Math.min(top, MAX_OUTLOOK_TOP) : DEFAULT_OUTLOOK_TOP);
      continue;
    }
    out[`$${option}`] = value;
  }
  return { $top: String(DEFAULT_OUTLOOK_TOP), ...out, $select: OUTLOOK_HEADERS_ONLY };
}

function outlookMessage(input: CuratedToolCallInput): { path: string; query: Record<string, string> } {
  const id = input.query?.id;
  if (id === undefined || !OUTLOOK_MESSAGE_ID.test(id)) throw new HttpError(400, "query.id must be an Outlook message id from search results.");
  return { path: `/v1.0/me/messages/${encodeURIComponent(id)}`, query: {} };
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
    resolve: (i) => ({ path: "/v1.0/me/messages", query: outlookSearchQuery(i.query) }),
  },
  {
    name: "microsoft-outlook-mail__read",
    connectorId: "microsoft-outlook-mail",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: outlookMessage,
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

  if (input.compose && (def.name === "microsoft-outlook-mail__draft" || def.name === "microsoft-outlook-mail__send")) {
    return sendComposedOutlook(def.name, input, input.compose, deps);
  }

  const { path, query } = def.resolve(input);
  // Message reads and searches are checked whole before an agent sees them (read-side
  // protection), so they may read past the agent-facing cap.
  const checkedRead = def.name === "microsoft-outlook-mail__read" || def.name === "microsoft-outlook-mail__search";
  const request = {
    entry: input.entry,
    userId: input.userId,
    connectionId: input.connectionId,
    dek: input.dek,
    method: def.method,
    path,
    query,
    body: input.body,
    contentType: "application/json" as const,
  };
  if (!checkedRead) return sendConnectorRequest(request, deps);
  const whole = await sendConnectorRequest({ ...request, maxBytes: MESSAGE_READ_BYTES }, deps);
  if (!whole.truncated) return whole;
  // Still too large to check whole: read the same message without its body.
  const headers = await sendConnectorRequest({ ...request, query: { ...query, $select: OUTLOOK_HEADERS_ONLY } }, deps);
  return { ...headers, tooLargeToCheck: true };
}

// One mailbox in Graph's shape ({ emailAddress: { name?, address } }).
function graphRecipient(mailbox: string): { emailAddress: { name?: string; address: string } } {
  const { name, address } = parseMailbox(mailbox);
  return { emailAddress: { ...(name ? { name } : {}), address } };
}

// The addresses on a Graph message, lower-cased and sorted (for comparing).
function graphAddresses(message: unknown): string[] {
  const out: string[] = [];
  for (const key of ["toRecipients", "ccRecipients", "bccRecipients"]) {
    const list = (message as Record<string, unknown> | null)?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const address = (item as { emailAddress?: { address?: unknown } } | null)?.emailAddress?.address;
      if (typeof address === "string") out.push(address.toLowerCase());
    }
  }
  return [...new Set(out)].sort();
}

function ok(result: CuratedToolResult): boolean {
  return result.status >= 200 && result.status < 300;
}

// Draft or send an email Warthog builds from the agent's plain fields. A reply is made with
// Graph's createReply (so Outlook threads it), then set to EXACTLY the approved recipients,
// subject and text, and checked before anything is sent: Graph's reply actions add the
// original sender (or its Reply-To) on their own, and the person approved a specific list.
async function sendComposedOutlook(tool: string, input: CuratedToolCallInput, compose: { draft: MailDraft; replyId?: string }, deps: CuratedToolDeps): Promise<CuratedToolResult> {
  const { draft, replyId } = compose;
  const send = tool === "microsoft-outlook-mail__send";
  let message: Record<string, unknown>;
  let approved: string[];
  try {
    const list = (mailboxes: readonly string[] | undefined) => (mailboxes ?? []).map(graphRecipient);
    const subject = draftSubject(draft);
    message = {
      ...(subject ? { subject } : {}),
      body: { contentType: "Text", content: draftText(draft) },
      toRecipients: list(draft.to),
      ccRecipients: list(draft.cc),
      bccRecipients: list(draft.bcc),
    };
    approved = graphAddresses(message);
  } catch (err) {
    if (err instanceof MailComposeError) throw new HttpError(400, err.message);
    throw err;
  }
  const request = (method: string, path: string, body?: unknown) => sendConnectorRequest({
    entry: input.entry, userId: input.userId, connectionId: input.connectionId, dek: input.dek,
    method, path, ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: "application/json" as const }),
  }, deps);

  if (!replyId) {
    return send ? request("POST", "/v1.0/me/sendMail", { message, saveToSentItems: true }) : request("POST", "/v1.0/me/messages", message);
  }
  if (!OUTLOOK_MESSAGE_ID.test(replyId)) throw new HttpError(400, "reply.id must be an Outlook message id from search or read.");
  const created = await request("POST", `/v1.0/me/messages/${encodeURIComponent(replyId)}/createReply`, {});
  if (!ok(created)) return created;
  const draftId = (JSON.parse(created.body) as { id?: unknown }).id;
  if (typeof draftId !== "string" || !OUTLOOK_MESSAGE_ID.test(draftId)) throw new HttpError(502, "Outlook didn't return the reply draft.");
  const path = `/v1.0/me/messages/${encodeURIComponent(draftId)}`;
  const updated = await request("PATCH", path, message);
  if (!ok(updated) || graphAddresses(JSON.parse(updated.body)).join(",") !== approved.join(",")) {
    await request("DELETE", path);
    throw new HttpError(502, "Outlook changed who the reply goes to, so nothing was sent.");
  }
  return send ? request("POST", `${path}/send`) : updated;
}

/** Whether the connected Outlook mailbox has ever sent mail to exactly `address` (Sent Items, exact match). */
export async function outlookHasSentTo(input: Pick<CuratedToolCallInput, "entry" | "userId" | "connectionId" | "dek">, address: string, deps: CuratedToolDeps): Promise<boolean> {
  const result = await sendConnectorRequest({
    ...input, method: "GET", path: "/v1.0/me/mailFolders/sentitems/messages",
    query: { $search: `"recipients:${address}"`, $top: "5", $select: "toRecipients,ccRecipients,bccRecipients" },
  }, deps);
  if (!ok(result)) throw new Error("sent-mail lookup failed");
  const parsed = JSON.parse(result.body) as { value?: unknown };
  return Array.isArray(parsed.value) && parsed.value.some((message) => graphAddresses(message).includes(address.toLowerCase()));
}
