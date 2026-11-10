// E07-S19 — the MCP endpoint serves the tool registry through the agent-call pipeline
// (design §6.1/§6.2, constitution 13/14/15; INV-102).
//
// RED-first: the MCP composition root `./compose` (`createMcpDispatch`) does NOT exist
// yet, so importing it throws and every test in this file fails until the builder writes
// the module. That absence IS the point of test-first — do NOT implement anything to make
// these pass.
//
// What ships under this task (the contract these tests pin):
//
//   ./compose.ts — the MCP composition root. It builds the pipeline's REAL dependencies
//     (the KeyWrapper from config, the DB-backed activity recorder, the rate limiter, the
//     tool-body executor and the pure policy pipeline) from the two things a composition
//     root is handed — `config` and the process `db` — and returns the DISPATCH the
//     `/mcp` route seam expects (`src/app/mcp/handler.ts`, E07-S12):
//
//       createMcpDispatch(deps: { db: Db; config: Config })
//         : (connectionId: string, request: Request) => Promise<Response>
//
//     The dispatch drives a stateless `createMcpHandler` whose `McpServer` REGISTERS every
//     core tool from the registry (plus the verified connection's permitted connector
//     tools), each handler routing through `handleAgentCall` under the connection resolved
//     from the VERIFIED bearer — never a value in the request body — and maps the pipeline
//     outcome to an MCP tool result:
//       • executed  → a normal result (content), NOT isError;
//       • ask        → `pending_approval` with `approval_id` + `expires_at` as STRUCTURED
//                      content, nothing released;
//       • denied/refused → `isError: true` carrying a plain reason.
//
// These tests pin BEHAVIOUR over the REAL MCP wire — they POST a JSON-RPC `tools/list` /
// `tools/call` to the dispatch with the Streamable-HTTP headers a real client sends
// (`Accept: application/json, text/event-stream`; `MCP-Protocol-Version: 2025-06-18`) and
// read the SSE response the SDK emits — and assert what the person's data store holds
// afterwards (an activity entry, a memory on /memory, a pending approval in the inbox),
// never the source text of any module. The auth boundary + the dispatch are also composed
// behind the real `createMcpRouteHandler` + `verifyBearer` in one end-to-end test, over an
// isolated in-memory PGlite seeded through the real stores. Tests never touch the network
// or Azure; every db handle is closed in a `finally`.
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1  tools/list returns the core tools (get_context, remember, search_memory,
//        request_card, request_identity_detail, check_approval, collect_release,
//        list_tasks, …) with their input schemas.
//   AC2  tools/call get_context returns the person's allowed context AND records an
//        activity entry for that connection; tools/call remember stores a memory the
//        person then sees on /memory.
//   AC3  tools/call request_card (card access on) creates a pending approval visible in
//        the inbox and returns `pending_approval` with its `approval_id`, releasing
//        nothing; a denied request (high-tier off) maps to `isError` + a plain reason.
//   AC4  the connection comes ONLY from the verified bearer: a body that names another
//        connection / user id is ignored; composed into /mcp, an unauthenticated call is
//        still 401 and a valid bearer lists the tools.
//   AC6  a malformed tool input is rejected (isError), never a silent success; and a
//        SQL-injection probe in an input field is stored as bound DATA, leaving the query
//        intact. [obligation:validate-and-parameterize-input]

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { createMcpDispatch } from "./compose";
import { rememberSchema, searchMemorySchema } from "./tools/memory";
import { getSkillSchema } from "./tools/get-skill";
import { inputSchema as checkApprovalSchema } from "./tools/check-approval";
import { inputSchema as collectReleaseSchema } from "./tools/collect-release";
import { completeTaskSchema, createTaskSchema, listTasksSchema, updateTaskSchema } from "./tools/tasks";
import { listRecordsSchema, saveRecordSchema, updateRecordSchema } from "./tools/records";
import { logActivitySchema } from "./tools/log-activity";

import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, systemClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions, type PermissionGrants } from "../db/agent-permissions";
import { listMemoriesForUser } from "../db/memories";
import { listPendingForUser } from "../db/approvals";
import { registerSubscription } from "../db/push-subscriptions";
import { createHousehold, setHouseholdBudget, setMemberLimit } from "../db/households";
import { upsertRate } from "../db/exchange-rates";
import { storeFingerprint } from "../db/release-fingerprints";
import { fingerprint } from "../crypto/hmac";
import { createConnection } from "../db/connections";
import { createRule } from "../db/rules";
import { saveIdentityField } from "../db/identity-fields";
import { createMemory } from "../db/memories";
import { createTask } from "../db/tasks";
import { FALLBACK_JOB_TYPE } from "../notify/approval-notifier";
import { outbox } from "../notify/outbox";
import { createToken } from "../oauth/store";
import { listActivity } from "../activity/list";
import { verifyBearer, type BearerVerification } from "../oauth/verify-bearer";
import { createMcpRouteHandler } from "../../app/mcp/handler";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

// --- fixtures -----------------------------------------------------------------------

// The frozen instant the agent/token fixtures are stamped at (the dispatch itself reads
// the system clock internally; no test asserts an exact wall-clock time).
const NOW = new Date("2026-06-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

// Dev-environment secrets at the exact lengths loadConfig requires (HMAC ≥ 32 bytes, dev
// KEK exactly 32). Test-only; the config is a pure function of this record so no test
// mutates the real process environment.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

const PUBLIC_BASE_URL = "https://warthog.example";
const REQUEST_HOST = "https://warthog.example";

function devConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: HMAC_KEY_B64,
    WARTHOG_DEV_KEK: DEV_KEK_B64,
    ...extra,
  } as NodeJS.ProcessEnv);
}

