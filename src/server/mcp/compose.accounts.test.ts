// One agent, several accounts of a service, end to end through the real MCP dispatch
// (docs/adr/several-accounts-per-agent.md):
//   - the agent still sees ONE set of Gmail tools, each taking an optional `account`;
//   - get_context lists every account it may use, with its own settings and no internal ids;
//   - a call names its account (in `account`, or in `query` for a client with the older tool
//     list), or uses the only one that fits; otherwise it is refused with the choices;
//   - an account the agent wasn't given is refused the same way whether or not it exists;
//   - each account's own settings are the ones checked, held and executed;
//   - an approved request never runs on an account the agent no longer has;
//   - a mail search with no account named covers every inbox the agent may read, and message
//     ids carry their inbox, so reads and replies go to the inbox that holds the email.

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
import { createConnection, updateConnectionStatus } from "../db/connections";
import { toEntry } from "../activity/writer";
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

test("with two accounts and none named, a read by a bare id is refused with the choices and nothing is fetched", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config);
    const net = upstream();
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const rpc = await readRpc(await dispatch(connectionId, call("google-gmail__read", { query: { id: "h1" } })));
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

// --- mail across inboxes (decision 5) -------------------------------------------------------

interface Inbox { list?: (url: URL) => Response; messages?: Record<string, unknown>[] }

// One fake Gmail for every account, told apart by the token each request carries. An account's
// search lists its messages and each message's headers come back by id; anything else is a 404.
function gmail(inboxes: Record<string, Inbox>) {
  const sent: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization");
    sent.push({ url, method: String(init?.method ?? "GET"), token });
    const inbox = inboxes[String(token).replace(/^Bearer tok-/, "")];
    if (!inbox) return Response.json({ error: "no such inbox" }, { status: 401 });
    if (url.pathname.endsWith("/messages") && init?.method !== "POST") {
      if (inbox.list) return inbox.list(url);
      return Response.json({ messages: (inbox.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: inbox.messages?.length ?? 0 });
    }
    const id = /\/messages\/([^/]+)$/.exec(url.pathname)?.[1];
    const found = inbox.messages?.find((m) => m.id === id);
    if (found) return Response.json(found);
    if (url.pathname.endsWith("/messages/send")) return Response.json({ id: "sent-1", threadId: "t-sent" });
    return Response.json({ error: { code: 404 } }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, sent, tokens: () => [...new Set(sent.map((s) => s.token))].sort() };
}

const mail = (id: string, from: string, subject: string, day: number) => ({
  id, threadId: `t-${id}`, labelIds: ["INBOX"], snippet: `About ${subject}`, internalDate: String(Date.UTC(2026, 10, day)),
  payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, { name: "Message-ID", value: `<${id}@mail.example>` }] },
});

type View = { messages: { id: string; threadId?: string; account: string; subject?: string }[]; accounts: { account: string; status: string; count: number }[]; coverage: string };
const viewOf = (rpc: Rpc) => rpc.result?.structuredContent as unknown as View;
const text = (rpc: Rpc) => String(rpc.result?.content?.[0]?.text ?? "");

test("one search covers every inbox the agent may read: merged newest first, each email naming its inbox, ids carrying it", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId, home, work, spare } = await seed(db, config);
    const net = gmail({
      home: { messages: [mail("h1", "Hostplus <hi@hostplus.com.au>", "Statement", 20), mail("h2", "AGL <hi@agl.com.au>", "Bill", 22)] },
      Work: { messages: [mail("w1", "Medibank <hi@medibank.com.au>", "Renewal", 21)] },
      spare: { messages: [mail("s1", "Someone <x@example.org>", "Not for this agent", 23)] },
    });
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const rpc = await readRpc(await dispatch(connectionId, call("google-gmail__search", { query: { q: "newer_than:30d" } })));
    assert.notEqual(status(rpc), "refused", reason(rpc));
    const view = viewOf(rpc);
    const [h, w] = [accountHandle(home), accountHandle(work)];
    assert.deepEqual(view.messages.map((m) => [m.id, m.threadId, m.account]), [
      [`${h}.h2`, `${h}.t-h2`, "home@example.com"],
      [`${w}.w1`, `${w}.t-w1`, "Work@Example.com"],
      [`${h}.h1`, `${h}.t-h1`, "home@example.com"],
    ]);
    assert.deepEqual(net.tokens(), ["Bearer tok-Work", "Bearer tok-home"], "the inbox the agent wasn't given is never contacted");
    assert.ok(!JSON.stringify(rpc).includes(spare) && !JSON.stringify(rpc).includes("spare@"), "nor named");
    // One page in all: the default 10 is shared between the two inboxes.
    assert.deepEqual(net.sent.filter((s) => s.url.pathname.endsWith("/messages")).map((s) => s.url.searchParams.get("maxResults")), ["5", "5"]);
    assert.equal(view.coverage, "Searched 2 inboxes: home@example.com (2), Work@Example.com (1).");
    assert.match(text(rpc), /\n1\. In home@example\.com · 2026-11-22T00:00:00\.000Z · AGL <hi@agl\.com\.au> · “Bill”/);
    assert.match(text(rpc), /Searched 2 inboxes: home@example\.com \(2\), Work@Example\.com \(1\)\./);
    // The "open in Gmail" link opens each email's own inbox.
    assert.match(JSON.stringify(view.messages[1]), /authuser=Work%40Example\.com/);

    const again = await readRpc(await dispatch(connectionId, call("google-gmail__search", { query: { q: "newer_than:30d" } })));
    assert.equal(text(again), text(rpc), "the same search reads the same way every time");
  } finally { await db.close(); }
});

