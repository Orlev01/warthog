// E09-S11 — Curated Microsoft tools (`src/server/connectors/curated/microsoft.ts`).
//
// RED-first: the module does not exist yet, so importing `./microsoft` throws and every
// test here fails at load — that absence IS the point of test-first. As the TESTER I must
// NOT create or edit the module (or any implementation/source file) to make these pass;
// the builder writes `curated/microsoft.ts` (and its sibling handler) afterwards to this
// contract.
//
// WHY this exists (task E09-S11; design §7 "Connector engine" — "Curated tools (declared
// reads/changes + reversal + 'sends a message' flag)"): Microsoft is the second
// founder-registered provider and needs the same curated coverage as Google — Outlook mail
// (search, read, draft, send), Outlook calendar (list, create↔delete, update) and OneDrive
// (search, read). Each tool declares whether it reads or makes a change, a reversal link
// (create event is undone by delete event) the Undo flow reads, and a "sends a message"
// flag the rules engine reads. The tools reach Microsoft ONLY through the person's Microsoft
// OAuth connection (a Bearer access token presented to the host taken from the catalogue
// entry's `base_url`, never a caller value) and are refused when that connection needs
// reconnecting.
//
// These tests pin BEHAVIOUR (what each tool declares; that a call hits the entry host with
// the connection's Bearer token; that a needs-reconnect connection is refused with NO
// request; that a handler rejects malformed / oversized / mis-shaped input with a 4xx and
// binds every value so a SQL probe cannot alter a query; that no ambient env secret leaks)
// — never the source text of any file; a later rename that preserves behaviour must not
// redden them. The HTTP + data sources are injected seams (conventions: external services
// sit behind fakes; tests never touch the network): a recording `fetch` stands in for
// Microsoft Graph, and the db is the real in-memory PGlite with the real migrations
// (`../../../test/db`) or a recording stand-in that proves what reached the query layer.
//
// The shared curated-tool shape (name / connectorId / makesChange / sendsMessage /
// reversalTool) already lives in the sibling `./google` module; whether the builder
// re-exports those named types from `./microsoft` or imports them from `./google` is its
// call, so this suite DERIVES the types from the two value exports it does pin
// (`MICROSOFT_CURATED_TOOLS`, `callMicrosoftTool`) rather than importing type names — the
// behaviour is what matters, not where a type alias is declared.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // One curated tool's declaration. The rules engine and the Undo flow read these.
//   interface CuratedTool {
//     name: string;            // "<connectorId>__<verb>" (matches the `<id>__request`
//                              //  convention): e.g. "microsoft-outlook-calendar__create"
//     connectorId: string;     // "microsoft-outlook-mail" | "microsoft-outlook-calendar"
//                              //  | "microsoft-onedrive"
//     makesChange: boolean;    // false = a read; true = makes a change (follows the
//                              //  agent's change-making setting)
//     sendsMessage: boolean;   // the "sends a message" flag the rules engine reads
//     reversalTool?: string;   // the curated tool that undoes this one (create → delete)
//   }
//
//   const MICROSOFT_CURATED_TOOLS: readonly CuratedTool[];   // the 10 tools below
//
//   interface CuratedToolDeps { db: Db; fetch: typeof fetch; }   // injected seams
//
//   interface CuratedToolCallInput {
//     tool: string;            // one of the curated tool names
//     entry: CatalogueEntry;   // the connector entry; the HOST (base_url) comes from HERE
//     userId: string;          // the SESSION's id (never a client value) — member scope
//     connectionId: string;    // which OWNED Microsoft connection's token to present
//     dek: Uint8Array;         // the owner's 256-bit data key (already unwrapped)
//     query?: Record<string, string>;   // tool query parameters (e.g. a search query)
//     body?: string;           // the request body for a change tool
//   }
//
//   interface CuratedToolResult { status: number; body: string; truncated: boolean; }
//
//   callMicrosoftTool(input, deps): Promise<CuratedToolResult>
//     • Looks up the tool declaration by name; an UNKNOWN tool is refused (no request).
//     • Resolves the OWNED connection member-scoped by `userId`; a connection that is not
//       the session user's is refused (no request).
//     • REFUSES a connection whose status is not "connected" (needs_reconnect) — no request.
//     • For a "connected" connection, presents the stored Bearer access token to the
//       entry's host at the tool's endpoint, using a READ method (GET/HEAD) for a read tool
//       and a CHANGE method for a change tool, and returns the upstream status + body.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { MICROSOFT_CURATED_TOOLS, callMicrosoftTool } from "./microsoft";
import { createUser } from "../../db/users";
import {
  createConnection,
  getConnectionById,
  type Connection,
  type ConnectionStatus,
} from "../../db/connections";
import { freshDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { parseBody, HttpError } from "../../http/validate";
import type { CatalogueEntry } from "../../../domain/catalogue/schema";

// Derived from the two value exports this suite pins — so the test does not couple to WHERE
// the shared `Curated*` type aliases are declared (re-exported here, or imported from
// `./google`): only the behaviour is pinned.
type CuratedTool = (typeof MICROSOFT_CURATED_TOOLS)[number];
type CuratedToolDeps = Parameters<typeof callMicrosoftTool>[1];
type CuratedToolResult = Awaited<ReturnType<typeof callMicrosoftTool>>;

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A distinctive access token that must ride in the OUTBOUND request (the person's Microsoft
// OAuth token) and a decoy that must NEVER leak from an ambient env value.
const OAUTH_TOKEN = "microsoft-ACCESS-TOKEN-7c6b5a4d-SECRET";
const DECOY_SECRET = "env-decoy-SECRET-must-never-be-used";

// The three Microsoft connector entries (mirroring the real catalogue files). The HOST comes
// ONLY from `base_url`: all three sit on the shared Microsoft Graph host, each a distinct
// connector. Microsoft is a founder-registered provider in full, so (unlike Google) these
// entries carry no early-access flag.
const MAIL_ENTRY: CatalogueEntry = {
  id: "microsoft-outlook-mail",
  name: "Outlook Mail",
  aliases: ["outlook email", "office 365 mail"],
  category: "email",
  auth_kind: "oauth2",
  base_url: "https://graph.microsoft.com/v1.0",
  auth: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
      "offline_access",
    ],
  },
};

