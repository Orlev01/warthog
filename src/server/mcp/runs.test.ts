// Agent runs over the composed MCP dispatch (docs/adr/agent-runs.md): get_context starts a
// run, every tool advertises `run`, entries made under a run are linked to it and name the
// product the request came through, another agent's run is never linked, and a held call
// keeps its run through approval to the entry for its execution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createAgentExecutors, createMcpDispatch } from "./compose";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, systemClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions, type PermissionGrants } from "../db/agent-permissions";
import { decide, listPendingForUser } from "../db/approvals";
import { createRule } from "../db/rules";
import { listActivity } from "../activity/list";
import { listRuns } from "../agents/runs";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

const NOW = new Date("2026-06-01T00:00:00.000Z");

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

// A modern (2026-07-28) request as Claude Code sends it through Anthropic's connector
// service: the product header, and the client's own name in the request envelope.
function mcpPost(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("https://warthog.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function call(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

interface Rpc {
  result?: { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean; tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> };
  error?: unknown;
}

async function readRpc(res: Response): Promise<Rpc> {
  const text = await res.text();
  const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
  return JSON.parse(frames.length ? frames[frames.length - 1]! : text) as Rpc;
}

async function seed(db: Db, config: Config, grants: Partial<PermissionGrants> = {}) {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `runs-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, fixedClock(NOW));
  await upsertPermissions(db, {
    userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "allow",
    identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [],
    memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120, ...grants,
  });
  return { userId: user.id, connectionId, agentId: agent.id, dek: new Uint8Array(dek) };
}

async function startRunOver(dispatch: ReturnType<typeof createMcpDispatch>, connectionId: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const rpc = await readRpc(await dispatch(connectionId, mcpPost(call("get_context", args), headers)));
  assert.notEqual(rpc.result?.isError, true, JSON.stringify(rpc));
  return JSON.parse(rpc.result!.content![0]!.text!) as { run: { id: string; workingOn: string | null; note: string } | null };
}

test("every Warthog tool advertises the optional run field", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config);
    const rpc = await readRpc(await createMcpDispatch({ db, config })(connectionId, mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })));
    const tools = rpc.result?.tools ?? [];
    assert.ok(tools.length > 5);
    for (const tool of tools) assert.ok(tool.inputSchema?.properties?.run, `${tool.name} advertises run`);
    const getContext = tools.find((tool) => tool.name === "get_context")!;
    assert.ok(getContext.inputSchema?.properties?.working_on, "get_context asks what the conversation is for");
  } finally { await db.close(); }
});

test("get_context starts a run, and calls that pass it are linked to it with the product", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connectionId, dek } = await seed(db, config);
    const dispatch = createMcpDispatch({ db, config });
    const claudeCode = { "x-anthropic-client": "ClaudeCode" };

    const context = await startRunOver(dispatch, connectionId, { working_on: "Fixing the website tests" }, claudeCode);
    assert.ok(context.run, "a run is handed out");
    assert.equal(context.run!.workingOn, "Fixing the website tests");
    assert.match(context.run!.note, /every Warthog call/);

    const remembered = await readRpc(await dispatch(connectionId, mcpPost(call("remember", { content: "Website tests use port 3107", run: context.run!.id }), claudeCode)));
    assert.notEqual(remembered.result?.isError, true, JSON.stringify(remembered));

    const other = await startRunOver(dispatch, connectionId, { working_on: "Planning the trip" }, { "x-anthropic-client": "Cowork" });
    assert.notEqual(other.run!.id, context.run!.id, "each conversation gets its own run");
    await readRpc(await dispatch(connectionId, mcpPost(call("search_memory", { query: "trip", run: other.run!.id }), { "x-anthropic-client": "Cowork" })));

    const inRun = await listActivity(db, userId, { runId: context.run!.id }, dek);
    assert.deepEqual(inRun.map((entry) => `${entry.tool}:${entry.kind}`).sort(), ["get_context:tool_call", "remember:tool_attempt", "remember:tool_call"], "a change's intent and result both join the run");
    for (const entry of inRun) {
      const payload = entry.payload as { run?: { id: string; label?: string }; via?: string; params?: Record<string, unknown> };
      assert.deepEqual(payload.run, { id: context.run!.id, label: "Fixing the website tests" });
      assert.equal(payload.via, "Claude Code");
      assert.equal(payload.params?.run, undefined, "the run is never recorded as a tool argument");
    }
    const inOther = await listActivity(db, userId, { runId: other.run!.id }, dek);
    assert.deepEqual(inOther.map((entry) => entry.tool).sort(), ["get_context", "search_memory"]);
    assert.equal((inOther[0]!.payload as { via?: string }).via, "Claude Cowork");

    const runs = await listRuns(db, userId, dek, { agentId });
    assert.deepEqual(runs.map((run) => [run.label, run.via, run.actions]), [["Planning the trip", "Claude Cowork", 2], ["Fixing the website tests", "Claude Code", 2]], "counted as Activity shows them");
  } finally { await db.close(); }
});

test("a run is never linked for another agent, and paging never starts a stray run", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const owner = await seed(db, config);
    const intruder = await seed(db, config);
    const dispatch = createMcpDispatch({ db, config });

    const ownerRun = (await startRunOver(dispatch, owner.connectionId)).run!;
    assert.equal(ownerRun.workingOn, null, "a run without a description is still a run");

    // Another person's agent names the owner's run: the call still works, unlinked.
    const borrowed = await readRpc(await dispatch(intruder.connectionId, mcpPost(call("remember", { content: "borrowed", run: ownerRun.id }))));
    assert.notEqual(borrowed.result?.isError, true, "a wrong run never blocks the call");
    assert.deepEqual((await listActivity(db, owner.userId, { runId: ownerRun.id }, owner.dek)).map((entry) => entry.tool), ["get_context"]);
    const intruderEntries = await listActivity(db, intruder.userId, {}, intruder.dek);
    assert.equal((intruderEntries.find((entry) => entry.tool === "remember")!.payload as { run?: unknown }).run, undefined);

    // Paging get_context without a run continues a conversation: no run is started.
    const before = (await listRuns(db, owner.userId, owner.dek, { agentId: owner.agentId })).length;
    const fresh = await startRunOver(dispatch, owner.connectionId);
    assert.ok(fresh.run, "no cursor and no run: a new conversation, a new run");
    const firstPage = await readRpc(await dispatch(owner.connectionId, mcpPost(call("get_context", { run: ownerRun.id }))));
    const continued = JSON.parse(firstPage.result!.content![0]!.text!) as { run: { id: string } };
    assert.equal(continued.run.id, ownerRun.id, "passing the run continues it");
    assert.equal((await listRuns(db, owner.userId, owner.dek, { agentId: owner.agentId })).length, before + 1);
  } finally { await db.close(); }
});

test("a held call keeps its run through the person's approval", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config);
    await createRule(db, { userId, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "specific_tool", tool: "remember" } }, dek);
    const dispatch = createMcpDispatch({ db, config });
    const run = (await startRunOver(dispatch, connectionId, { working_on: "Tidying notes" }, { "x-anthropic-client": "ClaudeCode" })).run!;

    const held = await readRpc(await dispatch(connectionId, mcpPost(call("remember", { content: "Approve me", run: run.id }), { "x-anthropic-client": "ClaudeCode" })));
    assert.ok(held.result?.structuredContent, `the change is held for approval: ${JSON.stringify(held)}`);
    const approvalId = String(held.result!.structuredContent!.approval_id);
    const pending = (await listPendingForUser(db, userId, dek)).find((approval) => approval.id === approvalId)!;
    assert.deepEqual(pending.detail.run, { id: run.id, label: "Tidying notes" }, "the approval names the run");
    assert.equal(pending.detail.via, "Claude Code", "and the product");

    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, systemClock);
    const outcome = await createAgentExecutors({ db, config }).executeApprovedHold(userId, approvalId);
    assert.equal(outcome.status, "executed", JSON.stringify(outcome));

    const inRun = await listActivity(db, userId, { runId: run.id }, dek);
    const executed = inRun.find((entry) => entry.tool === "remember" && entry.outcome === "executed");
    assert.ok(executed, "the approved execution is recorded under the run");
    assert.equal((executed!.payload as { via?: string }).via, "Claude Code");
  } finally { await db.close(); }
});

test("a direct connection is named by the client name it sends in the request envelope", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config);
    const dispatch = createMcpDispatch({ db, config });
    // Claude Code 2.1.289 connected directly sends no product header; its client name rides in
    // params._meta on every request (measured 16 Nov 2026).
    const envelope = { "io.modelcontextprotocol/clientInfo": { name: "claude-code", title: "Claude Code", version: "2.1.289" } };
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_context", arguments: { working_on: "Direct" }, _meta: envelope } };
    const rpc = await readRpc(await dispatch(connectionId, mcpPost(body)));
    assert.notEqual(rpc.result?.isError, true, JSON.stringify(rpc));
    const entry = (await listActivity(db, userId, {}, dek)).find((item) => item.tool === "get_context")!;
    assert.equal((entry.payload as { via?: string }).via, "Claude Code");
  } finally { await db.close(); }
});

test("a malformed run never blocks a call, and refused calls and agent reports join their run", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config);
    const dispatch = createMcpDispatch({ db, config });
    const run = (await startRunOver(dispatch, connectionId, { working_on: "Odd inputs" })).run!;

    // The whole run object, or an over-long string, instead of the id: the call still runs.
    for (const odd of [run, "r".repeat(500), 42]) {
      const rpc = await readRpc(await dispatch(connectionId, mcpPost(call("remember", { content: `odd ${typeof odd}`, run: odd }))));
      assert.notEqual(rpc.result?.isError, true, `run ${JSON.stringify(odd).slice(0, 40)} must not block: ${JSON.stringify(rpc)}`);
    }
    const context = await startRunOver(dispatch, connectionId, { run: { id: run.id }, working_on: "w".repeat(5000) });
    assert.ok(context.run, "a malformed run or description never withholds the context");

    // A call refused for its own input, and an agent's own report, still join the run.
    await readRpc(await dispatch(connectionId, mcpPost(call("remember", { run: run.id }))));
    await readRpc(await dispatch(connectionId, mcpPost(call("log_activity", { reason: "Tidied the notes", run: run.id }))));
    const kinds = (await listActivity(db, userId, { runId: run.id }, dek)).map((entry) => entry.kind);
    assert.ok(kinds.includes("tool_rejected"), `the refused call is in the conversation: ${kinds}`);
    assert.ok(kinds.some((kind) => kind !== "tool_call" && kind !== "tool_attempt" && kind !== "tool_rejected"), `the agent's report is in the conversation: ${kinds}`);
  } finally { await db.close(); }
});

