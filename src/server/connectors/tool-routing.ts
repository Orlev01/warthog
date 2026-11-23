// Review fix D5 — connector tool exposure and routing (design §6.2 "Tool list for an agent
// = Warthog core tools + the connector tools it is permitted, namespaced <connector>__<tool>";
// §7 "Connector engine"; constitution 15 "agents reach services only through Warthog").
//
// Two halves of the one job of putting a person's connected services on the MCP surface:
//
//   1. `connectorToolsetFor` — WHICH connector tools a connection is served: for every one
//      of the person's CONNECTED services that this agent is granted and that the catalogue
//      knows, either its curated tools (Gmail, Google Calendar/Drive, Outlook mail/calendar,
//      OneDrive, LinkedIn — each with its declared read/change class and sends-a-message flag) or, for
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
import { callLinkedInTool, LINKEDIN_CURATED_TOOLS } from "./curated/linkedin";
import { checkLinkedInPost, LinkedInPostError, MAX_POST_CHARS } from "../../domain/content/linkedin-post";
import { sendConnectorRequest } from "./request-tool";
import { draftRecipients, MailComposeError, type MailDraft } from "../../domain/content/compose-mail";
import type { ConnectorToolDeclaration, ConnectorToolset } from "../mcp/tools/registry";
import type { AccountGrant } from "../../domain/permissions/account-access";

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

// Drafting and sending email (Gmail and Outlook): plain fields Warthog turns into the email
// itself (docs/adr/approval-card-truth.md), so what the person approves is exactly what is
// sent. A hand-built `body`/`raw` message is refused.
const mailbox = z.string().min(3).max(400);
const mailboxes = z.array(mailbox).max(50);
export const mailComposeSchema = z.object({
  to: mailboxes.optional().describe("Who it goes to, e.g. [\"Sam Lee <sam@example.com>\"]. For a reply, usually the message's replyTo or from."),
  cc: mailboxes.optional().describe("Copied to."),
  bcc: mailboxes.optional().describe("Blind-copied to."),
  subject: z.string().max(900).regex(/^[^\r\n]*$/, "The subject can't contain a line break.").optional()
    .describe("The subject. A reply without one gets \"Re: <original subject>\"."),
  text: z.string().max(100_000).describe("The email's text. Warthog sends it as plain text."),
  reply: z.object({ id: z.string().min(1).max(512).describe("The id of the message being replied to, from search or read.") })
    .optional().describe("Reply in that message's thread. List the recipients yourself in to and cc."),
  // Kept only so an old-style call gets a clear refusal instead of a silent drop.
  body: z.string().max(MAX_BODY).optional().describe("Not used: give to, subject and text."),
  html: z.string().max(MAX_BODY).optional().describe("Not used: Warthog sends plain text, so put the message in text."),
  reason,
});
export type MailComposeInput = z.infer<typeof mailComposeSchema>;

// A LinkedIn post: plain fields Warthog turns into the post itself
// (docs/adr/linkedin-connector.md), so the card shows exactly what goes out.
export const linkedInPostSchema = z.object({
  text: z.string().min(1).max(MAX_POST_CHARS).describe("The post's text, as it should appear. Hashtags like #hiring work; @mentions don't."),
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional()
    .describe("Who can see it: CONNECTIONS (the default) or PUBLIC (anyone on LinkedIn)."),
  link: z.object({
    url: z.string().min(1).max(2000).describe("A public https address."),
    title: z.string().max(200).optional().describe("The link's title. Defaults to the site's name."),
    description: z.string().max(300).optional().describe("A line about the link."),
  }).optional().describe("A link shown under the post."),
  reason,
}).superRefine((post, ctx) => {
  // Refused here, before it's held, so the agent can fix it rather than the person approving a
  // post that then fails.
  try {
    checkLinkedInPost(post);
  } catch (err) {
    if (!(err instanceof LinkedInPostError)) throw err;
    ctx.addIssue({ code: "custom", message: err.message });
  }
});
export type LinkedInPostFields = z.infer<typeof linkedInPostSchema>;

