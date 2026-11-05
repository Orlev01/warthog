// E09-S09 — General request tool (`src/server/connectors/request-tool.ts`).
//
// RED-first: the module does not exist yet, so importing `./request-tool` throws and
// every test here fails at load — that absence IS the point of test-first. As the TESTER
// I must NOT create or edit the module (or any implementation/source file) to make these
// pass; the builder writes `request-tool.ts` (and its sibling handler) afterwards to this
// contract.
//
// WHY this exists (task E09-S09; design §7 "Connector engine" — "General request tool per
// connector: `<id>__request {method, path, query, body}`; `path` is relative to the
// entry's base URL (host cannot be overridden → no SSRF); GET/HEAD = reads, anything else
// = makes changes. Upstream timeout 20 s; responses truncated to 100 KB for agents"):
// every connected service not covered by a curated tool is reachable through ONE
// authenticated request tool scoped to that service. The host is taken ONLY from the
// catalogue entry's `base_url` — never a caller value (CLAUDE.md security: "Connector
// requests never take a host from the caller"); a caller-supplied absolute URL or a path
// that tries to override the host is refused, so there is no SSRF.
//
// These tests pin BEHAVIOUR (which method is a read, which URL a relative path resolves
// to, what the outbound request carries, that an oversized body is truncated and a slow
// upstream is aborted, that a handler rejects bad input with a 4xx and binds every value)
// — never the source text of any file; a later rename that preserves behaviour must not
// redden them. The HTTP + data sources are injected seams (conventions: external services
// sit behind fakes; tests never touch the network) — a recording `fetch` stands in for the
// upstream service, the db is the real in-memory PGlite with the real migrations
// (`../../test/db`) or a recording/encrypted stand-in that proves what reached the query
// layer. Timeouts are driven with node:test's mock timers so no test waits 20 real seconds.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface RequestToolDeps {        // injected seams
//     db: Db;                          // the parameterizing data seam (member-scoped reads)
//     fetch: typeof fetch;             // the HTTP seam (SSRF-guarded fetch in prod)
//   }
//
//   interface ConnectorRequestInput {
//     entry: CatalogueEntry;           // the connector entry; the HOST (base_url) and the
//                                       // auth kind come from HERE, never from a caller
//     userId: string;                  // the SESSION's id (never a client value) — member scope
//     connectionId: string;            // which OWNED connection's credentials to present
//     dek: Uint8Array;                 // the owner's 256-bit data key (already unwrapped)
//     method: string;                  // GET/HEAD = read; anything else makes a change
//     path: string;                    // relative to entry.base_url; host override rejected
//     query?: Record<string, string>;  // appended as query parameters
//     body?: string;                   // forwarded on a method that carries a body
//   }
//
//   interface ConnectorRequestResult {
//     status: number;                  // the upstream status, passed through
//     body: string;                    // the upstream body, TRUNCATED to ~100 KB for agents
//     truncated: boolean;              // true iff the body was truncated at the cap
//   }
//
//   requestMakesChange(method: string): boolean
//     • GET / HEAD (any case) → false (a read); ANYTHING ELSE → true (makes a change), so
//       an unknown verb gets the stricter "makes changes" gate.
//
//   resolveRequestUrl(baseUrl: string, path: string, query?): URL
//     • Joins a RELATIVE path onto the entry base URL and appends the query parameters.
//     • REJECTS (throws an HttpError in the 4xx range) any attempt to override the host —
//       an absolute URL (scheme present) or a protocol-relative `//host` — so the host is
//       always the entry's.
//
//   sendConnectorRequest(input, deps): Promise<ConnectorRequestResult>
//     • Resolves the OWNED connection's credentials (member-scoped by `userId`), presents
//       them to the upstream (the api_key/basic header template, or a Bearer access token
//       for oauth2/provider_mcp), and sends ONE request to the entry's host at the resolved
//       relative path + query. Resolves for BOTH a provider_mcp (curated) and an
//       api_key/oauth2 (generic) connection.
//     • Truncates a response over ~100 KB; aborts the upstream call at 20 s.
//     • A path that tries to override the host is refused and NO request is sent.
//     • A connection that is not the session user's resolves no credentials → refused, no
//       request sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  requestMakesChange,
  resolveRequestUrl,
  sendConnectorRequest,
  type RequestToolDeps,
  type ConnectorRequestResult,
} from "./request-tool";
import { createUser } from "../db/users";
import { createConnection, getConnectionById, type Connection } from "../db/connections";
import { encrypt } from "../crypto/envelope";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { parseBody, HttpError } from "../http/validate";
import type { CatalogueEntry } from "../../domain/catalogue/schema";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// Distinctive secret values that must ride in the OUTBOUND request (authenticated tool)
// and must NEVER leak from an ambient env value. Distinctive so a scan is unambiguous.
const API_KEY_SECRET = "sk-APIKEY-9f8e7d6c-SECRET";
const OAUTH_TOKEN = "oauth-ACCESS-TOKEN-5a4b3c2d-SECRET";
const MCP_TOKEN = "mcp-ACCESS-TOKEN-1a2b3c4d-SECRET";
const DECOY_SECRET = "env-decoy-SECRET-must-never-be-used";