// The shape a parsed MCP response carries: either a JSON-RPC `result` (a tools/list set,
// or a CallToolResult) or a JSON-RPC `error`.
interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
    }>;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

// A POST to /mcp carrying the Streamable-HTTP headers a REAL MCP client sends — an Accept
// naming BOTH application/json and text/event-stream (or the server answers 406 Not
// Acceptable) and the protocol-version header. `bearer` adds an Authorization header for
// the route-composed end-to-end test; no Origin header is sent (the non-browser agent
// case). `body` is sent verbatim when a string.
function mcpPost(body: unknown, opts: { bearer?: string } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new Request(`${REQUEST_HOST}/mcp`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// A JSON-RPC tools/call envelope.
function callBody(name: string, args: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

const LIST_BODY = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

// Read an MCP response body: the stateless transport answers over SSE
// (`event: message\ndata: {json}`) on success and plain JSON on a transport-level refusal
// (e.g. a 406). Return the parsed JSON-RPC message either way (the LAST data frame on SSE).
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

// The text of a CallToolResult's content blocks joined (the plain reason / serialized
// result the dispatch surfaces).
function contentText(result: JsonRpcResponse["result"]): string {
  return (result?.content ?? []).map((block) => block.text ?? "").join(" ");
}

// SHA-256 hex — how a bearer is addressed in the OAuth store (never the raw value).
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// A seeded connection: a person (with a wrapped DEK), the agent row the bearer's
// connection id resolves to, and the connection's permission grants. Returns the raw DEK
// (to decrypt the person's stored data in assertions) and the ids the dispatch is driven
// with. `grants` overrides the defaults (card access on with a budget, high-tier OFF,
// memory on) field-by-field.
async function seedConnection(
  db: Db,
  config: Config,
  grants: Partial<PermissionGrants> = {},
): Promise<{ userId: string; connectionId: string; agentId: string; dek: Uint8Array }> {
  // The person's DEK is wrapped under the SAME local KEK the composition root derives from
  // config.devKek, so the dispatch's KeyWrapper unwraps exactly what we seed.
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `person-${randomUUID()}@warthog.com.au`, wrappedDek });

  // The bearer's connection id is the OAuth connection the agent IS (agents.connection_id).
  const connectionId = randomUUID();
  const agent = await createAgent(
    db,
    { userId: user.id, connectionId, displayName: "Claude", platform: "claude" },
    fixedClock(NOW),
  );

  await upsertPermissions(db, {
    userId: user.id,
    connectionId,
    grantedConnectors: [],
    readTools: true,
    changeTools: "allow",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: true,
    cardBudget: { amount: 1000, currency: "AUD", period: "month" },
    skillsScope: [],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...grants,
  });

  return { userId: user.id, connectionId, agentId: agent.id, dek };
}

// ===================================================================================
// AC1 — tools/list over the composed dispatch returns the core tools with input schemas.
// ===================================================================================

test("AC1: tools/list returns the registry's core tools, each with an input schema", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    const res = await dispatch(connectionId, mcpPost(LIST_BODY));
    assert.equal(res.status, 200, "an authenticated tools/list is served (200)");

    const rpc = await readRpc(res);
    const tools = rpc.result?.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, `tools/list must return a non-empty tool set, got: ${JSON.stringify(rpc)}`);

    const byName = new Map(tools!.map((tool) => [tool.name, tool]));
    const expected = [
      "get_context",
      "remember",
      "search_memory",
      "request_card",
      "request_identity_detail",
      "check_approval",
      "collect_release",
      "list_tasks",
    ];
    for (const name of expected) {
      const tool = byName.get(name);
      assert.ok(tool, `tools/list must include the core tool ${name}`);
      assert.equal(tool!.inputSchema?.type, "object", `${name} must advertise an object input schema`);
      assert.ok(
        tool!.inputSchema?.properties && "reason" in tool!.inputSchema.properties,
        `${name}'s input schema must expose the universal optional reason (design §6.2)`,
      );
    }
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Review fix D1 — tools/list publishes each tool's REAL input schema (the fields its body
// validates, with the required ones marked) and a plain-English description, so an agent
// can discover what to send instead of seeing only `reason` and the bare tool name.
// ===================================================================================

// The fields each tool body REQUIRES (and the optional ones it also accepts), taken from
// the body's own zod schema — so the advertised schema and what the body validates can
// never drift apart again.
function requiredKeys(schema: z.ZodObject): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
    .map(([key]) => key)
    .sort();
}

const BODY_SCHEMAS: Record<string, z.ZodObject> = {
  remember: rememberSchema,
  search_memory: searchMemorySchema,
  get_skill: getSkillSchema,
  check_approval: checkApprovalSchema,
  collect_release: collectReleaseSchema,
  list_tasks: listTasksSchema,
  create_task: createTaskSchema,
  update_task: updateTaskSchema,
  complete_task: completeTaskSchema,
  list_records: listRecordsSchema,
  save_record: saveRecordSchema,
  update_record: updateRecordSchema,
  log_activity: logActivitySchema,
};

