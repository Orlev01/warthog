// E09-S10 — Curated Google tools (design §7 "Connector engine": "Curated tools
// (declared reads/changes + reversal + 'sends a message' flag): Gmail (search, read,
// draft, send), Google Calendar (list, create↔delete, update), Google Drive (search,
// read text, metadata)").
//
// The most-used Google services get CLEAR curated tools. Each tool DECLARES whether it
// reads or makes a change (so a change follows the agent's change-making setting), a
// reversal link (create event is undone by delete event) the Undo flow reads, and a
// "sends a message" flag the rules engine reads. Gmail send + draft both use the
// conservative message-policy gate; creating a draft does not deliver email.
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
import { buildMimeMessage, MailComposeError, type MailDraft, type ReplyTarget } from "../../../domain/content/compose-mail";

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
  // An email the agent drafted or is sending, from plain fields: Warthog builds the message
  // (docs/adr/approval-card-truth.md). `replyId` threads it under that message.
  readonly compose?: { readonly draft: MailDraft; readonly replyId?: string };
}

// The upstream status and body (truncated to ~100 KB by the transport), passed back.
// `tooLargeToCheck` marks a message Warthog could only fetch the headers of, because the
// whole message was too large to check (read-side protection).
export interface CuratedToolResult {
  readonly status: number;
  readonly body: string;
  readonly truncated: boolean;
  readonly tooLargeToCheck?: boolean;
  /** Warthog's own note on what was read (a spreadsheet's first tab only). */
  readonly note?: string;
}

// The internal richer declaration: the public fields plus how the tool is dispatched —
// its HTTP method and the relative endpoint (+ forwarded query) it resolves to. The host
// is NEVER part of this; it comes only from the entry's `base_url`.
interface CuratedToolDef extends CuratedTool {
  readonly method: string;
  readonly resolve: (input: CuratedToolCallInput) => { path: string; query?: Record<string, string> };
}

// Read-side protection (docs/adr/read-side-protection.md): a whole message must be parsed
// to be checked, so a message read may fetch up to this much; the agent still sees at most
// ~100 KB of checked text.
const MESSAGE_READ_BYTES = 2 * 1024 * 1024;

// A Gmail message or thread id: opaque URL-safe characters only.
const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

// The Gmail read formats an agent may ask for. Every full or raw request is read as
// `full`, which Warthog turns into the checked view; the raw RFC 822 source is never
// fetched for an agent. Headers-only stays available for triage.
function gmailReadFormat(requested: string | undefined): "full" | "metadata" {
  const format = requested?.toLowerCase();
  return format === "metadata" || format === "minimal" ? "metadata" : "full";
}

// Calendar list parameters an agent may set (a time range, a search, paging, ordering).
const CALENDAR_LIST_PARAMS = ["timeMin", "timeMax", "q", "maxResults", "pageToken", "singleEvents", "orderBy", "timeZone", "iCalUID", "updatedMin", "showDeleted", "eventTypes"] as const;

// Gmail search parameters an agent may set; anything else (e.g. `fields`, `alt`) is dropped.
const GMAIL_SEARCH_PARAMS = ["q", "maxResults", "pageToken", "labelIds", "includeSpamTrash"] as const;

