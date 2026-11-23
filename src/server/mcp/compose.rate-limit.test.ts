// The agent's request limit, applied by the MCP dispatch before any per-request work (review
// 2026-11-23, High: every MCP request unwrapped the person's DEK through Key Vault, uncached,
// before the limit was checked, so a looping agent could exhaust the vault quota everyone
// shares). Design §6.2: connection active → rate limit → permission check.
//
// Pins BEHAVIOUR over the real MCP wire: what an agent gets back, what the person's activity
// holds, how often the KeyWrapper is asked to unwrap. The limiter is the process-wide one,
// over the system clock; every test uses its own connection, so windows never mix, and each
// test makes its calls well inside one minute.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createMcpDispatch } from "./compose";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { cachedKeyWrapper, createDekCache } from "../crypto/dek-cache";
import { fixedClock, systemClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

const NOW = new Date("2026-11-23T00:00:00.000Z");
const RATE_LIMIT_REASON = /going too fast/;

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

// The dev KeyWrapper with a counter on unwrap.
function countingWrapper(config: Config): { wrapper: KeyWrapper; unwraps: () => number } {
  const inner = localAesKeyWrapper(config.devKek!);
  let count = 0;
  return {
    unwraps: () => count,
    wrapper: { wrap: (dek) => inner.wrap(dek), unwrap: async (wrapped) => { count += 1; return inner.unwrap(wrapped); } },
  };
}

// A person, their agent and its grants with the given request limit.
async function seed(db: Db, config: Config, rateLimit: number): Promise<{ userId: string; agentId: string; connectionId: string }> {
  const user = await createUser(db, { email: `person-${randomUUID()}@warthog.com.au`, wrappedDek: await localAesKeyWrapper(config.devKek!).wrap(randomBytes(32)) });
  const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Claude", platform: "claude" }, fixedClock(NOW));
  await upsertPermissions(db, {
    userId: user.id, connectionId: agent.connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: true,
    highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit,
    tasksAccess: true,
  } as Parameters<typeof upsertPermissions>[1]);
  return { userId: user.id, agentId: agent.id, connectionId: agent.connectionId };
}

interface Rpc {
  result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string }[] };
  error?: { message?: string };
}

async function post(dispatch: ReturnType<typeof createMcpDispatch>, connectionId: string, body: unknown): Promise<Rpc> {
  const res = await dispatch(connectionId, new Request("https://warthog.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify(body),
  }));
  const text = await res.text();
  const frame = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1)!
    : text;
  return JSON.parse(frame) as Rpc;
}

const call = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const textOf = (rpc: Rpc) => (rpc.result?.content ?? []).map((block) => block.text ?? "").join(" ");

async function outcomes(db: Db, userId: string): Promise<{ outcome: string; tool: string | null }[]> {
  const rows = await db.query("SELECT outcome, tool FROM activity_entries WHERE user_id = $1 ORDER BY seq", [userId]);
  return rows.rows.map((row) => ({ outcome: String(row.outcome), tool: row.tool == null ? null : String(row.tool) }));
}

test("a person's limit of N lets exactly N tool calls through: each call is counted once", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config, 3);
    const dispatch = createMcpDispatch({ db, config });

    for (let i = 0; i < 3; i += 1) {
      const rpc = await post(dispatch, connectionId, call("list_tasks"));
      assert.notEqual(rpc.result?.isError, true, `call ${i + 1} of 3 is within the limit: ${textOf(rpc)}`);
    }
    const over = await post(dispatch, connectionId, call("list_tasks"));
    assert.equal(over.result?.isError, true, "the fourth call is over the limit");
    assert.match(textOf(over), RATE_LIMIT_REASON, "it is refused with the rate-limit reason, as a tool result");
  } finally {
    await db.close();
  }
});

