// E09-S18 — Provider OAuth callback route (`src/app/connect/callback/route.ts` + its
// SIBLING `handler.ts`, design §7 connector engine; constitution 15/16; INV-101
// admin-auth-required, INV-102 validate-and-parameterize-input, INV-103 secrets-from-env).
//
// RED-first: the sibling factory `./handler` (`createConnectCallbackHandler`) does not
// exist yet, so importing it throws and EVERY test here fails until the builder writes the
// module. That absence IS the point of test-first — as the TESTER I must NOT create or
// edit any implementation/source file to make these pass; the builder writes `handler.ts`
// (and the thin `route.ts`) afterwards to this contract.
//
// WHY this exists (task E09-S18): a provider sign-in connection (Google, Microsoft, …)
// sends the person back to Warthog after consent. The callback is a SERVER AUTH BOUNDARY:
// it must verify the signed-in session, validate the CSRF `state` against the pending
// flow the connect-start stashed FOR THAT PERSON, exchange the authorization code through
// the OAuth connector client, and store the connection — bound to the SESSION user, never
// a value from the request.
//
// These tests pin BEHAVIOUR (the HTTP outcome, which seam the handler drives, and the
// stored state), never the source text of any module — a later rename that preserves
// behaviour must not redden them. A Next App-Router `route.ts` may export ONLY the known
// route keys (the HTTP verbs + framework config) or `next build` rejects it (OBS-025), so
// the injectable factory lives HERE, in the sibling `handler.ts`, and `route.ts` imports it
// and exports only the verb(s). Its entry-shape is pinned in the sibling `route.test.ts`.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // The connect-start secrets stashed for a pending provider sign-in — NOT the user id
//   // (the lookup below is already scoped by the session user, so the flow needn't carry it).
//   interface PendingConnectFlow { connectorId: string; accountLabel: string; codeVerifier: string }
//
//   // What the callback hands the exchange/store step. `userId` is ALWAYS the session's.
//   interface CompleteConnectionInput {
//     userId: string; connectorId: string; accountLabel: string; code: string; codeVerifier: string;
//   }
//
//   interface ConnectCallbackSeams {                                   // every seam optional,
//     resolveSession?:    (request: Request) => Promise<Session | null>;   // production defaults
//     takePendingFlow?:   (userId: string, state: string) => Promise<PendingConnectFlow | null>;
//     completeConnection?:(input: CompleteConnectionInput) => Promise<Connection>;
//     config?:            Config;
//   }
//
//   createConnectCallbackHandler(seams?: ConnectCallbackSeams): { GET(request: Request): Promise<Response> }
//
//     GET (the provider redirect lands here with `?code=…&state=…`):
//       1. Resolve the session (`resolveSession`). No session → reject the whole request
//          with 401 OR a redirect to sign-in, before any flow lookup or exchange (INV-101).
//       2. Read + validate `code` and `state` from the query (INV-102): a missing/oversized
//          value is a 4xx (never a 500), before any exchange.
//       3. Look up the pending flow by (SESSION userId, state) — `takePendingFlow`. A state
//          that maps to no flow FOR THIS SESSION USER (missing / mismatched / another
//          person's) is rejected; nothing is exchanged.
//       4. Exchange the code and store the connection (`completeConnection`) with the
//          connector/label/verifier from the stashed flow and the code from the query,
//          scoped to the session user. On success, land the person back in the app.
//
// The seams are injected so the route's OWN job (auth gate + state validation +
// orchestration) is exercised without the composition root. The happy path drives the
// REAL `exchangeCodeForConnection` over an isolated in-memory PGlite with a recording
// `fetch` standing in for the provider token endpoint — so "stores the connection
// connected" is proven against the real connector client + connections store, never a
// mock of them. The authoritative parameter-binding proof for the stores lives in their
// own tests (`connections`, `oauth-client`), which this route composes. Tests never touch
// the network or Azure; every db handle is closed in a `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";

import { createConnectCallbackHandler } from "./handler";

