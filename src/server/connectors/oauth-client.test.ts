// E09-S06 — OAuth connector client (`src/server/connectors/oauth-client.ts`).
//
// RED-first: the module does not exist yet, so importing `./oauth-client` throws and
// every test here fails at load — that absence IS the point of test-first. As the
// TESTER I must NOT create or edit the module (or any implementation/source file) to
// make these pass; the builder writes `oauth-client.ts` afterwards to this contract.
//
// WHY this exists (task E09-S06; design §7 "Connector engine"; §2 library table —
// "oauth4webapi … Warthog as OAuth client to Google/Microsoft/others (code+PKCE,
// refresh)"): provider sign-in connections (Google, Microsoft, …) need standard OAuth
// 2.1 with PKCE and refresh. This is the oauth4webapi-based client that
//   (1) builds an authorize URL from a catalogue entry's URLs + scopes with PKCE S256,
//   (2) exchanges an authorization code + PKCE verifier for tokens and stores them
//       DEK-encrypted on a connection (`../db/connections`, `../crypto/envelope`),
//   (3) refreshes the stored tokens, renewing before expiry.
// The provider HOST is taken ONLY from the catalogue entry — never a value from a
// caller (CLAUDE.md security: "Connector requests never take a host from the caller").
//
// These tests pin BEHAVIOUR (the authorize URL a build produces, the request the client
// sends, the stored/returned state), never the source text of any file — a later rename
// that preserves behaviour must not redden them. The HTTP + time sources are injected
// seams (conventions: external services sit behind fakes; tests never touch the
// network) — a recording `fetch` stands in for the provider's token endpoint, a fixed
// clock freezes time. The db is the real in-memory PGlite with the real migrations
// (`../../test/db`), or a recording stand-in that proves what reached the query layer.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface OAuthClientConfig {       // the operator-configured client (from config,
//     clientId: string;                 // which alone reads env — INV-103). NEVER read
//     clientSecret: string;             // from process.env by this module; injected.
//     redirectUri: string;
//   }
//
//   interface OAuthClientDeps {         // injected seams
//     db: Db;                           // the parameterizing data seam
//     clock: Clock;                     // time (connectedAt / expiry), never Date.now()
//     fetch: typeof fetch;              // the HTTP seam (SSRF-guarded fetch in prod)
//   }
//
//   interface AuthorizeRequest { url: string; codeVerifier: string; state: string }
//
//   buildAuthorizeUrl({ entry, config }): Promise<AuthorizeRequest>
//     • Builds the provider authorize URL at the ENTRY's authorize endpoint (host from
//       `entry.auth.authorize_url` only), carrying response_type=code, the config's
//       client_id + redirect_uri, the entry's scopes, a PKCE S256 challenge and a state.
//       Returns the raw code_verifier + state (the pending-flow secrets) alongside the
//       URL. The returned verifier hashes (base64url SHA-256) to the URL's code_challenge.
//
//   exchangeCodeForConnection(
//     { entry, config, userId, accountLabel, code, state, codeVerifier, dek, status? },
//     deps): Promise<Connection>
//     • Exchanges the code + PKCE verifier at the ENTRY's token endpoint (host from
//       `entry.auth.token_url` only) and stores the resulting tokens DEK-encrypted on a
//       NEW connection owned by `userId` (connectorId = entry.id, the given accountLabel,
//       status defaults to "connected"). Returns the Connection — WITHOUT credentials.
//
//   refreshConnectionTokens(
//     { entry, config, userId, connectionId, dek }, deps): Promise<Connection>
//     • Reads the owned connection's stored credentials, sends the stored refresh token
//       to the ENTRY's token endpoint (host from the entry only), and updates the stored
//       credentials with the renewed token set. Returns the updated Connection (no creds).
//
// `userId` is always the session's id (never a client value); every member-scoped read /
// write binds it. Scopes of "absence" assertions are kept narrow to the exact surface
// under test (a token value legitimately lives, encrypted, in a column and decrypted
// behind getConnectionCredentials — so the plaintext-leak scan is the raw columns only).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (isolated in-memory PGlite), so tests share no
// state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import {
  buildAuthorizeUrl,
  exchangeCodeForConnection,
  refreshConnectionTokens,
  type OAuthClientConfig,
  type OAuthClientDeps,
} from "./oauth-client";
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