// A generic self-contained entry: api_key, host = api.acme.example, key injected into the
// entry's header TEMPLATE.
const API_KEY_ENTRY: CatalogueEntry = {
  id: "acme-notes",
  name: "Acme Notes",
  aliases: ["acme"],
  category: "notes",
  auth_kind: "api_key",
  base_url: "https://api.acme.example",
  auth: { header: "Authorization: Bearer {api_key}" },
  instructions: "Create a key in Acme settings.",
};

// A generic self-contained entry: oauth2 (provider sign-in), host = api.goog.example. Its
// stored credentials carry an access token presented as a Bearer.
const OAUTH2_ENTRY: CatalogueEntry = {
  id: "goog-drive",
  name: "Google Drive",
  aliases: ["gdrive"],
  category: "files",
  auth_kind: "oauth2",
  base_url: "https://api.goog.example",
  auth: {
    authorize_url: "https://auth.goog.example/authorize",
    token_url: "https://auth.goog.example/token",
    scopes: ["drive.readonly"],
  },
};

// A curated / registry-linked entry: provider_mcp, host = mcp.github.example. The request
// tool must resolve for THIS shape too (OBS-046 — the curated shape is the primary path and
// breaks at every seam the tester only exercised with the convenient self-contained shape).
const PROVIDER_MCP_ENTRY: CatalogueEntry = {
  id: "github",
  name: "GitHub",
  aliases: ["gh"],
  category: "developer-tools",
  auth_kind: "provider_mcp",
  base_url: "https://mcp.github.example",
  auth: {},
};

const ACME_HOST = new URL(API_KEY_ENTRY.base_url).host;
const GOOG_HOST = new URL(OAUTH2_ENTRY.base_url).host;
const GH_HOST = new URL(PROVIDER_MCP_ENTRY.base_url).host;

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

// Seed a connected service for `userId` with the given connector + stored credentials,
// through the REAL record store (DEK-encrypted). Returns the created connection.
async function seedConnection(
  db: Db,
  entry: CatalogueEntry,
  userId: string,
  credentials: Record<string, unknown>,
  dek: Uint8Array,
): Promise<Connection> {
  return createConnection(
    db,
    { userId, connectorId: entry.id, accountLabel: `${userId}@${entry.id}`, credentials },
    dek,
    { now: () => new Date("2026-05-01T10:00:00.000Z") },
  );
}

function makeDeps(db: Db, fetchFn: typeof globalThis.fetch): RequestToolDeps {
  return { db, fetch: fetchFn };
}

// --- the upstream service, faked ---------------------------------------------------

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

// A recording `fetch` stand-in: records every request and returns (or throws) whatever
// `respond` yields. No network.
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
// "the presented secret must ride HERE" scan (a credential rides in a header, by scheme).
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