test("another agent of the same person cannot use a run", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config);
    const secondConnection = randomUUID();
    await createAgent(db, { userId, connectionId: secondConnection, displayName: "ChatGPT", platform: "chatgpt" }, fixedClock(NOW));
    await upsertPermissions(db, {
      userId, connectionId: secondConnection, grantedConnectors: [], readTools: true, changeTools: "allow",
      identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [],
      memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120,
    });
    const dispatch = createMcpDispatch({ db, config });
    const run = (await startRunOver(dispatch, connectionId)).run!;
    await readRpc(await dispatch(secondConnection, mcpPost(call("remember", { content: "not this run", run: run.id }))));
    assert.deepEqual((await listActivity(db, userId, { runId: run.id }, dek)).map((entry) => entry.tool), ["get_context"]);
  } finally { await db.close(); }
});

test("an approval checked from another conversation stays with the conversation that asked", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config);
    await createRule(db, { userId, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "specific_tool", tool: "remember" } }, dek);
    const dispatch = createMcpDispatch({ db, config });
    const asking = (await startRunOver(dispatch, connectionId, { working_on: "Asking" })).run!;
    const held = await readRpc(await dispatch(connectionId, mcpPost(call("remember", { content: "Held", run: asking.id }))));
    const approvalId = String(held.result!.structuredContent!.approval_id);
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, systemClock);

    const checking = (await startRunOver(dispatch, connectionId, { working_on: "Checking" })).run!;
    await readRpc(await dispatch(connectionId, mcpPost(call("check_approval", { approval_id: approvalId, run: checking.id }))));
    const executed = (await listActivity(db, userId, {}, dek)).find((entry) => entry.tool === "remember" && entry.outcome === "executed");
    assert.ok(executed, "the held call ran when checked");
    assert.equal((executed!.payload as { run?: { id: string } }).run?.id, asking.id, "its result is recorded under the conversation that asked");
    assert.ok((await listActivity(db, userId, { runId: asking.id }, dek)).some((entry) => entry.seq === executed!.seq));
    assert.ok((await listActivity(db, userId, { runId: checking.id }, dek)).some((entry) => entry.tool === "check_approval"), "the check itself is in the checking conversation");
  } finally { await db.close(); }
});