// Instants deliberately in the past relative to the wall clock, so anything that wrongly
// read Date.now() instead of the injected clock would diverge here. T1 is well past a
// 1-hour access-token lifetime from T0, so a refresh fires regardless of any threshold.
const T0 = new Date("2026-05-01T10:00:00.000Z");
const T1 = new Date("2026-05-01T12:00:00.000Z");
const CLOCK = fixedClock(T0);
const CLOCK_LATER = fixedClock(T1);

// A Google-family oauth2 catalogue entry (the host the client must use for Google). The
// authorize and token endpoints are Google's own; the client takes the host from HERE.
const GOOGLE_ENTRY: CatalogueEntry = {
  id: "google-gmail",
  name: "Gmail",
  aliases: ["gmail"],
  category: "email",
  auth_kind: "oauth2",
  base_url: "https://gmail.googleapis.com",
  auth: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"],
  },
  google_early_access: true,
};

// A Microsoft-family oauth2 entry (a DIFFERENT host), used to show the authorize host
// tracks the entry, not a fixed or caller-supplied value.
const MICROSOFT_ENTRY: CatalogueEntry = {
  id: "microsoft-outlook-mail",
  name: "Outlook mail",
  aliases: ["outlook"],
  category: "email",
  auth_kind: "oauth2",
  base_url: "https://graph.microsoft.com",
  auth: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["https://graph.microsoft.com/Mail.Read", "offline_access"],
  },
};

// The operator-configured client. The redirect URI carries a host (warthog.com.au) that
// is a CALLER/config value — a token request must never be sent there; it goes to the
// entry's token host.
const CONFIG: OAuthClientConfig = {
  clientId: "warthog-injected-CLIENTID-abc",
  clientSecret: "warthog-injected-SECRET-xyz",
  redirectUri: "https://warthog.com.au/connections/callback",
};

const GOOGLE_TOKEN_HOST = new URL(GOOGLE_ENTRY.auth.token_url as string).host;
const GOOGLE_AUTHORIZE = new URL(GOOGLE_ENTRY.auth.authorize_url as string);
const MICROSOFT_AUTHORIZE = new URL(MICROSOFT_ENTRY.auth.authorize_url as string);
const REDIRECT_HOST = new URL(CONFIG.redirectUri).host;

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this client only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; the client never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

function makeDeps(db: Db, clock: Clock, fetchFn: typeof globalThis.fetch): OAuthClientDeps {
  return { db, clock, fetch: fetchFn };
}

// The PKCE S256 challenge for a verifier: base64url(SHA-256(verifier)), unpadded — the
// exact relationship RFC 7636 (and oauth4webapi) define. The test re-derives it to prove
// the returned verifier matches the URL's challenge, independent of how it was built.
function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// --- the provider token endpoint, faked -------------------------------------------

// What the client sent, captured for inspection (host, grant, bound secrets).
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

