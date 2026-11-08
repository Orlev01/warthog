// E10-S12 — Agent consent flow, end to end at the seam level (design §6.1/§6.2;
// constitution 14/15/16; brief "Agent consent screen").
//
// RED-first: the new seams this flow needs — `beginAuthorization` (consent-first routing +
// the server-side pending store) and the consent decision taking an opaque pending HANDLE —
// do not exist yet, so this file fails to import/run until the builder adds them. That
// absence IS the point of test-first — do NOT implement anything to make these pass.
//
// WHY this exists: until E10-S12 the `/oauth/authorize` route issued a code to any signed-in
// person with NO consent and NO agent row, so an OAuth-connected agent (Claude, ChatGPT) got
// "This agent is not connected." on every tool call. This test walks the WHOLE fixed flow
// over the REAL seams and proves the agent is CONNECTED afterwards:
//
//   beginAuthorization (consent-first, request carried server-side)
//     → the consent decision APPROVE (names the agent, creates its connection + permissions,
//        issues the code bound to that connection)
//     → /oauth/token exchange (PKCE S256) → an access token
//     → the token resolves to the connection (verifyBearer)
//     → POST /mcp tools/call get_context → EXECUTED (not "This agent is not connected.")
//     → Warthog itself records an activity entry the person sees on /activity.
//
// It asserts BEHAVIOUR (stored agent/permissions, the issued token, the MCP tool result over
// the real wire, the recorded activity), never the source text of any module — exactly the
// style of compose.test.ts, whose MCP wire + DEK helpers are mirrored here. An isolated
// in-memory PGlite is seeded through the real stores; no network, no Azure; every db handle
// is closed in a `finally`.
//
// AC1  consent → approve → token → /mcp get_context is EXECUTED and records an activity entry.
// AC2  refuse → redirect with error=access_denied, and no agent / connection / code created.
// AC3  the approved agent appears on /agents with the chosen name and permissions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { createAuthorizeActions, type ConsentApproval } from "./actions";
import { beginAuthorization } from "../../../server/oauth/authorize";

import { loadConfig, type Config } from "../../../server/config";
import { localAesKeyWrapper } from "../../../server/crypto/key-wrapper";
import { exchangeToken } from "../../../server/oauth/token";
import { verifyBearer } from "../../../server/oauth/verify-bearer";
import { createClient } from "../../../server/oauth/store";
import { createClientResolver } from "../../../server/oauth/clients";
import { createMcpDispatch } from "../../../server/mcp/compose";
import { listActivity } from "../../../server/activity/list";
import { createUser } from "../../../server/db/users";
import { listAgentsForUser } from "../../../server/db/agents";
import { getConnectionPermissions } from "../../../server/db/agent-permissions";
import { createConnection } from "../../../server/db/connections";
import { fixedClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";
import type { Session } from "../../../server/auth/session";

// --- fixtures -----------------------------------------------------------------------

// The founder's public host, so the issuer, the MCP resource and the /mcp request host all
// flow from one base (design §6.1).
const BASE_URL = "https://warthog.example";
const MCP_RESOURCE = "https://warthog.example/mcp";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
// The RFC 7636 Appendix B test vector: base64url(SHA-256(CODE_VERIFIER)) === CODE_CHALLENGE.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state-7f3a91c0";
// A frozen instant: the code (60 s TTL) and the token (1 h TTL) are minted and used here, so
// a fixed clock keeps the window deterministic.
const NOW = new Date("2026-06-01T00:00:00.000Z");

// Dev secrets at the lengths loadConfig requires (HMAC ≥ 32 bytes, dev KEK exactly 32), as
// compose.test.ts uses — so the dispatch's KeyWrapper unwraps exactly the DEK we seed.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

function devConfig(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: BASE_URL,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: HMAC_KEY_B64,
    WARTHOG_DEV_KEK: DEV_KEK_B64,
  } as NodeJS.ProcessEnv);
}

// Review fix A1: the client is resolved from the database (each test registers it, as a
// real flow needs); no CIMD fetch is ever made in tests.
function deps(db: Db, config: Config) {
  return {
    db,
    config,
    clock: fixedClock(NOW),
    random: systemRandom,
    hmacKey: config.hmacKey,
    resolveClient: createClientResolver({
      db,
      fetchCimd: async (clientId: string): Promise<Record<string, unknown>> => {
        throw new Error(`no CIMD fetch in tests (${clientId})`);
      },
    }),
  };
}

function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

function authorizeParams(): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
    state: STATE,
    scope: "warthog",
  });
}

function approval(overrides: Partial<ConsentApproval> = {}): ConsentApproval {
  return { name: "My Claude", platform: "claude", template: "standard", ...overrides };
}