test("an inbox that needs reconnecting is named and skipped; the rest are still searched; if every inbox fails, the search fails", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, work } = await seed(db, config);
    await updateConnectionStatus(db, { userId, id: work, status: "needs_reconnect" });
    const net = gmail({ home: { messages: [mail("h1", "Hostplus <hi@hostplus.com.au>", "Statement", 20)] }, Work: { messages: [mail("w1", "x <x@x.org>", "y", 21)] } });
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const rpc = await readRpc(await dispatch(connectionId, call("google-gmail__search", { query: { q: "x" } })));
    assert.deepEqual(viewOf(rpc).messages.map((m) => m.account), ["home@example.com"]);
    assert.equal(viewOf(rpc).coverage, "Searched 1 inbox: home@example.com (1). Not searched: Work@Example.com needs reconnecting in Warthog → Connectors.");
    assert.deepEqual(net.tokens(), ["Bearer tok-home"]);
    // A one-inbox search asks that inbox for the whole page.
    assert.equal(net.sent[0]?.url.searchParams.get("maxResults"), "10");

    const down = gmail({ home: { list: () => new Response("{}", { status: 500 }) } });
    const failing = await readRpc(await createMcpDispatch({ db, config, fetch: down.fetch })(connectionId, call("google-gmail__search", { query: { q: "x" } })));
    assert.equal(status(failing), "refused");
    assert.match(reason(failing), /No inbox could be searched\. Not searched: home@example\.com couldn't be searched just now; Work@Example\.com needs reconnecting in Warthog → Connectors\./);
    const entries = await db.query("SELECT outcome FROM activity_entries WHERE user_id = $1 AND tool = $2 ORDER BY seq", [userId, "google-gmail__search"]);
    assert.deepEqual(entries.rows.map((r) => r.outcome), ["executed", "failed"]);
  } finally { await db.close(); }
});

test("an inbox the agent may not read is skipped and named, and never contacted", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId, home, work, spare, grant } = await seed(db, config);
    await grant([{ accountId: home }, { accountId: work }, { accountId: spare, readTools: false }]);
    const net = gmail({ home: { messages: [mail("h1", "a <a@a.org>", "b", 20)] }, Work: { messages: [] }, spare: { messages: [mail("s1", "a <a@a.org>", "b", 20)] } });
    const rpc = await readRpc(await createMcpDispatch({ db, config, fetch: net.fetch })(connectionId, call("google-gmail__search", { query: { q: "x" } })));
    assert.equal(viewOf(rpc).coverage, "Searched 2 inboxes: home@example.com (1), Work@Example.com (0). Not searched: spare@example.com isn't allowed for this agent.");
    assert.ok(!net.tokens().includes("Bearer tok-spare"));
  } finally { await db.close(); }
});

test("a read by an id from search goes to the inbox the id names, and only there", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId, home, work, spare } = await seed(db, config);
    const net = gmail({ home: { messages: [mail("h1", "a <a@a.org>", "b", 20)] }, Work: { messages: [mail("w1", "Medibank <hi@medibank.com.au>", "Renewal", 21)] } });
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const read = await readRpc(await dispatch(connectionId, call("google-gmail__read", { query: { id: `${accountHandle(work)}.w1` } })));
    assert.equal((read.result?.structuredContent?.message as { id?: string }).id, `${accountHandle(work)}.w1`);
    assert.deepEqual(net.tokens(), ["Bearer tok-Work"]);
    assert.ok(net.sent.every((s) => s.url.pathname.endsWith("/messages/w1")), "only the native id reaches Gmail");

    // An id from an inbox the agent wasn't given reads like an account it doesn't have, and
    // nothing is fetched.
    net.sent.length = 0;
    const foreign = await readRpc(await dispatch(connectionId, call("google-gmail__read", { query: { id: `${accountHandle(spare)}.s1` } })));
    const unknown = await readRpc(await dispatch(connectionId, call("google-gmail__read", { query: { id: "x" }, account: "nobody@example.com" })));
    assert.equal(status(foreign), "refused");
    assert.equal(reason(foreign), reason(unknown));
    assert.equal(net.sent.length, 0);

    // An id tagged with one inbox is only ever sent with that inbox's token, whatever it is.
    const crossed = await readRpc(await dispatch(connectionId, call("google-gmail__read", { query: { id: `${accountHandle(home)}.w1` } })));
    assert.notEqual(crossed.result?.structuredContent?.status, "executed");
    assert.deepEqual(net.tokens(), ["Bearer tok-home"]);
  } finally { await db.close(); }
});