// A recording `fetch` stand-in: records every request and returns the given canned
// provider response (a standards-compliant token endpoint response). No network.
function recordingFetch(respond: () => Response): {
  fetch: typeof globalThis.fetch;
  requests: SeenRequest[];
} {
  const requests: SeenRequest[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    const headersText = [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    requests.push({
      url,
      method: String(init?.method ?? "GET"),
      body: bodyToString(init?.body),
      headersText,
    });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch: fn, requests };
}

// A standards-compliant OAuth 2.0 token endpoint response (200 + application/json), the
// shape oauth4webapi accepts for both the code and refresh grants.
function tokenResponse(tokens: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}): Response {
  return new Response(JSON.stringify({ token_type: "Bearer", expires_in: 3600, ...tokens }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// The whole of what a captured request reveals, for narrow "a secret must not appear"
// scans (client secrets may ride in the body OR an auth header depending on client-auth
// style — scan both).
function requestText(requests: SeenRequest[]): string {
  return requests.map((r) => [r.url, r.body, r.headersText].join("\n")).join("\n");
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

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text
// (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Whether a relation of this exact name exists — a non-throwing probe scoped to the one
// table under test (behaviour, not source text).
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

// Assert a returned Connection carries NO credentials, scoped to the one object: no
// `credentials` key and no token value folded in. The same token lives (encrypted) in a
// raw column — this is the client-facing shape only.
function assertNoCredentials(connection: Connection, accessToken: string, refreshToken: string): void {
  const obj = connection as unknown as Record<string, unknown>;
  assert.ok(!("credentials" in obj), "the connection shape carries no credentials field");
  const json = JSON.stringify(connection);
  assert.ok(!json.includes(accessToken), "no access-token value is folded into the connection");
  assert.ok(!json.includes(refreshToken), "no refresh-token value is folded into the connection");
}

// ===========================================================================
// AC1 — the authorize URL is built from the catalogue entry's URLs and scopes with
// PKCE S256.
// ===========================================================================

test("buildAuthorizeUrl builds a PKCE-S256 authorize URL at the entry's endpoint with the config's client id, redirect and the entry's scopes", async () => {
  const { url, codeVerifier, state } = await buildAuthorizeUrl({ entry: GOOGLE_ENTRY, config: CONFIG });

  const u = new URL(url);

  // The authorize endpoint is the ENTRY's (origin + path), never a caller value.
  assert.equal(u.origin, GOOGLE_AUTHORIZE.origin, "the authorize URL is at the entry's host");
  assert.equal(u.pathname, GOOGLE_AUTHORIZE.pathname, "…and the entry's authorize path");

  // Standard OAuth 2.1 authorization-code request parameters.
  assert.equal(u.searchParams.get("response_type"), "code", "response_type=code");
  assert.equal(u.searchParams.get("client_id"), CONFIG.clientId, "the config's client id");
  assert.equal(u.searchParams.get("redirect_uri"), CONFIG.redirectUri, "the config's redirect uri");

  // PKCE S256: the challenge method is S256 and the returned verifier hashes to the
  // challenge in the URL (the real relationship, not a literal).
  assert.equal(u.searchParams.get("code_challenge_method"), "S256", "PKCE method is S256");
  const challenge = u.searchParams.get("code_challenge");
  assert.ok(challenge && challenge.length > 0, "a PKCE code_challenge is present");
  assert.ok(codeVerifier.length >= 43, "the code verifier meets the RFC 7636 minimum length");
  assert.equal(challenge, pkceS256(codeVerifier), "the challenge is base64url(SHA-256(verifier))");

  // The entry's scopes are all requested (scope is a space-delimited list).
  const scopes = new Set((u.searchParams.get("scope") ?? "").split(" ").filter(Boolean));
  for (const scope of GOOGLE_ENTRY.auth.scopes as string[]) {
    assert.ok(scopes.has(scope), `scope ${scope} is requested`);
  }

  // The returned state is the one carried in the URL (the CSRF pending-flow value).
  assert.equal(u.searchParams.get("state"), state, "the returned state matches the URL's state");
  assert.ok(state.length > 0, "a non-empty state is issued");
});

test("buildAuthorizeUrl takes the authorize host ONLY from the catalogue entry — a Microsoft entry yields a Microsoft URL", async () => {
  const google = await buildAuthorizeUrl({ entry: GOOGLE_ENTRY, config: CONFIG });
  const microsoft = await buildAuthorizeUrl({ entry: MICROSOFT_ENTRY, config: CONFIG });

  assert.equal(new URL(google.url).host, GOOGLE_AUTHORIZE.host, "Google entry → Google authorize host");
  assert.equal(
    new URL(microsoft.url).host,
    MICROSOFT_AUTHORIZE.host,
    "Microsoft entry → Microsoft authorize host",
  );
  assert.notEqual(
    new URL(google.url).host,
    new URL(microsoft.url).host,
    "the host tracks the entry, not a fixed or caller value",
  );
  // The config (the only non-entry input) carries no host but the redirect — which must
  // not be mistaken for the authorize host.
  assert.notEqual(new URL(google.url).host, REDIRECT_HOST, "the redirect host is not the authorize host");
});

test("buildAuthorizeUrl draws a fresh PKCE verifier and state per call", async () => {
  const a = await buildAuthorizeUrl({ entry: GOOGLE_ENTRY, config: CONFIG });
  const b = await buildAuthorizeUrl({ entry: GOOGLE_ENTRY, config: CONFIG });

  assert.notEqual(a.codeVerifier, b.codeVerifier, "each authorize request has its own verifier");
  assert.notEqual(a.state, b.state, "each authorize request has its own state");
  // Each URL's challenge still matches its own verifier.
  assert.equal(new URL(a.url).searchParams.get("code_challenge"), pkceS256(a.codeVerifier));
  assert.equal(new URL(b.url).searchParams.get("code_challenge"), pkceS256(b.codeVerifier));
});

// ===========================================================================
// AC1 — a code exchange stores the encrypted tokens on the connection.
// ===========================================================================

test("exchangeCodeForConnection exchanges the code+verifier and stores the tokens DEK-encrypted on a new connection", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "exchange");
    const dek = freshDek();
    const f = recordingFetch(() =>
      tokenResponse({ access_token: "atok_FRESH", refresh_token: "rtok_FRESH", scope: "gmail.readonly" }),
    );

    const conn = await exchangeCodeForConnection(
      {
        entry: GOOGLE_ENTRY,
        config: CONFIG,
        userId,
        accountLabel: "oren@gmail.com",
        code: "auth-code-123",
        state: "state-abc",
        codeVerifier: "a".repeat(43),
        dek,
      },
      makeDeps(db, CLOCK, f.fetch),
    );

    // The returned connection: owned, for this connector, with the label and a status.
    assert.equal(conn.userId, userId, "the connection is owned by the session user");
    assert.equal(conn.connectorId, GOOGLE_ENTRY.id, "the connector is the entry's id");
    assert.equal(conn.accountLabel, "oren@gmail.com", "the account label is recorded");
    assert.equal(conn.status, "connected", "a freshly connected service is 'connected'");
    assertNoCredentials(conn, "atok_FRESH", "rtok_FRESH");

    // It is now one of the person's connections.
    const listed = await listConnectionsForUser(db, userId);
    assert.equal(listed.length, 1, "the connection is persisted and listed");
    assert.equal(listed[0]!.id, conn.id, "the listed connection is the one just created");

    // The tokens round-trip only under the owner's DEK.
    const creds = await getConnectionCredentials(db, userId, conn.id, dek);
    const credsJson = JSON.stringify(creds);
    assert.ok(credsJson.includes("atok_FRESH"), "the access token is stored and decrypts under the DEK");
    assert.ok(credsJson.includes("rtok_FRESH"), "the refresh token is stored and decrypts under the DEK");

    // The token request was sent to the ENTRY's token endpoint, carrying the code + PKCE
    // verifier under the authorization_code grant.
    assert.equal(f.requests.length, 1, "exactly one token request was made");
    assert.equal(new URL(f.requests[0]!.url).host, GOOGLE_TOKEN_HOST, "to the entry's token host");
    assert.match(f.requests[0]!.body, /grant_type=authorization_code/, "the authorization_code grant");
    assert.ok(f.requests[0]!.body.includes("auth-code-123"), "the code is sent");
    assert.ok(f.requests[0]!.body.includes(`code_verifier=${"a".repeat(43)}`), "the PKCE verifier is sent");
  } finally {
    await db.close();
  }
});

test("the exchanged tokens are stored only encrypted — the plaintext never appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "atrest");
    const dek = freshDek();
    const f = recordingFetch(() =>
      tokenResponse({ access_token: "atok_ATREST", refresh_token: "rtok_ATREST", scope: "s" }),
    );

    const conn = await exchangeCodeForConnection(
      {
        entry: GOOGLE_ENTRY,
        config: CONFIG,
        userId,
        accountLabel: "oren@gmail.com",
        code: "c",
        state: "st",
        codeVerifier: "a".repeat(43),
        dek,
      },
      makeDeps(db, CLOCK, f.fetch),
    );

    // Scoped narrowly to the connections table: the raw columns must not hold the
    // plaintext tokens (they are DEK-encrypted), yet they decrypt behind the accessor.
    const raw = await rawConnectionsText(db);
    assert.ok(!raw.includes("atok_ATREST"), "the access token is not stored in plaintext");
    assert.ok(!raw.includes("rtok_ATREST"), "the refresh token is not stored in plaintext");

    const creds = await getConnectionCredentials(db, userId, conn.id, dek);
    assert.ok(JSON.stringify(creds).includes("atok_ATREST"), "but it decrypts under the owner's DEK");
  } finally {
    await db.close();
  }
});

