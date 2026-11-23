// One agent, several accounts of a service, end to end through the real MCP dispatch
// (docs/adr/several-accounts-per-agent.md):
//   - the agent still sees ONE set of Gmail tools, each taking an optional `account`;
//   - get_context lists every account it may use, with its own settings and no internal ids;
//   - a call names its account (in `account`, or in `query` for a client with the older tool
//     list), or uses the only one that fits; otherwise it is refused with the choices;
//   - an account the agent wasn't given is refused the same way whether or not it exists;
//   - each account's own settings are the ones checked, held and executed;
//   - an approved request never runs on an account the agent no longer has.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createMcpDispatch } from "./compose";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { getConnectionPermissions, upsertPermissions, type AccountGrantInput } from "../db/agent-permissions";
import { createConnection } from "../db/connections";
import { decide, getApproval } from "../db/approvals";
import { accountHandle } from "../../domain/permissions/account-access";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

const NOW = new Date("2026-11-24T00:00:00.000Z");

function devConfig(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: Buffer.alloc(48, 0x2a).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 0x5c).toString("base64"),
  } as NodeJS.ProcessEnv);
}

function mcpPost(body: unknown): Request {
  return new Request("https://warthog.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify(body),
  });
}

type Rpc = { result?: { content?: { text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown>; tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] } };

async function readRpc(res: Response): Promise<Rpc> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    return JSON.parse(frames.at(-1)!);
  }
  return JSON.parse(text);
}

const call = (name: string, args: unknown) => mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const LIST = mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
// A refusal comes back as an error result carrying the plain reason.
const status = (rpc: Rpc) => (rpc.result?.isError ? "refused" : rpc.result?.structuredContent?.status);
const reason = (rpc: Rpc) => String(rpc.result?.structuredContent?.reason ?? rpc.result?.content?.[0]?.text ?? "");

interface Seen { url: URL; method: string; token: string | null }