// A db seam that answers the member-scoped credentials read with a REAL DEK-encrypted row
// (so the production `getConnectionCredentials` decrypts it faithfully) without touching
// PGlite — used by the timeout tests so node:test's mock timers never meet the driver.
async function credentialsDb(
  connectionId: string,
  dek: Uint8Array,
  credentials: Record<string, unknown>,
): Promise<Db> {
  const envelope = await encrypt(
    dek,
    "connections",
    "credentials",
    connectionId,
    JSON.stringify(credentials),
  );
  return {
    query(text: string) {
      if (/from\s+connections/i.test(text) && /credentials/i.test(text)) {
        return Promise.resolve({
          rows: [{ id: connectionId, credentials: envelope }] as Record<string, unknown>[],
        });
      }
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Let pending microtasks drain (setImmediate is NOT a mocked timer) so the request reaches
// the transport and arms its timeout before we tick the mock clock.
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ===========================================================================
// AC2 — GET/HEAD are classified reads; any other method makes a change (so the call
// follows the agent's change-making setting). A pure classifier.
// ===========================================================================

test("requestMakesChange classifies GET and HEAD as reads (any case)", () => {
  for (const method of ["GET", "HEAD", "get", "head", "Get", "Head"]) {
    assert.equal(requestMakesChange(method), false, `${method} is a read`);
  }
});

test("requestMakesChange classifies every other method as a change (any case)", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "Delete", "OPTIONS"]) {
    assert.equal(requestMakesChange(method), true, `${method} makes a change`);
  }
});

test("requestMakesChange treats an unknown verb conservatively as a change", () => {
  // An unrecognised method is not a known read, so it gets the stricter gate.
  assert.equal(requestMakesChange("FROBNICATE"), true, "an unknown verb makes a change");
  assert.equal(requestMakesChange("x"), true, "a nonsense verb makes a change");
});

// ===========================================================================
// AC1 — the request goes to the entry base URL joined with the RELATIVE path; the host
// cannot be overridden (an absolute URL or a protocol-relative host is rejected). A pure
// URL resolver, exhaustively probed.
// ===========================================================================

// Normalise whatever resolveRequestUrl returns (a URL or its href string) to a URL so the
// test tolerates either return shape.
function resolved(baseUrl: string, path: string, query?: Record<string, string>): URL {
  return new URL(String(resolveRequestUrl(baseUrl, path, query)));
}

test("resolveRequestUrl joins a relative path onto the entry host", () => {
  const u = resolved(API_KEY_ENTRY.base_url, "/v3/user");
  assert.equal(u.host, ACME_HOST, "the host is the entry's");
  assert.equal(u.pathname, "/v3/user", "the relative path is joined under the entry host");
});

test("resolveRequestUrl joins a path with no leading slash onto the entry host", () => {
  const u = resolved(API_KEY_ENTRY.base_url, "v3/user");
  assert.equal(u.host, ACME_HOST, "the host is still the entry's");
  assert.ok(u.pathname.endsWith("/v3/user"), "the relative path is joined under the entry host");
});

test("resolveRequestUrl appends the query parameters", () => {
  const u = resolved(API_KEY_ENTRY.base_url, "/search", { q: "hello world", n: "2" });
  assert.equal(u.host, ACME_HOST, "the host is the entry's");
  assert.equal(u.searchParams.get("q"), "hello world", "a query value is appended (and encoded)");
  assert.equal(u.searchParams.get("n"), "2", "every query value is appended");
});

// A table of paths that try to steer the request off the entry host — each must be refused.
const hostOverrideProbes = [
  "https://evil.example/x", // absolute URL, different host
  "http://evil.example/x", // absolute URL, different scheme + host
  "//evil.example/x", // protocol-relative: new URL(…, base) silently swaps the host
  "https://169.254.169.254/latest/meta-data/", // SSRF to cloud metadata via an absolute URL
  "http://127.0.0.1:5432/", // SSRF to a local service via an absolute URL
];

for (const probe of hostOverrideProbes) {
  test(`resolveRequestUrl rejects a host-override attempt with a 4xx: ${probe}`, () => {
    assert.throws(
      () => resolveRequestUrl(API_KEY_ENTRY.base_url, probe),
      (err: unknown) =>
        err instanceof HttpError && err.status >= 400 && err.status < 500,
      "a host-override path is refused at the boundary (4xx), never resolved",
    );
  });
}