function pick(query: Record<string, string> | undefined, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = query?.[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function gmailMessageId(query: Record<string, string> | undefined): string {
  const id = query?.id;
  if (id === undefined || !GMAIL_ID.test(id)) throw new HttpError(400, "query.id must be a Gmail message id from search results.");
  return id;
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
  // Gmail — search / read are reads; draft / send both receive message-policy checks.
  {
    name: "google-gmail__search",
    connectorId: "google-gmail",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: (i) => ({ path: "/gmail/v1/users/me/messages", query: pick(i.query, GMAIL_SEARCH_PARAMS) }),
  },
  {
    name: "google-gmail__read",
    connectorId: "google-gmail",
    makesChange: false,
    sendsMessage: false,
    method: "GET",
    resolve: (i) => ({
      path: `/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId(i.query))}`,
      query: { format: gmailReadFormat(i.query?.format) },
    }),
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
    resolve: (i) => ({ path: "/calendar/v3/calendars/primary/events", query: pick(i.query, CALENDAR_LIST_PARAMS) }),
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

  if (input.compose && (def.name === "google-gmail__draft" || def.name === "google-gmail__send")) {
    return sendComposedGmail(def, input, input.compose, deps);
  }

  const { path, query } = def.resolve(input);
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
  if (def.name === "google-gmail__search") return searchWithSummaries(request, deps);
  if (def.name === "google-drive__read_text") return readDriveText(request, deps);
  if (def.name !== "google-gmail__read" || query?.format !== "full") return sendConnectorRequest(request, deps);

  // A full message read: fetch the whole message so Warthog can check it. One that is still
  // too large is re-read as headers only, and the agent is told its text couldn't be checked.
  const full = await sendConnectorRequest({ ...request, maxBytes: MESSAGE_READ_BYTES }, deps);
  if (!full.truncated) return full;
  const headers = await sendConnectorRequest({ ...request, query: { ...query, format: "metadata" } }, deps);
  return { ...headers, tooLargeToCheck: true };
}

// The headers a reply needs from the message it answers: read as metadata, never the body.
async function gmailReplyTarget(input: CuratedToolCallInput, replyId: string, deps: CuratedToolDeps): Promise<{ target: ReplyTarget; threadId?: string }> {
  if (!GMAIL_ID.test(replyId)) throw new HttpError(400, "reply.id must be a Gmail message id from search or read.");
  const original = await sendConnectorRequest({
    entry: input.entry, userId: input.userId, connectionId: input.connectionId, dek: input.dek,
    method: "GET", path: `/gmail/v1/users/me/messages/${encodeURIComponent(replyId)}`, query: { format: "metadata" },
  }, deps);
  if (original.status < 200 || original.status >= 300) throw new HttpError(404, "The message being replied to wasn't found.");
  let parsed: { threadId?: unknown; payload?: { headers?: { name?: unknown; value?: unknown }[] } };
  try {
    parsed = JSON.parse(original.body);
  } catch {
    throw new HttpError(502, "Warthog couldn't read the message being replied to.");
  }
  const header = (name: string) => parsed.payload?.headers?.find((h) => typeof h.name === "string" && h.name.toLowerCase() === name)?.value;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    target: { messageId: text(header("message-id")), references: text(header("references")), subject: text(header("subject")) },
    threadId: typeof parsed.threadId === "string" && GMAIL_ID.test(parsed.threadId) ? parsed.threadId : undefined,
  };
}

// Draft or send an email Warthog builds from the agent's plain fields.
async function sendComposedGmail(def: CuratedToolDef, input: CuratedToolCallInput, compose: { draft: MailDraft; replyId?: string }, deps: CuratedToolDeps): Promise<CuratedToolResult> {
  const reply = compose.replyId ? await gmailReplyTarget(input, compose.replyId, deps) : undefined;
  let raw: string;
  try {
    raw = buildMimeMessage(compose.draft, reply?.target);
  } catch (err) {
    if (err instanceof MailComposeError) throw new HttpError(400, err.message);
    throw err;
  }
  const message = { raw, ...(reply?.threadId ? { threadId: reply.threadId } : {}) };
  const { path } = def.resolve(input);
  return sendConnectorRequest({
    entry: input.entry, userId: input.userId, connectionId: input.connectionId, dek: input.dek,
    method: def.method, path, body: JSON.stringify(def.name === "google-gmail__draft" ? { message } : message), contentType: "application/json",
  }, deps);
}

/** Whether the connected Gmail account has ever sent mail to exactly `address` (Gmail's search matches words, so each hit is checked). */
export async function gmailHasSentTo(input: Pick<CuratedToolCallInput, "entry" | "userId" | "connectionId" | "dek">, address: string, deps: CuratedToolDeps): Promise<boolean> {
  const q = `in:sent {to:${address} cc:${address} bcc:${address}}`;
  const list = await sendConnectorRequest({ ...input, method: "GET", path: "/gmail/v1/users/me/messages", query: { q, maxResults: "5" } }, deps);
  if (list.status < 200 || list.status >= 300) throw new Error("sent-mail lookup failed");
  const ids = ((JSON.parse(list.body) as { messages?: { id?: unknown }[] }).messages ?? [])
    .map((m) => m.id).filter((id): id is string => typeof id === "string" && GMAIL_ID.test(id));
  const wanted = address.toLowerCase();
  const hits = await Promise.all(ids.map(async (id) => {
    const got = await sendConnectorRequest({ ...input, method: "GET", path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, query: { format: "metadata" } }, deps);
    if (got.status < 200 || got.status >= 300) return false;
    const headers = (JSON.parse(got.body) as { payload?: { headers?: { name?: unknown; value?: unknown }[] } }).payload?.headers ?? [];
    const recipients = headers
      .filter((h) => typeof h.name === "string" && /^(?:to|cc|bcc)$/i.test(h.name) && typeof h.value === "string")
      .map((h) => String(h.value).toLowerCase());
    return recipients.some((value) => ((value.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? []) as string[]).includes(wanted));
  }));
  return hits.some(Boolean);
}

// Gmail search returns ids only, so an agent used to read every result to triage an inbox. A
// search now fetches each result's headers and preview (never its body) and returns them
// together, at most 25 a page (10 by default), so triage takes one call. Warthog checks the
// previews like any other content. A result whose headers can't be fetched keeps its ids and
// says so. Gmail's per-second quota can turn a busy search's fetch away (429): it's tried once more.
const MAX_SEARCH_RESULTS = 25;
const DEFAULT_SEARCH_RESULTS = 10;
const SUMMARY_CONCURRENCY = 6;
const RETRY_AFTER_MS = 400;

async function searchWithSummaries(request: Parameters<typeof sendConnectorRequest>[0], deps: CuratedToolDeps): Promise<CuratedToolResult> {
  const asked = Number.parseInt(request.query?.maxResults ?? "", 10);
  const maxResults = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_SEARCH_RESULTS) : DEFAULT_SEARCH_RESULTS;
  const list = await sendConnectorRequest({ ...request, query: { ...request.query, maxResults: String(maxResults) } }, deps);
  if (list.status < 200 || list.status >= 300) return list;
  let parsed: { messages?: { id?: unknown; threadId?: unknown }[]; nextPageToken?: unknown; resultSizeEstimate?: unknown };
  try {
    parsed = JSON.parse(list.body);
  } catch {
    return list;
  }
  const found = (parsed.messages ?? []).filter((m) => typeof m.id === "string" && GMAIL_ID.test(m.id)).slice(0, maxResults);
  const summaries: unknown[] = new Array(found.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(SUMMARY_CONCURRENCY, found.length) }, async () => {
    while (next < found.length) {
      const index = next++;
      const item = found[index]!;
      const unavailable = { id: item.id, threadId: item.threadId, unavailable: true };
      try {
        const fetchOne = () => sendConnectorRequest({ ...request, path: `/gmail/v1/users/me/messages/${encodeURIComponent(String(item.id))}`, query: { format: "metadata" } }, deps);
        let got = await fetchOne();
        if (got.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
          got = await fetchOne();
        }
        summaries[index] = got.status >= 200 && got.status < 300 && !got.truncated ? JSON.parse(got.body) : unavailable;
      } catch {
        summaries[index] = unavailable;
      }
    }
  }));
  return {
    status: list.status,
    truncated: false,
    body: JSON.stringify({ messages: summaries, summaries: true, ...(typeof parsed.nextPageToken === "string" ? { nextPageToken: parsed.nextPageToken } : {}), ...(typeof parsed.resultSizeEstimate === "number" ? { resultSizeEstimate: parsed.resultSizeEstimate } : {}) }),
  };
}