test("D1: tools/list advertises each tool's real required fields and a plain description", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    const rpc = await readRpc(await dispatch(connectionId, mcpPost(LIST_BODY)));
    const tools = rpc.result?.tools ?? [];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // Every tool says what it does in words, not just its own name.
    for (const tool of tools) {
      const description = tool.description ?? "";
      assert.ok(description.trim().length > 20, `${tool.name} must carry a plain-English description`);
      assert.notEqual(description, tool.name, `${tool.name}'s description must not be just its name`);
    }

    // The fields the agents most need to discover are advertised as required.
    const required = (name: string): string[] => [...(byName.get(name)?.inputSchema?.required ?? [])].sort();
    assert.ok(required("remember").includes("content"), "remember requires content");
    assert.ok(required("check_approval").includes("approval_id"), "check_approval requires approval_id");
    assert.ok(
      "wait_seconds" in (byName.get("check_approval")?.inputSchema?.properties ?? {}),
      "check_approval lists wait_seconds",
    );
    assert.ok(required("get_skill").includes("title"), "get_skill requires title");
    assert.ok(required("create_task").includes("title"), "create_task requires title");
    assert.ok(required("update_task").includes("id"), "update_task requires id");
    assert.ok(required("complete_task").includes("id"), "complete_task requires id");
    assert.deepEqual(required("save_record"), ["fields", "kind"], "save_record requires kind and fields");
    assert.deepEqual(required("update_record"), ["fields", "id"], "update_record requires id and fields");
    assert.deepEqual(required("request_card"), ["amount", "currency", "merchant"], "request_card requires its card fields");

    // Table-driven: each advertised schema matches the body schema it is routed to.
    for (const [name, schema] of Object.entries(BODY_SCHEMAS)) {
      const advertised = byName.get(name);
      assert.ok(advertised, `tools/list must include ${name}`);
      assert.deepEqual(required(name), requiredKeys(schema), `${name}'s advertised required fields match its body`);
      for (const key of Object.keys(schema.shape)) {
        assert.ok(key in (advertised!.inputSchema?.properties ?? {}), `${name} must advertise its ${key} field`);
      }
    }
  } finally {
    await db.close();
  }
});

test("D1: a tools/call missing a required field is refused with a message naming the field", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    const rpc = await readRpc(await dispatch(connectionId, mcpPost(callBody("remember", {}))));
    assert.equal(rpc.result?.isError, true, "a remember with no content is an error");
    assert.match(contentText(rpc.result), /content/, "the refusal names the missing field");
    assert.equal((await listMemoriesForUser(db, userId, dek)).length, 0, "nothing is saved");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — tools/call get_context returns the allowed context AND Warthog records it;
//       tools/call remember stores a memory the person then sees on /memory.
// ===================================================================================

test("AC2: tools/call get_context returns a result (not an error) and records a warthog activity entry", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, agentId, dek } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    const res = await dispatch(connectionId, mcpPost(callBody("get_context", {})));
    assert.equal(res.status, 200);

    const rpc = await readRpc(res);
    assert.ok(rpc.result, `get_context must return a tool result, got: ${JSON.stringify(rpc)}`);
    assert.notEqual(rpc.result!.isError, true, "an allowed read returns a result, never isError");
    assert.ok(
      Array.isArray(rpc.result!.content) && rpc.result!.content.length > 0,
      "the allowed context is returned as tool-result content",
    );

    // Warthog writes the record itself (principle 14): the person sees it on their
    // Activity page (the same list-all read), scoped to this connection's agent.
    const entries = await listActivity(db, userId, { agentId }, dek);
    const recorded = entries.find((entry) => entry.tool === "get_context");
    assert.ok(recorded, "an activity entry for the get_context call was recorded for this connection");
    assert.equal(recorded!.source, "warthog", "Warthog records it itself (source=warthog), not the agent");
  } finally {
    await db.close();
  }
});

test("AC2: tools/call remember stores a memory the person then sees via the /memory read", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    const marker = `remember-${randomUUID()}`;
    const res = await dispatch(connectionId, mcpPost(callBody("remember", { content: marker })));
    const rpc = await readRpc(res);
    assert.notEqual(rpc.result?.isError, true, `an allowed remember is not an error, got: ${JSON.stringify(rpc)}`);

    // The /memory page reads the person's memories through listMemoriesForUser.
    const memories = await listMemoriesForUser(db, userId, dek);
    assert.ok(
      memories.some((memory) => memory.content === marker),
      "the remembered memory is visible to the person on /memory",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3 — tools/call request_card creates a pending approval (visible in the inbox) and
//       returns pending_approval with its approval_id + expires_at, releasing nothing;
//       a denied request maps to isError with a plain reason.
// ===================================================================================

test("AC3: tools/call request_card returns pending_approval (structured) and creates a pending inbox approval, releasing nothing", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config); // card access on, budget set
    const dispatch = createMcpDispatch({ db, config });

    const res = await dispatch(
      connectionId,
      mcpPost(callBody("request_card", { amount: 50, currency: "AUD", merchant: "Test Shop" })),
    );
    const rpc = await readRpc(res);
    const result = rpc.result;
    assert.ok(result, `request_card must return a tool result, got: ${JSON.stringify(rpc)}`);
    assert.notEqual(result!.isError, true, "a card request that needs approval is not an error");

    // The ask outcome is carried as STRUCTURED content with the approval id and expiry.
    const structured = result!.structuredContent;
    assert.ok(structured, "the pending_approval outcome is carried as structured content");
    assert.equal(structured!.status, "pending_approval", "the agent is told the request is pending approval");
    assert.equal(typeof structured!.approval_id, "string", "the structured content carries the approval_id");
    const expiresAt = structured!.expires_at as string;
    assert.ok(expiresAt, "the structured content carries expires_at");
    assert.ok(!Number.isNaN(new Date(expiresAt).getTime()), "expires_at is a valid instant");

    // Many MCP clients hand the model only the text content, so the text carries the same
    // structured result as JSON (MCP: a tool returning structured content SHOULD also return
    // it serialised in a text block) — otherwise the agent never sees the approval_id it
    // needs for check_approval.
    const text = result!.content?.[0]?.text ?? "";
    const fromText = JSON.parse(text) as Record<string, unknown>;
    assert.equal(fromText.approval_id, structured!.approval_id, "the text carries the approval_id");
    assert.equal(fromText.status, "pending_approval");
    assert.match(String(fromText.next ?? ""), /check_approval/, "and tells the agent what to call next");

    // The approval is visible in the person's inbox, still PENDING — nothing released.
    const pending = await listPendingForUser(db, userId, dek);
    const approval = pending.find((entry) => entry.id === structured!.approval_id);
    assert.ok(approval, "the created approval is visible in the person's inbox (pending list)");
    assert.equal(approval!.status, "pending", "the request is held pending — nothing is released");
  } finally {
    await db.close();
  }
});

