import { z } from "zod";
import { findToolsSchema } from "./tools/registry";
import { mayCollectReleasedField } from "../agents/resource-access";
import { createProviderRuntime } from "../connectors/provider-runtime";
// E07-S19 — the MCP composition root (design §6.1/§6.2; constitution 13/14/15; INV-102).
//
// `createMcpDispatch` is the one place the MCP endpoint's REAL dependencies are built from
// the two things a composition root is handed — `config` and the process `db`: the
// KeyWrapper (selected from config), the DB-backed activity recorder, the per-process rate
// limiter, the tool-body executor (which routes each executed call to its real tool body),
// and the pure policy pipeline (`handleAgentCall`). It returns the DISPATCH the `/mcp`
// route seam expects (`src/app/mcp/handler.ts`):
//
//   createMcpDispatch(deps): (connectionId, request) => Promise<Response>
//
// The dispatch drives a stateless `createMcpHandler` whose per-request `McpServer`
// REGISTERS every core tool the registry resolves for the VERIFIED connection (plus its
// permitted connector tools), each handler routing through `handleAgentCall` under the
// connection resolved ONLY from the verified bearer (the `authInfo.clientId` the dispatch
// is handed — NEVER a value in the request body), and maps the pipeline outcome to an MCP
// tool result:
//   • executed       → a normal result (content), not isError;
//   • pending_approval→ `pending_approval` with approval_id + expires_at as STRUCTURED
//                       content (and the same JSON as text), nothing released;
//   • refused        → isError with a plain reason.
//
// A SERVER module built purely from its two inputs: it reads no `process.env` directly
// (the KeyWrapper comes from the already-parsed `config`, INV-103) and every member-scoped
// read/write takes the user id from the resolved connection, never a client value. Each
// tool body VALIDATES its input at the boundary (zod → a 4xx `HttpError` before any db
// access, INV-102) and every store binds its values as parameters, so a SQL-shaped field
// travels as inert data and cannot alter a query.

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";

