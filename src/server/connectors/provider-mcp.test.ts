// E09-S08 — Provider-hosted MCP client (CIMD / DCR) (`src/server/connectors/provider-mcp.ts`).
//
// RED-first: the module does NOT exist yet, so importing `./provider-mcp` throws and
// every test here fails at load — that absence IS the point of test-first. As the
// TESTER I must NOT create or edit the module (or any implementation/source file) to
// make these pass; the builder writes `provider-mcp.ts` afterwards to this contract.
//
// WHY this exists (task E09-S08; design §6.1, §7 "Connector engine"): a `provider_mcp`
// connector is reached as an MCP *client*. It is always connectable because Warthog
// self-registers — it presents its own Client ID Metadata Document URL
// (`/oauth/client-metadata.json`) as its `client_id` when the provider advertises CIMD
// support, and falls back to Dynamic Client Registration (RFC 7591) when it does not —
// then lists the provider's tools. Every outbound fetch (discovery, DCR, the MCP
// transport) is SSRF-guarded (the guard itself is pinned in `./provider-mcp.guarded-fetch.test.ts`).
//
// The provider HOST is taken ONLY from the catalogue entry's `base_url` and the
// provider's OWN discovery metadata — never a value from the caller (CLAUDE.md
// security: "Connector requests never take a host from the caller").
//
// These tests pin BEHAVIOUR (which registration path is taken, the request the client
// sends, the client_id handed to the transport, the stored/returned connection, the
// tools listed), never the source text of any file — a later rename that preserves
// behaviour must not redden them. HTTP, time and the MCP transport are injected seams
// (conventions: external services sit behind fakes; tests never touch the network): a
// recording `fetch` stands in for the provider's discovery/DCR endpoints, a fixed clock
// freezes time, and a recording `listTools` stands in for the MCP client. The db is the
// real in-memory PGlite with the real migrations (`../../test/db`), or a recording
// stand-in that proves what reached the query layer.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface ProviderTool { name: string; description?: string }   // one MCP tool
//
//   type ListProviderTools = (params: {                 // the MCP-client seam
//     serverUrl: string;                                // the provider MCP server = entry.base_url
//     clientId:  string;                                // Warthog's resolved client_id
//     fetch:     typeof fetch;                           // the SSRF-guarded outbound fetch
//   }) => Promise<ProviderTool[]>;
//
//   interface ProviderMcpConfig {                        // from config (the one env reader,
//     clientMetadataUrl: string;                         // INV-103). The https URL Warthog
//   }                                                    // presents as its client_id under CIMD
//                                                        // (it points at /oauth/client-metadata.json).
//
//   interface ProviderMcpDeps {                          // injected seams
//     db: Db; clock: Clock; fetch: typeof fetch; listTools: ListProviderTools;
//   }
//
//   connectProviderMcp(
//     { entry, config, userId, accountLabel, dek },
//     deps): Promise<{ connection: Connection; tools: ProviderTool[] }>
//     • Discovers the provider's authorization-server metadata over `deps.fetch` (host
//       from `entry.base_url` / the provider's own metadata only).
//     • If the metadata advertises `client_id_metadata_document_supported: true`,
//       registers via CIMD: it presents `config.clientMetadataUrl` as its client_id and
//       makes NO DCR request. Otherwise it falls back to DCR: it POSTs to the metadata's
//       `registration_endpoint` and uses the issued `client_id`.
//     • Lists the provider's tools through `deps.listTools`, handing it the provider
//       server URL, the resolved client_id and `deps.fetch` (so the transport is guarded
//       too).
//     • Stores the connection DEK-encrypted on a NEW connection owned by `userId`
//       (connectorId = entry.id, the given accountLabel, status "connected"), through the
//       SAME `../db/connections` record store the generic (api_key/oauth2) connectors use.
//       Returns the Connection (WITHOUT credentials) and the listed tools.
//
// `userId` is always the session's id (never a client value); every member-scoped read /
// write binds it. "Absence" assertions are scoped narrowly to the exact surface under
// test (a client_id legitimately lives, encrypted, in a column and decrypts behind
// getConnectionCredentials — so the at-rest scan is the raw columns only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  connectProviderMcp,
  type ProviderMcpConfig,
  type ProviderMcpDeps,
  type ProviderTool,
  type ListProviderTools,
} from "./provider-mcp";
import { saveApiKeyConnection } from "./api-key";
import { createUser } from "../db/users";
import {
  getConnectionById,
  getConnectionCredentials,
  listConnectionsForUser,
  type Connection,
} from "../db/connections";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import type { CatalogueEntry } from "../../domain/catalogue/schema";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const T0 = new Date("2026-05-01T10:00:00.000Z");
const CLOCK = fixedClock(T0);