import { createUser } from "../../../server/db/users";
import { listConnectionsForUser, type Connection } from "../../../server/db/connections";
import { exchangeCodeForConnection, type OAuthClientConfig } from "../../../server/connectors/oauth-client";
import { createSession, verifySession, COOKIE_NAME, type Session } from "../../../server/auth/session";
import { loadConfig, type Config } from "../../../server/config";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { fixedRandom } from "../../../server/seams/random";
import { freshDb } from "../../../test/db";
import { createProtectedResourceMetadataHandler } from "../../.well-known/oauth-protected-resource/handler";
import type { CatalogueEntry } from "../../../domain/catalogue/schema";
import type { Db } from "../../../server/db/index";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const NOW = new Date("2026-06-01T10:00:00.000Z");
const CLOCK: Clock = fixedClock(NOW);

// A valid DEVELOPMENT config, a pure function of this record (no test mutates the real
// environment). Secret values are test-only, at the lengths `loadConfig` requires.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

function configFixture(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: HMAC_KEY_B64,
    WARTHOG_DEV_KEK: DEV_KEK_B64,
  } as NodeJS.ProcessEnv);
}

// A Google-family oauth2 catalogue entry — the provider HOST the exchange must use comes
// only from HERE (CLAUDE.md: "Connector requests never take a host from the caller").
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

// The operator-configured OAuth client (from config, the one env reader — INV-103).
const CONFIG: OAuthClientConfig = {
  clientId: "warthog-injected-CLIENTID",
  clientSecret: "warthog-injected-SECRET",
  redirectUri: "https://warthog.example/connect/callback",
};