test("a reply goes from the inbox that holds the email: its Sent check and the send use that inbox; a different account is refused", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek, home, work, grant } = await seed(db, config);
    await grant([{ accountId: home }, { accountId: work }]);
    const net = gmail({ home: { messages: [] }, Work: { messages: [mail("w1", "Medibank <hi@medibank.com.au>", "Renewal", 21)] } });
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const reply = { to: ["hi@medibank.com.au"], text: "Thanks", reply: { id: `${accountHandle(work)}.w1` } };

    const wrong = await readRpc(await dispatch(connectionId, call("google-gmail__send", { ...reply, account: "home@example.com" })));
    assert.equal(status(wrong), "refused");
    assert.equal(reason(wrong), "That email is in Work@Example.com, not home@example.com. Leave out account, or name Work@Example.com.");
    assert.equal(net.sent.length, 0);

    const held = await readRpc(await dispatch(connectionId, call("google-gmail__send", reply)));
    assert.equal(status(held), "pending_approval");
    const approvalId = String(held.result?.structuredContent?.approval_id);
    const approval = await getApproval(db, userId, approvalId, dek);
    assert.equal((approval!.detail as Record<string, unknown>).account, "Work@Example.com");
    assert.ok(net.sent.some((s) => s.url.searchParams.get("q")?.startsWith("in:sent")), "the Sent check ran");
    assert.deepEqual(net.tokens(), ["Bearer tok-Work"], "in the inbox the reply goes from");

    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(new Date()));
    net.sent.length = 0;
    const ran = await readRpc(await dispatch(connectionId, call("check_approval", { approval_id: approvalId, wait_seconds: 0 })));
    assert.equal(JSON.parse(text(ran)).status, "executed");
    assert.ok(net.sent.some((s) => s.url.pathname.endsWith("/messages/w1")), "the email being answered is read in its own inbox");
    assert.ok(net.sent.some((s) => s.url.pathname.endsWith("/messages/send")));
    assert.deepEqual(net.tokens(), ["Bearer tok-Work"]);
  } finally { await db.close(); }
});

test("a new email with more than one inbox that may send is refused, listing only those inboxes", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId, home, work, spare, grant } = await seed(db, config);
    await grant([{ accountId: home }, { accountId: work }, { accountId: spare, changeTools: "off" }]);
    const net = gmail({});
    const rpc = await readRpc(await createMcpDispatch({ db, config, fetch: net.fetch })(connectionId, call("google-gmail__send", { to: ["ann@example.org"], subject: "Hi", text: "Hello" })));
    assert.equal(status(rpc), "refused");
    assert.equal(reason(rpc), "This agent can use 2 Gmail accounts for this: home@example.com, Work@Example.com. Say which one in account. If your tool has no account field, ask the person to refresh Warthog in your app's connector settings.");
    assert.equal(net.sent.length, 0);
  } finally { await db.close(); }
});

test("a further page of results belongs to one inbox, so it needs account", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config);
    const net = gmail({ home: { messages: [] }, Work: { messages: [] } });
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const rpc = await readRpc(await dispatch(connectionId, call("google-gmail__search", { query: { q: "x", pageToken: "p2" } })));
    assert.equal(status(rpc), "refused");
    assert.equal(reason(rpc), "A page of results belongs to one inbox: pass account with pageToken.");
    assert.equal(net.sent.length, 0);
    const paged = await readRpc(await dispatch(connectionId, call("google-gmail__search", { query: { q: "x", pageToken: "p2" }, account: "home@example.com" })));
    assert.notEqual(status(paged), "refused");
    assert.equal(net.sent[0]?.url.searchParams.get("pageToken"), "p2");
  } finally { await db.close(); }
});

