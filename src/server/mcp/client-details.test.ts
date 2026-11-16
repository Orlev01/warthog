// The apps an agent's requests come through, over the composed MCP dispatch and the client
// memory: a 2026-07-28 client's details are read from where it sends them, each app is
// recorded once however often one connection moves between apps, unchanged reports are not
// rewritten on every request, and a failure never costs the agent its call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createMcpDispatch } from "./compose";
import { createRedactingRecorder } from "./recorder";
import { CLIENT_REFRESH_MS, CLIENT_RETRY_MS, RECENT_CLIENTS, createClientMemory, readClientObservation, type ClientObservation } from "./client-observation";
import { loadConfig, type Config } from "../config";
import { encrypt } from "../crypto/envelope";
import { fingerprint } from "../crypto/hmac";
import { storeFingerprint } from "../db/release-fingerprints";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { listActivity } from "../activity/list";
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

// The four apps measured behind one claude.ai connector on 16 Nov 2026, each with the
// envelope it sends in params._meta on every request.
const APPS = {
  claudeCode: { header: "ClaudeCode", info: { name: "claude-code", title: "Claude Code", version: "2.1.289", description: "Anthropic's agentic coding tool", websiteUrl: "https://claude.com/claude-code" }, capabilities: { elicitation: {}, roots: {} } },
  chats: { header: "Cowork", info: { name: "claude-code", title: "Claude Code", version: "2.1.326-ccs.sha14b5cc04c8a4", description: "Anthropic's agentic coding tool" }, capabilities: { elicitation: {}, extensions: {}, roots: {} } },
  claudeAi: { header: "ClaudeAI", info: { name: "Anthropic/ClaudeAI", version: "1.0.0" }, capabilities: { extensions: {} } },
  toolbox: { header: "ClaudeAI", info: { name: "Anthropic/Toolbox", version: "1.0.0" }, capabilities: { extensions: {} } },
} as const;
type App = (typeof APPS)[keyof typeof APPS];

function modernCall(app: App, name: string, args: Record<string, unknown>): Request {
  const body = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args, _meta: { "io.modelcontextprotocol/clientInfo": app.info, "io.modelcontextprotocol/clientCapabilities": app.capabilities, "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  };
  return new Request("https://warthog.example/mcp", {
    method: "POST",
    // The headers Claude Code sent with each call in the 16 Nov measurement.
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name, "x-anthropic-client": app.header },
    body: JSON.stringify(body),
  });
}

async function readRpc(res: Response): Promise<{ result?: { isError?: boolean }; error?: unknown }> {
  const text = await res.text();
  const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
  return JSON.parse(frames.length ? frames[frames.length - 1]! : text);
}

async function seed(db: Db, config: Config) {
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `apps-${randomUUID()}@warthog.com.au`, wrappedDek: await localAesKeyWrapper(config.devKek!).wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, fixedClock(NOW));
  await upsertPermissions(db, {
    userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "allow",
    identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [],
    memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120,
  });
  const connection = { userId: user.id, connectionId, agentId: agent.id, active: true };
  return { userId: user.id, agentId: agent.id, connectionId, connection, dek: new Uint8Array(dek) };
}

const observed = (app: App): ClientObservation => ({
  name: app.info.name, version: app.info.version, protocol: "2026-07-28",
  capabilities: Object.keys(app.capabilities).sort(), source: "client_reported",
});

test("a current client's details are recorded from the request envelope, once, and carried on its entries", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connectionId, dek } = await seed(db, config);
    const dispatch = createMcpDispatch({ db, config });
    for (const query of ["dentist", "port", "trip"]) {
      const rpc = await readRpc(await dispatch(connectionId, modernCall(APPS.claudeCode, "search_memory", { query })));
      assert.ok(rpc.result && rpc.result.isError !== true, JSON.stringify(rpc));
    }
    const record = await readClientObservation(db, userId, agentId, dek);
    assert.equal(record?.name, "claude-code");
    assert.equal(record?.version, "2.1.289");
    assert.equal(record?.protocol, "2026-07-28");
    assert.deepEqual(record?.capabilities, ["elicitation", "roots"]);
    assert.equal(record?.seen.length, 1);

    const entries = await listActivity(db, userId, {}, dek);
    assert.equal(entries.filter((entry) => entry.kind === "client_observed").length, 1, "an unchanged app is recorded once");
    const searches = entries.filter((entry) => entry.tool === "search_memory");
    assert.equal(searches.length, 3);
    for (const entry of searches) {
      assert.equal((entry.payload as { client?: { name?: string } }).client?.name, "claude-code", "each entry names the app it came through");
    }
    assert.doesNotMatch(JSON.stringify(entries), /agentic coding|claude\.com/, "descriptions and links are never kept");
  } finally { await db.close(); }
});