const CALENDAR_ENTRY: CatalogueEntry = {
  id: "microsoft-outlook-calendar",
  name: "Outlook Calendar",
  aliases: ["microsoft calendar", "office 365 calendar"],
  category: "calendar",
  auth_kind: "oauth2",
  base_url: "https://graph.microsoft.com/v1.0",
  auth: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["https://graph.microsoft.com/Calendars.ReadWrite", "offline_access"],
  },
};

const ONEDRIVE_ENTRY: CatalogueEntry = {
  id: "microsoft-onedrive",
  name: "OneDrive",
  aliases: ["microsoft onedrive", "onedrive files"],
  category: "storage",
  auth_kind: "oauth2",
  base_url: "https://graph.microsoft.com/v1.0",
  auth: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["https://graph.microsoft.com/Files.ReadWrite", "offline_access"],
  },
};

// All three Microsoft services resolve to the one Microsoft Graph host (the base_url's path
// prefix, e.g. /v1.0, is the builder's to carry — the HOST is what a caller must never set).
const GRAPH_HOST = new URL(MAIL_ENTRY.base_url).host;

const ENTRY_BY_CONNECTOR: Record<string, CatalogueEntry> = {
  [MAIL_ENTRY.id]: MAIL_ENTRY,
  [CALENDAR_ENTRY.id]: CALENDAR_ENTRY,
  [ONEDRIVE_ENTRY.id]: ONEDRIVE_ENTRY,
};

function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// Seed a Microsoft connection for `userId` with a stored Bearer access token, at the given
// status, through the REAL record store (DEK-encrypted). Returns the created connection.
async function seedConnection(
  db: Db,
  entry: CatalogueEntry,
  userId: string,
  dek: Uint8Array,
  status: ConnectionStatus = "connected",
): Promise<Connection> {
  return createConnection(
    db,
    {
      userId,
      connectorId: entry.id,
      accountLabel: `${userId}@${entry.id}`,
      credentials: {
        access_token: OAUTH_TOKEN,
        token_type: "Bearer",
        refresh_token: "refresh-xyz",
        expires_at: "2026-06-01T00:00:00.000Z",
      },
      status,
    },
    dek,
    { now: () => new Date("2026-05-01T10:00:00.000Z") },
  );
}