test("AC3: a denied tools/call (high-tier access off) maps to isError with a plain reason and holds nothing", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    // high-tier OFF (the default) → request_identity_detail is denied at the policy gate.
    const { userId, connectionId, dek } = await seedConnection(db, config, { highTierAccess: false });
    const dispatch = createMcpDispatch({ db, config });

    const res = await dispatch(
      connectionId,
      mcpPost(callBody("request_identity_detail", { field: "passport", purpose: "Check in for a flight" })),
    );
    const rpc = await readRpc(res);
    assert.equal(rpc.result?.isError, true, "a denied request is surfaced as an MCP error (isError)");
    assert.match(contentText(rpc.result), /high-tier/, "refused by the policy gate, not by input validation");
    assert.ok(contentText(rpc.result).trim().length > 0, "the error carries a plain reason");

    const pending = await listPendingForUser(db, userId, dek);
    assert.equal(pending.length, 0, "a denied request holds nothing — no pending approval is created");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Review fix D2 — the composed pipeline is wired to the approval notifier (a push to
// every registered device plus the scheduled SMS/email fallback) and the request-metrics
// recorder, so an approval created over MCP actually reaches the person.
// ===================================================================================

// Register one push device for the person and return its (unique) endpoint.
async function registerDevice(db: Db, userId: string, dek: Uint8Array): Promise<string> {
  const endpoint = `https://push.example/${randomUUID()}`;
  await registerSubscription(
    db,
    { userId, endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } },
    dek,
    fixedClock(NOW),
  );
  return endpoint;
}

// The approval.fallback job rows scheduled for one approval.
async function fallbackJobsFor(db: Db, approvalId: string): Promise<Array<{ runAt: Date }>> {
  const rows = await db.query(
    "SELECT run_at FROM jobs WHERE type = $1 AND payload->>'approvalId' = $2",
    [FALLBACK_JOB_TYPE, approvalId],
  );
  return rows.rows.map((row) => ({ runAt: new Date(row.run_at as string) }));
}

test("D2: a card request over MCP pushes to the person's device and schedules the fallback", async () => {
  const db = await freshDb();
  try {
    const config = devConfig({ WARTHOG_DEV_TOOLS: "1" });
    const { userId, connectionId, dek } = await seedConnection(db, config);
    const endpoint = await registerDevice(db, userId, dek);
    const dispatch = createMcpDispatch({ db, config });

    const rpc = await readRpc(
      await dispatch(connectionId, mcpPost(callBody("request_card", { amount: 20, currency: "AUD", merchant: "Shop" }))),
    );
    const approvalId = rpc.result?.structuredContent?.approval_id as string;
    assert.equal(typeof approvalId, "string", `request_card is pending approval, got: ${JSON.stringify(rpc)}`);

    // One fallback job, due at the approval's own created_at + the default 2 minutes.
    const created = await db.query("SELECT created_at FROM approvals WHERE id = $1", [approvalId]);
    const createdAt = new Date(created.rows[0]!.created_at as string);
    const jobs = await fallbackJobsFor(db, approvalId);
    assert.equal(jobs.length, 1, "exactly one approval.fallback job is scheduled");
    assert.equal(jobs[0]!.runAt.getTime(), createdAt.getTime() + 2 * 60_000, "due 2 minutes after creation");

    // The dev outbox received the push for this device, carrying the approval id only.
    const pushes = outbox.list().filter((message) => message.channel === "push" && message.recipient === endpoint);
    assert.equal(pushes.length, 1, "one push is sent to the registered device");
    assert.ok(`${pushes[0]!.body} ${pushes[0]!.link ?? ""}`.includes(approvalId), "the push names the approval");
    assert.ok(!`${pushes[0]!.body} ${pushes[0]!.link ?? ""}`.includes("Shop"), "the push carries no request detail");
  } finally {
    await db.close();
  }
});

test("D2: a failed push does not fail the request: still pending_approval, fallback still scheduled", async () => {
  const db = await freshDb();
  try {
    // Dev tools off and no VAPID keys: the real Web Push sender refuses every send.
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config);
    await registerDevice(db, userId, dek);
    const dispatch = createMcpDispatch({ db, config });

    const rpc = await readRpc(
      await dispatch(connectionId, mcpPost(callBody("request_card", { amount: 20, currency: "AUD", merchant: "Shop" }))),
    );
    assert.notEqual(rpc.result?.isError, true, `the request is not an error, got: ${JSON.stringify(rpc)}`);
    assert.equal(rpc.result?.structuredContent?.status, "pending_approval");
    const approvalId = rpc.result!.structuredContent!.approval_id as string;
    assert.equal((await fallbackJobsFor(db, approvalId)).length, 1, "the fallback is still scheduled");
  } finally {
    await db.close();
  }
});