test("resolveRequestUrl rejects an absolute URL even to the SAME host (paths are relative only)", () => {
  // The host cannot be overridden AND an absolute URL is not a relative path — refuse it.
  assert.throws(
    () => resolveRequestUrl(API_KEY_ENTRY.base_url, `${API_KEY_ENTRY.base_url}/v3/user`),
    (err: unknown) => err instanceof HttpError && err.status >= 400 && err.status < 500,
    "an absolute URL is refused even when its host matches the entry's",
  );
});

test("a query value that looks like a host does NOT override the host", () => {
  // A caller value shaped like a URL rides as an opaque query parameter; it never steers
  // the request off the entry host.
  const u = resolved(API_KEY_ENTRY.base_url, "/callback", { next: "https://evil.example/cb" });
  assert.equal(u.host, ACME_HOST, "the host is still the entry's — a query value never sets it");
  assert.equal(u.searchParams.get("next"), "https://evil.example/cb", "it is just a parameter");
});

// ===========================================================================
// AC1 + AC3 — sendConnectorRequest sends ONE request to the ENTRY's host at the resolved
// relative path, presenting the OWNED connection's credentials, and resolves for BOTH a
// generic self-contained (api_key / oauth2) connection AND a curated/registry-linked
// (provider_mcp) connection. The response status + body are returned.
// ===========================================================================

test("an api_key connection: the request hits the entry host at the path and presents the key", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "apikey");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, userId, { api_key: API_KEY_SECRET }, dek);
    const f = recordingFetch(okResponse);

    const result: ConnectorRequestResult = await sendConnectorRequest(
      { entry: API_KEY_ENTRY, userId, connectionId: conn.id, dek, method: "GET", path: "/v3/user" },
      makeDeps(db, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one upstream request is sent");
    const sent = f.requests[0]!;
    const u = new URL(sent.url);
    assert.equal(u.host, ACME_HOST, "the request goes to the entry's host (never a caller host)");
    assert.equal(u.pathname, "/v3/user", "…at the resolved relative path");
    assert.equal(sent.method.toUpperCase(), "GET", "with the requested method");

    // The person's key is presented in the entry's header template (authenticated tool).
    assert.ok(
      requestHeaderText(f.requests).includes(API_KEY_SECRET),
      "the stored key is presented to the upstream service",
    );
    assert.ok(!sent.url.includes(API_KEY_SECRET), "the key is never leaked into the URL");

    assert.equal(result.status, 200, "the upstream status is returned");
    assert.equal(result.body, "ok-body", "the upstream body is returned");
    assert.equal(result.truncated, false, "a small body is not truncated");
  } finally {
    await db.close();
  }
});

test("an oauth2 connection: the request hits the entry host and presents the Bearer access token", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "oauth2");
    const dek = freshDek();
    const conn = await seedConnection(
      db,
      OAUTH2_ENTRY,
      userId,
      { access_token: OAUTH_TOKEN, token_type: "Bearer", refresh_token: "r", expires_at: "2026-06-01T00:00:00.000Z" },
      dek,
    );
    const f = recordingFetch(okResponse);

    const result = await sendConnectorRequest(
      { entry: OAUTH2_ENTRY, userId, connectionId: conn.id, dek, method: "GET", path: "/drive/v3/files" },
      makeDeps(db, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one upstream request is sent");
    assert.equal(new URL(f.requests[0]!.url).host, GOOG_HOST, "the request goes to the entry's host");
    assert.ok(
      requestHeaderText(f.requests).includes(OAUTH_TOKEN),
      "the stored access token is presented to the upstream service",
    );
    assert.equal(result.status, 200, "the upstream status is returned");
  } finally {
    await db.close();
  }
});