test("moving between the apps one connection is used from records each app once", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connectionId, dek } = await seed(db, config);
    const dispatch = createMcpDispatch({ db, config });
    const order = [APPS.claudeCode, APPS.chats, APPS.claudeAi, APPS.claudeCode, APPS.toolbox, APPS.chats, APPS.claudeCode, APPS.claudeAi];
    for (const [i, app] of order.entries()) {
      const rpc = await readRpc(await dispatch(connectionId, modernCall(app, "search_memory", { query: `q${i}` })));
      assert.ok(rpc.result && rpc.result.isError !== true, JSON.stringify(rpc));
    }
    const reported = (await listActivity(db, userId, { kind: "client_observed" }, dek))
      .map((entry) => { const client = (entry.payload as { client: ClientObservation }).client; return `${client.name} ${client.version}`; })
      .sort();
    assert.deepEqual(reported, [
      "Anthropic/ClaudeAI 1.0.0", "Anthropic/Toolbox 1.0.0", "claude-code 2.1.289", "claude-code 2.1.326-ccs.sha14b5cc04c8a4",
    ], "four apps, four entries, however often they alternate");
    const record = await readClientObservation(db, userId, agentId, dek);
    assert.equal(record?.seen.length, 4);
    assert.deepEqual(new Set(record!.seen.map((item) => `${item.name} ${item.version}`)), new Set(reported));
  } finally { await db.close(); }
});

test("an unchanged report is rewritten at most once per refresh window, and a new version is news", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connection, dek } = await seed(db, config);
    const recorder = createRedactingRecorder({ db, clock: fixedClock(NOW), dekFor: async () => dek });
    const remember = createClientMemory({ db, recorder, onError: (err) => { throw err; } });
    let unwraps = 0;
    const dekFor = async () => { unwraps += 1; return dek; };
    const at = (ms: number) => new Date(NOW.getTime() + ms);

    await remember(connection, observed(APPS.claudeCode), at(0), dekFor);
    await remember(connection, observed(APPS.claudeCode), at(1_000), dekFor);
    await remember(connection, observed(APPS.claudeCode), at(CLIENT_REFRESH_MS - 1), dekFor);
    assert.equal(unwraps, 1, "repeats inside the window touch neither the database nor the key");
    assert.equal((await readClientObservation(db, userId, agentId, dek))?.observedAt, at(0).toISOString());

    await remember(connection, observed(APPS.claudeCode), at(CLIENT_REFRESH_MS), dekFor);
    assert.equal(unwraps, 2);
    assert.equal((await readClientObservation(db, userId, agentId, dek))?.observedAt, at(CLIENT_REFRESH_MS).toISOString(), "last seen moves on");

    await remember(connection, observed(APPS.claudeCode), at(CLIENT_REFRESH_MS - 3 * 60 * 60_000), dekFor);
    assert.equal(unwraps, 3, "a clock that stepped back hours does not hold refreshes off for hours");

    await remember(connection, { ...observed(APPS.claudeCode), version: "2.1.290" }, at(CLIENT_REFRESH_MS + 1), dekFor);
    const record = await readClientObservation(db, userId, agentId, dek);
    assert.equal(record?.version, "2.1.290", "the latest report is the top-level one");
    assert.deepEqual(record?.seen.map((item) => item.version), ["2.1.290", "2.1.289"]);
    assert.equal((await listActivity(db, userId, { kind: "client_observed" }, dek)).length, 2, "an update is recorded; a refresh is not");
  } finally { await db.close(); }
});

test("the record keeps a bounded list of recent apps, latest first", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connection, dek } = await seed(db, config);
    const recorder = createRedactingRecorder({ db, clock: fixedClock(NOW), dekFor: async () => dek });
    const remember = createClientMemory({ db, recorder, onError: (err) => { throw err; } });
    for (let i = 0; i < RECENT_CLIENTS + 3; i += 1) {
      await remember(connection, { ...observed(APPS.claudeCode), version: `2.1.${300 + i}` }, new Date(NOW.getTime() + i * 1000), async () => dek);
    }
    const record = await readClientObservation(db, userId, agentId, dek);
    assert.equal(record?.seen.length, RECENT_CLIENTS);
    assert.equal(record?.seen[0]?.version, `2.1.${300 + RECENT_CLIENTS + 2}`);
    assert.equal(record?.seen.at(-1)?.version, "2.1.303", "the least recently seen fall off");
  } finally { await db.close(); }
});

test("a record written by an earlier release still matches the app it describes", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connection, dek } = await seed(db, config);
    // The earlier shape: one report and when it was seen, with no list.
    const earlier = { name: "Example client", version: "3", protocol: "2025-11-25", capabilities: ["roots"], source: "client_reported", observedAt: NOW.toISOString() };
    await db.query("UPDATE agents SET client_observation_ct = $3 WHERE user_id = $1 AND id = $2",
      [userId, agentId, await encrypt(dek, "agents", "client_observation_ct", agentId, JSON.stringify(earlier))]);
    const before = await readClientObservation(db, userId, agentId, dek);
    assert.deepEqual(before?.seen.map((item) => item.name), ["Example client"]);

    const recorder = createRedactingRecorder({ db, clock: fixedClock(NOW), dekFor: async () => dek });
    const remember = createClientMemory({ db, recorder, onError: (err) => { throw err; } });
    const { observedAt: _seen, ...report } = earlier;
    await remember(connection, report as ClientObservation, new Date(NOW.getTime() + 60_000), async () => dek);
    assert.equal((await listActivity(db, userId, { kind: "client_observed" }, dek)).length, 0, "the same app is not reported again");
    assert.equal((await readClientObservation(db, userId, agentId, dek))?.seen.length, 1);
  } finally { await db.close(); }
});