test("D2: every tools/call records the request count and latency metrics", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    await readRpc(await dispatch(connectionId, mcpPost(callBody("get_context", {}))));

    const rows = await db.query("SELECT name, outcome FROM metric_events ORDER BY name");
    const names = rows.rows.map((row) => String(row.name));
    assert.ok(names.includes("agent.request"), "a request-count metric is recorded");
    assert.ok(names.includes("agent.request.latency_ms"), "a request-latency metric is recorded");
    assert.ok(rows.rows.every((row) => row.outcome === "executed"), "tagged with the call's outcome");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Review fix D3 — card requests through the composed pipeline are checked against the
// household budget and the member's limit (in the household currency), and a foreign
// amount is converted with the stored daily reference rate.
// ===================================================================================

async function requestCard(
  dispatch: ReturnType<typeof createMcpDispatch>,
  connectionId: string,
  amount: number,
  currency = "AUD",
): Promise<JsonRpcResponse["result"]> {
  const rpc = await readRpc(
    await dispatch(connectionId, mcpPost(callBody("request_card", { amount, currency, merchant: "Shop" }))),
  );
  return rpc.result;
}

test("D3: a card request over the member's household limit is refused, holding nothing", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config);
    const household = await createHousehold(db, { ownerId: userId, currency: "AUD", monthlyBudget: 500 });
    await setMemberLimit(db, { householdId: household.id, actorId: userId, userId, monthlyLimit: 200 });
    const dispatch = createMcpDispatch({ db, config });

    const result = await requestCard(dispatch, connectionId, 300);
    assert.equal(result?.isError, true, "an over-limit request is refused");
    assert.match(contentText(result), /household spending limit/);
    assert.equal((await listPendingForUser(db, userId, dek)).length, 0, "no approval is created");
  } finally {
    await db.close();
  }
});

test("D3: a card request over the shared household budget is refused; unset legs impose no cap", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId } = await seedConnection(db, config);
    const household = await createHousehold(db, { ownerId: userId, currency: "AUD", monthlyBudget: 500 });
    const dispatch = createMcpDispatch({ db, config });

    const over = await requestCard(dispatch, connectionId, 900);
    assert.equal(over?.isError, true, "an over-budget request is refused");
    assert.match(contentText(over), /shared budget/);

    // No member limit and no shared budget: nothing caps the request (it asks the person).
    await setHouseholdBudget(db, { householdId: household.id, actorId: userId, monthlyBudget: null });
    const asked = await requestCard(dispatch, connectionId, 900);
    assert.equal(asked?.structuredContent?.status, "pending_approval", `got: ${JSON.stringify(asked)}`);
  } finally {
    await db.close();
  }
});

test("D3: a foreign-currency card request is converted with the stored daily rate", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seedConnection(db, config); // A$1000/month budget
    const dispatch = createMcpDispatch({ db, config });

    // No USD→AUD rate stored yet: refused with a plain reason rather than guessed.
    const noRate = await requestCard(dispatch, connectionId, 100, "USD");
    assert.equal(noRate?.isError, true);
    assert.match(contentText(noRate), /reference rate/i);

    // With a rate on file, 100 USD (150 AUD) is within budget and asks the person.
    await upsertRate(db, { rateDate: "2020-01-01", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });
    const converted = await requestCard(dispatch, connectionId, 100, "USD");
    assert.equal(converted?.structuredContent?.status, "pending_approval", `got: ${JSON.stringify(converted)}`);

    // 800 USD is 1200 AUD — over the A$1000 budget once converted.
    const over = await requestCard(dispatch, connectionId, 800, "USD");
    assert.match(contentText(over), /card budget/);
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Review fix D4 — once a high-tier value has been released, a later tool call that echoes
// it (in any surface form, including one written with spaces or dashes) is stored in the
// activity record as `[released value]`, never the value.
// ===================================================================================

test("D4: a released value echoed in a later tool call is redacted from the activity record", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, agentId, dek } = await seedConnection(db, config);
    // Released just now (the dispatch reads the system clock; a fingerprint lives 90 days).
    for (const value of ["PA1234567", "AB-123-456"]) {
      await storeFingerprint(db, { userId, fingerprint: fingerprint(dek, value) }, systemClock);
    }
    const dispatch = createMcpDispatch({ db, config });

    const content = "My passport is PA1234567, licence ab 123 456";
    const rpc = await readRpc(await dispatch(connectionId, mcpPost(callBody("remember", { content }))));
    assert.notEqual(rpc.result?.isError, true, `remember succeeds, got: ${JSON.stringify(rpc)}`);

    const entries = await listActivity(db, userId, { agentId }, dek);
    const entry = entries.find((candidate) => candidate.tool === "remember");
    assert.ok(entry, "the remember call was recorded");
    const stored = JSON.stringify(entry!.payload);
    assert.ok(!stored.includes("PA1234567"), "the released passport number is not stored");
    assert.ok(!/ab 123 456/i.test(stored), "the released licence is not stored in another surface form");
    assert.equal(stored.split("[released value]").length - 1, 2, "both values are replaced by the marker");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Review fix D5 — a connection's permitted connector tools are served over MCP
// (namespaced <connector>__<tool>) and routed through the pipeline to the connector
// engine: the general request tool for a service without curated tools, the curated
// tools (with their read/change and sends-a-message declarations) for Google/Microsoft.
// ===================================================================================

// A recording upstream: every request the connector engine sends, answered with a fixed body.
function recordingFetch(): { fetch: typeof fetch; sent: Array<{ url: string; init: RequestInit }> } {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    return new Response('{"upstream":"ok"}', { status: 200 });
  }) as typeof fetch;
  return { fetch: fake, sent };
}

async function connectService(
  db: Db,
  userId: string,
  dek: Uint8Array,
  connectorId: string,
  credentials: Record<string, unknown>,
): Promise<void> {
  await createConnection(db, { userId, connectorId, accountLabel: "me", credentials }, dek, fixedClock(NOW));
}

test("D5: tools/list serves the granted connector's request tool and nothing for an ungranted one", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config, { grantedConnectors: ["amadeus"] });
    await connectService(db, userId, dek, "amadeus", { api_key: "sk-test" });
    await connectService(db, userId, dek, "alpaca", { api_key: "sk-other" });
    const dispatch = createMcpDispatch({ db, config, fetch: recordingFetch().fetch });

    const tools = (await readRpc(await dispatch(connectionId, mcpPost(LIST_BODY)))).result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("amadeus__request"), "the granted, connected service's request tool is served");
    assert.ok(!names.some((name) => name.startsWith("alpaca__")), "an ungranted service contributes no tools");
    const request = tools.find((tool) => tool.name === "amadeus__request");
    assert.deepEqual([...(request?.inputSchema?.required ?? [])].sort(), ["method", "path"]);
  } finally {
    await db.close();
  }
});