test("a provider_mcp (curated) connection resolves too: the request hits the entry host and presents its token", async () => {
  // OBS-046: the curated / registry-linked shape is the product's primary path. The request
  // tool must resolve for it, not only the convenient self-contained shape.
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "mcp");
    const dek = freshDek();
    const conn = await seedConnection(
      db,
      PROVIDER_MCP_ENTRY,
      userId,
      { access_token: MCP_TOKEN, client_id: "https://warthog.com.au/oauth/client-metadata.json" },
      dek,
    );
    const f = recordingFetch(okResponse);

    const result = await sendConnectorRequest(
      { entry: PROVIDER_MCP_ENTRY, userId, connectionId: conn.id, dek, method: "GET", path: "/user/repos" },
      makeDeps(db, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one upstream request is sent");
    const u = new URL(f.requests[0]!.url);
    assert.equal(u.host, GH_HOST, "the request goes to the entry's host");
    assert.equal(u.pathname, "/user/repos", "…at the resolved relative path");
    assert.ok(
      requestHeaderText(f.requests).includes(MCP_TOKEN),
      "the provider connection's token is presented to the upstream service",
    );
    assert.equal(result.status, 200, "the upstream status is returned for the curated shape too");
    assert.equal(result.body, "ok-body", "and the upstream body is returned");
  } finally {
    await db.close();
  }
});

test("sendConnectorRequest appends the query and forwards a body on a change method", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "post");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, userId, { api_key: API_KEY_SECRET }, dek);
    const f = recordingFetch(() => new Response("created", { status: 201 }));

    const result = await sendConnectorRequest(
      {
        entry: API_KEY_ENTRY,
        userId,
        connectionId: conn.id,
        dek,
        method: "POST",
        path: "/v3/notes",
        query: { draft: "true" },
        body: JSON.stringify({ title: "hi" }),
      },
      makeDeps(db, f.fetch),
    );

    const sent = f.requests[0]!;
    const u = new URL(sent.url);
    assert.equal(u.host, ACME_HOST, "the request goes to the entry's host");
    assert.equal(u.pathname, "/v3/notes", "at the resolved relative path");
    assert.equal(u.searchParams.get("draft"), "true", "the query is appended");
    assert.equal(sent.method.toUpperCase(), "POST", "the change method is forwarded");
    assert.ok(sent.body.includes("\"title\":\"hi\""), "the body is forwarded to the upstream");
    assert.equal(result.status, 201, "the upstream status is returned");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 (no SSRF) — a path that tries to override the host is refused by sendConnectorRequest
// and NO request is ever sent.
// ===========================================================================

test("sendConnectorRequest refuses a host-override path and sends NO request", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "noredir");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, userId, { api_key: API_KEY_SECRET }, dek);
    const f = recordingFetch(okResponse);

    await assert.rejects(
      sendConnectorRequest(
        {
          entry: API_KEY_ENTRY,
          userId,
          connectionId: conn.id,
          dek,
          method: "GET",
          path: "https://169.254.169.254/latest/meta-data/",
        },
        makeDeps(db, f.fetch),
      ),
      "an absolute URL that overrides the host is refused",
    );
    assert.equal(f.requests.length, 0, "no request is sent to an overridden host");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — responses over 100 KB are truncated; upstream calls time out at 20 s.
// ===========================================================================

test("a response over 100 KB is truncated to ~100 KB, content-preserving", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "truncate");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, userId, { api_key: API_KEY_SECRET }, dek);

    // 300 KB of a single ASCII byte, so char-length == byte-length and the leading content
    // is unambiguous.
    const huge = "a".repeat(300 * 1024);
    const f = recordingFetch(() => new Response(huge, { status: 200 }));

    const result = await sendConnectorRequest(
      { entry: API_KEY_ENTRY, userId, connectionId: conn.id, dek, method: "GET", path: "/big" },
      makeDeps(db, f.fetch),
    );

    assert.equal(result.truncated, true, "an oversized body is flagged truncated");
    const bytes = Buffer.byteLength(result.body, "utf8");
    assert.ok(bytes <= 110 * 1024, `the body is capped near 100 KB (was ${bytes} bytes)`);
    assert.ok(bytes >= 90 * 1024, `the body keeps ~100 KB, not a sliver (was ${bytes} bytes)`);
    assert.equal(
      result.body.slice(0, 90 * 1024),
      "a".repeat(90 * 1024),
      "the kept content is the upstream body's leading bytes (truncation, not corruption)",
    );
  } finally {
    await db.close();
  }
});