import type { Config } from "../config";
import type { Db } from "../db/index";
import { selectKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { createRedactingRecorder } from "./recorder";
import { toEntry } from "../activity/writer";
import { type UndoReversalJob, type UndoReversalResult } from "../activity/undo";
import { calendarReversalForEntry, successfulConnectorResult } from "../activity/calendar-reversal";
import { getRateLimiter } from "./rate-limit";
import { systemClock, type Clock } from "../seams/clock";
import { getUserById } from "../db/users";
import { getAgentByConnectionId, getAgentById } from "../db/agents";
import { getApproval } from "../db/approvals";
import { getConnectionPermissions } from "../db/agent-permissions";
import { listConnectionsForUser } from "../db/connections";
import { getProcessCatalogue, type CatalogueIndex } from "../connectors/catalogue";
import { connectorToolsetFor, createConnectorToolExecutor, selectConnectorAccount } from "../connectors/tool-routing";
import { HttpError } from "../http/validate";
import { createGuardedFetch } from "../http/guarded-fetch";
import { notifyApprovalCreated, type ApprovalPushSender } from "../notify/approval-notifier";
import { createWebPushSender } from "../notify/web-push";
import { outbox } from "../notify/outbox";
import { recordMetricEvent } from "../metrics/record";

import {
  createAgentCallPipeline,
  type AgentCall,
  type AgentCallResult,
  type AgentCallPipeline,
  type ApprovedHoldResult,
} from "./pipeline";
import { createToolRegistry, type ToolDefinition } from "./tools/registry";
import type { AgentConnection } from "./context";

import { createRememberTool, createSearchMemoryTool } from "./tools/memory";
import { createGetSkillTool } from "./tools/get-skill";
import { createGetContextTool } from "./tools/get-context";
import { createCheckApprovalTool } from "./tools/check-approval";
import { createCollectReleaseTool } from "./tools/collect-release";
import { createLogActivityTool } from "./tools/log-activity";
import {
  createListRecordsTool,
  createSaveRecordTool,
  createUpdateRecordTool,
} from "./tools/records";
import {
  createCompleteTaskTool,
  createCreateTaskTool,
  createListTasksTool,
  createUpdateTaskTool,
} from "./tools/tasks";
import { releaseStore } from "../crypto/release-store";

// The two inputs a composition root is handed (design §6.1 addendum): the process-wide
// migrated db and the parsed runtime config. Everything else is built from these here. The
// outbound fetch connector calls ride on (default: the SSRF-guarded fetch) and the
// connector catalogue (default: the process-wide index) may be supplied by a test.
export interface McpDispatchDeps {
  readonly db: Db;
  readonly config: Config;
  readonly fetch?: typeof fetch;
  readonly catalogue?: CatalogueIndex;
}

// The dispatch the `/mcp` route seam drives after the bearer is verified: the VERIFIED
// connection id (the session identity, never a body value) plus the original request.
export type McpDispatch = (connectionId: string, request: Request) => Promise<Response>;

// This resource requires the `warthog` scope (design §6.1/§6.2) — the same scope the route
// and bearer verification name.
const MCP_SCOPE = "warthog";

// The stateless MCP server's identity (design §6.2 — one handler per process).
const MCP_SERVER_NAME = "warthog";
const MCP_SERVER_VERSION = "0.1.0";

// A thrown tool call maps to a plain-English reason the agent sees; an internal failure is
// never surfaced verbatim (only the input-boundary's own fixed 4xx messages are safe).
const TOOL_FAILED_REASON = "The tool call could not be completed.";

// Register `tool` on `server`, routing the call through `tool.handle` under the already
// resolved `connection` (from the verified bearer). The advertised input schema is the
// tool body's REAL schema and the description says what the tool does, so tools/list
// tells an agent exactly which fields to send. The SDK validates the arguments against
// that schema first and refuses a bad call naming the field at fault (zod's issue path and
// message, never the input value); `tool.handle` and the body validate again (INV-102).
function registerTool(
  server: McpServer,
  tool: ToolDefinition,
  connection: AgentConnection | null,
): void {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    async (args: unknown) => {
      // The connection is the verified bearer's; a request that never resolved one cannot
      // be scoped to a person, so it is refused rather than run (never a silent success).
      if (!connection) {
        return errorResult("This agent is not connected.");
      }
      try {
        const outcome = await tool.handle(args, connection);
        return toToolResult(outcome);
      } catch (err) {
        // A boundary 4xx (malformed / oversized input, INV-102) carries its own fixed,
        // safe message. Any other failure is logged for operators (never its message) and
        // surfaced as a plain MCP error — never a silent success.
        if (err instanceof HttpError) return errorResult(err.message);
        logFailure("tool_call_failed", err, { tool: tool.name });
        return errorResult(TOOL_FAILED_REASON);
      }
    },
  );
}

// Map one pipeline outcome to an MCP CallToolResult (design §6.2).
function toToolResult(outcome: AgentCallResult): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  switch (outcome.status) {
    case "executed":
      // An allowed read/write returns its result as content — never isError.
      return { content: [{ type: "text", text: JSON.stringify(outcome.result ?? null) }] };
    case "pending_approval": {
      // The ask outcome is carried as STRUCTURED content with the approval id and expiry;
      // nothing is released (the pipeline held the call behind a pending approval). The text
      // block carries the same JSON: many MCP clients give the model only the text, and the
      // agent needs the approval_id for check_approval (MCP: structured content SHOULD also
      // be returned serialised in a text block).
      const structured = {
        status: "pending_approval",
        approval_id: outcome.approval_id,
        expires_at: outcome.expires_at.toISOString(),
        next: "The person has been asked. Call check_approval with this approval_id to wait for their decision.",
      };
      return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
    }
    case "refused":
      // A denied / refused call is an MCP error carrying the plain reason.
      return errorResult(outcome.reason);
  }
}

