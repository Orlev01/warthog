// Waiting for an approval in the same reply, end to end through the real MCP dispatch
// (`createMcpDispatch`, docs/adr/approval-continuation.md).
//
// Pins BEHAVIOUR an agent and the person experience. A held send tells the agent to wait with
// check_approval. A wait that is under way returns as soon as the person approves, with the
// sent result, so the agent carries on without being asked "what happened?". A wait whose
// request is cancelled (the agent's app went away) stops, and never runs the held send on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { createMcpDispatch } from "./compose";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { createConnection } from "../db/connections";
import { decide } from "../db/approvals";
import { freshDb } from "../../test/db";
import { mcpRequest } from "../../test/mcp-request";
import type { Db } from "../db/index";

import { adoptStandIn, grantServices } from "../../test/grants";
const NOW = new Date("2026-11-27T00:00:00.000Z");

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

type Rpc = { result?: { content?: { text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } };

async function readRpc(res: Response): Promise<Rpc> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    return JSON.parse(frames.at(-1)!);
  }
  return JSON.parse(text);
}

function call(name: string, args: unknown, signal?: AbortSignal): Request {
  const request = mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return signal ? new Request(request, { signal }) : request;
}

async function seed(db: Db, config: Config) {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `person-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  await createAgent(db, { userId: user.id, connectionId, displayName: "ChatGPT", platform: "chatgpt" }, fixedClock(NOW));
  await grantServices(db, {
    userId: user.id, connectionId, grantedConnectors: ["google-gmail"], readTools: true, changeTools: "ask_first", identityAccess: false,
    highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120,
  });
  const created = await createConnection(db, { userId: user.id, connectorId: "google-gmail", accountLabel: "sam@example.com", credentials: { access_token: "tok" } }, dek, fixedClock(NOW));
  await adoptStandIn(db, user.id, "google-gmail", created.id);
  return { userId: user.id, connectionId, dek };
}

// Gmail as Warthog sees it: Sent-mail searches find nothing, and a send succeeds.
function gmail() {
  const sends: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/messages/send")) {
      sends.push(String(init?.body ?? ""));
      return Response.json({ id: "sent1", threadId: "t1" });
    }
    return Response.json({ messages: [] });
  }) as typeof globalThis.fetch;
  return { fetch, sends };
}

async function holdSend(db: Db) {
  const config = devConfig();
  const { userId, connectionId, dek } = await seed(db, config);
  const upstream = gmail();
  const dispatch = createMcpDispatch({ db, config, fetch: upstream.fetch });
  const held = await readRpc(await dispatch(connectionId, call("google-gmail__send", { to: ["ana@example.com"], subject: "Friday", text: "See you then." })));
  assert.equal(held.result?.structuredContent?.status, "pending_approval");
  const approvalId = String(held.result!.structuredContent!.approval_id);
  const approve = () => decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(new Date()));
  return { dispatch, connectionId, upstream, held, approvalId, approve };
}

test("a held send tells the agent to wait with check_approval in the same reply", async () => {
  const db = await freshDb();
  try {
    const { held } = await holdSend(db);
    const next = String(held.result!.structuredContent!.next);
    assert.match(next, /call check_approval with this approval_id straight away/);
    assert.match(next, /While it says pending, call it again/);
    assert.match(next, /Don't send the request again/);
  } finally { await db.close(); }
});

test("a wait under way returns the sent result as soon as the person approves", async () => {
  const db = await freshDb();
  try {
    const { dispatch, connectionId, upstream, approvalId, approve } = await holdSend(db);
    const started = Date.now();
    const waiting = dispatch(connectionId, call("check_approval", { approval_id: approvalId, wait_seconds: 50 })).then(readRpc);
    await delay(300);
    assert.equal(upstream.sends.length, 0, "nothing is sent while the person hasn't decided");
    await approve();

    const rpc = await waiting;
    assert.notEqual(rpc.result?.isError, true, JSON.stringify(rpc));
    assert.match(JSON.stringify(rpc.result?.content), /executed/);
    assert.equal(upstream.sends.length, 1, "approved once, sent once");
    assert.ok(Date.now() - started < 10_000, `it returned once approved, not at the end of the wait (${Date.now() - started}ms)`);
  } finally { await db.close(); }
});

test("a cancelled wait stops, and never runs the held send on its own", async () => {
  const db = await freshDb();
  try {
    const { dispatch, connectionId, upstream, approvalId, approve } = await holdSend(db);
    const controller = new AbortController();
    const waiting = dispatch(connectionId, call("check_approval", { approval_id: approvalId, wait_seconds: 50 }, controller.signal)).catch(() => undefined);
    await delay(300);
    controller.abort();
    await waiting;
    await delay(1_500);

    // The person approves after the agent went away: approving runs it in the inbox, not a
    // forgotten wait. Here nothing runs it, so nothing is sent until someone asks.
    await approve();
    await delay(2_000);
    assert.equal(upstream.sends.length, 0, "the cancelled wait was no longer polling");

    const again = await readRpc(await dispatch(connectionId, call("check_approval", { approval_id: approvalId, wait_seconds: 0 })));
    assert.match(JSON.stringify(again.result?.content), /executed/);
    assert.equal(upstream.sends.length, 1, "the next check runs it, once");
  } finally { await db.close(); }
});