test("D5: a GET through the request tool reaches the catalogue host with the stored credential and is recorded", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, agentId, dek } = await seedConnection(db, config, { grantedConnectors: ["amadeus"] });
    await connectService(db, userId, dek, "amadeus", { api_key: "sk-test" });
    const upstream = recordingFetch();
    const dispatch = createMcpDispatch({ db, config, fetch: upstream.fetch });

    const rpc = await readRpc(
      await dispatch(connectionId, mcpPost(callBody("amadeus__request", { method: "GET", path: "/v1/flights" }))),
    );
    assert.notEqual(rpc.result?.isError, true, `the read is executed, got: ${JSON.stringify(rpc)}`);
    assert.match(contentText(rpc.result), /upstream/, "the upstream body is returned to the agent");

    assert.equal(upstream.sent.length, 1);
    assert.equal(upstream.sent[0]!.url, "https://api.amadeus.com/v1/flights", "only the catalogue host is called");
    const headers = new Headers(upstream.sent[0]!.init.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-test", "the stored credential is presented");

    const entries = await listActivity(db, userId, { agentId }, dek);
    const entry = entries.find((candidate) => candidate.tool === "amadeus__request");
    assert.ok(entry, "the connector call is recorded");
    assert.equal(entry!.connectorId, "amadeus");
    assert.ok(!JSON.stringify(entry!.payload).includes("sk-test"), "the credential never reaches the record");
  } finally {
    await db.close();
  }
});

test("D5: a change through the request tool follows the ask-first setting and sends nothing", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config, {
      grantedConnectors: ["amadeus"],
      changeTools: "ask_first",
    });
    await connectService(db, userId, dek, "amadeus", { api_key: "sk-test" });
    const upstream = recordingFetch();
    const dispatch = createMcpDispatch({ db, config, fetch: upstream.fetch });

    const rpc = await readRpc(
      await dispatch(connectionId, mcpPost(callBody("amadeus__request", { method: "POST", path: "/v1/orders", body: "{}" }))),
    );
    assert.equal(rpc.result?.structuredContent?.status, "pending_approval", `got: ${JSON.stringify(rpc)}`);
    assert.equal(upstream.sent.length, 0, "nothing is sent before the person approves");
  } finally {
    await db.close();
  }
});

test("D5: curated Gmail tools are served (no general request tool) and message rules apply to them", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config, { grantedConnectors: ["google-gmail"] });
    await connectService(db, userId, dek, "google-gmail", { access_token: "ya29-test" });
    await createRule(
      db,
      {
        userId,
        kind: "ask_first",
        scope: { type: "any_agent" },
        action: { type: "send_message", channel: "email" },
        condition: { type: "recipient_in_domain", domain: "example.com" },
      },
      dek,
    );
    const upstream = recordingFetch();
    const dispatch = createMcpDispatch({ db, config, fetch: upstream.fetch });

    const names = ((await readRpc(await dispatch(connectionId, mcpPost(LIST_BODY)))).result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes("google-gmail__send") && names.includes("google-gmail__search"));
    assert.ok(!names.includes("google-gmail__request"), "a curated service is not reachable around its curated tools");

    const mime = (to: string) => JSON.stringify({ raw: Buffer.from(`To: ${to}\r\nSubject: hi\r\n\r\nhello`).toString("base64url") });
    const held = await readRpc(
      await dispatch(connectionId, mcpPost(callBody("google-gmail__send", { body: mime("Bob <bob@example.com>") }))),
    );
    assert.equal(held.result?.structuredContent?.status, "pending_approval", "a send to the ruled domain asks first");
    assert.equal(upstream.sent.length, 0);

    const sent = await readRpc(await dispatch(connectionId, mcpPost(callBody("google-gmail__send", { body: mime("bob@other.org") }))));
    assert.notEqual(sent.result?.isError, true, `a send elsewhere goes through, got: ${JSON.stringify(sent)}`);
    assert.equal(upstream.sent.length, 1);
    assert.equal(upstream.sent[0]!.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  } finally {
    await db.close();
  }
});

test("D5: a connector revoked from the agent disappears and a direct call is refused", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config, { grantedConnectors: [] });
    await connectService(db, userId, dek, "amadeus", { api_key: "sk-test" });
    const upstream = recordingFetch();
    const dispatch = createMcpDispatch({ db, config, fetch: upstream.fetch });

    const names = ((await readRpc(await dispatch(connectionId, mcpPost(LIST_BODY)))).result?.tools ?? []).map((t) => t.name);
    assert.ok(!names.includes("amadeus__request"));
    const rpc = await readRpc(
      await dispatch(connectionId, mcpPost(callBody("amadeus__request", { method: "GET", path: "/v1/x" }))),
    );
    assert.equal(rpc.result?.isError ?? Boolean(rpc.error), true, "the call is refused");
    assert.equal(upstream.sent.length, 0);
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Review fix D6 — request_identity_detail names WHICH detail it wants and WHY, and both
// are stored on the approval the person reviews in their inbox.
// ===================================================================================