// A CallToolResult for a refusal / failure: a plain reason, isError.
function errorResult(reason: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: reason }], isError: true };
}

// The push channel approval notifications go out on, chosen by config like every other
// sender (`selectSenders`): with dev tooling on, the process-wide dev outbox records a push
// carrying only the approval's inbox link; otherwise the real VAPID Web Push sender over
// the SSRF-guarded fetch, which refuses loudly while the VAPID keys are unset — the
// notifier tolerates a failed push and its scheduled SMS/email fallback is the recovery.
function approvalPushSender(config: Config): ApprovalPushSender {
  if (config.devTools) {
    return {
      sendApprovalPush: (subscription, approvalId) =>
        outbox.sendPush({
          recipient: subscription.endpoint,
          body: "An agent is waiting for your approval.",
          link: `${config.publicBaseUrl}/inbox?approval=${encodeURIComponent(approvalId)}`,
        }),
    };
  }
  return createWebPushSender({ vapid: config.vapid, fetch: createGuardedFetch() });
}

// Log a failure on the MCP path for operators: a fixed event name, non-personal context
// (a tool name) and the error's class — never its message, which could carry personal
// content (design §4.3).
function logFailure(event: string, err: unknown, context: Record<string, string> = {}): void {
  console.error(
    "[warthog mcp]",
    JSON.stringify({ event, ...context, error: err instanceof Error ? err.name : "unknown" }),
  );
}

// A best-effort side effect of an agent call (the approval notifier, a metric write) that
// fails is logged and swallowed, so it can never turn a call that was already handled —
// an approval and its held request are written before the notifier runs — into an error
// for the agent.
function logSideEffectFailure(event: string, err: unknown): void {
  logFailure(event, err);
}