test("a response at or under 100 KB is returned whole, not truncated", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "whole");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, userId, { api_key: API_KEY_SECRET }, dek);

    const small = "b".repeat(50 * 1024); // 50 KB, well under the cap
    const f = recordingFetch(() => new Response(small, { status: 200 }));

    const result = await sendConnectorRequest(
      { entry: API_KEY_ENTRY, userId, connectionId: conn.id, dek, method: "GET", path: "/small" },
      makeDeps(db, f.fetch),
    );

    assert.equal(result.truncated, false, "a body under the cap is not truncated");
    assert.equal(result.body, small, "the whole upstream body is returned intact");
  } finally {
    await db.close();
  }
});

test("sendConnectorRequest passes an AbortSignal to the upstream and aborts it at 20 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dek = freshDek();
  const connectionId = randomUUID();
  const db = await credentialsDb(connectionId, dek, { api_key: API_KEY_SECRET });

  let signal: AbortSignal | undefined;
  // A transport that never settles on its own: the only way out is the request tool's
  // timeout aborting the signal it was handed.
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>(() => {
      signal = init?.signal ?? undefined;
    });

  void sendConnectorRequest(
    { entry: API_KEY_ENTRY, userId: "u", connectionId, dek, method: "GET", path: "/slow" },
    makeDeps(db, hangingFetch),
  ).catch(() => {});
  await flushAsync(); // let the request reach the transport and arm the timeout

  assert.ok(signal instanceof AbortSignal, "the upstream call is cancellable — a signal is passed");
  assert.equal(signal?.aborted, false, "the signal is not aborted before the timeout");

  t.mock.timers.tick(19_999);
  assert.equal(signal?.aborted, false, "the upstream call is still live just before 20 s");

  t.mock.timers.tick(100); // cross the 20 s budget
  assert.equal(signal?.aborted, true, "the upstream call is aborted once 20 s elapses");
});

test("an upstream that outlives the 20 s timeout makes the call reject", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dek = freshDek();
  const connectionId = randomUUID();
  const db = await credentialsDb(connectionId, dek, { api_key: API_KEY_SECRET });

  const abortingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      if (s?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      s?.addEventListener("abort", () => reject(new Error("aborted")));
    });

  const p = sendConnectorRequest(
    { entry: API_KEY_ENTRY, userId: "u", connectionId, dek, method: "GET", path: "/slow" },
    makeDeps(db, abortingFetch),
  );
  p.catch(() => {}); // avoid an unhandled rejection before we assert on it
  await flushAsync();
  t.mock.timers.tick(20_100);

  await assert.rejects(p, "a timed-out upstream call surfaces as a rejection");
});

// ===========================================================================
// Member scope (CLAUDE.md: "Every member-scoped read/write takes userId from the session")
// — a request for a connection that is not the session user's resolves no credentials and
// is refused; NO request is sent.
// ===========================================================================