// Two provider_mcp catalogue entries on DIFFERENT hosts (shaped like the real seed:
// an empty `auth` block, a curated tool list). The MCP server host is taken from each
// entry's base_url — the client takes the host from HERE, never a caller value.
const GITHUB_ENTRY: CatalogueEntry = {
  id: "github",
  name: "GitHub",
  aliases: ["github repos"],
  category: "developer-tools",
  auth_kind: "provider_mcp",
  base_url: "https://api.githubcopilot.com/mcp/",
  auth: {},
  curated_tools: [{ name: "list_repositories" }],
};

const NOTION_ENTRY: CatalogueEntry = {
  id: "notion",
  name: "Notion",
  aliases: ["notion workspace"],
  category: "productivity",
  auth_kind: "provider_mcp",
  base_url: "https://mcp.notion.com/mcp",
  auth: {},
  curated_tools: [{ name: "search_pages" }],
};

// A generic (self-contained) api_key entry — no verify request, so saving it makes no
// outbound call. Used to show the generic shape and the provider_mcp shape resolve
// through the SAME connection record store (AC3).
const GENERIC_API_KEY_ENTRY: CatalogueEntry = {
  id: "generic-key-service",
  name: "Generic key service",
  aliases: ["generic"],
  category: "productivity",
  auth_kind: "api_key",
  base_url: "https://api.generic.example",
  auth: { header: "Authorization: Bearer {api_key}" },
};

// The operator-configured identity. `clientMetadataUrl` carries Warthog's OWN host
// (warthog.com.au) — the CIMD client_id. Warthog NEVER fetches this URL (the provider
// fetches it); it only ever presents it as its client_id.
const CONFIG: ProviderMcpConfig = {
  clientMetadataUrl: "https://warthog.com.au/oauth/client-metadata.json",
};
const WARTHOG_HOST = new URL(CONFIG.clientMetadataUrl).host;

const GITHUB_HOST = new URL(GITHUB_ENTRY.base_url).host;
const NOTION_HOST = new URL(NOTION_ENTRY.base_url).host;

const DCR_CLIENT_ID = "dcr-issued-CLIENTID-xyz-123";

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

function makeDeps(
  db: Db,
  clock: Clock,
  fetchFn: typeof globalThis.fetch,
  listTools: ListProviderTools,
): ProviderMcpDeps {
  return { db, clock, fetch: fetchFn, listTools };
}

// --- the provider's discovery + DCR endpoints, faked -------------------------------

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly headersText: string;
}

function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