/** The draft an agent wrote, in the email builder's terms. */
export function mailDraftOf(input: MailComposeInput): MailDraft {
  return {
    ...(input.to ? { to: input.to } : {}),
    ...(input.cc ? { cc: input.cc } : {}),
    ...(input.bcc ? { bcc: input.bcc } : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    text: input.text,
  };
}

/** The refusal for an old-style call: a hand-built message, or an HTML version the card can't show. */
export function composeRefusal(input: { body?: unknown; html?: unknown }): string | undefined {
  if (input.body !== undefined) return "Use to, subject and text: Warthog builds the email.";
  if (input.html !== undefined) return "Warthog sends plain text, so what the person approves is exactly what is sent. Put the message in text.";
  return undefined;
}

// Who a drafted or sent email goes to, read from its plain fields, so recipient rules match
// the real list. An address Warthog can't read is refused before anything else happens, and
// a send needs at least one recipient.
function composedRecipients(requireOne: boolean): (params: Record<string, unknown>) => string[] {
  return (params) => {
    const refusal = composeRefusal(params);
    if (refusal) throw new HttpError(400, refusal);
    try {
      const recipients = draftRecipients(mailDraftOf(params as MailComposeInput));
      if (requireOne && recipients.length === 0) throw new HttpError(400, "An email needs at least one recipient in to, cc or bcc.");
      return recipients;
    } catch (err) {
      if (err instanceof MailComposeError) throw new HttpError(400, err.message);
      throw err;
    }
  };
}

const MAIL_COMPOSE_TOOLS = new Set(["google-gmail__draft", "google-gmail__send", "microsoft-outlook-mail__draft", "microsoft-outlook-mail__send"]);

/** Whether a tool drafts or sends email from plain fields. */
export function isMailComposeTool(tool: string): boolean {
  return MAIL_COMPOSE_TOOLS.has(tool);
}

// The curated tools of every provider that has them, by connector id.
const CURATED_BY_CONNECTOR: ReadonlyMap<string, readonly CuratedTool[]> = groupByConnector([
  ...GOOGLE_CURATED_TOOLS,
  ...MICROSOFT_CURATED_TOOLS,
  ...LINKEDIN_CURATED_TOOLS,
]);
const GOOGLE_TOOL_NAMES = new Set(GOOGLE_CURATED_TOOLS.map((tool) => tool.name));
const MICROSOFT_TOOL_NAMES = new Set(MICROSOFT_CURATED_TOOLS.map((tool) => tool.name));
const LINKEDIN_TOOL_NAMES = new Set(LINKEDIN_CURATED_TOOLS.map((tool) => tool.name));
const LINKEDIN_POST = "linkedin__create_post";
const LINKEDIN_DELETE = "linkedin__delete_post";

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
const GMAIL_PRESENTATION: Readonly<Record<string, { title: string; description: string }>> = {
  search: {
    title: "Gmail: Search messages",
    description: "Search the connected Gmail account. query.q uses Gmail search syntax, e.g. from:qantas newer_than:30d; query.maxResults (up to 25, default 10) and query.pageToken page through results. Returns who, subject, date, a preview and whether it's unread for each message: read one by id for its full text. Doesn't change mail.",
  },
  read: {
    title: "Gmail: Read message",
    description: "Read one Gmail message by query.id from search results. Returns Warthog's checked view: from, to, subject, date, a preview, the text with its links numbered, and attachment names. query.format=metadata returns headers and the preview only; query.link=N returns link N in full. Sign-in code and password emails are withheld: tell the person to open those in Gmail. Doesn't change mail.",
  },
  draft: {
    title: "Gmail: Create unsent draft",
    description: "Save an email as a draft in the connected Gmail account; nothing is sent. Give to, subject and text; Warthog builds a plain-text email. To reply in a thread, pass reply.id and list the recipients. A draft is a change, so the person may be asked first.",
  },
  send: {
    title: "Gmail: Send email",
    description: "Send an email from the connected Gmail account. Give to (and cc/bcc), subject and text; Warthog builds a plain-text email. To reply in a thread, pass reply.id and list the recipients. pending_approval means nothing has been sent yet.",
  },
};

const OUTLOOK_MAIL_PRESENTATION: Readonly<Record<string, { title: string; description: string }>> = {
  search: {
    title: "Outlook: Search messages",
    description: "Search the connected Outlook mailbox. query.$search takes words, e.g. \"invoice\"; query.$filter, $orderby, $top (up to 25, default 10) and $skip page and sort. Returns who, subject, date and a preview for each message: read one by id for its text. Doesn't change mail.",
  },
  draft: {
    title: "Outlook: Create unsent draft",
    description: "Save an email as a draft in the connected Outlook mailbox; nothing is sent. Give to, subject and text; Warthog builds a plain-text email. To reply in a thread, pass reply.id and list the recipients.",
  },
  send: {
    title: "Outlook: Send email",
    description: "Send an email from the connected Outlook mailbox. Give to (and cc/bcc), subject and text; Warthog builds a plain-text email. To reply in a thread, pass reply.id and list the recipients. pending_approval means nothing has been sent yet.",
  },
  read: {
    title: "Outlook: Read message",
    description: "Read one Outlook message by query.id from search results. Returns Warthog's checked view: from, to, subject, date, a preview and the text with its links numbered. Sign-in code and password emails are withheld: tell the person to open those in Outlook. Doesn't change mail.",
  },
};

const LINKEDIN_PRESENTATION: Readonly<Record<string, { title: string; description: string }>> = {
  profile: {
    title: "LinkedIn: Your profile",
    description: "The person's LinkedIn name, email and photo. LinkedIn doesn't let Warthog read their feed, connections, messages or job history.",
  },
  create_post: {
    title: "LinkedIn: Post",
    description: "Post on the person's LinkedIn. Give text, and optionally visibility (CONNECTIONS by default, or PUBLIC) and a link. The person always approves a post first: pending_approval means nothing is posted yet. Returns the post's id and link.",
  },
  delete_post: {
    title: "LinkedIn: Delete post",
    description: "Delete one of the person's LinkedIn posts by query.id, the id create_post returned (urn:li:share:…). The person always approves a delete first.",
  },
};

// Calendar tools that send invitations to the event's guests (docs/adr/approval-card-truth.md):
// their guests are read from the event body so the approval card names them.
const CALENDAR_INVITE_TOOLS = new Set([
  "google-calendar__create", "google-calendar__update", "microsoft-outlook-calendar__create", "microsoft-outlook-calendar__update",
]);

/** The guest addresses in a Google or Outlook event body (`attendees[].email` / `attendees[].emailAddress.address`). */
export function calendarGuests(rawBody: string | undefined): string[] {
  if (rawBody === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const attendees = (parsed as { attendees?: unknown } | null)?.attendees;
  if (!Array.isArray(attendees)) return [];
  const out: string[] = [];
  for (const attendee of attendees.slice(0, 200)) {
    const record = (attendee ?? {}) as { email?: unknown; emailAddress?: { address?: unknown } };
    const address = typeof record.email === "string" ? record.email : record.emailAddress?.address;
    if (typeof address === "string" && address.includes("@")) out.push(address.trim().toLowerCase());
  }
  return [...new Set(out)];
}

function declarationOf(tool: CuratedTool, serviceName: string): ConnectorToolDeclaration {
  const verb = tool.name.slice(tool.connectorId.length + NAMESPACE.length);
  const presentation = tool.connectorId === "google-gmail" ? GMAIL_PRESENTATION[verb]
    : tool.connectorId === "microsoft-outlook-mail" ? OUTLOOK_MAIL_PRESENTATION[verb]
    : tool.connectorId === "linkedin" ? LINKEDIN_PRESENTATION[verb] : undefined;
  return {
    name: verb,
    title: presentation?.title ?? `${serviceName}: ${verb.replace(/_/g, " ")}`,
    description: presentation?.description ?? `${serviceName}: ${verb.replace(/_/g, " ")} (${tool.makesChange ? "makes a change" : "reads only"}).`,
    makesChange: tool.makesChange,
    ...(tool.sendsMessage
      ? { messageChannel: "email" as const, schema: mailComposeSchema, recipientsOf: composedRecipients(verb === "send"), outbound: true }
      : {}),
    ...(CALENDAR_INVITE_TOOLS.has(tool.name) ? { recipients: calendarGuests, outbound: true } : {}),
    // Editing an event notifies the guests it already has, even when the edit doesn't list them.
    ...(tool.name.endsWith("calendar__update") ? { alwaysOutbound: true } : {}),
    // A post reaches other people, and LinkedIn's terms rule out posting without the member,
    // so the person is always asked first (docs/adr/linkedin-connector.md).
    ...(tool.name === LINKEDIN_POST
      ? { schema: linkedInPostSchema, messageChannel: "post" as const, outbound: true, alwaysOutbound: true, alwaysAsk: true }
      : {}),
    // An agent's delete can't be taken back, so the person is asked first too. Undo of a post
    // Warthog made is the person's own action and runs straight away (compose.ts runReversal).
    ...(tool.name === LINKEDIN_DELETE ? { alwaysAsk: true } : {}),
  };
}

// The connector tools one of the person's accounts offers: its service's curated tools, the
// tools its provider listed for that account, or the general request tool when it has none.
// Undefined when the service is unknown or the provider listed nothing.
export function accountToolsFor(
  connection: Pick<Connection, "id" | "connectorId">,
  catalogue: CatalogueIndex,
  providerTools: Readonly<Record<string, readonly ConnectorToolDeclaration[]>> = {},
): readonly ConnectorToolDeclaration[] | undefined {
  const entry = catalogue.get(connection.connectorId);
  if (!entry) return undefined;
  if (entry.auth_kind === "provider_mcp") return providerTools[connection.id]?.length ? providerTools[connection.id] : undefined;
  const curated = CURATED_BY_CONNECTOR.get(connection.connectorId);
  return curated
    ? curated.map((tool) => declarationOf(tool, entry.name))
    : [
        {
          ...(entry.get_is_change
            ? {
                name: REQUEST_TOOL,
                description: `Send one authenticated request to the person's ${entry.name} account (paths are relative to its API). ${entry.name} can send messages on any request, so every request, GET included, makes a change.`,
                getIsChange: true,
              }
            : {
                name: REQUEST_TOOL,
                description: `Send one authenticated request to the person's ${entry.name} account (paths are relative to its API). GET and HEAD read; any other method makes a change.`,
              }),
          // A change through an email, messaging or calendar service (Nylas sends mail; booking
          // services email invitees) sends something to other people.
          ...(entry.category === "email" || entry.category === "messaging" || entry.category === "calendar" ? { outbound: true } : {}),
        },
      ];
}

// The connector tools an agent is served, by service: the tools of every CONNECTED account it
// was given (docs/adr/several-accounts-per-agent.md), once each. Tools stay one set per
// service however many accounts it has; each call is bound to one account by the pipeline.
export function connectorToolsetFor(
  connections: readonly Connection[],
  accounts: readonly Pick<AccountGrant, "accountId">[],
  catalogue: CatalogueIndex,
  providerTools: Readonly<Record<string, readonly ConnectorToolDeclaration[]>> = {},
): ConnectorToolset {
  const granted = new Set(accounts.map((account) => account.accountId));
  const toolset: Record<string, ConnectorToolDeclaration[]> = {};
  for (const connection of connections) {
    if (connection.status !== "connected" || !granted.has(connection.id)) continue;
    const tools = accountToolsFor(connection, catalogue, providerTools);
    if (!tools) continue;
    const merged = (toolset[connection.connectorId] ??= []);
    for (const tool of tools) if (!merged.some((known) => known.name === tool.name)) merged.push(tool);
  }
  return toolset;
}

// The seams the executor runs on.
export interface ConnectorToolExecutorDeps {
  readonly executeProvider?: (userId:string,connectionId:string,tool:string,input:unknown)=>Promise<unknown>;
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
): (call: ConnectorCall, userId: string, accountId?: string) => Promise<unknown> {
  return async function executeConnectorTool(call: ConnectorCall, userId: string, accountId?: string): Promise<unknown> {
    const entry = deps.catalogue.get(call.connector);
    const prefix = `${call.connector}${NAMESPACE}`;
    if (!entry || (entry.auth_kind === "provider_mcp" && !deps.executeProvider) || !call.tool.startsWith(prefix)) {
      throw new HttpError(400, "This service tool is not available.");
    }
    const verb = call.tool.slice(prefix.length);

    // The account the call was bound to, when it is the person's live connection to this
    // service (member-scoped by the session user). Never another account in its place.
    const connections = await listConnectionsForUser(deps.db, userId);
    const connection = connections.find((c) => c.id === accountId && c.connectorId === call.connector && c.status === "connected");
    if (!connection) {
      throw new HttpError(409, "Choose a connected account for this service in the agent settings.");
    }
    if (entry.auth_kind === "provider_mcp") return deps.executeProvider!(userId,connection.id,verb,call.params);
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

    if (isMailComposeTool(call.tool)) {
      const composed = parseParams(mailComposeSchema, call.params);
      const refusal = composeRefusal(composed);
      if (refusal) throw new HttpError(400, refusal);
      const input = { tool: call.tool, entry, userId, connectionId: connection.id, dek, compose: { draft: mailDraftOf(composed), ...(composed.reply ? { replyId: composed.reply.id } : {}) } };
      if (GOOGLE_TOOL_NAMES.has(call.tool)) return callGoogleTool(input, transport);
      return callMicrosoftTool(input, transport);
    }
    if (call.tool === LINKEDIN_POST) {
      const { text, visibility, link } = parseParams(linkedInPostSchema, call.params);
      return callLinkedInTool({ tool: call.tool, entry, userId, connectionId: connection.id, dek,
        post: { text, ...(visibility ? { visibility } : {}), ...(link ? { link } : {}) } }, transport);
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
    if (LINKEDIN_TOOL_NAMES.has(call.tool)) return callLinkedInTool(input, transport);
    throw new HttpError(400, "This service tool is not available.");
  };
}