// Build the agent-call pipeline's REAL dependencies from the two composition-root inputs
// (config + the process db): the KeyWrapper selected from config, the DB-backed recorder,
// the per-process rate limiter, the tool-body executor and the pure pipeline. The ONE place
// the pipeline is assembled (constitution: one source of truth), shared by the MCP dispatch
// and the inbox/activity executors — so an approved hold and an undo reversal run through
// exactly the gate every live agent call passes.
function buildAgentPipeline(deps: McpDispatchDeps): AgentCallPipeline {
  const { db, config } = deps;

  // --- the pipeline's real dependencies, built from config + db ---------------

  // The KeyWrapper selected from config (local AES in dev/test, Key Vault in production);
  // it unwraps the person's DEK so personal content is encrypted/decrypted member-scoped.
  const keyWrapper: KeyWrapper = selectKeyWrapper({
    nodeEnv: config.nodeEnv,
    localKek: config.devKek,
  });
  const clock: Clock = systemClock;

  // The person's unwrapped DEK, resolved per user (member-scoped: the user id is the
  // session's, never a client value). Throws when the person has no row (never silently).
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("createMcpDispatch: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Warthog writes the record itself (principle 14): the DB-backed recorder redacts then
  // DEK-encrypts each entry before it is persisted, with the person's released-value
  // fingerprints loaded so an echoed high-tier value is stored as `[released value]`.
  const recorder = createRedactingRecorder({ db, clock, dekFor: dataKeyFor });
  const rateLimiter = getRateLimiter();

  // The connector engine an allowed connector call is carried out by: the person's live
  // connection, its credentials and the catalogue host only, over the SSRF-guarded fetch.
  const provider = createProviderRuntime({db,catalogue:deps.catalogue ?? getProcessCatalogue(config),clock,publicBaseUrl:config.publicBaseUrl,dekFor:dataKeyFor,fetch:deps.fetch});
  const executeConnectorTool = createConnectorToolExecutor({
    executeProvider:provider.execute,
    db,
    catalogue: deps.catalogue ?? getProcessCatalogue(config),
    fetch: deps.fetch ?? createGuardedFetch(),
    dekFor: dataKeyFor,
  });

  // --- the tool bodies the executor routes executed calls to ------------------

  // The pipeline is referenced LATE by the tool executor (check_approval runs an approved
  // hold through it), so it is declared here and assigned below; every tool call happens at
  // request time, after the assignment.
  let pipeline: AgentCallPipeline;

  const rememberTool = createRememberTool({ db, keyWrapper, clock });
  const searchMemoryTool = createSearchMemoryTool({ db, keyWrapper, clock });
  const getSkillTool = createGetSkillTool({ db, keyWrapper });
  const collectReleaseTool = createCollectReleaseTool({ releaseStore, canCollect: async (connection, approvalId) => {
    const approval = await getApproval(db, connection.userId, approvalId, await dataKeyFor(connection.userId));
    if (!approval || approval.agentId !== connection.agentId || approval.status !== "approved") return false;
    const grants = await getConnectionPermissions(db, connection.userId, connection.connectionId);
    const kind = (approval.detail as { request?: unknown }).request;
    return kind === "card" ? grants?.cardAccess === true : kind === "high_tier" && grants?.highTierAccess === true && await mayCollectReleasedField(db,connection.userId,approvalId,grants);
  } });
  const logActivityTool = createLogActivityTool({ recorder });
  const listTasksTool = createListTasksTool({ db, keyWrapper });
  const createTaskTool = createCreateTaskTool({ db, keyWrapper });
  const updateTaskTool = createUpdateTaskTool({ db, keyWrapper });
  const completeTaskTool = createCompleteTaskTool({ db, keyWrapper });
  const listRecordsTool = createListRecordsTool({ db, keyWrapper });
  const saveRecordTool = createSaveRecordTool({ db, keyWrapper });
  const updateRecordTool = createUpdateRecordTool({ db, keyWrapper });
  const checkApprovalTool = createCheckApprovalTool({
    db,
    keyWrapper,
    clock,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    executeApprovedHold: (userId: string, approvalId: string) =>
      pipeline.executeApprovedHold(userId, approvalId),
  });

  // get_context hands the agent everything it has been granted for this connection — the
  // low-tier profile (when allowed), preferences, the skill index with the house skill, the
  // rules as sentences, the memory it may read and its open tasks — member-scoped by the
  // connection, with no internal ids.
  const getContextTool = createGetContextTool({ db, keyWrapper, clock });

  // The tool-body executor the pipeline runs on ALLOW: a connector tool goes to the
  // connector engine under the connection's owner; a core tool is routed to its real body by
  // the tool name the registry stamped it with. A tool with no body (a request tool reaches
  // execute only once approved, via executeApprovedHold) fails LOUDLY rather than silently
  // doing nothing.
  const executeTool = async (call: AgentCall, connection: AgentConnection): Promise<unknown> => {
    if (call.connector !== null) {
      const grants = await getConnectionPermissions(db, connection.userId, connection.connectionId);
      const selected = selectConnectorAccount(await listConnectionsForUser(db, connection.userId), call.connector, grants?.connectorAccounts?.[call.connector]);
      if (!selected || selected.id !== call.connectorAccountId) return { status: "refused", reason: "The service account changed or is unavailable. Submit a new request." };
      return executeConnectorTool({ ...call, connector: call.connector }, connection.userId, call.connectorAccountId);
    }
    switch (call.tool) {
      case "find_tools": {
        const query=findToolsSchema.parse(call.params);
        const grants=await getConnectionPermissions(db,connection.userId,connection.connectionId);
        if(!grants) return {tools:[],nextCursor:null};
        const catalogue=deps.catalogue ?? getProcessCatalogue(config);
        const connections=await listConnectionsForUser(db,connection.userId);
        const selected=connections.filter(c=>grants.grantedConnectors.includes(c.connectorId)&&selectConnectorAccount(connections,c.connectorId,grants.connectorAccounts?.[c.connectorId])?.id===c.id);
        const declarations=connectorToolsetFor(connections,grants.grantedConnectors,catalogue,grants.connectorAccounts,await provider.toolsets(connection.userId,selected));
        const all=createToolRegistry({pipeline}).resolveTools(grants,declarations,{expanded:true}).filter(t=>t.name.includes("__")&&(!query.query||`${t.name} ${t.description}`.toLowerCase().includes(query.query.toLowerCase())));
        const start=query.cursor??0,end=start+(query.limit??20);
        return {tools:all.slice(start,end).map(t=>({name:t.name,title:t.title,description:t.description,inputSchema:z.toJSONSchema(t.inputSchema),annotations:t.annotations})),nextCursor:end<all.length?end:null};
      }
      case "call_tool": return {status:"refused",reason:"That tool is not available to this agent. Use find_tools for its current tools."};
      case "get_context":
        return getContextTool.handle(connection,call.params);
      case "get_skill":
        return getSkillTool.handle(call.params, connection);
      case "remember":
        return rememberTool.handle(call.params, connection);
      case "search_memory":
        return searchMemoryTool.handle(call.params, connection);
      case "check_approval":
        return checkApprovalTool.handle(call.params, connection);
      case "collect_release":
        return collectReleaseTool.handle(call.params, connection);
      case "list_tasks":
        return listTasksTool.handle(call.params, connection);
      case "create_task":
        return createTaskTool.handle(call.params, connection);
      case "update_task":
        return updateTaskTool.handle(call.params, connection);
      case "complete_task":
        return completeTaskTool.handle(call.params, connection);
      case "list_records":
        return listRecordsTool.handle(call.params, connection);
      case "save_record":
        return saveRecordTool.handle(call.params, connection);
      case "update_record":
        return updateRecordTool.handle(call.params, connection);
      case "log_activity":
        return logActivityTool.handle(call.params, connection);
      default:
        throw new Error(`executeTool: no tool body for ${call.tool}`);
    }
  };

  // An approval created by the pipeline notifies the person at once (a push to every
  // registered device plus the scheduled SMS/email fallback, design §10), and every
  // handled call records the request count/latency metrics through the guarded recorder.
  const approvalPush = approvalPushSender(config);
  pipeline = createAgentCallPipeline({
    db,
    keyWrapper,
    clock,
    rateLimiter,
    recorder,
    executeTool,
    prepareCall: async (call, connection) => {
      if (call.connector === null) return call;
      const grants = await getConnectionPermissions(db, connection.userId, connection.connectionId);
      const selected = selectConnectorAccount(await listConnectionsForUser(db, connection.userId), call.connector, grants?.connectorAccounts?.[call.connector]);
      if (!selected) return null;
      if (call.connectorAccountId && selected.id !== call.connectorAccountId) return null;
      return { ...call, connectorAccountId: selected.id, connectorAccountLabel: selected.accountLabel };
    },
    notifyApprovalCreated: async (input) => {
      try {
        await notifyApprovalCreated({ db, clock, push: approvalPush }, input);
      } catch (err) {
        logSideEffectFailure("approval_notify_failed", err);
      }
    },
    recordMetric: async (input) => {
      try {
        await recordMetricEvent(db, clock, input);
      } catch (err) {
        logSideEffectFailure("metric_record_failed", err);
      }
    },
  });
  return pipeline;
}

export function createMcpDispatch(deps: McpDispatchDeps): McpDispatch {
  const { db, config } = deps;
  const catalogue = deps.catalogue ?? getProcessCatalogue(config);

  // The pipeline is assembled once here (the composition root's job) and the registry is
  // resolved over it; both are reused for every request this dispatch serves.
  const pipeline = buildAgentPipeline(deps);
  const registry = createToolRegistry({ pipeline });
  const wrapper=selectKeyWrapper({nodeEnv:config.nodeEnv,localKek:config.devKek});
  const provider=createProviderRuntime({db,catalogue,clock:systemClock,publicBaseUrl:config.publicBaseUrl,fetch:deps.fetch,dekFor:async userId=>{
    const user=await getUserById(db,userId);
    if(!user) throw new Error("No user data key");
    return wrapper.unwrap(user.wrappedDek);
  }});

  // --- the stateless MCP handler + per-request server -------------------------

  // Resolve the VERIFIED connection id to its owning person and agent (one row per
  // connection, design §6.1). The id came from the verified bearer, so this is the root
  // identity resolution; null when no agent is linked (an inconsistent credential).
  async function resolveConnection(connectionId: string): Promise<AgentConnection | null> {
    const agent = await getAgentByConnectionId(db, connectionId);
    if (!agent) return null;
    return {
      userId: agent.userId,
      connectionId: agent.connectionId,
      agentId: agent.id,
      active: agent.status === "connected",
    };
  }

  // Build a fresh MCP server for one request, registering the tools the registry resolves
  // for the verified connection (core tools + its permitted connector tools). Each handler
  // is bound to the resolved connection, so identity is taken ONLY from the verified bearer.
  async function buildServer(authInfo: AuthInfo | undefined): Promise<McpServer> {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

    const connectionId = authInfo?.clientId;
    const connection = connectionId ? await resolveConnection(connectionId) : null;

    let tools: readonly ToolDefinition[];
    if (connection) {
      const permissions = await getConnectionPermissions(db, connection.userId, connection.connectionId);
      // The connector tools this connection may use: its person's connected services that
      // this agent is granted (member-scoped by the verified connection's owner).
      const connections = await listConnectionsForUser(db, connection.userId);
      const providerTools = permissions ? await provider.toolsets(connection.userId,connections.filter(c => permissions.grantedConnectors.includes(c.connectorId) && selectConnectorAccount(connections,c.connectorId,permissions.connectorAccounts?.[c.connectorId])?.id===c.id)) : {};
      tools = permissions
        ? registry.resolveTools(
            permissions,
            connectorToolsetFor(
              connections,
              permissions.grantedConnectors,
              catalogue,
              permissions.connectorAccounts,
              providerTools,
            ),
          )
        : registry.coreTools;
    } else {
      // No connection resolved: advertise the core tools so tools/list still answers; a
      // tools/call then refuses (above) rather than running unscoped.
      tools = registry.coreTools;
    }

    for (const tool of tools) {
      registerTool(server, tool, connection);
    }
    return server;
  }

  const handler = createMcpHandler((ctx) => buildServer(ctx.authInfo), { legacy: "stateless" });

  return async function dispatch(connectionId: string, request: Request): Promise<Response> {
    // Hand the VERIFIED connection to the SDK as pass-through authInfo (clientId = the
    // connection id); the per-request factory reads it to scope the tools. The SDK never
    // reads identity from the body.
    return handler.fetch(request, {
      authInfo: { token: connectionId, clientId: connectionId, scopes: [MCP_SCOPE] },
    });
  };
}

// E07-S20 — the agent-call executors the signed-in inbox and activity screens drive, built
// from the SAME composition-root inputs (config + the process db) and routed through the
// SAME pipeline the MCP endpoint uses. Approving a held non-release call runs it exactly
// once (`executeApprovedHold`, the pipeline's single-shot runner — the one check_approval
// already uses); undoing a reversible entry runs its declared reversal through the pipeline
// and REPORTS the outcome in plain words (`runReversal`, the undo service's reversal seam),
// never the old "not configured" stub and never a silent failure. The user id is always the
// CALLER's (the session's / the owning entry's), never a form value (design §5).
export interface AgentExecutors {
  executeApprovedHold(userId: string, approvalId: string): Promise<ApprovedHoldResult>;
  runReversal(job: UndoReversalJob): Promise<UndoReversalResult>;
}

// Plain-words fallbacks so an undo that could not route its reversal still reports an
// outcome — the undo service always records a reversal entry, never a blank or silent one.
const REVERSAL_NO_ROUTE =
  "This action couldn't be undone automatically — there's no connected agent to run the reversal.";
const REVERSAL_FAILED = "The reversal couldn't be completed.";

// One pipeline outcome as the plain-words outcome the undo entry records.
function reversalOutcome(result: AgentCallResult): UndoReversalResult {
  switch (result.status) {
    case "executed":
      return successfulConnectorResult(result.result)
        ? { status: "executed", outcome: "Undone." }
        : { status: "failed", outcome: REVERSAL_FAILED };
    case "refused":
      return { status: "refused", outcome: result.reason };
    case "pending_approval":
      return { status: "pending_approval", outcome: "This needs your approval before it can be undone. Open Approvals to continue." };
  }
}

export function createAgentExecutors(deps: McpDispatchDeps): AgentExecutors {
  const { db } = deps;
  const pipeline = buildAgentPipeline(deps);

  // Run an entry's declared reversal through the pipeline and report its outcome. The
  // original entry (member-scoped by the caller's user id + its seq, bound as parameters —
  // never a client value) names the agent and connected service the reversal re-uses; the
  // reversal tool is routed through the SAME gate a live agent call passes (so a connector
  // the agent may no longer use is cleanly declined), and the outcome is reported in plain
  // words — never thrown — so the undo service can always append its reversal entry (design
  // §9; constitution 14/15).
  async function runReversal(job: UndoReversalJob): Promise<UndoReversalResult> {
    const found = await db.query(
      "SELECT * FROM activity_entries WHERE user_id = $1 AND seq = $2",
      [job.userId, job.originalSeq],
    );
    const row = found.rows[0];
    if (!row) {
      return { status: "refused", outcome: REVERSAL_NO_ROUTE };
    }

    const agentId = row.agent_id == null ? null : String(row.agent_id);
    if (!agentId) {
      return { status: "refused", outcome: REVERSAL_NO_ROUTE };
    }

    const agent = await getAgentById(db, job.userId, agentId);
    if (!agent) {
      return { status: "refused", outcome: REVERSAL_NO_ROUTE };
    }

    const connection: AgentConnection = {
      userId: agent.userId,
      connectionId: agent.connectionId,
      agentId: agent.id,
      active: agent.status === "connected",
    };
    const call: AgentCall = {
      connector: row.connector_id == null ? null : String(row.connector_id),
      tool: job.reversalTool,
      makesChange: true,
      reason: job.reason,
    };

    try {
      // A reversal must use the account on the original action, never the agent's
      // newly selected account. Legacy entries without that binding fail closed.
      if (call.connector) {
        const user = await getUserById(db, job.userId);
        if (!user) return { status: "refused", outcome: REVERSAL_NO_ROUTE };
        const wrapper = selectKeyWrapper({ nodeEnv: deps.config.nodeEnv, localKek: deps.config.devKek });
        const dek = await wrapper.unwrap(user.wrappedDek);
        try {
          const entry = await toEntry(row, dek);
          const target = calendarReversalForEntry(entry);
          const accountId = (entry.payload as { connectorAccountId?: unknown } | null)?.connectorAccountId;
          if (!target || target.tool !== job.reversalTool || typeof accountId !== "string") {
            return { status: "refused", outcome: "This action cannot be undone automatically because its original event or service account is unavailable." };
          }
          const result = await pipeline.handleAgentCall(connection, { ...call, connectorAccountId: accountId,
            params: { query: { eventId: target.eventId } },
          });
          return reversalOutcome(result);
        } finally { dek.fill(0); }
      }
      return { status: "refused", outcome: REVERSAL_NO_ROUTE };
    } catch {
      // The pipeline surfaces a policy decision as a result, so a throw here is an
      // infrastructure failure, not a refusal. Report it in plain words rather than letting
      // it escape, so the undo service can still record the reversal entry.
      return { status: "failed", outcome: REVERSAL_FAILED };
    }
  }

  return {
    executeApprovedHold: (userId: string, approvalId: string) =>
      pipeline.executeApprovedHold(userId, approvalId),
    runReversal,
  };
}
