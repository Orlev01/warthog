// E17-S11 — Dev agent console provisions a REAL agent for the signed-in person
// (`src/app/dev/agent-console/actions.ts`, design §12 dev tools; INV-102
// validate-and-parameterize-input, INV-103 secrets-from-env; constitution 16 per-agent
// access keys, constitution 21 public address from config).
//
// SUPERSESSION of E17-S10: the console used to mint a bare `wh_ak_` key for a RANDOM
// connection with NO agent behind it — so every `tools/call` was refused "This agent is
// not connected." It now PROVISIONS a real dev agent FOR THE SIGNED-IN PERSON through the
// already-built per-agent access-key mechanism (`createAccessKeyActions.create`, with
// sensible default permissions), once per person and then reused on reload. These tests
// are amended to that new contract: every unrelated pin (the key is a real `wh_ak_` bearer
// in `oauth_access_keys` that verifies; the `/mcp` endpoint; the key is runtime entropy,
// not a source literal; only a hashed form is stored) is kept intact, and the pins the
// behaviour change invalidates (a key that resolved to no agent) are replaced by the new
// ones (a key that resolves to a CONNECTED agent owned by the person, whose `tools/call`
// executes and is recorded in that person's activity, and whose `remember` stores a memory
// the person sees on /memory).
//
// WHY the sibling `actions.ts` (not `page.tsx`): a Next App-Router `page.tsx` entry may
// export ONLY its framework fields, so an injectable, unit-testable seam cannot live on the
// entry without breaking `next build` (OBS-025). The thin loader reads the process-wide
// database (`getServerDb()`), the signed-in session (from the `__Host-wh_session` cookie)
// and config at request time, then builds this `createAgentConsoleActions(deps)` factory
// (the convention's `createXActions(deps)` pattern) and renders the view.
//
//   createAgentConsoleActions({ db, clock, random, config }): {
//     load(session: Session | null): Promise<{ accessKey: string; endpoint: string }>
//   }
//
//     load(session) — "provision or reuse the signed-in person's dev agent":
//       1. For a SIGNED-IN person it provisions (creates ONCE, then reuses on reload) a
//          real dev agent OWNED by `session.userId` through `createAccessKeyActions.create`
//          with sensible default permissions, and hands back a working bearer for it. The
//          returned `accessKey` is a genuine `wh_ak_` key in the real `oauth_access_keys`
//          table that verifies through the already-built `verifyAccessKey` / `verifyBearer`
//          to the ONE connection of that agent — NOT a parallel credential path.
//       2. Driven through the REAL `/mcp` pipeline (`createMcpDispatch`), a `tools/call`
//          `get_context` EXECUTES (not refused "not connected") and Warthog records it in
//          the signed-in person's activity; `remember` stores a memory the person sees on
//          /memory. (The old bare-connection key could do neither.)
//       3. Reloading reuses the SAME dev agent rather than creating a new one each time.
//       4. With NO signed-in person (`session == null` — the state the guarded page renders
//          in when nobody is signed in) it still provisions a working key backed by a real
//          CONNECTED agent (the dev fallback), self-contained against a fresh database.
//       5. `endpoint` names the /mcp agent endpoint the console POSTs to.
//       6. The raw key is runtime entropy from the injected `random` seam, never a literal
//          baked into source (INV-103): two independent mints differ; only a hashed form is
//          stored.
//
// These tests pin BEHAVIOUR (what resolves, what executes, what the person's store holds
// afterwards), never the source text of any module — a later behaviour-preserving refactor
// must stay green. They drive the factory and the REAL MCP dispatch against an isolated
// in-memory PGlite with the REAL migrations (`src/test/db`), so nothing touches the network
// or Azure; every db handle is closed in a `finally`. The dev-tools guard ("404 when dev
// tools are off") lives in `page.tsx` and is pinned behaviourally by its sibling
// `page.test.tsx`; here we pin what the provisioning seam the loader composes actually does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createAgentConsoleActions } from "./actions";