// A recording `fetch` that models ONE provider host: every GET returns the provider's
// authorization-server / protected-resource metadata (a superset of both shapes, with
// every endpoint pointing back at the provider's own host), and every POST is treated
// as the DCR registration and returns an issued `client_id` (RFC 7591). The CIMD-support
// flag is what drives the module's branch. No network.
function providerFetch(opts: {
  host: string;
  cimdSupported: boolean;
}): { fetch: typeof globalThis.fetch; requests: SeenRequest[] } {
  const requests: SeenRequest[] = [];
  const origin = `https://${opts.host}`;
  const metadata = {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    client_id_metadata_document_supported: opts.cimdSupported,
    token_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
  };
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    requests.push({
      url,
      method,
      body: bodyToString(init?.body),
      headersText: [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"),
    });
    if (method === "POST") {
      return new Response(
        JSON.stringify({
          client_id: DCR_CLIENT_ID,
          client_id_issued_at: 0,
          redirect_uris: [`${WARTHOG_HOST}`],
          token_endpoint_auth_method: "none",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fn, requests };
}

// What a captured request reveals, for narrow "a secret must not appear" scans.
function requestText(requests: SeenRequest[]): string {
  return requests.map((r) => [r.url, r.body, r.headersText].join("\n")).join("\n");
}

// A recording `listTools` seam: captures the params it was handed and returns the given
// tools. The MCP transport never actually runs (no network).
function recordingListTools(tools: ProviderTool[]): {
  listTools: ListProviderTools;
  calls: { serverUrl: string; clientId: string; fetch: typeof globalThis.fetch }[];
} {
  const calls: { serverUrl: string; clientId: string; fetch: typeof globalThis.fetch }[] = [];
  const listTools: ListProviderTools = async (params) => {
    calls.push({ serverUrl: params.serverUrl, clientId: params.clientId, fetch: params.fetch });
    return tools;
  };
  return { listTools, calls };
}

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

async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Every string cell of the connections table, for a narrow at-rest leak scan.
async function rawConnectionsText(db: Db): Promise<string> {
  const all = await db.query("SELECT * FROM connections");
  const parts: string[] = [];
  for (const row of all.rows) {
    for (const cell of Object.values(row)) {
      if (typeof cell === "string") parts.push(cell);
    }
  }
  return parts.join("\n");
}

// A returned Connection carries NO credentials, scoped to the one object.
function assertNoCredentialsField(connection: Connection): void {
  const obj = connection as unknown as Record<string, unknown>;
  assert.ok(!("credentials" in obj), "the connection shape carries no credentials field");
}

function postRequests(requests: SeenRequest[]): SeenRequest[] {
  return requests.filter((r) => r.method === "POST");
}

// ===========================================================================
// AC1 — connecting a provider_mcp entry registers via CIMD (when the provider
// advertises it) and lists the provider's tools.
// ===========================================================================

test("connectProviderMcp registers via CIMD when the provider advertises it, makes NO DCR request, and lists the tools", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "cimd");
    const dek = freshDek();
    const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
    const lt = recordingListTools([{ name: "list_repositories" }, { name: "create_issue" }]);

    const result = await connectProviderMcp(
      { entry: GITHUB_ENTRY, config: CONFIG, userId, accountLabel: "oren's github", dek },
      makeDeps(db, CLOCK, f.fetch, lt.listTools),
    );

    // Registered via CIMD → the client_id presented to the transport is Warthog's own
    // CIMD document URL, and NO DCR registration request was sent.
    assert.equal(lt.calls.length, 1, "the provider's tools are listed exactly once");
    assert.equal(lt.calls[0]!.clientId, CONFIG.clientMetadataUrl, "the CIMD client_id is the metadata document URL");
    assert.equal(
      postRequests(f.requests).length,
      0,
      "CIMD support means no DCR registration POST is made",
    );

    // The MCP server URL handed to the transport is at the ENTRY's host (host from the
    // entry only; a trailing-slash normalisation is immaterial).
    assert.equal(new URL(lt.calls[0]!.serverUrl).host, GITHUB_HOST, "the transport is pointed at the entry's MCP server host");

    // The provider's tools are returned.
    assert.deepEqual(
      result.tools.map((t) => t.name).sort(),
      ["create_issue", "list_repositories"],
      "the provider's listed tools are returned",
    );

    // A connection was recorded for this connector, owned by the session user.
    assert.equal(result.connection.userId, userId, "the connection is owned by the session user");
    assert.equal(result.connection.connectorId, GITHUB_ENTRY.id, "the connector is the entry's id");
    assert.equal(result.connection.accountLabel, "oren's github", "the account label is recorded");
    assert.equal(result.connection.status, "connected", "a freshly connected provider is 'connected'");
    assertNoCredentialsField(result.connection);

    const listed = await listConnectionsForUser(db, userId);
    assert.equal(listed.length, 1, "the connection is persisted and listed");
    assert.equal(listed[0]!.id, result.connection.id, "the listed connection is the one just created");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — when CIMD is unsupported, registration falls back to DCR (RFC 7591).
// ===========================================================================

test("connectProviderMcp falls back to DCR when the provider does not advertise CIMD, and uses the issued client_id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "dcr");
    const dek = freshDek();
    const f = providerFetch({ host: NOTION_HOST, cimdSupported: false });
    const lt = recordingListTools([{ name: "search_pages" }]);

    const result = await connectProviderMcp(
      { entry: NOTION_ENTRY, config: CONFIG, userId, accountLabel: "oren's notion", dek },
      makeDeps(db, CLOCK, f.fetch, lt.listTools),
    );

    // A DCR registration POST was sent — to the metadata's registration_endpoint, which
    // is at the PROVIDER's host (never the caller/config host).
    const posts = postRequests(f.requests);
    assert.equal(posts.length, 1, "exactly one DCR registration POST is made");
    assert.equal(new URL(posts[0]!.url).host, NOTION_HOST, "the DCR POST goes to the provider's host");
    assert.equal(new URL(posts[0]!.url).pathname, "/oauth/register", "…at the metadata's registration_endpoint");

    // The transport is handed the DCR-ISSUED client_id (not the CIMD document URL).
    assert.equal(lt.calls.length, 1, "the provider's tools are listed exactly once");
    assert.equal(lt.calls[0]!.clientId, DCR_CLIENT_ID, "the DCR-issued client_id is used");
    assert.notEqual(lt.calls[0]!.clientId, CONFIG.clientMetadataUrl, "…not the CIMD document URL");

    assert.deepEqual(result.tools.map((t) => t.name), ["search_pages"], "the provider's tools are returned");

    // The issued client_id persists (a DCR client_id is dynamic and must be stored) —
    // DEK-encrypted, decrypting only under the owner's DEK.
    const creds = await getConnectionCredentials(db, userId, result.connection.id, dek);
    assert.ok(
      JSON.stringify(creds).includes(DCR_CLIENT_ID),
      "the DCR-issued client_id is stored and decrypts under the owner's DEK",
    );

    assert.equal(result.connection.connectorId, NOTION_ENTRY.id, "the connector is the entry's id");
    assert.equal(result.connection.status, "connected", "a freshly connected provider is 'connected'");
  } finally {
    await db.close();
  }
});

test("a provider that omits the CIMD-support flag entirely falls back to DCR", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "dcr-absent");
    const dek = freshDek();
    // A metadata document WITHOUT `client_id_metadata_document_supported` — absence must
    // be treated as "unsupported", so the client registers via DCR.
    const requests: SeenRequest[] = [];
    const origin = `https://${NOTION_HOST}`;
    const metadataNoFlag = {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      token_endpoint_auth_methods_supported: ["none"],
    };
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = String(init?.method ?? "GET").toUpperCase();
      requests.push({ url, method, body: bodyToString(init?.body), headersText: "" });
      if (method === "POST") {
        return new Response(JSON.stringify({ client_id: DCR_CLIENT_ID, token_endpoint_auth_method: "none" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(metadataNoFlag), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const lt = recordingListTools([{ name: "search_pages" }]);

    await connectProviderMcp(
      { entry: NOTION_ENTRY, config: CONFIG, userId, accountLabel: "oren's notion", dek },
      makeDeps(db, CLOCK, fetchFn, lt.listTools),
    );

    assert.equal(postRequests(requests).length, 1, "an absent CIMD flag registers via DCR");
    assert.equal(lt.calls[0]!.clientId, DCR_CLIENT_ID, "the DCR-issued client_id is used");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 (host-safety half; the SSRF guard proper is pinned in the guarded-fetch test) —
// the discovery/registration host is the provider's, never the caller/config host, and
// the SSRF-guarded fetch is handed to the MCP transport too.
// ===========================================================================

test("discovery targets the provider's host from the entry — a Notion entry and a GitHub entry reach different provider hosts", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "host");
    const dek = freshDek();

    const gh = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
    const ghTools = recordingListTools([{ name: "list_repositories" }]);
    await connectProviderMcp(
      { entry: GITHUB_ENTRY, config: CONFIG, userId, accountLabel: "gh", dek },
      makeDeps(db, CLOCK, gh.fetch, ghTools.listTools),
    );

    const no = providerFetch({ host: NOTION_HOST, cimdSupported: true });
    const noTools = recordingListTools([{ name: "search_pages" }]);
    await connectProviderMcp(
      { entry: NOTION_ENTRY, config: CONFIG, userId, accountLabel: "no", dek },
      makeDeps(db, CLOCK, no.fetch, noTools.listTools),
    );

    assert.ok(gh.requests.length >= 1, "GitHub discovery made at least one request");
    assert.ok(no.requests.length >= 1, "Notion discovery made at least one request");
    for (const r of gh.requests) {
      assert.equal(new URL(r.url).host, GITHUB_HOST, "every GitHub request targets GitHub's host");
    }
    for (const r of no.requests) {
      assert.equal(new URL(r.url).host, NOTION_HOST, "every Notion request targets Notion's host");
    }
    // Never the caller/config host (warthog.com.au) — Warthog never fetches its own CIMD
    // document; it only presents the URL as its client_id.
    for (const r of [...gh.requests, ...no.requests]) {
      assert.notEqual(new URL(r.url).host, WARTHOG_HOST, "no outbound request targets the config/caller host");
    }
  } finally {
    await db.close();
  }
});

test("the MCP transport is handed the module's own SSRF-guarded fetch", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "transport");
    const dek = freshDek();
    const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
    const lt = recordingListTools([{ name: "list_repositories" }]);

    await connectProviderMcp(
      { entry: GITHUB_ENTRY, config: CONFIG, userId, accountLabel: "gh", dek },
      makeDeps(db, CLOCK, f.fetch, lt.listTools),
    );

    // The exact fetch injected as the (guarded) outbound HTTP seam is the one the MCP
    // transport receives — so the transport's own requests are guarded as well.
    assert.equal(lt.calls.length, 1, "the transport was invoked");
    assert.equal(lt.calls[0]!.fetch, f.fetch, "the transport uses the module's SSRF-guarded fetch, not the bare global fetch");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 (at-rest) — a provider_mcp connection stores its registration DEK-encrypted; the
// issued client_id never appears in a raw column.
// ===========================================================================

test("the DCR-issued client_id is stored only encrypted — the plaintext never appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "atrest");
    const dek = freshDek();
    const f = providerFetch({ host: NOTION_HOST, cimdSupported: false });
    const lt = recordingListTools([{ name: "search_pages" }]);

    const result = await connectProviderMcp(
      { entry: NOTION_ENTRY, config: CONFIG, userId, accountLabel: "oren's notion", dek },
      makeDeps(db, CLOCK, f.fetch, lt.listTools),
    );

    const raw = await rawConnectionsText(db);
    assert.ok(!raw.includes(DCR_CLIENT_ID), "the issued client_id is not stored in plaintext");

    const creds = await getConnectionCredentials(db, userId, result.connection.id, dek);
    assert.ok(JSON.stringify(creds).includes(DCR_CLIENT_ID), "but it decrypts under the owner's DEK");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the curated/registry-linked shape (provider_mcp, which needs CIMD/DCR
// resolution) and the generic self-contained shape (api_key/oauth2) BOTH resolve through
// the SAME connection record store, member-scoped by the session's user id.
// ===========================================================================

test("a provider_mcp connection and a generic api_key connection resolve through the same connection record store", async () => {
  const db = await freshDb();
  try {
    const owner = await makeUser(db, "both-owner");
    const other = await makeUser(db, "both-other");
    const dek = freshDek();

    // The provider_mcp (CIMD-resolved) shape.
    const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
    const lt = recordingListTools([{ name: "list_repositories" }]);
    const mcp = await connectProviderMcp(
      { entry: GITHUB_ENTRY, config: CONFIG, userId: owner, accountLabel: "gh", dek },
      makeDeps(db, CLOCK, f.fetch, lt.listTools),
    );

    // The generic self-contained shape (api_key, no verify → no outbound call).
    const generic = await saveApiKeyConnection(
      {
        entry: GENERIC_API_KEY_ENTRY,
        userId: owner,
        accountLabel: "my key",
        apiKey: "sk_generic_123",
        dek,
      },
      { db, clock: CLOCK, fetch: f.fetch },
    );

    // BOTH are rows in the SAME connections store for the owner.
    const listed = await listConnectionsForUser(db, owner);
    const ids = listed.map((c) => c.id).sort();
    assert.deepEqual(
      ids,
      [mcp.connection.id, generic.connection.id].sort(),
      "both shapes are listed from the one connection record store",
    );

    // Both are retrievable by id, and both carry the SAME Connection shape (same keys).
    const mcpById = await getConnectionById(db, owner, mcp.connection.id);
    const genericById = await getConnectionById(db, owner, generic.connection.id);
    assert.ok(mcpById && genericById, "both resolve by id through one accessor");
    assert.deepEqual(
      Object.keys(mcpById!).sort(),
      Object.keys(genericById!).sort(),
      "both shapes resolve to the identical connection record shape",
    );

    // Both decrypt their stored credentials under the owner's DEK through the one accessor.
    assert.ok(
      JSON.stringify(await getConnectionCredentials(db, owner, generic.connection.id, dek)).includes("sk_generic_123"),
      "the generic connection's key resolves through getConnectionCredentials",
    );
    assert.ok(
      (await getConnectionCredentials(db, owner, mcp.connection.id, dek)) !== null,
      "the provider_mcp connection resolves through the SAME getConnectionCredentials",
    );

    // Member scope: another person resolves NEITHER record.
    assert.deepEqual(await listConnectionsForUser(db, other), [], "another person sees neither connection");
    assert.equal(await getConnectionById(db, other, mcp.connection.id), null, "…and cannot fetch the provider_mcp one by id");
    assert.equal(await getConnectionById(db, other, generic.connection.id), null, "…nor the generic one");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
// `../http/validate` boundary rejects malformed / oversized / missing / mis-typed /
// unknown-connector input with a 4xx BEFORE any query or outbound request runs, and a
// SQL-injection probe routed through the client is BOUND as a parameter.
//
// The handler below is a TEST FIXTURE that exercises the real validation boundary and
// this task's client — the intended usage, not an implementation file.
// ===========================================================================

function connectHandler(opts: {
  deps: ProviderMcpDeps;
  dek: Uint8Array;
  sessionUserId: string;
  resolveEntry: (connectorId: string) => CatalogueEntry | undefined;
}): (req: Request) => Promise<Response> {
  // The person picks a catalogue connector and a label. The user id comes from the
  // SESSION, never the body. Lengths are capped so an absurd value is rejected, yet
  // generous enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    connectorId: z.string().min(1).max(64),
    accountLabel: z.string().min(1).max(200),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      // The host comes ONLY from the catalogue: an unknown connector is refused here,
      // before the client is ever asked to reach a provider.
      const entry = opts.resolveEntry(body.connectorId);
      if (!entry) throw new HttpError(400, "unknown connector");
      const { connection } = await connectProviderMcp(
        {
          entry,
          config: CONFIG,
          userId: opts.sessionUserId,
          accountLabel: body.accountLabel,
          dek: opts.dek,
        },
        opts.deps,
      );
      return new Response(JSON.stringify({ id: connection.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/connectors/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const CATALOGUE = (id: string): CatalogueEntry | undefined =>
  id === GITHUB_ENTRY.id ? GITHUB_ENTRY : id === NOTION_ENTRY.id ? NOTION_ENTRY : undefined;

test("the handler rejects malformed JSON with a 4xx and reaches neither a query nor an outbound request", async () => {
  const db = recordingDb();
  const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
  const lt = recordingListTools([{ name: "list_repositories" }]);
  const handler = connectHandler({
    deps: makeDeps(db, CLOCK, f.fetch, lt.listTools),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
  assert.equal(f.requests.length, 0, "malformed input must never reach the provider");
  assert.equal(lt.calls.length, 0, "malformed input must never reach the MCP transport");
});

test("the handler rejects an oversized body with a 4xx and reaches neither a query nor an outbound request", async () => {
  const db = recordingDb();
  const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
  const lt = recordingListTools([{ name: "list_repositories" }]);
  const handler = connectHandler({
    deps: makeDeps(db, CLOCK, f.fetch, lt.listTools),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  const res = await handler(
    jsonRequest(
      JSON.stringify({ connectorId: GITHUB_ENTRY.id, accountLabel: "a".repeat(20 * 1024) }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
  assert.equal(f.requests.length, 0, "an oversized body must never reach the provider");
});

test("the handler rejects a body missing a required field with a 4xx", async () => {
  const db = recordingDb();
  const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
  const lt = recordingListTools([{ name: "list_repositories" }]);
  const handler = connectHandler({
    deps: makeDeps(db, CLOCK, f.fetch, lt.listTools),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  const res = await handler(jsonRequest(JSON.stringify({ connectorId: GITHUB_ENTRY.id })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
  assert.equal(f.requests.length, 0, "a schema violation must never reach the provider");
});

test("the handler rejects a mis-typed field with a 4xx", async () => {
  const db = recordingDb();
  const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
  const lt = recordingListTools([{ name: "list_repositories" }]);
  const handler = connectHandler({
    deps: makeDeps(db, CLOCK, f.fetch, lt.listTools),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // accountLabel must be a string — a number is a schema violation, rejected pre-query.
  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: GITHUB_ENTRY.id, accountLabel: 12345 })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
  assert.equal(f.requests.length, 0, "a mis-typed field must never reach the provider");
});

test("the handler refuses an unknown connector with a 4xx — the host comes only from the catalogue", async () => {
  const db = recordingDb();
  const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
  const lt = recordingListTools([{ name: "list_repositories" }]);
  const handler = connectHandler({
    deps: makeDeps(db, CLOCK, f.fetch, lt.listTools),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: "not-in-the-catalogue", accountLabel: "x" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(f.requests.length, 0, "an unknown connector never produces an outbound request");
  assert.equal(db.calls.length, 0, "an unknown connector never reaches a query");
});

test("a SQL-injection probe routed through the client is BOUND as a parameter, never spliced into the SQL", async () => {
  const db = recordingDb();
  const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
  const lt = recordingListTools([{ name: "list_repositories" }]);
  const probe = "oren'); DROP TABLE connections; --";
  const handler = connectHandler({
    deps: makeDeps(db, CLOCK, f.fetch, lt.listTools),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // A valid-shaped (if nasty) label: it passes validation, the connect flow completes
  // against the fakes, and the probe reaches the INSERT as a bound value.
  await handler(jsonRequest(JSON.stringify({ connectorId: GITHUB_ENTRY.id, accountLabel: probe })));

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe account label is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "probe");
    const dek = freshDek();
    const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
    const lt = recordingListTools([{ name: "list_repositories" }]);
    const probe = "oren'); DROP TABLE connections; --";
    const handler = connectHandler({
      deps: makeDeps(db, CLOCK, f.fetch, lt.listTools),
      dek,
      sessionUserId: userId,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(jsonRequest(JSON.stringify({ connectorId: GITHUB_ENTRY.id, accountLabel: probe })));
    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "connections"), true, "the connections table must still exist");

    const { id } = (await res.json()) as { id: string };
    const stored = await getConnectionById(db, userId, id);
    assert.equal(stored!.accountLabel, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "session");
    const attacker = await makeUser(db, "attacker");
    const dek = freshDek();
    const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
    const lt = recordingListTools([{ name: "list_repositories" }]);
    const handler = connectHandler({
      deps: makeDeps(db, CLOCK, f.fetch, lt.listTools),
      dek,
      sessionUserId: sessionUser,
      resolveEntry: CATALOGUE,
    });

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, connectorId: GITHUB_ENTRY.id, accountLabel: "gh" })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal((await listConnectionsForUser(db, sessionUser)).length, 1, "recorded under the SESSION user");
    assert.deepEqual(
      await listConnectionsForUser(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 [obligation:secrets-from-env] (INV-103) — config is injected (read from env only
// by src/server/config.ts); this module reads no process.env and folds no ambient secret
// into its requests, its stored credentials, the returned connection, or the tools.
// Shown behaviourally: the INJECTED clientMetadataUrl is the CIMD client_id, and a decoy
// secret planted in the environment never appears anywhere the client produces.
// ===========================================================================

const DECOY_SECRET = "env-decoy-SECRET-must-never-be-used";

test("the CIMD client_id is the INJECTED clientMetadataUrl, and no ambient env secret reaches the requests, the stored columns, the connection, or the tools", async () => {
  const prev = process.env.WARTHOG_PROVIDER_MCP_SECRET;
  process.env.WARTHOG_PROVIDER_MCP_SECRET = DECOY_SECRET;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "secrets");
    const dek = freshDek();
    const f = providerFetch({ host: GITHUB_HOST, cimdSupported: true });
    const lt = recordingListTools([{ name: "list_repositories" }]);

    const result = await connectProviderMcp(
      { entry: GITHUB_ENTRY, config: CONFIG, userId, accountLabel: "gh", dek },
      makeDeps(db, CLOCK, f.fetch, lt.listTools),
    );

    // The injected client_id is what is used — never an ambient env value.
    assert.equal(lt.calls[0]!.clientId, CONFIG.clientMetadataUrl, "the injected clientMetadataUrl is the CIMD client_id");

    const sent = requestText(f.requests);
    assert.ok(!sent.includes(DECOY_SECRET), "no ambient env secret is sent in any outbound request");

    assert.ok(!JSON.stringify(result.connection).includes(DECOY_SECRET), "the decoy never lands in the returned connection");
    assert.ok(!JSON.stringify(result.tools).includes(DECOY_SECRET), "the decoy never lands in the listed tools");

    const raw = await rawConnectionsText(db);
    assert.ok(!raw.includes(DECOY_SECRET), "the decoy never lands in a stored column");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_PROVIDER_MCP_SECRET;
    else process.env.WARTHOG_PROVIDER_MCP_SECRET = prev;
  }
});