function makeDeps(db: Db, fetchFn: typeof globalThis.fetch): CuratedToolDeps {
  return { db, fetch: fetchFn };
}

// --- the upstream service (Microsoft Graph), faked ---------------------------------

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

// A recording `fetch` stand-in: records every request and returns whatever `respond`
// yields. No network.
function recordingFetch(respond: () => Response): {
  fetch: typeof globalThis.fetch;
  requests: SeenRequest[];
} {
  const requests: SeenRequest[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    requests.push({
      url,
      method: String(init?.method ?? "GET"),
      headers,
      body: bodyToString(init?.body),
    });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch: fn, requests };
}

const okResponse = (): Response => new Response("ok-body", { status: 200 });

// The headers of every captured request, concatenated — the narrow surface for a
// "the presented Bearer must ride HERE" scan.
function requestHeaderText(requests: SeenRequest[]): string {
  return requests
    .map((r) => [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"))
    .join("\n");
}

// The whole of what a captured request reveals (url + headers + body) — for a narrow
// "an ambient env secret must NOT appear anywhere in the outbound request" scan.
function requestText(requests: SeenRequest[]): string {
  return requests
    .map((r) => {
      const headersText = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      return [r.url, r.method, headersText, r.body].join("\n");
    })
    .join("\n");
}

const READ_METHODS = new Set(["GET", "HEAD"]);

// --- a recording db seam (proves what reached the query layer) ---------------------

interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// ===========================================================================
// AC1 — Each tool declares reads vs makes-changes; create-calendar-event declares
// delete-event as its reversal; send and draft declare "sends a message". Pure data.
// ===========================================================================

// The exact curated tool set this task adds (design §7). Named with the existing
// `<connectorId>__<verb>` convention so the Undo flow's `reversalFor(tool)` and the rules
// engine can key on the same names across tasks.
const EXPECTED: readonly {
  name: string;
  connectorId: string;
  makesChange: boolean;
  sendsMessage: boolean;
  reversalTool?: string;
}[] = [
  // Outlook mail — search / read are reads; draft / send make changes AND send a message.
  { name: "microsoft-outlook-mail__search", connectorId: "microsoft-outlook-mail", makesChange: false, sendsMessage: false },
  { name: "microsoft-outlook-mail__read", connectorId: "microsoft-outlook-mail", makesChange: false, sendsMessage: false },
  { name: "microsoft-outlook-mail__draft", connectorId: "microsoft-outlook-mail", makesChange: true, sendsMessage: true },
  { name: "microsoft-outlook-mail__send", connectorId: "microsoft-outlook-mail", makesChange: true, sendsMessage: true },
  // Outlook calendar — list is a read; create / delete / update make changes; create is
  // undone by delete.
  { name: "microsoft-outlook-calendar__list", connectorId: "microsoft-outlook-calendar", makesChange: false, sendsMessage: false },
  {
    name: "microsoft-outlook-calendar__create",
    connectorId: "microsoft-outlook-calendar",
    makesChange: true,
    sendsMessage: false,
    reversalTool: "microsoft-outlook-calendar__delete",
  },
  { name: "microsoft-outlook-calendar__delete", connectorId: "microsoft-outlook-calendar", makesChange: true, sendsMessage: false },
  { name: "microsoft-outlook-calendar__update", connectorId: "microsoft-outlook-calendar", makesChange: true, sendsMessage: false },
  // OneDrive — both are reads.
  { name: "microsoft-onedrive__search", connectorId: "microsoft-onedrive", makesChange: false, sendsMessage: false },
  { name: "microsoft-onedrive__read", connectorId: "microsoft-onedrive", makesChange: false, sendsMessage: false },
];

function byName(): Map<string, CuratedTool> {
  return new Map(MICROSOFT_CURATED_TOOLS.map((t) => [t.name, t]));
}

test("the curated Microsoft tool set is exactly the ten Outlook mail / calendar / OneDrive tools", () => {
  const got = new Set(MICROSOFT_CURATED_TOOLS.map((t) => t.name));
  const want = new Set(EXPECTED.map((e) => e.name));
  assert.deepEqual([...got].sort(), [...want].sort(), "the declared tool names are exactly the task's set");
  assert.equal(MICROSOFT_CURATED_TOOLS.length, EXPECTED.length, "no duplicate and no extra tool is declared");
});

for (const want of EXPECTED) {
  test(`${want.name} declares its connector, read/change class and message flag`, () => {
    const tool = byName().get(want.name);
    assert.ok(tool, `${want.name} is declared`);
    assert.equal(tool!.connectorId, want.connectorId, "it belongs to its Microsoft connector");
    assert.equal(tool!.makesChange, want.makesChange, "it declares reads vs makes-changes correctly");
    assert.equal(tool!.sendsMessage, want.sendsMessage, "it declares the 'sends a message' flag correctly");
  });
}

test("create-calendar-event declares delete-event as its reversal", () => {
  const create = byName().get("microsoft-outlook-calendar__create");
  assert.ok(create, "the create tool is declared");
  assert.equal(
    create!.reversalTool,
    "microsoft-outlook-calendar__delete",
    "creating an event is undone by deleting it",
  );
  // The reversal must point at a REAL declared tool (so the Undo flow can run it).
  const target = byName().get(create!.reversalTool!);
  assert.ok(target, "the reversal names an existing curated tool");
  assert.equal(target!.connectorId, "microsoft-outlook-calendar", "the reversal is the same connector's delete tool");
});

test("only create-calendar-event declares a reversal (YAGNI — just the one the task asks for)", () => {
  for (const tool of MICROSOFT_CURATED_TOOLS) {
    if (tool.name === "microsoft-outlook-calendar__create") continue;
    assert.equal(
      tool.reversalTool,
      undefined,
      `${tool.name} declares no reversal — only create↔delete is specified`,
    );
  }
});

test("send and draft are the only tools that declare 'sends a message'", () => {
  const flagged = MICROSOFT_CURATED_TOOLS.filter((t) => t.sendsMessage).map((t) => t.name).sort();
  assert.deepEqual(
    flagged,
    ["microsoft-outlook-mail__draft", "microsoft-outlook-mail__send"],
    "exactly Outlook mail send + draft carry the message flag the rules engine reads",
  );
});

test("every read tool makes no change, sends no message and has no reversal (invariants)", () => {
  for (const tool of MICROSOFT_CURATED_TOOLS) {
    if (tool.makesChange) continue;
    assert.equal(tool.sendsMessage, false, `${tool.name} is a read, so it sends no message`);
    assert.equal(tool.reversalTool, undefined, `${tool.name} is a read, so it has nothing to reverse`);
  }
});

test("every declared tool is well-formed: name is <connectorId>__<verb> for a Microsoft connector", () => {
  const microsoftConnectors = new Set([
    "microsoft-outlook-mail",
    "microsoft-outlook-calendar",
    "microsoft-onedrive",
  ]);
  for (const tool of MICROSOFT_CURATED_TOOLS) {
    assert.ok(microsoftConnectors.has(tool.connectorId), `${tool.name} belongs to a Microsoft connector`);
    assert.equal(typeof tool.makesChange, "boolean", `${tool.name}.makesChange is a boolean`);
    assert.equal(typeof tool.sendsMessage, "boolean", `${tool.name}.sendsMessage is a boolean`);
    assert.ok(
      tool.name.startsWith(`${tool.connectorId}__`),
      `${tool.name} is namespaced under its connector id`,
    );
  }
});

// ===========================================================================
// AC2 — the tools call the service THROUGH the Microsoft OAuth connection (the stored Bearer
// token is presented to the entry host) and are REFUSED when the connection needs
// reconnecting. The method class follows the tool's read/change declaration.
// ===========================================================================

test("a read tool (calendar list) hits the entry host with the connection's Bearer, using a read method", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "cal-read");
    const dek = freshDek();
    const conn = await seedConnection(db, CALENDAR_ENTRY, userId, dek, "connected");
    const f = recordingFetch(okResponse);

    const result: CuratedToolResult = await callMicrosoftTool(
      { tool: "microsoft-outlook-calendar__list", entry: CALENDAR_ENTRY, userId, connectionId: conn.id, dek },
      makeDeps(db, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one upstream request is sent");
    const sent = f.requests[0]!;
    assert.equal(new URL(sent.url).host, GRAPH_HOST, "the request goes to the entry's host, never a caller host");
    assert.ok(READ_METHODS.has(sent.method.toUpperCase()), `a read tool uses a read method (was ${sent.method})`);
    assert.ok(
      requestHeaderText(f.requests).includes(OAUTH_TOKEN),
      "the connection's Bearer access token is presented to Microsoft",
    );
    assert.ok(!sent.url.includes(OAUTH_TOKEN), "the token is never leaked into the URL");
    assert.equal(result.status, 200, "the upstream status is returned");
    assert.equal(result.body, "ok-body", "the upstream body is returned");
  } finally {
    await db.close();
  }
});

test("an Outlook mail read tool hits the Graph host with the connection's Bearer", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "mail-read");
    const dek = freshDek();
    const conn = await seedConnection(db, MAIL_ENTRY, userId, dek, "connected");
    const f = recordingFetch(okResponse);

    const result = await callMicrosoftTool(
      {
        tool: "microsoft-outlook-mail__search",
        entry: MAIL_ENTRY,
        userId,
        connectionId: conn.id,
        dek,
        query: { q: "from:boss" },
      },
      makeDeps(db, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one upstream request is sent");
    assert.equal(new URL(f.requests[0]!.url).host, GRAPH_HOST, "the request goes to the Microsoft Graph host");
    assert.ok(READ_METHODS.has(f.requests[0]!.method.toUpperCase()), "a read tool uses a read method");
    assert.ok(
      requestHeaderText(f.requests).includes(OAUTH_TOKEN),
      "the connection's Bearer access token is presented to Outlook mail",
    );
    assert.equal(result.status, 200, "the upstream status is returned");
  } finally {
    await db.close();
  }
});