import { loadConfig, type Config } from "../../../server/config";
import { verifyAccessKey } from "../../../server/oauth/access-key";
import { verifyBearer } from "../../../server/oauth/verify-bearer";
import { createMcpDispatch } from "../../../server/mcp/compose";
import { listActivity } from "../../../server/activity/list";
import { listMemoriesForUser } from "../../../server/db/memories";
import { createUser } from "../../../server/db/users";
import { getAgentByConnectionId, listAgentsForUser } from "../../../server/db/agents";
import { localAesKeyWrapper } from "../../../server/crypto/key-wrapper";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { fixedRandom, systemRandom, type Random } from "../../../server/seams/random";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";
import type { Session } from "../../../server/auth/session";

// A frozen instant the provisioning happens at (the dev agent's connected-at, if the
// factory records one). Deterministic, so nothing depends on the wall clock.
const T0 = new Date("2026-05-01T00:00:00.000Z");
const clock: Clock = fixedClock(T0);

// The access-key shape design §6.1 mandates: `wh_ak_` + 32 base62 characters. The
// provisioned dev key must look like a real per-agent access key.
const ACCESS_KEY_SHAPE = /^wh_ak_[0-9A-Za-z]{32}$/;

// The configured public base URL the endpoint is built from. A complete, valid
// DEVELOPMENT environment so `loadConfig` succeeds; the secret values are the repo's
// test-only base64 values (HMAC ≥ 32 bytes, dev KEK exactly 32).
const PUBLIC_BASE_URL = "https://warthog.example";

function devEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PUBLIC_BASE_URL,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
    WARTHOG_DEV_TOOLS: "1",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function devConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(devEnv(overrides));
}

// Build the provisioning seam under test with the pinned deps — a real db seam, a fixed
// clock + the given randomness source, and an explicit config.
function makeActions(db: Db, random: Random, config: Config = devConfig()) {
  return createAgentConsoleActions({ db, clock, random, config });
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the provisioning seam only needs its user id (it is the
// consent screen's twin, not a sensitive re-auth), so stepped-up state is left null.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(T0.getTime() - 60_000),
    lastSeenAt: new Date(T0.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// Create a REAL person with a KNOWN data key, wrapped under the SAME local KEK the MCP
// dispatch derives from `config.devKek`, so a test can decrypt that person's activity and
// memory afterwards. The agent/permission rows the console provisions hang off this id,
// which must exist in `users` for the foreign keys. Returns the id, the raw DEK and a
// plain signed-in session for them.
async function makePerson(
  db: Db,
  config: Config,
  who: string,
): Promise<{ userId: string; dek: Uint8Array; session: Session }> {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek, session: sessionFor(user.id) };
}

// How many access keys the REAL credential table holds — a probe that the provisioning
// wrote into `oauth_access_keys` (the real mechanism), not some parallel dev store.
async function accessKeyCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM oauth_access_keys");
  return Number(result.rows[0]?.n ?? -1);
}

// How many agent rows the whole database holds — the dev fallback is one dev person with
// one dev agent, so a reload that reuses rather than re-creates leaves this at 1.
async function agentRowCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM agents");
  return Number(result.rows[0]?.n ?? -1);
}