// A real person whose DEK is wrapped under the SAME local KEK the composition root derives
// from config.devKek, so the dispatch's KeyWrapper (and listActivity below) read what we
// seed. Returns the user id and the raw DEK (to decrypt the person's activity).
async function makePerson(db: Db, config: Config): Promise<{ userId: string; dek: Uint8Array }> {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `person-${Math.random().toString(36).slice(2)}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// Exchange the issued code for an access token, PKCE S256 (same fields a real client sends).
function tokenParams(code: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: CODE_VERIFIER,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
  });
}

// A POST to /mcp with the Streamable-HTTP headers a real MCP client sends (Accept names both
// JSON and SSE) and the bearer. Mirrors compose.test.ts's mcpPost.
function mcpPost(body: unknown, opts: { bearer?: string } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new Request(`${BASE_URL}/mcp`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function callBody(name: string, args: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

// Read an MCP response: SSE (`data: {json}`) on success, plain JSON on a transport refusal.
// Returns the last JSON-RPC message. Mirrors compose.test.ts's readRpc.
interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}
async function readRpc(res: Response): Promise<JsonRpcResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const frames = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((frame) => frame.length > 0);
    assert.ok(frames.length > 0, `an SSE MCP response must carry a data frame, got: ${text}`);
    return JSON.parse(frames[frames.length - 1]!) as JsonRpcResponse;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

function contentText(result: JsonRpcResponse["result"]): string {
  return (result?.content ?? []).map((block) => block.text ?? "").join(" ");
}

// Pull the authorization code out of a redirect-back URL (null on a refusal).
function codeIn(redirectTo: string): string | null {
  return new URL(redirectTo).searchParams.get("code");
}

// =====================================================================================
// AC1 — consent → approve → token → /mcp get_context is EXECUTED (the agent is CONNECTED,
// no longer "This agent is not connected.") and Warthog records the activity.
// =====================================================================================

test("AC1: an approved OAuth agent exchanges its code for a token and calls get_context — connected, not refused", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    // The consenting client is registered (CIMD), as a real authorize + token exchange needs.
    await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
    const { userId, dek } = await makePerson(db, config);
    const session = sessionFor(userId);

    // 1. The signed-in, valid authorize request is carried to consent (server-side), not
    //    issued a code.
    const begun = await beginAuthorization({ params: authorizeParams(), session }, deps(db, config));
    assert.ok(begun.ok, "a valid authorize request begins the consent flow");
    if (!begun.ok) throw new Error("unreachable: beginAuthorization was not ok");
    assert.equal(begun.redirectTo, "/oauth/consent", "the person is sent to the consent screen first");

    // 2. The person APPROVES: the decision reads the pending request server-side (by handle),
    //    names the agent, creates its connection + permissions, and issues the code.
    const decided = await createAuthorizeActions(deps(db, config)).approve(session, begun.handle, approval());
    assert.ok(decided.ok, "approving the consent succeeds");
    if (!decided.ok) throw new Error("unreachable: approve was not ok");

    const url = new URL(decided.redirectTo);
    assert.equal(`${url.origin}${url.pathname}`, REDIRECT_URI, "approval redirects back to the client");
    assert.equal(url.searchParams.get("state"), STATE, "the redirect echoes the request state");
    assert.equal(url.searchParams.get("iss"), BASE_URL, "the redirect carries the issuer (RFC 9207)");
    const code = codeIn(decided.redirectTo);
    assert.ok(code != null, "an authorization code is issued on approval");

    // 3. The client exchanges the code at /oauth/token (PKCE S256) for an access token.
    const exchanged = await exchangeToken({ params: tokenParams(code!) }, deps(db, config));
    assert.ok(exchanged.ok, `the code exchanges for a token, got: ${JSON.stringify(exchanged)}`);
    if (!exchanged.ok) throw new Error("unreachable: token exchange failed");
    const accessToken = exchanged.body.access_token;
    assert.ok(accessToken.length >= 32, "an opaque access token is returned");

    // 4. The token resolves to the agent's connection (the fix: there IS an agent row).
    const verified = await verifyBearer(mcpPost(callBody("get_context", {}), { bearer: accessToken }), {
      db,
      config,
      clock: fixedClock(NOW),
    });
    assert.ok(verified.ok, "the access token resolves to a live connection (not unauthenticated)");
    if (!verified.ok) throw new Error("unreachable: bearer not verified");

    // 5. POST /mcp tools/call get_context under that connection: EXECUTED, never the
    //    "This agent is not connected." refusal this task fixes.
    const dispatch = createMcpDispatch({ db, config });
    const res = await dispatch(verified.connectionId, mcpPost(callBody("get_context", {})));
    assert.equal(res.status, 200, "the tool call is served");
    const rpc = await readRpc(res);
    assert.ok(rpc.result, `get_context returns a tool result, got: ${JSON.stringify(rpc)}`);
    assert.notEqual(rpc.result!.isError, true, "the connected agent's read is executed, not an error");
    assert.ok(
      !/not connected/i.test(contentText(rpc.result)),
      `get_context must NOT be refused as 'not connected'; got: ${contentText(rpc.result)}`,
    );
    assert.ok(
      Array.isArray(rpc.result!.content) && rpc.result!.content.length > 0,
      "the allowed context is returned as tool-result content",
    );

    // 6. Warthog recorded the call itself — the person sees it on /activity.
    const agents = await listAgentsForUser(db, userId);
    const agentId = agents[0]!.id;
    const entries = await listActivity(db, userId, { agentId }, dek);
    const recorded = entries.find((entry) => entry.tool === "get_context");
    assert.ok(recorded, "an activity entry for get_context was recorded for this connection");
    assert.equal(recorded!.source, "warthog", "Warthog records it itself (source=warthog), not the agent");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — the approved agent appears on /agents with the chosen name and permissions.
// =====================================================================================

test("AC3: the approved agent appears on /agents with the chosen name and permissions", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
    const { userId } = await makePerson(db, config);
    const session = sessionFor(userId);

    const begun = await beginAuthorization({ params: authorizeParams(), session }, deps(db, config));
    assert.ok(begun.ok);
    if (!begun.ok) throw new Error("unreachable");

    const decided = await createAuthorizeActions(deps(db, config)).approve(
      session,
      begun.handle,
      approval({ name: "Research buddy", platform: "claude", template: "standard" }),
    );
    assert.ok(decided.ok);
    if (!decided.ok) throw new Error("unreachable");

    // The /agents read (the list-all primitive, member-scoped) shows the chosen name.
    const agents = await listAgentsForUser(db, userId);
    assert.equal(agents.length, 1, "exactly one agent appears on /agents");
    assert.equal(agents[0]!.displayName, "Research buddy", "the agent carries the chosen name");
    assert.equal(agents[0]!.status, "connected", "a freshly consented agent is connected");

    // Its connection's chosen permissions were written (one source of truth for the grants).
    const grants = await getConnectionPermissions(db, userId, agents[0]!.connectionId);
    assert.ok(grants != null, "the chosen permissions are stored for the connection");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — refusing redirects with error=access_denied and creates no agent / connection /
// code (nothing exchangeable at the token endpoint).
// =====================================================================================

test("AC2: refusing consent redirects with access_denied and creates nothing", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
    const { userId } = await makePerson(db, config);
    const session = sessionFor(userId);

    const begun = await beginAuthorization({ params: authorizeParams(), session }, deps(db, config));
    assert.ok(begun.ok);
    if (!begun.ok) throw new Error("unreachable");

    const decided = await createAuthorizeActions(deps(db, config)).refuse(session, begun.handle);
    assert.ok(decided.ok, "refusing is a handled outcome, not an error");
    if (!decided.ok) throw new Error("unreachable");

    const url = new URL(decided.redirectTo);
    assert.equal(`${url.origin}${url.pathname}`, REDIRECT_URI, "refusal redirects back to the client");
    assert.equal(url.searchParams.get("error"), "access_denied", "refusal carries error=access_denied");
    assert.equal(url.searchParams.get("state"), STATE, "refusal echoes the request state");
    assert.equal(codeIn(decided.redirectTo), null, "refusal issues no authorization code");

    // Nothing was created: no agent on /agents.
    assert.deepEqual(await listAgentsForUser(db, userId), [], "refusing creates no agent");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix A2 — what the consent screen shows is what the agent gets.
//
// Until this fix a Standard agent connected through the consent screen was refused
// list_tasks, create_task, list_records and save_record (those tools gated on the
// connector tool classes, which the decision set from ticked services only), and most
// of the screen's toggles were never submitted. Now tasks and records have their own
// grants, every visible toggle overrides the starting set, and a ticked service is kept
// only when the person has actually connected it.
// =====================================================================================

// Connect an agent end to end (authorize → consent approve → token) with the given
// approval, and return what an MCP call needs.
async function connectWith(
  overrides: Partial<ConsentApproval>,
): Promise<{ db: Db; config: Config; userId: string; connectionId: string }> {
  const db = await freshDb();
  const config = devConfig();
  await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
  const { userId } = await makePerson(db, config);
  const session = sessionFor(userId);
  const begun = await beginAuthorization({ params: authorizeParams(), session }, deps(db, config));
  if (!begun.ok) throw new Error(`begin failed: ${begun.error}`);
  const decided = await createAuthorizeActions(deps(db, config)).approve(session, begun.handle, approval(overrides));
  if (!decided.ok) throw new Error(`approve failed: ${decided.error}`);
  const exchanged = await exchangeToken({ params: tokenParams(codeIn(decided.redirectTo)!) }, deps(db, config));
  if (!exchanged.ok) throw new Error(`exchange failed: ${exchanged.error}`);
  const verified = await verifyBearer(mcpPost(callBody("list_tasks", {}), { bearer: exchanged.body.access_token }), {
    db,
    config,
    clock: fixedClock(NOW),
  });
  if (!verified.ok) throw new Error("bearer not verified");
  return { db, config, userId, connectionId: verified.connectionId };
}

async function callTool(
  ctx: { db: Db; config: Config; connectionId: string },
  name: string,
  args: unknown,
): Promise<string> {
  const res = await createMcpDispatch({ db: ctx.db, config: ctx.config })(ctx.connectionId, mcpPost(callBody(name, args)));
  return contentText((await readRpc(res)).result);
}

test("A2: a Standard agent with no services ticked can use tasks and life-admin records", async () => {
  const ctx = await connectWith({ template: "standard" });
  try {
    for (const [tool, args] of [
      ["list_tasks", {}],
      ["create_task", { title: "Book removalists" }],
      ["list_records", {}],
    ] as const) {
      const text = await callTool(ctx, tool, args);
      assert.ok(!/does not have permission/i.test(text), `${tool} is allowed for Standard, got: ${text}`);
    }
  } finally {
    await ctx.db.close();
  }
});

test("A2: a Minimal agent is refused tasks and records", async () => {
  const ctx = await connectWith({ template: "minimal" });
  try {
    for (const tool of ["list_tasks", "list_records"]) {
      const text = await callTool(ctx, tool, {});
      assert.match(text, /does not have permission/i, `${tool} is refused for Minimal`);
    }
  } finally {
    await ctx.db.close();
  }
});

test("A2: the person's toggles override the starting set, and the stored grants match them", async () => {
  const ctx = await connectWith({
    template: "standard",
    identity: false,
    memoryRead: false,
    tasks: false,
    records: true,
    highTier: true,
    card: true,
    cardBudget: { amount: 200, currency: "AUD", period: "month" },
    learningSharing: true,
  });
  try {
    const grants = await getConnectionPermissions(ctx.db, ctx.userId, ctx.connectionId);
    assert.ok(grants != null);
    assert.equal(grants!.identityAccess, false, "unticked basic profile is not granted");
    assert.equal(grants!.memoryRead, false, "unticked shared memory is not granted");
    assert.equal(grants!.tasksAccess, false, "unticked tasks is not granted");
    assert.equal(grants!.recordsAccess, true, "ticked records is granted");
    assert.equal(grants!.highTierAccess, true);
    assert.equal(grants!.cardAccess, true);
    assert.deepEqual(grants!.cardBudget, { amount: 200, currency: "AUD", period: "month" });
    assert.equal(grants!.sharing, true);

    assert.match(await callTool(ctx, "list_tasks", {}), /does not have permission/i, "tasks refused as chosen");
    assert.doesNotMatch(await callTool(ctx, "list_records", {}), /does not have permission/i, "records allowed");
  } finally {
    await ctx.db.close();
  }
});

test("A2: a ticked service is granted only when the person has connected it", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
    const { userId, dek } = await makePerson(db, config);
    await createConnection(
      db,
      { userId, connectorId: "gmail", accountLabel: "me@example.com", credentials: { token: "x" } },
      dek,
      fixedClock(NOW),
    );
    const session = sessionFor(userId);
    const begun = await beginAuthorization({ params: authorizeParams(), session }, deps(db, config));
    if (!begun.ok) throw new Error("unreachable");
    const decided = await createAuthorizeActions(deps(db, config)).approve(
      session,
      begun.handle,
      approval({ template: "standard", tickedServices: ["gmail", "not-connected-service"] }),
    );
    assert.ok(decided.ok);
    const agents = await listAgentsForUser(db, userId);
    const grants = await getConnectionPermissions(db, userId, agents[0]!.connectionId);
    assert.deepEqual(grants!.grantedConnectors, ["gmail"], "only the person's own connected service is granted");
    assert.equal(grants!.readTools, true, "its read tools are on");
    assert.equal(grants!.changeTools, "ask_first", "its changes ask first");
  } finally {
    await db.close();
  }
});