test("a OneDrive read tool hits the Graph host with the connection's Bearer, using a read method", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "onedrive-read");
    const dek = freshDek();
    const conn = await seedConnection(db, ONEDRIVE_ENTRY, userId, dek, "connected");
    const f = recordingFetch(okResponse);

    const result = await callMicrosoftTool(
      {
        tool: "microsoft-onedrive__search",
        entry: ONEDRIVE_ENTRY,
        userId,
        connectionId: conn.id,
        dek,
        query: { q: "quarterly report" },
      },
      makeDeps(db, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one upstream request is sent");
    assert.equal(new URL(f.requests[0]!.url).host, GRAPH_HOST, "the request goes to the Microsoft Graph host");
    assert.ok(READ_METHODS.has(f.requests[0]!.method.toUpperCase()), "a read tool uses a read method");
    assert.ok(
      requestHeaderText(f.requests).includes(OAUTH_TOKEN),
      "the connection's Bearer access token is presented to OneDrive",
    );
    assert.equal(result.status, 200, "the upstream status is returned");
  } finally {
    await db.close();
  }
});

test("a change tool (calendar create) hits the entry host with the Bearer, using a change method", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "cal-create");
    const dek = freshDek();
    const conn = await seedConnection(db, CALENDAR_ENTRY, userId, dek, "connected");
    const f = recordingFetch(() => new Response("created", { status: 200 }));

    const result = await callMicrosoftTool(
      {
        tool: "microsoft-outlook-calendar__create",
        entry: CALENDAR_ENTRY,
        userId,
        connectionId: conn.id,
        dek,
        body: JSON.stringify({
          subject: "Dentist",
          start: { dateTime: "2026-06-01T09:00:00", timeZone: "Australia/Sydney" },
          end: { dateTime: "2026-06-01T09:30:00", timeZone: "Australia/Sydney" },
        }),
      },
      makeDeps(db, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one upstream request is sent");
    const sent = f.requests[0]!;
    assert.equal(new URL(sent.url).host, GRAPH_HOST, "the request goes to the entry's host");
    assert.ok(
      !READ_METHODS.has(sent.method.toUpperCase()),
      `a change tool uses a change method, never GET/HEAD (was ${sent.method})`,
    );
    assert.ok(
      requestHeaderText(f.requests).includes(OAUTH_TOKEN),
      "the connection's Bearer access token is presented to Microsoft",
    );
    assert.equal(result.status, 200, "the upstream status is returned");
  } finally {
    await db.close();
  }
});