test("exchangeCodeForConnection sends the token request to the entry's host, never the caller's redirect host", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "exhost");
    const dek = freshDek();
    const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r", scope: "s" }));

    await exchangeCodeForConnection(
      {
        entry: GOOGLE_ENTRY,
        config: CONFIG,
        userId,
        accountLabel: "oren@gmail.com",
        code: "c",
        state: "st",
        codeVerifier: "a".repeat(43),
        dek,
      },
      makeDeps(db, CLOCK, f.fetch),
    );

    const host = new URL(f.requests[0]!.url).host;
    assert.equal(host, GOOGLE_TOKEN_HOST, "the token host is the catalogue entry's");
    assert.notEqual(host, REDIRECT_HOST, "never the caller/config redirect host");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — token refresh renews before expiry and updates the stored tokens; the refresh
// target host is the catalogue entry's host, not a caller value.
// ===========================================================================

test("refreshConnectionTokens renews the tokens using the stored refresh token and updates the stored credentials", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "refresh");
    const dek = freshDek();

    // Phase 1 — a connection whose stored refresh token is rtok_A.
    const exchangeFetch = recordingFetch(() =>
      tokenResponse({ access_token: "atok_A", refresh_token: "rtok_A", scope: "s" }),
    );
    const conn = await exchangeCodeForConnection(
      {
        entry: GOOGLE_ENTRY,
        config: CONFIG,
        userId,
        accountLabel: "oren@gmail.com",
        code: "c",
        state: "st",
        codeVerifier: "a".repeat(43),
        dek,
      },
      makeDeps(db, CLOCK, exchangeFetch.fetch),
    );

    // Phase 2 — refresh renews to atok_B / rtok_B (clock advanced past the old expiry).
    const refreshFetch = recordingFetch(() =>
      tokenResponse({ access_token: "atok_B", refresh_token: "rtok_B", scope: "s" }),
    );
    const refreshed = await refreshConnectionTokens(
      { entry: GOOGLE_ENTRY, config: CONFIG, userId, connectionId: conn.id, dek },
      makeDeps(db, CLOCK_LATER, refreshFetch.fetch),
    );

    assert.equal(refreshed.id, conn.id, "the same connection is returned");
    assert.equal(refreshed.status, "connected", "a successful refresh keeps the connection connected");

    // The refresh request used the refresh_token grant and the PREVIOUSLY STORED token.
    assert.equal(refreshFetch.requests.length, 1, "exactly one refresh request was made");
    assert.match(refreshFetch.requests[0]!.body, /grant_type=refresh_token/, "the refresh_token grant");
    assert.ok(
      refreshFetch.requests[0]!.body.includes("rtok_A"),
      "the previously-stored refresh token is presented",
    );

    // The stored tokens are UPDATED to the renewed pair; the old ones are gone.
    const creds = await getConnectionCredentials(db, userId, conn.id, dek);
    const credsJson = JSON.stringify(creds);
    assert.ok(credsJson.includes("atok_B"), "the renewed access token is stored");
    assert.ok(credsJson.includes("rtok_B"), "the renewed refresh token is stored");
    assert.ok(!credsJson.includes("atok_A"), "the old access token is replaced");
    assert.ok(!credsJson.includes("rtok_A"), "the old refresh token is replaced");
  } finally {
    await db.close();
  }
});