test("a failure to remember the app is reported to the operator and never fails the call", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connection, dek } = await seed(db, config);
    const recorder = createRedactingRecorder({ db, clock: fixedClock(NOW), dekFor: async () => dek });
    const failures: unknown[] = [];
    const remember = createClientMemory({ db, recorder, onError: (err) => failures.push(err) });
    await remember(connection, observed(APPS.claudeCode), NOW, async () => { throw new Error("key service unavailable"); });
    assert.equal(failures.length, 1);
    // A failure is not retried on every request, but it is retried soon.
    let unwraps = 0;
    await remember(connection, observed(APPS.claudeCode), new Date(NOW.getTime() + 1000), async () => { unwraps += 1; return dek; });
    assert.equal(unwraps, 0, "the next request inside the back-off does not try again");
    await remember(connection, observed(APPS.claudeCode), new Date(NOW.getTime() + CLIENT_RETRY_MS), async () => { unwraps += 1; return dek; });
    assert.equal(unwraps, 1);
    assert.equal(failures.length, 1);
    assert.equal((await readClientObservation(db, connection.userId, connection.agentId, dek))?.name, "claude-code");
  } finally { await db.close(); }
});

test("going back to an app the agent already uses records nothing, even when every report is written", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connection, dek } = await seed(db, config);
    const recorder = createRedactingRecorder({ db, clock: fixedClock(NOW), dekFor: async () => dek });
    // No refresh window: every report reaches the record, so only `seen` can keep it quiet.
    const remember = createClientMemory({ db, recorder, refreshMs: 0, onError: (err) => { throw err; } });
    const order = [APPS.claudeCode, APPS.chats, APPS.claudeCode, APPS.chats, APPS.claudeCode];
    for (const [i, app] of order.entries()) await remember(connection, observed(app), new Date(NOW.getTime() + i * 1000), async () => dek);
    assert.equal((await listActivity(db, userId, { kind: "client_observed" }, dek)).length, 2);
    const record = await readClientObservation(db, userId, agentId, dek);
    assert.deepEqual(record?.seen.map((item) => item.version), ["2.1.289", "2.1.326-ccs.sha14b5cc04c8a4"], "two apps, latest first");
    assert.equal(record?.seen[0]?.observedAt, new Date(NOW.getTime() + 4000).toISOString());
  } finally { await db.close(); }
});

test("a report the person's released-value redaction changes still matches its stored copy", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connection, dek } = await seed(db, config);
    // A released value that happens to equal the version's normalised token ("21289").
    await storeFingerprint(db, { userId, fingerprint: fingerprint(dek, "21289") }, fixedClock(NOW));
    const recorder = createRedactingRecorder({ db, clock: fixedClock(NOW), dekFor: async () => dek });
    const remember = createClientMemory({ db, recorder, refreshMs: 0, onError: (err) => { throw err; } });
    for (let i = 0; i < 4; i += 1) await remember(connection, observed(APPS.claudeCode), new Date(NOW.getTime() + i * 1000), async () => dek);
    assert.equal((await listActivity(db, userId, { kind: "client_observed" }, dek)).length, 1);
    const record = await readClientObservation(db, userId, agentId, dek);
    assert.equal(record?.seen.length, 1, "no duplicate copies pile up");
    assert.doesNotMatch(JSON.stringify(record), /2\.1\.289/, "the released value is not stored");
  } finally { await db.close(); }
});

test("simultaneous requests with the same report are written once", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connection, dek } = await seed(db, config);
    const recorder = createRedactingRecorder({ db, clock: fixedClock(NOW), dekFor: async () => dek });
    const remember = createClientMemory({ db, recorder, onError: (err) => { throw err; } });
    let unwraps = 0;
    await Promise.all([0, 1, 2, 3].map((i) => remember(connection, observed(APPS.claudeCode), new Date(NOW.getTime() + i), async () => { unwraps += 1; return dek; })));
    assert.equal(unwraps, 1);
    assert.equal((await listActivity(db, userId, { kind: "client_observed" }, dek)).length, 1);
  } finally { await db.close(); }
});

test("a run reference in the request envelope reaches the entry it describes", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config);
    const dispatch = createMcpDispatch({ db, config });
    const request = modernCall(APPS.claudeCode, "search_memory", { query: "dentist" });
    const body = JSON.parse(await request.text());
    body.params._meta["app.warthog/runId"] = "fix-tests.1";
    const rpc = await readRpc(await dispatch(connectionId, new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) })));
    assert.ok(rpc.result && rpc.result.isError !== true, JSON.stringify(rpc));
    const entry = (await listActivity(db, userId, {}, dek)).find((item) => item.tool === "search_memory")!;
    assert.equal((entry.payload as { reportedRunId?: string }).reportedRunId, "fix-tests.1");
  } finally { await db.close(); }
});