test("a send tool (mail send) uses a change method and presents the connection's Bearer", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "mail-send");
    const dek = freshDek();
    const conn = await seedConnection(db, MAIL_ENTRY, userId, dek, "connected");
    const f = recordingFetch(() => new Response("", { status: 202 }));

    const result = await callMicrosoftTool(
      {
        tool: "microsoft-outlook-mail__send",
        entry: MAIL_ENTRY,
        userId,
        connectionId: conn.id,
        dek,
        body: JSON.stringify({ message: { subject: "Hi", toRecipients: [] } }),
      },
      makeDeps(db, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one upstream request is sent");
    const sent = f.requests[0]!;
    assert.equal(new URL(sent.url).host, GRAPH_HOST, "the request goes to the entry's host");
    assert.ok(
      !READ_METHODS.has(sent.method.toUpperCase()),
      `a send tool uses a change method, never GET/HEAD (was ${sent.method})`,
    );
    assert.ok(
      requestHeaderText(f.requests).includes(OAUTH_TOKEN),
      "the connection's Bearer access token is presented to Outlook mail",
    );
    assert.equal(result.status, 202, "the upstream status is returned");
  } finally {
    await db.close();
  }
});

test("callMicrosoftTool REFUSES a connection that needs reconnecting and sends NO request", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "reconnect");
    const dek = freshDek();
    // The same person's Microsoft connection, but it needs reconnecting (a failed refresh).
    const conn = await seedConnection(db, CALENDAR_ENTRY, userId, dek, "needs_reconnect");
    const f = recordingFetch(okResponse);

    await assert.rejects(
      callMicrosoftTool(
        { tool: "microsoft-outlook-calendar__list", entry: CALENDAR_ENTRY, userId, connectionId: conn.id, dek },
        makeDeps(db, f.fetch),
      ),
      "a tool is refused while the connection needs reconnecting",
    );
    assert.equal(f.requests.length, 0, "no request is sent to Microsoft while the connection needs reconnecting");
  } finally {
    await db.close();
  }
});