function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-${who}`).toString("base64"),
  });
  return user.id;
}

// A plain verified session for `userId` — identity the route must trust over any request
// value. (The real verifySession path is exercised separately below.)
function fixedSession(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

// Pull one cookie value out of the request's Cookie header (the real session resolver's job).
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// The REAL session resolver seam: reads the `__Host-wh_session` cookie and verifies it with
// the already-built `verifySession` over `db`. Used to prove a genuinely-verified session is
// admitted and an unverifiable cookie is refused — faithful server-side auth, not a mock.
function realResolveSession(db: Db, clock: Clock) {
  return async (request: Request): Promise<Session | null> => {
    const token = readCookie(request, COOKIE_NAME);
    return token ? verifySession(db, token, { clock }) : null;
  };
}

// The provider's OAuth redirect: a GET to /connect/callback carrying `code` + `state` (and
// any extra query a forged request might add, to prove it is ignored). A session cookie is
// attached when given.
function callbackRequest(
  opts: { code?: string; state?: string; cookie?: string; query?: Record<string, string> } = {},
): Request {
  const url = new URL("https://warthog.example/connect/callback");
  if (opts.code !== undefined) url.searchParams.set("code", opts.code);
  if (opts.state !== undefined) url.searchParams.set("state", opts.state);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = `${COOKIE_NAME}=${opts.cookie}`;
  return new Request(url.href, { method: "GET", headers });
}

// --- the pending-flow store seam, faked (keyed by SESSION user + state) --------------

interface PendingFlowFields {
  connectorId: string;
  accountLabel: string;
  codeVerifier: string;
}

// An in-memory pending-flow store that mirrors the real one's contract: a flow is stashed
// under (userId, state) at connect-start and CONSUMED once by (userId, state) at callback.
// `taken` records every lookup key so a test can prove the lookup used the SESSION user id.
function pendingFlowStore() {
  const map = new Map<string, PendingFlowFields>();
  const taken: string[] = [];
  const key = (userId: string, state: string): string => `${userId}\u0000${state}`;
  const put = (userId: string, state: string, flow: PendingFlowFields): void => {
    map.set(key(userId, state), flow);
  };
  const take = async (userId: string, state: string): Promise<PendingFlowFields | null> => {
    const k = key(userId, state);
    taken.push(k);
    const flow = map.get(k) ?? null;
    if (flow) map.delete(k);
    return flow;
  };
  return { put, take, taken };
}

// --- the exchange/store seam, spied (and optionally driven by the REAL client) -------

interface SeenComplete {
  userId: string;
  connectorId: string;
  accountLabel: string;
  code: string;
  codeVerifier: string;
}

// A fabricated connected connection, for tests that only assert the handler drove the
// exchange with the right arguments (no db needed).
function fakeConnection(input: SeenComplete): Connection {
  return {
    id: randomUUID(),
    userId: input.userId,
    connectorId: input.connectorId,
    accountLabel: input.accountLabel,
    status: "connected",
    connectedAt: NOW,
  };
}

// A `completeConnection` spy: records every input the handler built and returns a
// connection (fabricated by default, or via `impl` — e.g. the REAL exchange+store).
function completeSpy(impl?: (input: SeenComplete) => Promise<Connection>) {
  const calls: SeenComplete[] = [];
  const completeConnection = async (input: {
    userId: string;
    connectorId: string;
    accountLabel: string;
    code: string;
    codeVerifier: string;
  }): Promise<Connection> => {
    const seen: SeenComplete = {
      userId: input.userId,
      connectorId: input.connectorId,
      accountLabel: input.accountLabel,
      code: input.code,
      codeVerifier: input.codeVerifier,
    };
    calls.push(seen);
    return impl ? impl(seen) : fakeConnection(seen);
  };
  return { completeConnection, calls };
}

// The REAL exchange+store: the production connector client (`exchangeCodeForConnection`)
// over `db`, a frozen clock and a recording `fetch`. Proves the callback actually stores a
// connected connection through the real code path, host taken only from the catalogue entry.
function realComplete(db: Db, dek: Uint8Array, fetchFn: typeof globalThis.fetch) {
  return async (input: SeenComplete): Promise<Connection> => {
    if (input.connectorId !== GOOGLE_ENTRY.id) {
      throw new Error(`unexpected connector ${input.connectorId}`);
    }
    return exchangeCodeForConnection(
      {
        entry: GOOGLE_ENTRY,
        config: CONFIG,
        userId: input.userId,
        accountLabel: input.accountLabel,
        code: input.code,
        // The callback's state already validated against the stashed flow; the exchange's
        // own state check gets a self-consistent value (callback == expected).
        state: "exchange-state",
        codeVerifier: input.codeVerifier,
        dek,
      },
      { db, clock: CLOCK, fetch: fetchFn },
    );
  };
}

// --- a recording `fetch` standing in for the provider token endpoint ----------------

interface SeenRequest {
  url: string;
  method: string;
  body: string;
}

function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

function recordingFetch(respond: () => Response): { fetch: typeof globalThis.fetch; requests: SeenRequest[] } {
  const requests: SeenRequest[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    requests.push({ url, method: String(init?.method ?? "GET"), body: bodyToString(init?.body) });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch: fn, requests };
}

// A standards-compliant OAuth 2.0 token endpoint response (the shape oauth4webapi accepts).
function tokenResponse(tokens: { access_token: string; refresh_token?: string; scope?: string }): Response {
  return new Response(JSON.stringify({ token_type: "Bearer", expires_in: 3600, ...tokens }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// --- a recording db seam (proves what reached the query layer) ----------------------

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

// The parameterize half of INV-102: a probe reaches the query layer as a BOUND value and
// never as spliced SQL text.
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued through the callback");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the value travels bound into the query");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the value is bound, never concatenated into the SQL text");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Whether a relation of this exact name exists — a non-throwing probe for the survival test.
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// --- driving the handler ------------------------------------------------------------

// Invoke the callback's GET, tolerant of EITHER factory return shape this repo uses: a
// single-verb factory may return the bare `(request) => Response` (as `createRevokeHandler`
// does) or an object exposing `{ GET }` (as `createMcpRouteHandler` does). Both are valid
// ways for `route.ts` to export only its GET verb (OBS-025), so the tests pin the HTTP
// behaviour, not which of the two the builder chose.
function callGet(handler: unknown, request: Request): Promise<Response> {
  const fn =
    typeof handler === "function"
      ? (handler as (r: Request) => Promise<Response>)
      : (handler as { GET?: (r: Request) => Promise<Response> }).GET;
  if (typeof fn !== "function") {
    throw new Error("the connect-callback factory exposes no GET handler");
  }
  return fn(request);
}

// --- response-outcome helpers -------------------------------------------------------

function assert4xx(res: Response): void {
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
}

// A rejected callback is either a 4xx or a redirect to an error/notice page — never a
// plain success that proceeded.
function assertRejected(res: Response): void {
  const loc = res.headers.get("location");
  const redirect = res.status >= 300 && res.status < 400 && loc != null;
  const clientError = res.status >= 400 && res.status < 500;
  assert.ok(
    redirect || clientError,
    `a rejected callback must be a 4xx or a redirect, got ${res.status} (location: ${loc ?? "none"})`,
  );
}

function assertUnauthenticated(res: Response): void {
  if (res.status === 401) return;
  const loc = res.headers.get("location");
  assert.ok(
    res.status >= 300 && res.status < 400 && loc != null && /sign-?in/i.test(loc),
    `an unauthenticated callback must be 401 or a redirect to sign-in, got ${res.status} (location: ${loc ?? "none"})`,
  );
}

async function serialiseResponse(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  let body = "";
  try {
    body = await res.clone().text();
  } catch {
    body = "";
  }
  return `${res.status} ${headers} ${body}`;
}

// ===================================================================================
// AC1 — a valid state for the session user exchanges the code and stores the connection
// connected; a missing or mismatched state is rejected.
// ===================================================================================

test("AC1: a valid callback for the session user exchanges the code and stores the connection connected", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "connect-ok");
    const dek = freshDek();
    const f = recordingFetch(() => tokenResponse({ access_token: "atok_CB", refresh_token: "rtok_CB", scope: "s" }));
    const flows = pendingFlowStore();
    flows.put(userId, "state-OK", {
      connectorId: GOOGLE_ENTRY.id,
      accountLabel: "oren@gmail.com",
      codeVerifier: "a".repeat(43),
    });

    const handler = createConnectCallbackHandler({
      resolveSession: async () => fixedSession(userId),
      takePendingFlow: flows.take,
      completeConnection: completeSpy(realComplete(db, dek, f.fetch)).completeConnection,
      config: configFixture(),
    });

    const res = await callGet(handler, callbackRequest({ code: "the-code", state: "state-OK" }));

    // The callback succeeded (not a rejection).
    assert.ok(res.status < 400, `a valid callback must not be rejected, got ${res.status}`);

    // The connection is now stored for the SESSION user, marked connected.
    const listed = await listConnectionsForUser(db, userId);
    assert.equal(listed.length, 1, "the connection is stored");
    assert.equal(listed[0]!.connectorId, GOOGLE_ENTRY.id, "for the connector from the stashed flow");
    assert.equal(listed[0]!.status, "connected", "a freshly connected service is 'connected'");

    // The code really was exchanged at the provider's token endpoint (host from the entry).
    assert.equal(f.requests.length, 1, "the code was exchanged at the provider token endpoint");
    assert.equal(new URL(f.requests[0]!.url).host, "oauth2.googleapis.com", "at the entry's token host");

    // The person is landed back in the app, never bounced back to the provider.
    const location = res.headers.get("location");
    if (location) {
      assert.ok(
        !/accounts\.google\.com|oauth2\.googleapis\.com/.test(location),
        `the callback lands the person back in the app, not the provider: ${location}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("AC1: the exchange uses the code from the query and the connector/label/verifier from the stashed flow (user from the session)", async () => {
  const userId = "session-user-2";
  const flows = pendingFlowStore();
  flows.put(userId, "state-2", {
    connectorId: GOOGLE_ENTRY.id,
    accountLabel: "label-from-flow",
    codeVerifier: "verifier-from-flow",
  });
  const complete = completeSpy();
  const handler = createConnectCallbackHandler({
    resolveSession: async () => fixedSession(userId),
    takePendingFlow: flows.take,
    completeConnection: complete.completeConnection,
    config: configFixture(),
  });

  // The query also smuggles a userId; it must be ignored in favour of the session's.
  await callGet(handler, callbackRequest({ code: "code-from-query", state: "state-2", query: { userId: "attacker-ignored" } }));

  assert.equal(complete.calls.length, 1, "a valid callback performs exactly one exchange");
  const seen = complete.calls[0]!;
  assert.equal(seen.userId, userId, "the exchange is scoped to the SESSION user, never a query value");
  assert.equal(seen.code, "code-from-query", "the authorization code comes from the query");
  assert.equal(seen.connectorId, GOOGLE_ENTRY.id, "the connector comes from the stashed pending flow");
  assert.equal(seen.accountLabel, "label-from-flow", "the account label comes from the stashed pending flow");
  assert.equal(seen.codeVerifier, "verifier-from-flow", "the PKCE verifier comes from the stashed pending flow");
});