test("sendConnectorRequest refuses a connection that is not the session user's and sends NO request", async () => {
  const db = await freshDb();
  try {
    const owner = await makeUser(db, "owner");
    const other = await makeUser(db, "other");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, owner, { api_key: API_KEY_SECRET }, dek);
    const f = recordingFetch(okResponse);

    await assert.rejects(
      sendConnectorRequest(
        { entry: API_KEY_ENTRY, userId: other, connectionId: conn.id, dek, method: "GET", path: "/v3/user" },
        makeDeps(db, f.fetch),
      ),
      "another person cannot drive a request through someone else's connection",
    );
    assert.equal(f.requests.length, 0, "no request is sent when the connection is not the caller's");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC6 [obligation:secrets-from-env] (INV-103) — config is injected; this module reads no
// process.env and folds no ambient secret into the outbound request or the result. Shown
// behaviourally: the request carries the INJECTED credential, and a decoy secret planted in
// the environment never appears in the request or the returned result.
// ===========================================================================

test("the request carries the INJECTED credential; an ambient env secret never appears", async () => {
  const prev = process.env.WARTHOG_CONNECTOR_SECRET;
  process.env.WARTHOG_CONNECTOR_SECRET = DECOY_SECRET;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "secrets");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, userId, { api_key: API_KEY_SECRET }, dek);
    const f = recordingFetch(okResponse);

    const result = await sendConnectorRequest(
      { entry: API_KEY_ENTRY, userId, connectionId: conn.id, dek, method: "GET", path: "/v3/user" },
      makeDeps(db, f.fetch),
    );

    const sent = requestText(f.requests);
    assert.ok(sent.includes(API_KEY_SECRET), "the injected credential is what the request presents");
    assert.ok(!sent.includes(DECOY_SECRET), "no ambient env secret is folded into the request");
    assert.ok(!JSON.stringify(result).includes(DECOY_SECRET), "no ambient env secret lands in the result");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_CONNECTOR_SECRET;
    else process.env.WARTHOG_CONNECTOR_SECRET = prev;
  }
});

// ===========================================================================
// AC5 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
// `../http/validate` boundary rejects malformed / oversized / mis-typed input with a 4xx
// BEFORE any query or upstream request runs, shape-guards the connection id (OBS-049),
// takes the user id from the SESSION (never the body), and binds every value (so a SQL
// probe cannot alter a query).
//
// The handler below is a TEST FIXTURE that exercises the real validation boundary and this
// task's send path — the intended usage, not an implementation file. (A route `route.ts`
// exports only its HTTP verbs; this factory lives beside it — a sibling seam — per the
// App-Router rules.)
// ===========================================================================