test("callMicrosoftTool refuses a connection that is not the session user's and sends NO request", async () => {
  const db = await freshDb();
  try {
    const owner = await makeUser(db, "owner");
    const other = await makeUser(db, "other");
    const dek = freshDek();
    const conn = await seedConnection(db, CALENDAR_ENTRY, owner, dek, "connected");
    const f = recordingFetch(okResponse);

    await assert.rejects(
      callMicrosoftTool(
        { tool: "microsoft-outlook-calendar__list", entry: CALENDAR_ENTRY, userId: other, connectionId: conn.id, dek },
        makeDeps(db, f.fetch),
      ),
      "another person cannot drive a tool through someone else's Microsoft connection",
    );
    assert.equal(f.requests.length, 0, "no request is sent when the connection is not the caller's");
  } finally {
    await db.close();
  }
});

test("callMicrosoftTool refuses an unknown tool name and sends NO request", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "unknown-tool");
    const dek = freshDek();
    const conn = await seedConnection(db, CALENDAR_ENTRY, userId, dek, "connected");
    const f = recordingFetch(okResponse);

    await assert.rejects(
      callMicrosoftTool(
        { tool: "microsoft-outlook-calendar__nuke_everything", entry: CALENDAR_ENTRY, userId, connectionId: conn.id, dek },
        makeDeps(db, f.fetch),
      ),
      "a tool name that is not a declared curated tool is refused",
    );
    assert.equal(f.requests.length, 0, "an unknown tool never produces an upstream request");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:secrets-from-env] (INV-103) — config is injected; this module reads no
// process.env and folds no ambient secret into the outbound request or the result. Shown
// behaviourally: the request carries the INJECTED (DEK-decrypted) Bearer token, and a decoy
// secret planted in the environment never appears in the request or the returned result.
// ===========================================================================