test("AC1: a callback whose state matches no pending flow is rejected and nothing is exchanged", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "mismatch");
    const flows = pendingFlowStore();
    flows.put(userId, "the-real-state", {
      connectorId: GOOGLE_ENTRY.id,
      accountLabel: "x",
      codeVerifier: "a".repeat(43),
    });
    const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r" }));
    const complete = completeSpy(realComplete(db, freshDek(), f.fetch));
    const handler = createConnectCallbackHandler({
      resolveSession: async () => fixedSession(userId),
      takePendingFlow: flows.take,
      completeConnection: complete.completeConnection,
      config: configFixture(),
    });

    const res = await callGet(handler, callbackRequest({ code: "c", state: "a-DIFFERENT-state" }));

    assertRejected(res);
    assert.equal(complete.calls.length, 0, "a mismatched state never triggers an exchange");
    assert.equal(f.requests.length, 0, "…and never reaches the provider token endpoint");
    assert.equal((await listConnectionsForUser(db, userId)).length, 0, "no connection is stored for a mismatched state");
  } finally {
    await db.close();
  }
});

test("AC1/INV-101: a state belonging to another person is rejected — the pending flow is looked up by the SESSION user", async () => {
  const alice = "alice-user";
  const bob = "bob-user";
  const flows = pendingFlowStore();
  // Alice started a connect flow; her state must not be usable from Bob's session.
  flows.put(alice, "alice-state", {
    connectorId: GOOGLE_ENTRY.id,
    accountLabel: "alice@gmail.com",
    codeVerifier: "a".repeat(43),
  });
  const complete = completeSpy();
  const handler = createConnectCallbackHandler({
    resolveSession: async () => fixedSession(bob),
    takePendingFlow: flows.take,
    completeConnection: complete.completeConnection,
    config: configFixture(),
  });

  const res = await callGet(handler, callbackRequest({ code: "c", state: "alice-state" }));

  assertRejected(res);
  assert.equal(complete.calls.length, 0, "another person's state can never complete a connection for this session");
  assert.deepEqual(
    flows.taken,
    [`${bob}\u0000alice-state`],
    "the pending flow is looked up by the SESSION user id, never the state alone",
  );
});