test("an over-limit tool call is refused before anything unwraps the person's key; the burst is summarised once", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, agentId, connectionId } = await seed(db, config, 2);
    const spy = countingWrapper(config);
    const dispatch = createMcpDispatch({ db, config, keyWrapper: spy.wrapper });

    await post(dispatch, connectionId, call("list_tasks"));
    await post(dispatch, connectionId, call("search_memory", { query: "x" }));
    assert.ok(spy.unwraps() > 0, "calls within the limit do unwrap the key");

    // The first over-limit call writes the burst's ONE summary entry (encrypted, so it needs
    // the key once, after the limit decided); every later one unwraps nothing at all.
    const first = await post(dispatch, connectionId, call("list_tasks"));
    assert.match(textOf(first), RATE_LIMIT_REASON);
    const afterFirst = spy.unwraps();
    for (let i = 0; i < 4; i += 1) {
      const rpc = await post(dispatch, connectionId, call(i % 2 === 0 ? "get_context" : "list_tasks", { run: "r", query: "x" }));
      assert.equal(rpc.result?.isError, true);
      assert.match(textOf(rpc), RATE_LIMIT_REASON);
    }
    assert.equal(spy.unwraps(), afterFirst, "over-limit calls after the first unwrap nothing");

    const recorded = await outcomes(db, userId);
    assert.deepEqual(recorded.filter((e) => e.outcome === "rate_limited"), [{ outcome: "rate_limited", tool: "list_tasks" }],
      "one entry summarises the burst, naming the tool");
    const card = await db.query("SELECT request_count FROM agents WHERE id = $1", [agentId]);
    assert.equal(Number(card.rows[0]?.request_count), 7, "every call, refused or not, still counts on the agent card");
  } finally {
    await db.close();
  }
});

test("with the DEK cache, a burst of requests unwraps the person's key once", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config, 2);
    const spy = countingWrapper(config);
    const keyWrapper = cachedKeyWrapper(spy.wrapper, createDekCache({ clock: systemClock, schedule: () => () => {} }));
    const dispatch = createMcpDispatch({ db, config, keyWrapper });

    await post(dispatch, connectionId, LIST);
    await post(dispatch, connectionId, call("list_tasks"));
    await post(dispatch, connectionId, call("get_context"));
    for (let i = 0; i < 3; i += 1) await post(dispatch, connectionId, call("list_tasks"));
    await post(dispatch, connectionId, LIST);
    assert.equal(spy.unwraps(), 1, "seven requests, one Key Vault unwrap");
  } finally {
    await db.close();
  }
});

test("tools/list is not counted against the limit and still answers while the agent is over it", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config, 2);
    const dispatch = createMcpDispatch({ db, config });

    for (let i = 0; i < 5; i += 1) await post(dispatch, connectionId, LIST);
    for (let i = 0; i < 2; i += 1) {
      assert.notEqual((await post(dispatch, connectionId, call("list_tasks"))).result?.isError, true, "listing used none of the limit");
    }
    assert.match(textOf(await post(dispatch, connectionId, call("list_tasks"))), RATE_LIMIT_REASON);
    const listed = await post(dispatch, connectionId, LIST);
    assert.ok(listed.result?.tools?.some((tool) => tool.name === "list_tasks"), "the tool list is still served");
  } finally {
    await db.close();
  }
});

test("an over-limit call to a tool Warthog doesn't have is refused the same way and records no made-up name", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId } = await seed(db, config, 1);
    const dispatch = createMcpDispatch({ db, config });

    await post(dispatch, connectionId, call("list_tasks"));
    const rpc = await post(dispatch, connectionId, call("not-a-service__exfiltrate", { to: "x@example.com" }));
    assert.equal(rpc.result?.isError, true);
    assert.match(textOf(rpc), RATE_LIMIT_REASON);
    const recorded = (await outcomes(db, userId)).filter((e) => e.outcome === "rate_limited");
    assert.equal(recorded.length, 1);
    assert.notEqual(recorded[0]!.tool, "not-a-service__exfiltrate", "an unknown name is not written into the record");
  } finally {
    await db.close();
  }
});

test("the same refusal answers a 2026-07-28 client, which names its app on every call", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config, 1);
    const spy = countingWrapper(config);
    const dispatch = createMcpDispatch({ db, config, keyWrapper: spy.wrapper });
    const modern = (name: string) => new Request("https://warthog.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {}, _meta: {
        "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.289" },
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      } } }),
    });
    const read = async (res: Response): Promise<Rpc> => {
      const text = await res.text();
      const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
      return JSON.parse(frames.length ? frames.at(-1)! : text) as Rpc;
    };

    assert.notEqual((await read(await dispatch(connectionId, modern("list_tasks")))).result?.isError, true);
    await read(await dispatch(connectionId, modern("list_tasks"))); // the burst's summary entry
    const before = spy.unwraps();
    const rpc = await read(await dispatch(connectionId, modern("list_tasks")));
    assert.equal(rpc.result?.isError, true);
    assert.match(textOf(rpc), RATE_LIMIT_REASON);
    assert.equal(spy.unwraps(), before, "nothing unwrapped the key, its app report included");
  } finally {
    await db.close();
  }
});