test("the request carries the INJECTED Bearer; an ambient env secret never appears", async () => {
  const prev = process.env.WARTHOG_MICROSOFT_SECRET;
  process.env.WARTHOG_MICROSOFT_SECRET = DECOY_SECRET;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "secrets");
    const dek = freshDek();
    const conn = await seedConnection(db, CALENDAR_ENTRY, userId, dek, "connected");
    const f = recordingFetch(okResponse);

    const result = await callMicrosoftTool(
      { tool: "microsoft-outlook-calendar__list", entry: CALENDAR_ENTRY, userId, connectionId: conn.id, dek },
      makeDeps(db, f.fetch),
    );

    const sent = requestText(f.requests);
    assert.ok(sent.includes(OAUTH_TOKEN), "the injected connection token is what the request presents");
    assert.ok(!sent.includes(DECOY_SECRET), "no ambient env secret is folded into the request");
    assert.ok(!JSON.stringify(result).includes(DECOY_SECRET), "no ambient env secret lands in the result");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_MICROSOFT_SECRET;
    else process.env.WARTHOG_MICROSOFT_SECRET = prev;
  }
});

// ===========================================================================
// AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
// `../../http/validate` boundary rejects malformed / oversized / mis-typed input with a 4xx
// BEFORE any query or upstream request runs, shape-guards the connection id (OBS-049 — it
// reaches `WHERE id = $1`), takes the user id from the SESSION (never the body), and binds
// every value (so a SQL probe cannot alter a query).
//
// The handler below is a TEST FIXTURE that exercises the real validation boundary and this
// task's curated-call path — the intended usage, not an implementation file. (A route
// `route.ts` exports only its HTTP verbs; this factory lives beside it — a sibling seam —
// per the App-Router rules.)
// ===========================================================================

function curatedToolHandler(opts: {
  deps: CuratedToolDeps;
  dek: Uint8Array;
  sessionUserId: string;
  resolveEntry: (connectorId: string) => CatalogueEntry | undefined;
}): (req: Request) => Promise<Response> {
  // The body names the curated tool, which owned connection, and optional query/body. The
  // user id comes from the SESSION, never the body. The connection id is shape-guarded as a
  // uuid (OBS-049). Lengths are capped so an absurd value is rejected, yet generous enough
  // that a probe can still REACH a query.
  const schema = z.object({
    tool: z.string().min(1).max(64),
    connectionId: z.uuid(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.string().max(100 * 1024).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const input = await parseBody(schema, req, { maxBytes: 64 * 1024 });
      // The connection is resolved member-scoped by the SESSION id; its connector names the
      // catalogue entry (the host comes only from there).
      const connection = await getConnectionById(opts.deps.db, opts.sessionUserId, input.connectionId);
      if (!connection) throw new HttpError(404, "unknown connection");
      const entry = opts.resolveEntry(connection.connectorId);
      if (!entry) throw new HttpError(400, "unknown connector");

      const result = await callMicrosoftTool(
        {
          tool: input.tool,
          entry,
          userId: opts.sessionUserId,
          connectionId: input.connectionId,
          dek: opts.dek,
          query: input.query,
          body: input.body,
        },
        opts.deps,
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/connections/microsoft/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const CATALOGUE = (id: string): CatalogueEntry | undefined => ENTRY_BY_CONNECTOR[id];

test("the handler rejects malformed JSON with a 4xx and reaches neither a query nor a request", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = curatedToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId: randomUUID(),
    resolveEntry: CATALOGUE,
  });

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
  assert.equal(f.requests.length, 0, "malformed input must never reach an upstream request");
});

test("the handler rejects an oversized body with a 4xx and reaches neither a query nor a request", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = curatedToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId: randomUUID(),
    resolveEntry: CATALOGUE,
  });

  // ~200 KiB body field, well over the handler's 64 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(
      JSON.stringify({ tool: "microsoft-outlook-mail__send", connectionId: randomUUID(), body: "a".repeat(200 * 1024) }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
  assert.equal(f.requests.length, 0, "an oversized body must never reach an upstream request");
});