test("the refresh target host is the catalogue entry's token host, not a caller value", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "refreshhost");
    const dek = freshDek();

    const exchangeFetch = recordingFetch(() =>
      tokenResponse({ access_token: "atok_A", refresh_token: "rtok_A", scope: "s" }),
    );
    const conn = await exchangeCodeForConnection(
      {
        entry: GOOGLE_ENTRY,
        config: CONFIG,
        userId,
        accountLabel: "oren@gmail.com",
        code: "c",
        state: "st",
        codeVerifier: "a".repeat(43),
        dek,
      },
      makeDeps(db, CLOCK, exchangeFetch.fetch),
    );

    const refreshFetch = recordingFetch(() =>
      tokenResponse({ access_token: "atok_B", refresh_token: "rtok_B", scope: "s" }),
    );
    await refreshConnectionTokens(
      { entry: GOOGLE_ENTRY, config: CONFIG, userId, connectionId: conn.id, dek },
      makeDeps(db, CLOCK_LATER, refreshFetch.fetch),
    );

    const host = new URL(refreshFetch.requests[0]!.url).host;
    assert.equal(host, GOOGLE_TOKEN_HOST, "the refresh host is the catalogue entry's token host");
    assert.notEqual(host, REDIRECT_HOST, "never the caller/config redirect host");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
