// A held call as an MCP task, end to end through the real MCP dispatch (`createMcpDispatch`,
// ./approval-tasks.ts, docs/adr/approval-continuation.md).
//
// Pins BEHAVIOUR an agent's app and the person experience:
// - a client that declares the Tasks extension gets a working task for a held send, not
//   `pending_approval`; one that doesn't keeps `pending_approval`;
// - `tasks/get` reports working until the person decides, then the sent result, and the send
//   runs once however often it is polled;
// - a denial completes the task with the refusal as an error result;
// - another agent's task, or a client that didn't declare the extension, gets the spec's errors;
// - cancelling is acknowledged but leaves the decision to the person;
// - polling records nothing in Activity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createMcpDispatch } from "./compose";
import { TASKS_EXTENSION } from "./approval-tasks";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { createConnection } from "../db/connections";
import { decide, getApproval } from "../db/approvals";
import { readActivity } from "../activity/writer";
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

type Rpc = { result?: Record<string, unknown> & { content?: { text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }; error?: { code: number; message: string } };

async function readRpc(res: Response): Promise<Rpc> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    return JSON.parse(frames.at(-1)!);
  }
  return JSON.parse(text);
}

// The envelope a client that supports tasks sends on every request.
const WITH_TASKS = { "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION]: {} } } };

function rpc(method: string, params: Record<string, unknown>, tasks = true): Request {
  return mcpRequest({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...(tasks ? { _meta: WITH_TASKS } : {}) } });
}

async function seed(db: Db, config: Config) {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `person-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const agent = async () => {
    const connectionId = randomUUID();
    await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, fixedClock(NOW));
    await grantServices(db, {
      userId: user.id, connectionId, grantedConnectors: ["google-gmail"], readTools: true, changeTools: "ask_first", identityAccess: false,
      highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120,
    });
    return connectionId;
  };
  const connectionId = await agent();
  const created = await createConnection(db, { userId: user.id, connectorId: "google-gmail", accountLabel: "sam@example.com", credentials: { access_token: "tok" } }, dek, fixedClock(NOW));
  await adoptStandIn(db, user.id, "google-gmail", created.id);
  return { userId: user.id, connectionId, dek, anotherAgent: agent };
}

async function setup(db: Db) {
  const config = devConfig();
  const seeded = await seed(db, config);
  const sends: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/messages/send")) {
      sends.push(String(init?.body ?? ""));
      return Response.json({ id: "sent1", threadId: "t1" });
    }
    return Response.json({ messages: [] });
  }) as typeof globalThis.fetch;
  const dispatch = createMcpDispatch({ db, config, fetch });
  const send = (tasks = true) => dispatch(seeded.connectionId, rpc("tools/call", { name: "google-gmail__send", arguments: { to: ["ana@example.com"], subject: "Friday", text: "See you then." } }, tasks)).then(readRpc);
  const get = (taskId: string, connectionId = seeded.connectionId, tasks = true) => dispatch(connectionId, rpc("tasks/get", { taskId }, tasks)).then(readRpc);
  const decideAs = (taskId: string, status: "approved" | "denied") => decide(db, { userId: seeded.userId, id: taskId, decision: { status } }, seeded.dek, fixedClock(new Date()));
  return { ...seeded, dispatch, sends, send, get, decideAs };
}

test("a client that declares tasks gets a working task for a held send; one that doesn't gets pending_approval", async () => {
  const db = await freshDb();
  try {
    const { send, userId, dek, sends } = await setup(db);
    const task = (await send()).result!;
    assert.equal(task.resultType, "task");
    assert.equal(task.status, "working");
    assert.equal(task.statusMessage, "Waiting for the person to approve this in Warthog.");
    assert.equal(task.ttlMs, null);
    assert.equal(task.pollIntervalMs, 5000);
    const approval = await getApproval(db, userId, String(task.taskId), dek);
    assert.equal(approval?.status, "pending", "the task id is the approval the person sees");
    assert.equal(sends.length, 0, "nothing is sent before the person decides");

    const plain = (await send(false)).result!;
    assert.equal(plain.structuredContent?.status, "pending_approval");
    assert.equal(plain.resultType ?? "complete", "complete");
  } finally { await db.close(); }
});

test("tasks/get is working until the person approves, then the sent result; the send runs once", async () => {
  const db = await freshDb();
  try {
    const { send, get, decideAs, sends } = await setup(db);
    const taskId = String((await send()).result!.taskId);
    const working = (await get(taskId)).result!;
    assert.equal(working.status, "working");
    assert.equal(working.taskId, taskId);
    assert.equal(working.result, undefined);

    await decideAs(taskId, "approved");
    const done = (await get(taskId)).result!;
    assert.equal(done.status, "completed");
    const result = done.result as { content: { text: string }[]; isError?: boolean };
    assert.notEqual(result.isError, true);
    assert.match(result.content[0]!.text, /sent1/, "the send's own result, as the tool would have returned it");

    const again = (await get(taskId)).result!;
    assert.deepEqual(again.result, done.result, "the same result however often it is polled");
    assert.equal(sends.length, 1, "approved once, sent once");
  } finally { await db.close(); }
});

test("a denial completes the task with the refusal as an error result", async () => {
  const db = await freshDb();
  try {
    const { send, get, decideAs, sends } = await setup(db);
    const taskId = String((await send()).result!.taskId);
    await decideAs(taskId, "denied");
    const done = (await get(taskId)).result!;
    assert.equal(done.status, "completed", "a tool-level refusal is completed, never failed");
    const result = done.result as { content: { text: string }[]; isError?: boolean };
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, "The person denied this request.");
    assert.equal(sends.length, 0);
  } finally { await db.close(); }
});

test("another agent's task is not found, and a client that didn't declare tasks is told what it lacks", async () => {
  const db = await freshDb();
  try {
    const { send, get, anotherAgent } = await setup(db);
    const taskId = String((await send()).result!.taskId);
    const other = await anotherAgent();
    assert.equal((await get(taskId, other)).error?.code, -32602, "another agent's task id finds nothing");
    assert.equal((await get(randomUUID())).error?.code, -32602, "nor does an unknown one");
    assert.equal((await get("not-a-uuid")).error?.code, -32602);
    assert.equal((await get(taskId, undefined, false)).error?.code, -32021, "the Tasks extension wasn't declared");
  } finally { await db.close(); }
});

test("cancelling is acknowledged, and the decision stays the person's", async () => {
  const db = await freshDb();
  try {
    const { send, dispatch, connectionId, get, userId, dek } = await setup(db);
    const taskId = String((await send()).result!.taskId);
    const cancel = await readRpc(await dispatch(connectionId, rpc("tasks/cancel", { taskId })));
    assert.equal(cancel.error, undefined);
    assert.deepEqual(Object.keys(cancel.result ?? {}).filter((key) => key !== "resultType" && key !== "_meta"), [], "an empty acknowledgement");
    assert.equal((await get(taskId)).result!.status, "working");
    assert.equal((await getApproval(db, userId, taskId, dek))?.status, "pending");
  } finally { await db.close(); }
});

test("the client's polls record nothing in Activity", async () => {
  const db = await freshDb();
  try {
    const { send, get, userId, dek } = await setup(db);
    const taskId = String((await send()).result!.taskId);
    const before = (await readActivity(db, userId, dek)).length;
    for (let i = 0; i < 3; i++) await get(taskId);
    assert.equal((await readActivity(db, userId, dek)).length, before);
  } finally { await db.close(); }
});