function upstream() {
  const sent: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: new URL(String(input)), method: String(init?.method ?? "GET"), token: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ messages: [], resultSizeEstimate: 0 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const BASE = {
  readTools: true, changeTools: "ask_first" as const, identityAccess: true, highTierAccess: false, cardAccess: false,
  cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120,
};

// A person with three Gmail accounts; the agent is given two of them, the second with changes off.
async function seed(db: Db, config: Config) {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `person-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, fixedClock(NOW));
  const connect = async (label: string) =>
    (await createConnection(db, { userId: user.id, connectorId: "google-gmail", accountLabel: label, credentials: { access_token: `tok-${label.split("@")[0]}` } }, dek, fixedClock(NOW))).id;
  const home = await connect("home@example.com");
  const work = await connect("Work@Example.com");
  const spare = await connect("spare@example.com");
  const grant = (accounts: AccountGrantInput[]) => upsertPermissions(db, { userId: user.id, connectionId, ...BASE, accounts });
  await grant([{ accountId: home }, { accountId: work, changeTools: "off" }]);
  return { userId: user.id, connectionId, dek, home, work, spare, grant };
}

test("the agent sees one set of Gmail tools taking an account, and get_context lists each account it may use", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId, home, work, spare } = await seed(db, config);
    const dispatch = createMcpDispatch({ db, config, fetch: upstream().fetch });
    const tools = (await readRpc(await dispatch(connectionId, LIST))).result?.tools ?? [];
    assert.equal(tools.filter((t) => t.name === "google-gmail__search").length, 1);
    assert.ok(tools.find((t) => t.name === "google-gmail__search")?.inputSchema?.properties?.account, "search takes an account");
    assert.ok(tools.find((t) => t.name === "google-gmail__send")?.inputSchema?.properties?.account, "send takes an account");

    const context = await readRpc(await dispatch(connectionId, call("get_context", {})));
    const text = JSON.stringify(context);
    const accounts = (context.result?.structuredContent?.serviceAccounts ?? JSON.parse(context.result?.content?.[0]?.text ?? "{}").serviceAccounts) as Record<string, unknown>[];
    assert.deepEqual(accounts, [
      { service: "google-gmail", account: "home@example.com", handle: accountHandle(home), status: "connected", reads: true, changes: "ask_first", tools: "all" },
      { service: "google-gmail", account: "Work@Example.com", handle: accountHandle(work), status: "connected", reads: true, changes: "off", tools: "all" },
    ]);
    for (const id of [home, work, spare]) assert.ok(!text.includes(id), "no internal account id reaches the agent");
    assert.ok(!text.includes("spare@example.com"), "an account the agent wasn't given isn't named");
  } finally { await db.close(); }
});

test("a call names its account, by address in any case, by handle, or inside query for an older client", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId, work } = await seed(db, config);
    const net = upstream();
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });

    await readRpc(await dispatch(connectionId, call("google-gmail__search", { account: "work@example.com", query: { q: "from:hostplus" } })));
    assert.equal(net.sent[0]?.token, "Bearer tok-Work");
    net.sent.length = 0;
    await readRpc(await dispatch(connectionId, call("google-gmail__search", { account: accountHandle(work), query: { q: "x" } })));
    assert.equal(net.sent[0]?.token, "Bearer tok-Work");
    net.sent.length = 0;
    // A client with the older tool list has no account field, but query takes any key.
    await readRpc(await dispatch(connectionId, call("google-gmail__search", { query: { q: "x", account: "HOME@example.com" } })));
    assert.equal(net.sent[0]?.token, "Bearer tok-home");
    assert.ok(!net.sent[0]?.url.searchParams.has("account"), "the account never reaches Gmail");
  } finally { await db.close(); }
});

test("with two accounts and none named, a read is refused with the choices and nothing is fetched", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config);
    const net = upstream();
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const rpc = await readRpc(await dispatch(connectionId, call("google-gmail__search", { query: { q: "x" } })));
    assert.equal(status(rpc), "refused");
    assert.match(reason(rpc), /This agent can use 2 Gmail accounts for this: home@example\.com, Work@Example\.com\. Say which one in account\./);
    assert.equal(net.sent.length, 0);
  } finally { await db.close(); }
});

test("an account the agent wasn't given is refused the same way whether or not it exists", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config);
    const net = upstream();
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const ungranted = await readRpc(await dispatch(connectionId, call("google-gmail__search", { account: "spare@example.com", query: { q: "x" } })));
    const unknown = await readRpc(await dispatch(connectionId, call("google-gmail__search", { account: "nobody@example.com", query: { q: "x" } })));
    assert.equal(status(ungranted), "refused");
    assert.equal(reason(ungranted), reason(unknown));
    assert.match(reason(ungranted), /can't use that Gmail account\. Accounts it can use: home@example\.com, Work@Example\.com\./);
    assert.equal(net.sent.length, 0);
  } finally { await db.close(); }
});

test("each account's own settings decide: a send goes from the only account allowed to send, and never from one that isn't", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config);
    const net = upstream();
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const send = { to: ["ann@example.org"], subject: "Hi", text: "Hello" };

    // Work has changes off, so with no account named the send uses home, the only one allowed.
    const held = await readRpc(await dispatch(connectionId, call("google-gmail__send", send)));
    assert.equal(status(held), "pending_approval");
    const approval = await getApproval(db, userId, String(held.result?.structuredContent?.approval_id), dek);
    assert.equal((approval!.detail as Record<string, unknown>).account, "home@example.com");

    const fromWork = await readRpc(await dispatch(connectionId, call("google-gmail__send", { ...send, account: "work@example.com" })));
    assert.equal(status(fromWork), "refused", "work's own setting turns its changes off");
    assert.equal(net.sent.filter((s) => s.url.pathname.endsWith("/messages/send")).length, 0);
  } finally { await db.close(); }
});

test("an approved request never runs on an account the agent no longer has", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek, work, grant } = await seed(db, config);
    const net = upstream();
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const held = await readRpc(await dispatch(connectionId, call("google-gmail__send", { to: ["ann@example.org"], subject: "Hi", text: "Hello", account: "home@example.com" })));
    assert.equal(status(held), "pending_approval");

    // The person takes home away and leaves the agent only work (now allowed to send).
    await grant([{ accountId: work }]);
    assert.deepEqual((await getConnectionPermissions(db, userId, connectionId))?.accounts.map((a) => a.accountId), [work]);
    await decide(db, { userId, id: String(held.result!.structuredContent!.approval_id), decision: { status: "approved" } }, dek, fixedClock(new Date()));
    const ran = await readRpc(await dispatch(connectionId, call("check_approval", { approval_id: held.result!.structuredContent!.approval_id, wait_seconds: 0 })));
    assert.doesNotMatch(JSON.stringify(ran), /"status":"executed"/);
    assert.equal(net.sent.filter((s) => s.url.pathname.endsWith("/messages/send")).length, 0, "nothing was sent from either account");
  } finally { await db.close(); }
});