// `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
// with a 4xx BEFORE any query or token request runs, and a SQL-injection probe routed
// through the client is BOUND as a parameter (it cannot alter a query). The host comes
// only from the catalogue, so an unknown connector is refused with a 4xx.
//
// The handler below is a TEST FIXTURE that exercises the real validation boundary and
// this task's client — the intended usage, not an implementation file.
// ===========================================================================

function completeConnectionHandler(opts: {
  deps: OAuthClientDeps;
  dek: Uint8Array;
  sessionUserId: string;
  resolveEntry: (connectorId: string) => CatalogueEntry | undefined;
}): (req: Request) => Promise<Response> {
  // The callback body carries the connector slug, the chosen account label, and the
  // code + state + PKCE verifier. The user id comes from the SESSION, never the body.
  // Lengths are capped so an absurd value is rejected, yet generous enough that a probe
  // can still REACH the query to prove it is bound.
  const schema = z.object({
    connectorId: z.string().min(1).max(64),
    accountLabel: z.string().min(1).max(200),
    code: z.string().min(1).max(4096),
    state: z.string().min(1).max(1024),
    codeVerifier: z.string().min(1).max(256),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      // The host comes ONLY from the catalogue: an unknown connector is refused here,
      // before the client is ever asked to reach a provider.
      const entry = opts.resolveEntry(body.connectorId);
      if (!entry) throw new HttpError(400, "unknown connector");
      const conn = await exchangeCodeForConnection(
        {
          entry,
          config: CONFIG,
          userId: opts.sessionUserId,
          accountLabel: body.accountLabel,
          code: body.code,
          state: body.state,
          codeVerifier: body.codeVerifier,
          dek: opts.dek,
        },
        opts.deps,
      );
      return new Response(JSON.stringify({ id: conn.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a
      // test sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/connections/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const CATALOGUE = (id: string): CatalogueEntry | undefined =>
  id === GOOGLE_ENTRY.id ? GOOGLE_ENTRY : undefined;

test("the handler rejects malformed JSON with a 4xx and reaches neither a query nor a token request", async () => {
  const db = recordingDb();
  const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r" }));
  const handler = completeConnectionHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
  assert.equal(f.requests.length, 0, "malformed input must never reach the token endpoint");
});

test("the handler rejects an oversized body with a 4xx and reaches neither a query nor a token request", async () => {
  const db = recordingDb();
  const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r" }));
  const handler = completeConnectionHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // ~20 KiB code blob, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(
      JSON.stringify({
        connectorId: GOOGLE_ENTRY.id,
        accountLabel: "oren@gmail.com",
        code: "a".repeat(20 * 1024),
        state: "st",
        codeVerifier: "a".repeat(43),
      }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
  assert.equal(f.requests.length, 0, "an oversized body must never reach the token endpoint");
});

test("the handler rejects a body missing a required field with a 4xx", async () => {
  const db = recordingDb();
  const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r" }));
  const handler = completeConnectionHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // No codeVerifier — a PKCE exchange cannot proceed without it.
  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: GOOGLE_ENTRY.id, accountLabel: "oren@gmail.com", code: "c", state: "st" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
  assert.equal(f.requests.length, 0, "a schema violation must never reach the token endpoint");
});

test("the handler rejects a mis-typed field with a 4xx", async () => {
  const db = recordingDb();
  const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r" }));
  const handler = completeConnectionHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // code must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: GOOGLE_ENTRY.id, accountLabel: "oren@gmail.com", code: 12345, state: "st", codeVerifier: "a".repeat(43) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
  assert.equal(f.requests.length, 0, "a mis-typed field must never reach the token endpoint");
});

test("the handler refuses an unknown connector with a 4xx — the host comes only from the catalogue", async () => {
  const db = recordingDb();
  const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r" }));
  const handler = completeConnectionHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: "not-in-the-catalogue", accountLabel: "x", code: "c", state: "st", codeVerifier: "a".repeat(43) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(f.requests.length, 0, "an unknown connector never produces an outbound request");
  assert.equal(db.calls.length, 0, "an unknown connector never reaches a query");
});

test("the handler accepts a well-formed callback and records the connection for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const f = recordingFetch(() =>
      tokenResponse({ access_token: "atok_HOK", refresh_token: "rtok_HOK", scope: "s" }),
    );
    const handler = completeConnectionHandler({
      deps: makeDeps(db, CLOCK, f.fetch),
      dek,
      sessionUserId: userId,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(JSON.stringify({ connectorId: GOOGLE_ENTRY.id, accountLabel: "oren@gmail.com", code: "the-code", state: "the-state", codeVerifier: "a".repeat(43) })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const stored = await getConnectionById(db, userId, id);
    assert.ok(stored, "a valid callback is persisted for the session user");
    assert.equal(stored!.connectorId, GOOGLE_ENTRY.id, "with the entry's connector id");
    assert.equal(stored!.accountLabel, "oren@gmail.com", "and the submitted account label");

    const creds = await getConnectionCredentials(db, userId, id, dek);
    assert.ok(JSON.stringify(creds).includes("atok_HOK"), "the exchanged tokens round-trip under the DEK");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r", scope: "s" }));
    const handler = completeConnectionHandler({
      deps: makeDeps(db, CLOCK, f.fetch),
      dek,
      sessionUserId: sessionUser,
      resolveEntry: CATALOGUE,
    });

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, connectorId: GOOGLE_ENTRY.id, accountLabel: "oren@gmail.com", code: "c", state: "st", codeVerifier: "a".repeat(43) })),
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

test("a SQL-injection probe routed through the client is BOUND as a parameter, never spliced into the SQL", async () => {
  const db = recordingDb();
  const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r", scope: "s" }));
  const probe = "oren'); DROP TABLE connections; --";
  const handler = completeConnectionHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // A valid-shaped (if nasty) account label: it passes validation, the token exchange
  // succeeds against the fake endpoint, and the probe reaches the INSERT as a value.
  await handler(
    jsonRequest(JSON.stringify({ connectorId: GOOGLE_ENTRY.id, accountLabel: probe, code: "c", state: "st", codeVerifier: "a".repeat(43) })),
  );

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe account label is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r", scope: "s" }));
    const probe = "oren'); DROP TABLE connections; --";
    const handler = completeConnectionHandler({
      deps: makeDeps(db, CLOCK, f.fetch),
      dek,
      sessionUserId: userId,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(JSON.stringify({ connectorId: GOOGLE_ENTRY.id, accountLabel: probe, code: "c", state: "st", codeVerifier: "a".repeat(43) })),
    );
    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "connections"), true, "the connections table must still exist");

    const { id } = (await res.json()) as { id: string };
    const stored = await getConnectionById(db, userId, id);
    assert.equal(stored!.accountLabel, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:secrets-from-env] (INV-103) — config is injected (read from env only
// by src/server/config.ts); this module reads no process.env and folds no ambient
// secret into the authorize URL, the token request, or the stored/returned connection.
// Shown behaviourally: the INJECTED client id is what the authorize URL carries, and a
// decoy secret planted in the environment never appears anywhere the client produces.
// ===========================================================================

const DECOY_CLIENT_ID = "env-decoy-CLIENTID-must-never-be-used";
const DECOY_SECRET = "env-decoy-SECRET-must-never-be-used";

test("the authorize URL carries the INJECTED client id, never an ambient env value", async () => {
  const prev = process.env.OAUTH_CLIENT_ID;
  process.env.OAUTH_CLIENT_ID = DECOY_CLIENT_ID;
  try {
    const { url } = await buildAuthorizeUrl({ entry: GOOGLE_ENTRY, config: CONFIG });
    assert.ok(url.includes(CONFIG.clientId), "the injected client id is used");
    assert.ok(!url.includes(DECOY_CLIENT_ID), "no ambient env client id leaks into the authorize URL");
  } finally {
    if (prev === undefined) delete process.env.OAUTH_CLIENT_ID;
    else process.env.OAUTH_CLIENT_ID = prev;
  }
});

test("no ambient env secret reaches the token request, the returned connection, or a stored column", async () => {
  const prevId = process.env.OAUTH_CLIENT_ID;
  const prevSecret = process.env.OAUTH_CLIENT_SECRET;
  process.env.OAUTH_CLIENT_ID = DECOY_CLIENT_ID;
  process.env.OAUTH_CLIENT_SECRET = DECOY_SECRET;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac4-secrets");
    const dek = freshDek();
    const f = recordingFetch(() =>
      tokenResponse({ access_token: "atok_ENV", refresh_token: "rtok_ENV", scope: "s" }),
    );

    const conn = await exchangeCodeForConnection(
      {
        entry: GOOGLE_ENTRY,
        config: CONFIG,
        userId,
        accountLabel: "oren@gmail.com",
        code: "c",
        state: "st",
        codeVerifier: "a".repeat(43),
        dek,
      },
      makeDeps(db, CLOCK, f.fetch),
    );

    const sent = requestText(f.requests);
    assert.ok(!sent.includes(DECOY_SECRET), "no ambient env secret is sent in the token request");
    assert.ok(!sent.includes(DECOY_CLIENT_ID), "no ambient env client id is sent in the token request");

    assert.ok(!JSON.stringify(conn).includes(DECOY_SECRET), "the decoy never lands in the returned connection");

    const raw = await rawConnectionsText(db);
    assert.ok(!raw.includes(DECOY_SECRET), "the decoy never lands in a stored column");
    assert.ok(!raw.includes(DECOY_CLIENT_ID), "the decoy client id never lands in a stored column");
  } finally {
    await db.close();
    if (prevId === undefined) delete process.env.OAUTH_CLIENT_ID;
    else process.env.OAUTH_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.OAUTH_CLIENT_SECRET;
    else process.env.OAUTH_CLIENT_SECRET = prevSecret;
  }
});