function requestToolHandler(opts: {
  deps: RequestToolDeps;
  dek: Uint8Array;
  sessionUserId: string;
  resolveEntry: (connectorId: string) => CatalogueEntry | undefined;
}): (req: Request) => Promise<Response> {
  // The body names which owned connection, the method, the relative path, and optional
  // query/body. The user id comes from the SESSION, never the body. The connection id is
  // shape-guarded as a uuid (OBS-049 — it reaches `WHERE id = $1`). Lengths are capped so
  // an absurd value is rejected, yet generous enough that a probe can still REACH a query.
  const schema = z.object({
    connectionId: z.uuid(),
    method: z.string().min(1).max(16),
    path: z.string().min(1).max(2048),
    query: z.record(z.string(), z.string()).optional(),
    body: z.string().max(100 * 1024).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const input = await parseBody(schema, req, { maxBytes: 64 * 1024 });
      // The connection is resolved member-scoped by the SESSION id; its connector names
      // the catalogue entry (the host comes only from there).
      const connection = await getConnectionById(opts.deps.db, opts.sessionUserId, input.connectionId);
      if (!connection) throw new HttpError(404, "unknown connection");
      const entry = opts.resolveEntry(connection.connectorId);
      if (!entry) throw new HttpError(400, "unknown connector");

      const result = await sendConnectorRequest(
        {
          entry,
          userId: opts.sessionUserId,
          connectionId: input.connectionId,
          dek: opts.dek,
          method: input.method,
          path: input.path,
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
  return new Request("https://warthog.com.au/connections/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const CATALOGUE = (id: string): CatalogueEntry | undefined =>
  id === API_KEY_ENTRY.id ? API_KEY_ENTRY : undefined;

test("the handler rejects malformed JSON with a 4xx and reaches neither a query nor a request", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = requestToolHandler({
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
  const handler = requestToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId: randomUUID(),
    resolveEntry: CATALOGUE,
  });

  // ~200 KiB body field, well over the handler's 64 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(
      JSON.stringify({ connectionId: randomUUID(), method: "POST", path: "/x", body: "a".repeat(200 * 1024) }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
  assert.equal(f.requests.length, 0, "an oversized body must never reach an upstream request");
});

test("the handler rejects a mis-typed / missing field with a 4xx", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = requestToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId: randomUUID(),
    resolveEntry: CATALOGUE,
  });

  // method must be a string — a number is a schema violation, rejected before any query.
  const misTyped = await handler(
    jsonRequest(JSON.stringify({ connectionId: randomUUID(), method: 123, path: "/x" })),
  );
  assert.ok(misTyped.status >= 400 && misTyped.status < 500, `expected a 4xx, got ${misTyped.status}`);

  // path is required — its absence is a schema violation.
  const missing = await handler(
    jsonRequest(JSON.stringify({ connectionId: randomUUID(), method: "GET" })),
  );
  assert.ok(missing.status >= 400 && missing.status < 500, `expected a 4xx, got ${missing.status}`);

  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
  assert.equal(f.requests.length, 0, "a schema violation must never reach an upstream request");
});

test("the handler shape-guards the connection id: a SQL-probe-shaped id is a 4xx, never a query (OBS-049)", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = requestToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId: randomUUID(),
    resolveEntry: CATALOGUE,
  });

  // A connection id shaped like a SQL-injection probe is not a uuid: the boundary refuses it
  // before it could ever reach `WHERE id = $1` (it would otherwise be an unhandled cast 500).
  const res = await handler(
    jsonRequest(
      JSON.stringify({ connectionId: "x'); DROP TABLE connections; --", method: "GET", path: "/x" }),
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
  const handler = requestToolHandler({
    deps: makeDeps(db, f.fetch),
    dek: freshDek(),
    sessionUserId,
    resolveEntry: CATALOGUE,
  });

  // The recording db returns no rows, so the flow stops at "unknown connection" — but the id
  // has already reached the member-scoped lookup as a BOUND value (the parameterize half).
  const res = await handler(
    jsonRequest(JSON.stringify({ connectionId, method: "GET", path: "/v3/user" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, "an unknown connection is a 4xx");
  assertBoundNotSpliced(db, connectionId);
  assert.ok(db.calls.some((c) => c.values.includes(sessionUserId)), "the lookup is member-scoped by the session id");
  assert.equal(f.requests.length, 0, "an unknown connection never produces an upstream request");
});

test("the handler refuses a host-override path with a 4xx and sends NO request", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ssrf");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, userId, { api_key: API_KEY_SECRET }, dek);
    const f = recordingFetch(okResponse);
    const handler = requestToolHandler({
      deps: makeDeps(db, f.fetch),
      dek,
      sessionUserId: userId,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(
        JSON.stringify({ connectionId: conn.id, method: "GET", path: "https://evil.example/steal" }),
      ),
    );

    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(f.requests.length, 0, "a host-override path never produces an upstream request");
  } finally {
    await db.close();
  }
});

test("the handler accepts a well-formed request for the SESSION user and returns the upstream response", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const conn = await seedConnection(db, API_KEY_ENTRY, userId, { api_key: API_KEY_SECRET }, dek);
    const f = recordingFetch(okResponse);
    const handler = requestToolHandler({
      deps: makeDeps(db, f.fetch),
      dek,
      sessionUserId: userId,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(JSON.stringify({ connectionId: conn.id, method: "GET", path: "/v3/user" })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const payload = (await res.json()) as ConnectorRequestResult;
    assert.equal(payload.status, 200, "the upstream status is reported");
    assert.equal(payload.body, "ok-body", "the upstream body is reported");
    assert.equal(f.requests.length, 1, "exactly one upstream request is made");
    assert.equal(new URL(f.requests[0]!.url).host, ACME_HOST, "to the entry's host");
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
    const conn = await seedConnection(db, API_KEY_ENTRY, owner, { api_key: API_KEY_SECRET }, dek);
    const f = recordingFetch(okResponse);

    // The attacker's session drives the handler but names the OWNER's connection id.
    const handler = requestToolHandler({
      deps: makeDeps(db, f.fetch),
      dek,
      sessionUserId: attacker,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(JSON.stringify({ connectionId: conn.id, method: "GET", path: "/v3/user" })),
    );

    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(f.requests.length, 0, "another person's connection never produces an upstream request");
  } finally {
    await db.close();
  }
});