// A JSON POST to /mcp carrying the given raw bearer — so a provisioned key can be run
// through the REAL `verifyBearer`, exactly as the /mcp route does.
function mcpRequest(bearer: string): Request {
  return new Request(`${PUBLIC_BASE_URL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } }),
  });
}

// A Streamable-HTTP POST to /mcp the REAL MCP dispatch answers (Accept names BOTH
// application/json and text/event-stream, plus the protocol-version header) — the exact
// envelope `compose.test.ts` drives the production dispatch with.
function mcpPost(body: unknown): Request {
  return new Request(`${PUBLIC_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
}

// A JSON-RPC tools/call envelope.
function callBody(name: string, args: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

// The parsed JSON-RPC message a tool call yields — a CallToolResult (content + isError) or
// an error.
interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

// Read an MCP response body: the stateless transport answers over SSE
// (`event: message\ndata: {json}`) on success, plain JSON on a transport-level refusal.
// Return the parsed JSON-RPC message (the LAST data frame on SSE).
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

// Run one `tools/call` with the console's key through the REAL /mcp dispatch: resolve the
// key to its connection exactly as `/mcp` does, then dispatch the tool call under that
// verified connection. Returns the connection id and the parsed tool result.
async function callToolWithKey(
  db: Db,
  config: Config,
  accessKey: string,
  name: string,
  args: unknown,
): Promise<{ connectionId: string; rpc: JsonRpcResponse }> {
  const resolved = await verifyAccessKey(db, accessKey);
  assert.ok(resolved, "the console's key must verify to a connection before a tool call");
  const dispatch = createMcpDispatch({ db, config });
  const res = await dispatch(resolved!.connectionId, mcpPost(callBody(name, args)));
  return { connectionId: resolved!.connectionId, rpc: await readRpc(res) };
}

// =====================================================================================
// The provisioned key reuses the REAL per-agent access-key mechanism AND binds to a real
// agent OWNED BY THE SIGNED-IN PERSON: it is a genuine `wh_ak_` bearer in the real
// `oauth_access_keys` table that resolves through `verifyAccessKey` to that agent's one
// connection. (Superseded: the old console bound the key to a bare connection with no
// agent behind it.)
// =====================================================================================

test("load(session) provisions a real per-agent access key bound to a connected agent owned by the signed-in person", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, session } = await makePerson(db, config, "provision");
    assert.equal(await accessKeyCount(db), 0, "precondition: no access keys before provisioning");

    const { accessKey } = await makeActions(db, systemRandom, config).load(session);

    assert.match(
      accessKey,
      ACCESS_KEY_SHAPE,
      `the provisioned dev key must be a real wh_ak_ access key, got: ${JSON.stringify(accessKey)}`,
    );

    // The REAL verification seam resolves it to a connection — proving it lives in the
    // real store under the same hash contract, not a parallel credential path.
    const resolved = await verifyAccessKey(db, accessKey);
    assert.ok(resolved, "the provisioned key must verify through the real verifyAccessKey");
    assert.ok(
      typeof resolved!.connectionId === "string" && resolved!.connectionId.length > 0,
      "the provisioned key must bind to a connection id",
    );

    // It was written into the REAL per-agent access-key table (not a dev-only table).
    assert.ok(await accessKeyCount(db) >= 1, "provisioning must store the key in oauth_access_keys");

    // NEW: a real agent sits behind that connection, OWNED BY the signed-in person and
    // CONNECTED — so a tool call can actually execute (the old bare-connection key had no
    // agent, so every call was refused "This agent is not connected").
    const agent = await getAgentByConnectionId(db, resolved!.connectionId);
    assert.ok(agent, "the console's key must resolve to a real agent, not a bare connection");
    assert.equal(agent!.userId, userId, "the dev agent belongs to the signed-in person");
    assert.equal(agent!.status, "connected", "the dev agent is connected, so its tool calls can execute");

    // The agent was created for the SESSION person (exactly one so far).
    assert.equal(
      (await listAgentsForUser(db, userId)).length,
      1,
      "the console provisions one dev agent for the signed-in person",
    );
  } finally {
    await db.close();
  }
});