test("an agent with one inbox gets ids that carry it, and a bare id still works", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId, home, grant } = await seed(db, config);
    await grant([{ accountId: home }]);
    const net = gmail({ home: { messages: [mail("h1", "Hostplus <hi@hostplus.com.au>", "Statement", 20)] } });
    const dispatch = createMcpDispatch({ db, config, fetch: net.fetch });
    const search = await readRpc(await dispatch(connectionId, call("google-gmail__search", { query: { q: "x" } })));
    const found = search.result?.structuredContent?.messages as { id: string }[];
    assert.deepEqual(found.map((m) => m.id), [`${accountHandle(home)}.h1`]);
    assert.match(text(search), new RegExp(`\\(id ${accountHandle(home)}\\.h1 · thread ${accountHandle(home)}\\.t-h1\\)`));
    assert.match(text(search), /More results|Previews only/);

    for (const id of ["h1", `${accountHandle(home)}.h1`]) {
      const read = await readRpc(await dispatch(connectionId, call("google-gmail__read", { query: { id } })));
      assert.equal((read.result?.structuredContent?.message as { id?: string })?.id, `${accountHandle(home)}.h1`, id);
    }
  } finally { await db.close(); }
});

test("an Outlook search covers both mailboxes and tags their ids", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const keyWrapper = localAesKeyWrapper(config.devKek!);
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `person-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
    const connectionId = randomUUID();
    await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, fixedClock(NOW));
    const connect = async (label: string) =>
      (await createConnection(db, { userId: user.id, connectorId: "microsoft-outlook-mail", accountLabel: label, credentials: { access_token: `tok-${label.split("@")[0]}` } }, dek, fixedClock(NOW))).id;
    const a = await connect("a@outlook.com");
    const b = await connect("b@outlook.com");
    await upsertPermissions(db, { userId: user.id, connectionId, ...BASE, accounts: [{ accountId: a }, { accountId: b }] });
    const sent: Seen[] = [];
    const message = (id: string, from: string, at: string) => ({ id, conversationId: `c-${id}`, receivedDateTime: at, subject: `About ${id}`, from: { emailAddress: { address: from } }, bodyPreview: "Hello", isRead: false });
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const token = new Headers(init?.headers).get("authorization");
      sent.push({ url, method: String(init?.method ?? "GET"), token });
      const value = token === "Bearer tok-a" ? [message("AAMk1=", "x@agl.com.au", "2026-11-20T00:00:00Z")] : [message("AAMk2=", "y@hostplus.com.au", "2026-11-21T00:00:00Z")];
      return Response.json({ value, "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/messages?$top=5&$skip=5` });
    }) as typeof globalThis.fetch;
    const rpc = await readRpc(await createMcpDispatch({ db, config, fetch })(connectionId, call("microsoft-outlook-mail__search", { query: { $search: "\"bill\"" } })));
    const view = viewOf(rpc);
    assert.deepEqual(view.messages.map((m) => [m.id, m.account]), [[`${accountHandle(b)}.AAMk2=`, "b@outlook.com"], [`${accountHandle(a)}.AAMk1=`, "a@outlook.com"]]);
    assert.deepEqual(sent.map((s) => s.url.searchParams.get("$top")), ["5", "5"]);
    assert.deepEqual(view.accounts.map((x) => (x as { nextSkip?: string }).nextSkip), ["5", "5"]);
    assert.match(text(rpc), /More from a@outlook\.com: search again with account a@outlook\.com, the same query and query\.\$skip=5/);
    // A further page names its mailbox.
    const page = await readRpc(await createMcpDispatch({ db, config, fetch })(connectionId, call("microsoft-outlook-mail__search", { query: { $search: "\"bill\"", $skip: "5" } })));
    assert.equal(reason(page), "A page of results belongs to one inbox: pass account with $skip.");
  } finally { await db.close(); }
});

test("a search across inboxes is one activity entry, naming each inbox's outcome by count only", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek, home, work } = await seed(db, config);
    await updateConnectionStatus(db, { userId, id: work, status: "needs_reconnect" });
    const net = gmail({ home: { messages: [mail("h1", "Hostplus <hi@hostplus.com.au>", "Statement", 20)] } });
    await readRpc(await createMcpDispatch({ db, config, fetch: net.fetch })(connectionId, call("google-gmail__search", { query: { q: "hostplus" } })));
    const rows = await db.query("SELECT * FROM activity_entries WHERE user_id = $1 AND tool = $2 ORDER BY seq", [userId, "google-gmail__search"]);
    assert.equal(rows.rows.length, 1, "one entry for the call");
    const entry = await toEntry(rows.rows[0]!, dek);
    assert.equal(entry.outcome, "executed");
    const payload = entry.payload as Record<string, unknown>;
    assert.deepEqual(payload.connectorAccountSet, [
      { id: home, label: "home@example.com", outcome: "searched", count: 1 },
      { id: work, label: "Work@Example.com", outcome: "needs reconnecting", count: 0 },
    ]);
    assert.ok(!JSON.stringify(payload).includes("Statement"), "no subject or text is kept");
  } finally { await db.close(); }
});