// ===================================================================================
// AC [obligation:admin-auth-required] (INV-101) — the callback requires a server-verified
// session; a public route stays usable with no auth; identity is never a client value.
// ===================================================================================

test("[admin-auth-required] an unauthenticated callback is rejected (401 or a redirect to sign-in) and never looks up a flow or exchanges", async () => {
  const flows = pendingFlowStore();
  const complete = completeSpy();
  let flowLookups = 0;
  const handler = createConnectCallbackHandler({
    resolveSession: async () => null,
    takePendingFlow: async (u, s) => {
      flowLookups++;
      return flows.take(u, s);
    },
    completeConnection: complete.completeConnection,
    config: configFixture(),
  });

  const res = await callGet(handler, callbackRequest({ code: "c", state: "s" }));

  assertUnauthenticated(res);
  assert.equal(flowLookups, 0, "an unauthenticated request never reaches the pending-flow lookup");
  assert.equal(complete.calls.length, 0, "…and never exchanges a code");
});

test("[admin-auth-required] a garbage/unknown session cookie is treated as unauthenticated (real verifySession)", async () => {
  const db = await freshDb();
  try {
    const complete = completeSpy();
    const handler = createConnectCallbackHandler({
      resolveSession: realResolveSession(db, CLOCK),
      takePendingFlow: pendingFlowStore().take,
      completeConnection: complete.completeConnection,
      config: configFixture(),
    });

    const res = await callGet(handler, callbackRequest({ code: "c", state: "s", cookie: `no-such-session-${randomUUID()}` }));

    assertUnauthenticated(res);
    assert.equal(complete.calls.length, 0, "an unverifiable cookie never completes a connection");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a genuinely verified session is admitted and completes the connection", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "admitted");
    const { token } = await createSession(db, userId, { clock: CLOCK, random: fixedRandom(9) });
    const flows = pendingFlowStore();
    flows.put(userId, "admit-state", {
      connectorId: GOOGLE_ENTRY.id,
      accountLabel: "oren@gmail.com",
      codeVerifier: "a".repeat(43),
    });
    const complete = completeSpy();
    const handler = createConnectCallbackHandler({
      resolveSession: realResolveSession(db, CLOCK),
      takePendingFlow: flows.take,
      completeConnection: complete.completeConnection,
      config: configFixture(),
    });

    const res = await callGet(handler, callbackRequest({ code: "c", state: "admit-state", cookie: token }));

    assert.ok(res.status < 400, `a verified session must be admitted, got ${res.status}`);
    assert.equal(complete.calls.length, 1, "a verified session completes the connection");
    assert.equal(complete.calls[0]!.userId, userId, "scoped to the verified session's user id");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a public route is served 200 with no auth header or session", async () => {
  // The protected-resource metadata is how an agent discovers HOW to get a token, so it
  // MUST stay reachable with no Authorization header or session (INV-101). The real,
  // already-built public handler — no bearer, no session presented.
  const handler = createProtectedResourceMetadataHandler({ config: configFixture() });
  const res = handler(new Request("https://warthog.example/.well-known/oauth-protected-resource"));
  assert.equal(res.status, 200, "a public route stays usable with no auth (INV-101)");
});

test("[admin-auth-required] the connection is bound to the SESSION user, never a user id from the request", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "owner");
    const attacker = randomUUID();
    const dek = freshDek();
    const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r", scope: "s" }));
    const flows = pendingFlowStore();
    flows.put(sessionUser, "own-state", {
      connectorId: GOOGLE_ENTRY.id,
      accountLabel: "oren@gmail.com",
      codeVerifier: "a".repeat(43),
    });
    const handler = createConnectCallbackHandler({
      resolveSession: async () => fixedSession(sessionUser),
      takePendingFlow: flows.take,
      completeConnection: completeSpy(realComplete(db, dek, f.fetch)).completeConnection,
      config: configFixture(),
    });

    await callGet(handler, callbackRequest({ code: "c", state: "own-state", query: { userId: attacker } }));

    assert.equal((await listConnectionsForUser(db, sessionUser)).length, 1, "stored under the SESSION user");
    assert.deepEqual(await listConnectionsForUser(db, attacker), [], "never under a user id smuggled in the request");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC [obligation:validate-and-parameterize-input] (INV-102) — the handler rejects
// malformed / oversized input with a 4xx (never a 500), treats a SQL-shaped input field as
// data, and binds every value that reaches a query. (The authoritative binding proof for
// the stores lives in the `connections` / `oauth-client` tests this route composes.)
// ===================================================================================

test("[validate-and-parameterize-input] a callback with a code but no state is rejected with a 4xx (the CSRF state is mandatory)", async () => {
  const complete = completeSpy();
  const handler = createConnectCallbackHandler({
    resolveSession: async () => fixedSession("u"),
    takePendingFlow: pendingFlowStore().take,
    completeConnection: complete.completeConnection,
    config: configFixture(),
  });

  const res = await callGet(handler, callbackRequest({ code: "c" })); // no state

  assert4xx(res);
  assert.equal(complete.calls.length, 0, "a stateless callback never exchanges a code");
});

test("[validate-and-parameterize-input] an oversized state is rejected with a 4xx and never exchanges", async () => {
  const complete = completeSpy();
  const handler = createConnectCallbackHandler({
    resolveSession: async () => fixedSession("u"),
    takePendingFlow: pendingFlowStore().take,
    completeConnection: complete.completeConnection,
    config: configFixture(),
  });

  const res = await callGet(handler, callbackRequest({ code: "c", state: "x".repeat(16 * 1024) }));

  assert4xx(res);
  assert.equal(complete.calls.length, 0, "an oversized state never exchanges a code");
});

test("[validate-and-parameterize-input] a SQL-injection probe in the state is treated as data: looked up as a value, the callback is rejected, nothing is exchanged", async () => {
  const probe = "x'; DROP TABLE connections; --";
  const taken: Array<{ userId: string; state: string }> = [];
  const complete = completeSpy();
  const handler = createConnectCallbackHandler({
    resolveSession: async () => fixedSession("probe-user"),
    takePendingFlow: async (userId, state) => {
      taken.push({ userId, state });
      return null;
    },
    completeConnection: complete.completeConnection,
    config: configFixture(),
  });

  const res = await callGet(handler, callbackRequest({ code: "c", state: probe }));

  assertRejected(res);
  assert.equal(complete.calls.length, 0, "a probe state matches no flow, so nothing is exchanged");
  assert.deepEqual(
    taken,
    [{ userId: "probe-user", state: probe }],
    "the state reaches the lookup verbatim as a bound value — never spliced or interpreted",
  );
});

test("[validate-and-parameterize-input] a SQL-shaped value carried through the callback into the connection INSERT is bound, never spliced", async () => {
  const userId = "writer";
  const probe = "oren'); DROP TABLE connections; --";
  const db = recordingDb();
  const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r", scope: "s" }));
  const flows = pendingFlowStore();
  flows.put(userId, "w-state", { connectorId: GOOGLE_ENTRY.id, accountLabel: probe, codeVerifier: "a".repeat(43) });
  const handler = createConnectCallbackHandler({
    resolveSession: async () => fixedSession(userId),
    takePendingFlow: flows.take,
    completeConnection: completeSpy(realComplete(db, freshDek(), f.fetch)).completeConnection,
    config: configFixture(),
  });

  await callGet(handler, callbackRequest({ code: "c", state: "w-state" }));

  assertBoundNotSpliced(db, probe);
});

test("[validate-and-parameterize-input] a SQL-shaped value stored through the callback round-trips as data and the connections table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "survivor");
    const dek = freshDek();
    const probe = "oren'); DROP TABLE connections; --";
    const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r", scope: "s" }));
    const flows = pendingFlowStore();
    flows.put(userId, "s-state", { connectorId: GOOGLE_ENTRY.id, accountLabel: probe, codeVerifier: "a".repeat(43) });
    const handler = createConnectCallbackHandler({
      resolveSession: async () => fixedSession(userId),
      takePendingFlow: flows.take,
      completeConnection: completeSpy(realComplete(db, dek, f.fetch)).completeConnection,
      config: configFixture(),
    });

    await callGet(handler, callbackRequest({ code: "c", state: "s-state" }));

    assert.equal(await tableExists(db, "connections"), true, "the connections table survives the probe");
    const listed = await listConnectionsForUser(db, userId);
    assert.equal(listed.length, 1, "the connection was stored");
    assert.equal(listed[0]!.accountLabel, probe, "the probe is stored verbatim as data, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC [obligation:secrets-from-env] (INV-103) — config flows in through the injected seam;
// no ambient env secret is folded into the callback's response.
// ===================================================================================

test("[secrets-from-env] no ambient env secret appears in a successful callback response", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "secrets-ok");
    const dek = freshDek();
    const f = recordingFetch(() => tokenResponse({ access_token: "a", refresh_token: "r", scope: "s" }));
    const flows = pendingFlowStore();
    flows.put(userId, "sec-state", {
      connectorId: GOOGLE_ENTRY.id,
      accountLabel: "oren@gmail.com",
      codeVerifier: "a".repeat(43),
    });
    // Config is built from an explicit env record (NO decoy), so the route reads config
    // through the seam, never ambient process.env.
    const handler = createConnectCallbackHandler({
      resolveSession: async () => fixedSession(userId),
      takePendingFlow: flows.take,
      completeConnection: completeSpy(realComplete(db, dek, f.fetch)).completeConnection,
      config: configFixture(),
    });

    const res = await callGet(handler, callbackRequest({ code: "c", state: "sec-state" }));
    const serialised = await serialiseResponse(res);

    assert.ok(!serialised.includes(DECOY), "no ambient env secret is folded into the callback response");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

test("[secrets-from-env] no ambient env secret appears in an unauthenticated callback response", async () => {
  const DECOY = "sk_live_DECOY_unauth_must_never_appear";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  try {
    const handler = createConnectCallbackHandler({
      resolveSession: async () => null,
      takePendingFlow: pendingFlowStore().take,
      completeConnection: completeSpy().completeConnection,
      config: configFixture(),
    });

    const res = await callGet(handler, callbackRequest({ code: "c", state: "s" }));
    const serialised = await serialiseResponse(res);

    assert.ok(!serialised.includes(DECOY), "no ambient env secret is folded into the unauthenticated response");
  } finally {
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