test("the provisioned key is accepted by the real /mcp bearer verification (end-to-end credential reuse)", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { session } = await makePerson(db, config, "bearer");
    const { accessKey } = await makeActions(db, systemRandom, config).load(session);

    // Drive the SAME verifyBearer the /mcp route uses: the dev key must authenticate as
    // an agent, so the console genuinely "calls /mcp with a dev access key".
    const verification = await verifyBearer(mcpRequest(accessKey), { db, config, clock });
    assert.equal(verification.ok, true, "the dev access key must verify as a bearer at /mcp");
    if (verification.ok) {
      assert.ok(verification.connectionId.length > 0, "verification resolves the console's connection");
    }

    // A bearer the console never minted must NOT verify — the key above passes on its own
    // merits, not because verification admits everything.
    const bogus = await verifyBearer(mcpRequest("wh_ak_not-a-real-key"), { db, config, clock });
    assert.equal(bogus.ok, false, "an unrelated bearer is still rejected");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — the console's key makes `tools/call get_context` EXECUTE and Warthog records it in
// the SIGNED-IN PERSON's activity. (The old bare-connection key was refused "This agent is
// not connected" and recorded nothing.)
// =====================================================================================

test("the console's key makes tools/call get_context execute and records it in the signed-in person's activity", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, dek, session } = await makePerson(db, config, "get-context");
    const { accessKey } = await makeActions(db, systemRandom, config).load(session);

    const { connectionId, rpc } = await callToolWithKey(db, config, accessKey, "get_context", {});

    // get_context executes — a normal tool result, never an MCP error (the old "not
    // connected" refusal would surface as isError).
    assert.ok(rpc.result, `get_context must return a tool result, got: ${JSON.stringify(rpc)}`);
    assert.notEqual(rpc.result!.isError, true, "an allowed get_context returns a result, never isError");

    // Warthog wrote the record itself (principle 14): the signed-in person sees it on their
    // /activity list (the same member-scoped read), for this console agent, as EXECUTED.
    const agent = await getAgentByConnectionId(db, connectionId);
    assert.ok(agent, "the console's key resolves to the person's agent");
    const entries = await listActivity(db, userId, { agentId: agent!.id }, dek);
    const recorded = entries.find((entry) => entry.tool === "get_context");
    assert.ok(recorded, "a get_context activity entry was recorded in the signed-in person's /activity");
    assert.equal(recorded!.source, "warthog", "Warthog records it itself (source=warthog), not the agent");
    assert.equal(recorded!.outcome, "executed", "the call EXECUTED — not refused 'This agent is not connected'");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — the console's key makes `tools/call remember` store a memory the signed-in person
// then sees on /memory. This forces the "sensible default permissions" to grant memory.
// =====================================================================================

test("the console's key makes tools/call remember store a memory the signed-in person sees on /memory", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, dek, session } = await makePerson(db, config, "remember");
    const { accessKey } = await makeActions(db, systemRandom, config).load(session);

    const marker = `console-remember-${randomUUID()}`;
    const { rpc } = await callToolWithKey(db, config, accessKey, "remember", { content: marker });
    assert.notEqual(
      rpc.result?.isError,
      true,
      `an allowed remember is not an MCP error, got: ${JSON.stringify(rpc)}`,
    );

    // The /memory page reads the person's memories through listMemoriesForUser; the just
    // remembered note is there (so the console's default permissions grant memory saving).
    const memories = await listMemoriesForUser(db, userId, dek);
    assert.ok(
      memories.some((memory) => memory.content === marker),
      "the remembered note is visible to the signed-in person on /memory",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — reloading the console REUSES the same dev agent rather than creating a new one each
// time: a second load for the same person provisions no new agent, and its key resolves to
// the SAME connection.
// =====================================================================================

test("reloading the console reuses the same dev agent rather than creating a new one each time", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, session } = await makePerson(db, config, "reuse");
    const actions = makeActions(db, systemRandom, config);

    const first = await actions.load(session);
    const firstConn = (await verifyAccessKey(db, first.accessKey))?.connectionId;
    assert.ok(firstConn, "the first load yields a working key");
    assert.equal(
      (await listAgentsForUser(db, userId)).length,
      1,
      "the first load provisions exactly one dev agent",
    );

    // Reload: the console must find and reuse the SAME dev agent, not mint another.
    const second = await actions.load(session);
    const secondConn = (await verifyAccessKey(db, second.accessKey))?.connectionId;
    assert.ok(secondConn, "a reload still yields a working key");

    assert.equal(
      (await listAgentsForUser(db, userId)).length,
      1,
      "reloading provisions NO new agent — the same dev agent is reused",
    );
    assert.equal(
      secondConn,
      firstConn,
      "the reload's key binds to the SAME connection (the reused dev agent)",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// With NO signed-in person (session == null — how the guarded page renders when nobody is
// signed in) load is self-contained: it still provisions a working key backed by a real
// CONNECTED agent (the dev fallback), and reloading it is idempotent (no duplicate-person
// crash). (Superseded: the old self-contained load bound the key to a bare connection with
// no agent.)
// =====================================================================================

test("load(null) is self-contained: with no signed-in person it provisions a working key backed by a real connected agent", async () => {
  const db = await freshDb(); // nothing seeded
  try {
    const config = devConfig();
    const first = await makeActions(db, systemRandom, config).load(null);

    const resolved = await verifyAccessKey(db, first.accessKey);
    assert.ok(resolved, "load(null) provisions a working key from nothing");

    // A real CONNECTED agent sits behind the fallback key too — so even with nobody signed
    // in, a tool call would execute rather than be refused "This agent is not connected".
    const agent = await getAgentByConnectionId(db, resolved!.connectionId);
    assert.ok(agent, "the fallback key resolves to a real agent, not a bare connection");
    assert.equal(agent!.status, "connected", "the fallback dev agent is connected");

    // Reloading with no session is idempotent — a second load still yields a working key
    // (the page re-renders the dev console repeatedly, so this must not crash on a duplicate
    // dev person), and reuses the one dev agent rather than piling up new ones.
    const second = await makeActions(db, systemRandom, config).load(null);
    assert.ok(await verifyAccessKey(db, second.accessKey), "a second load(null) still yields a working key");
    assert.equal(await agentRowCount(db), 1, "the dev fallback reuses its one agent across reloads");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — the console calls /mcp: load names the /mcp agent endpoint the view POSTs to.
// =====================================================================================

test("load(session) returns the /mcp endpoint the console posts tool calls to", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { session } = await makePerson(db, config, "endpoint");
    const { endpoint } = await makeActions(db, systemRandom, config).load(session);
    assert.equal(typeof endpoint, "string", "the console must be told where to post tool calls");
    assert.ok(
      endpoint.length > 0 && /\/mcp\/?$/.test(endpoint),
      `the endpoint must address the /mcp agent endpoint, got: ${JSON.stringify(endpoint)}`,
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [secrets-from-env] — the key is a runtime-minted secret from the injected random seam,
// never a literal baked into source: two independent mints produce different keys, and
// each verifies in its own store. A hard-coded key would make both identical.
// =====================================================================================

test("the access key is minted at runtime from the random seam, not a source literal [secrets-from-env]", async () => {
  const dbA = await freshDb();
  const dbB = await freshDb();
  try {
    const configA = devConfig();
    const configB = devConfig();
    const personA = await makePerson(dbA, configA, "fresh-a");
    const personB = await makePerson(dbB, configB, "fresh-b");

    // Two independent randomness sources → two distinct keys (a baked constant could not
    // differ). Each must still verify in ITS OWN store.
    const a = await makeActions(dbA, fixedRandom(0x11), configA).load(personA.session);
    const b = await makeActions(dbB, fixedRandom(0x22), configB).load(personB.session);

    assert.notEqual(
      a.accessKey,
      b.accessKey,
      "two independent mints must differ — the key is runtime entropy, not a hard-coded secret",
    );
    assert.ok(await verifyAccessKey(dbA, a.accessKey), "mint A verifies in store A");
    assert.ok(await verifyAccessKey(dbB, b.accessKey), "mint B verifies in store B");

    // And a key minted into store A does not verify in the unrelated store B (each key is
    // bound to the store it was issued in, not a shared literal).
    assert.equal(await verifyAccessKey(dbB, a.accessKey), null, "A's key is not valid in B's store");
  } finally {
    await dbA.close();
    await dbB.close();
  }
});