test("D6: request_identity_detail requires a field and a purpose and stores both on the approval", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config, { highTierAccess: true });
    const dispatch = createMcpDispatch({ db, config });

    const missing = await readRpc(await dispatch(connectionId, mcpPost(callBody("request_identity_detail", {}))));
    assert.equal(missing.result?.isError, true, "a request with no field or purpose is refused");
    assert.match(contentText(missing.result), /field/);
    assert.match(contentText(missing.result), /purpose/);

    const rpc = await readRpc(
      await dispatch(
        connectionId,
        mcpPost(callBody("request_identity_detail", { field: "passport", purpose: "Check in for a flight" })),
      ),
    );
    const approvalId = rpc.result?.structuredContent?.approval_id;
    assert.equal(typeof approvalId, "string", `the request is pending approval, got: ${JSON.stringify(rpc)}`);
    const approval = (await listPendingForUser(db, userId, dek)).find((entry) => entry.id === approvalId);
    assert.equal(approval?.detail?.field, "passport", "the approval shows which detail is wanted");
    assert.equal(approval?.detail?.purpose, "Check in for a flight", "the approval shows the stated purpose");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Review fix D7 — get_context hands the agent the brief's contents in one call (the
// low-tier profile when allowed, preferences, the skill index with Warthog's house skill,
// the rules as sentences, the shared memory it may read and its open tasks) and never
// an internal user or connection id.
// ===================================================================================

async function getContextOf(dispatch: ReturnType<typeof createMcpDispatch>, connectionId: string): Promise<{ text: string; json: Record<string, unknown> }> {
  const rpc = await readRpc(await dispatch(connectionId, mcpPost(callBody("get_context", {}))));
  assert.notEqual(rpc.result?.isError, true, `get_context succeeds, got: ${JSON.stringify(rpc)}`);
  const text = contentText(rpc.result);
  return { text, json: JSON.parse(text) as Record<string, unknown> };
}

test("D7: get_context returns the profile, skills, rules, memory and open tasks without internal ids", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, agentId, dek } = await seedConnection(db, config, { identityAccess: true, memoryRead: true });
    await saveIdentityField(db, { userId, kind: "name", value: "Ada Lovelace" }, dek);
    await createMemory(db, { userId, content: "Prefers window seats", sourceAgentId: null, scope: "shared" }, dek, fixedClock(NOW));
    await createTask(db, { userId, title: "Renew passport", assignee: "any", createdBy: { kind: "person" } }, dek);
    await createRule(
      db,
      { userId, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "card_request" } },
      dek,
    );
    const dispatch = createMcpDispatch({ db, config });

    const { text, json } = await getContextOf(dispatch, connectionId);
    assert.ok(!text.includes(userId), "the person's internal id is not returned");
    assert.ok(!text.includes(connectionId), "the connection's internal id is not returned");
    assert.ok(!text.includes(agentId), "the agent's internal id is not returned");

    assert.match(text, /Ada Lovelace/, "the low-tier profile is included when identity access is on");
    const skills = json.skills as Array<{ title: string }>;
    assert.ok(skills.some((skill) => skill.title === "Using Warthog"), "Warthog's house skill is indexed");
    assert.deepEqual(json.rules, ["Ask me before any agent requests a card"], "rules read back as sentences");
    assert.match(JSON.stringify(json.memory), /Prefers window seats/, "the shared memory it may read is included");
    assert.match(JSON.stringify(json.tasks), /Renew passport/, "its open tasks are included");
  } finally {
    await db.close();
  }
});

test("D7: get_context leaves out the profile and memory the agent is not granted", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config, { identityAccess: false, memoryRead: false });
    await saveIdentityField(db, { userId, kind: "name", value: "Ada Lovelace" }, dek);
    await createMemory(db, { userId, content: "Prefers window seats", sourceAgentId: null, scope: "shared" }, dek, fixedClock(NOW));
    const dispatch = createMcpDispatch({ db, config });

    const { text } = await getContextOf(dispatch, connectionId);
    assert.ok(!text.includes("Ada Lovelace"), "no profile without identity access");
    assert.ok(!text.includes("Prefers window seats"), "no memory without memory access");
  } finally {
    await db.close();
  }
});

// Review fix (unverified finding, confirmed): an internal failure behind a tool call is
// logged for operators — a fixed event, the tool and the error's class, never its message
// (which could carry personal content) — while the agent sees only the plain reason.
test("an internal tool failure is logged without its message and reported plainly to the agent", async (t) => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config, { grantedConnectors: ["amadeus"] });
    await connectService(db, userId, dek, "amadeus", { api_key: "sk-test" });
    const failing = (async () => {
      throw new TypeError("socket hang up for ada@example.com");
    }) as typeof fetch;
    const dispatch = createMcpDispatch({ db, config, fetch: failing });
    const logged = t.mock.method(console, "error", () => undefined);

    const rpc = await readRpc(
      await dispatch(connectionId, mcpPost(callBody("amadeus__request", { method: "GET", path: "/v1/x" }))),
    );
    assert.equal(rpc.result?.isError, true);
    assert.equal(contentText(rpc.result), "The tool call could not be completed.");

    const lines = logged.mock.calls.map((call) => call.arguments.map(String).join(" "));
    const line = lines.find((text) => text.includes("tool_call_failed"));
    assert.ok(line, `the failure is logged, got: ${JSON.stringify(lines)}`);
    assert.match(line!, /amadeus__request/);
    assert.match(line!, /TypeError/);
    assert.ok(!line!.includes("ada@example.com"), "the error message never reaches the log");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC4 — the connection comes ONLY from the verified bearer; a body naming another
//       connection / user id is ignored.
// ===================================================================================