// A Drive file as text: Google Docs and Slides are exported as plain text and Sheets as CSV;
// a file that is already text is read as it is; anything else (a PDF, an image, a zip) is not
// read, and the agent is told so instead of being handed raw bytes.
const DRIVE_EXPORTS: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};
const TEXT_TYPE = /^(?:text\/|application\/(?:json|xml|csv|x-ndjson|javascript|x-yaml|yaml|rtf)$)|\+(?:json|xml)$/;

async function readDriveText(request: Parameters<typeof sendConnectorRequest>[0], deps: CuratedToolDeps): Promise<CuratedToolResult> {
  const filePath = request.path;
  // supportsAllDrives: a file in a shared drive is otherwise "not found".
  const meta = await sendConnectorRequest({ ...request, query: { fields: "id,name,mimeType,size", supportsAllDrives: "true" } }, deps);
  if (meta.status < 200 || meta.status >= 300) return meta;
  let file: { mimeType?: unknown; name?: unknown };
  try {
    file = JSON.parse(meta.body);
  } catch {
    return meta;
  }
  const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
  const exportAs = DRIVE_EXPORTS[mimeType];
  if (exportAs) {
    const exported = await sendConnectorRequest({ ...request, path: `${filePath}/export`, query: { mimeType: exportAs } }, deps);
    // Drive exports a spreadsheet's first tab only.
    return exportAs === "text/csv" && exported.status >= 200 && exported.status < 300
      ? { ...exported, note: "Only the first sheet of this spreadsheet is shown, as CSV." }
      : exported;
  }
  if (TEXT_TYPE.test(mimeType)) return sendConnectorRequest({ ...request, query: { alt: "media", supportsAllDrives: "true" } }, deps);
  return {
    status: 200,
    truncated: false,
    body: JSON.stringify({ name: typeof file.name === "string" ? file.name : undefined, mimeType, unreadable: true, note: "Warthog can't read this file type yet. The person can open it in Google Drive." }),
  };
}