test("the handler rejects a mis-typed / missing field with a 4xx", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = curatedToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId: randomUUID(),
    resolveEntry: CATALOGUE,
  });

  // tool must be a string — a number is a schema violation, rejected before any query.
  const misTyped = await handler(
    jsonRequest(JSON.stringify({ tool: 123, connectionId: randomUUID() })),
  );
  assert.ok(misTyped.status >= 400 && misTyped.status < 500, `expected a 4xx, got ${misTyped.status}`);

  // connectionId is required — its absence is a schema violation.
  const missing = await handler(jsonRequest(JSON.stringify({ tool: "microsoft-outlook-calendar__list" })));
  assert.ok(missing.status >= 400 && missing.status < 500, `expected a 4xx, got ${missing.status}`);

  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
  assert.equal(f.requests.length, 0, "a schema violation must never reach an upstream request");
});

test("the handler shape-guards the connection id: a SQL-probe-shaped id is a 4xx, never a query (OBS-049)", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = curatedToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId: randomUUID(),
    resolveEntry: CATALOGUE,
  });

  // A connection id shaped like a SQL-injection probe is not a uuid: the boundary refuses it
  // before it could ever reach `WHERE id = $1` (it would otherwise be an unhandled cast 500).
  const res = await handler(
    jsonRequest(
      JSON.stringify({
        tool: "microsoft-outlook-calendar__list",
        connectionId: "x'); DROP TABLE connections; --",
      }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "the probe is rejected at the boundary and never reaches a query");
  assert.equal(f.requests.length, 0, "and never reaches an upstream request");
});

test("the handler binds the connection id as a parameter, never splicing it into the SQL", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const sessionUserId = randomUUID();
  const connectionId = randomUUID(); // a well-formed (bindable) id that passes the shape guard
  const handler = curatedToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId,
    resolveEntry: CATALOGUE,
  });

  // The recording db returns no rows, so the flow stops at "unknown connection" — but the id
  // has already reached the member-scoped lookup as a BOUND value (the parameterize half).
  const res = await handler(
    jsonRequest(JSON.stringify({ tool: "microsoft-outlook-calendar__list", connectionId })),
  );

  assert.ok(res.status >= 400 && res.status < 500, "an unknown connection is a 4xx");
  assertBoundNotSpliced(db, connectionId);
  assert.ok(
    db.calls.some((c) => c.values.includes(sessionUserId)),
    "the lookup is member-scoped by the session id",
  );
  assert.equal(f.requests.length, 0, "an unknown connection never produces an upstream request");
});

test("the handler accepts a well-formed request for the SESSION user and returns the upstream response", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const conn = await seedConnection(db, CALENDAR_ENTRY, userId, dek, "connected");
    const f = recordingFetch(okResponse);
    const handler = curatedToolHandler({
      deps: makeDeps(db, f.fetch),
      dek,
      sessionUserId: userId,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(JSON.stringify({ tool: "microsoft-outlook-calendar__list", connectionId: conn.id })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const payload = (await res.json()) as CuratedToolResult;
    assert.equal(payload.status, 200, "the upstream status is reported");
    assert.equal(payload.body, "ok-body", "the upstream body is reported");
    assert.equal(f.requests.length, 1, "exactly one upstream request is made");
    assert.equal(new URL(f.requests[0]!.url).host, GRAPH_HOST, "to the entry's host");
  } finally {
    await db.close();
  }
});

test("the handler is member-scoped: it refuses another person's connection with a 4xx and sends NO request", async () => {
  const db = await freshDb();
  try {
    const owner = await makeUser(db, "handler-owner");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const conn = await seedConnection(db, CALENDAR_ENTRY, owner, dek, "connected");
    const f = recordingFetch(okResponse);

    // The attacker's session drives the handler but names the OWNER's connection id.
    const handler = curatedToolHandler({
      deps: makeDeps(db, f.fetch),
      dek,
      sessionUserId: attacker,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(JSON.stringify({ tool: "microsoft-outlook-calendar__list", connectionId: conn.id })),
    );

    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(f.requests.length, 0, "another person's connection never produces an upstream request");
  } finally {
    await db.close();
  }
});