test("AC4: a body that names another connection/user id is ignored — the call is scoped to the verified connection", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, agentId, dek } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    // The tool arguments carry spoofed connection / user ids — a client trying to redirect
    // the member scope. The dispatch must take the identity from the verified bearer only.
    const marker = `scoped-${randomUUID()}`;
    const res = await dispatch(
      connectionId,
      mcpPost(callBody("remember", { content: marker, connectionId: "SPOOF-CONNECTION", userId: "SPOOF-USER" })),
    );
    const rpc = await readRpc(res);
    assert.notEqual(rpc.result?.isError, true, "the call runs under the verified connection, not the spoofed body ids");

    // The memory is saved for the VERIFIED person and sourced to the VERIFIED agent — the
    // spoofed ids (which belong to no one) had no effect.
    const memories = await listMemoriesForUser(db, userId, dek);
    assert.ok(
      memories.some((memory) => memory.content === marker && memory.sourceAgentId === agentId),
      "the memory is scoped to the verified connection's user and agent, never a client-supplied id",
    );
  } finally {
    await db.close();
  }
});

test("AC4: composed into the /mcp route, an unauthenticated tools/list is 401 and a valid bearer lists the tools", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seedConnection(db, config);

    // The REAL route composed with the REAL bearer verification and the REAL MCP dispatch.
    const handler = createMcpRouteHandler({
      verify: (request: Request): Promise<BearerVerification> =>
        verifyBearer(request, { db, config, clock: fixedClock(NOW) }),
      dispatch: createMcpDispatch({ db, config }),
      config,
    });

    // No credential → 401, before any tool dispatch.
    const unauth = await handler.POST(mcpPost(LIST_BODY));
    assert.equal(unauth.status, 401, "an unauthenticated /mcp call is still 401");

    // A valid access token bound to the connection → the tools are served.
    const raw = `access-${randomUUID()}`;
    await createToken(db, {
      tokenHash: sha256Hex(raw),
      connectionId,
      kind: "access",
      expiresAt: new Date(NOW.getTime() + HOUR_MS),
    });

    const ok = await handler.POST(mcpPost(LIST_BODY, { bearer: raw }));
    assert.equal(ok.status, 200, "a valid bearer reaches the composed dispatch");
    const rpc = await readRpc(ok);
    assert.ok(
      (rpc.result?.tools ?? []).some((tool) => tool.name === "get_context"),
      "the composed dispatch serves the registry's tools through the route",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC6 — [validate-and-parameterize-input] a malformed tool input is rejected (isError),
//       never a silent success; a SQL-injection probe is stored as bound DATA and the
//       query is left intact.
// ===================================================================================

test("AC6: a malformed tool input is rejected as an error, never a silent save", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    // remember requires a non-empty string `content`; a number is malformed.
    const res = await dispatch(connectionId, mcpPost(callBody("remember", { content: 123 })));
    const rpc = await readRpc(res);
    assert.equal(rpc.result?.isError, true, "a malformed tool input is surfaced as an error, never a successful save");

    const memories = await listMemoriesForUser(db, userId, dek);
    assert.equal(memories.length, 0, "a rejected remember stores no memory");
  } finally {
    await db.close();
  }
});

test("AC6: a SQL-injection probe in an input field is stored as bound data, leaving the query intact", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config);
    const dispatch = createMcpDispatch({ db, config });

    const probe = "'; DROP TABLE memories; --";
    const res = await dispatch(connectionId, mcpPost(callBody("remember", { content: probe })));
    const rpc = await readRpc(res);
    assert.notEqual(rpc.result?.isError, true, "the probe is accepted as ordinary data, not executed");

    // Stored verbatim as a BOUND value (parameter binding), exactly as entered.
    const afterProbe = await listMemoriesForUser(db, userId, dek);
    assert.ok(
      afterProbe.some((memory) => memory.content === probe),
      "the probe is stored verbatim (a bound value), exactly as entered",
    );

    // The memories table is intact — a second save still works, proving the probe altered
    // no query (it travelled as data, never as SQL).
    const res2 = await dispatch(connectionId, mcpPost(callBody("remember", { content: "after-the-probe" })));
    assert.notEqual((await readRpc(res2)).result?.isError, true, "a second save succeeds");
    const after = await listMemoriesForUser(db, userId, dek);
    assert.ok(
      after.some((memory) => memory.content === "after-the-probe"),
      "the memories table survives the probe (parameter binding, not string-built SQL)",
    );
  } finally {
    await db.close();
  }
});

test("an approved connector hold cannot switch to a different service account", async () => {
  const { createAgentExecutors } = await import("./compose");
  const { getConnectionPermissions } = await import("../db/agent-permissions");
  const { decide } = await import("../db/approvals");
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seedConnection(db, config, { grantedConnectors: ["amadeus"], changeTools: "ask_first" });
    const first = await createConnection(db, { userId, connectorId: "amadeus", accountLabel: "Personal", credentials: { api_key: "fixture-personal" } }, dek, systemClock);
    const second = await createConnection(db, { userId, connectorId: "amadeus", accountLabel: "Work", credentials: { api_key: "fixture-work" } }, dek, systemClock);
    const stored = (await getConnectionPermissions(db, userId, connectionId))!;
    await upsertPermissions(db, { ...stored, connectorAccounts: { amadeus: first.id } });
    const upstream = recordingFetch();
    const dispatch = createMcpDispatch({ db, config, fetch: upstream.fetch });
    const rpc = await readRpc(await dispatch(connectionId, mcpPost(callBody("amadeus__request", { method: "POST", path: "/v1/orders", body: "{}" }))));
    assert.equal(rpc.result?.structuredContent?.status, "pending_approval");
    const approvalId = String(rpc.result?.structuredContent?.approval_id);
    const approved = await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, systemClock);
    assert.equal(approved.detail.account, "Personal");
    await upsertPermissions(db, { ...stored, connectorAccounts: { amadeus: second.id } });
    const result = await createAgentExecutors({ db, config, fetch: upstream.fetch }).executeApprovedHold(userId, approvalId);
    assert.equal(result.status, "refused");
    assert.equal(upstream.sent.length, 0);
  } finally { await db.close(); }
});
