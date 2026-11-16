import { randomUUID } from "node:crypto";
import { requestObservation, clientObservation, createClientMemory, reportedRunId } from "./client-observation";
import { parseBody } from "../http/validate";
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
import { resolveRun } from "../agents/runs";
import { ANTHROPIC_CLIENT_HEADER, clientSurface } from "../../domain/agents/client-surface";
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
import { createResultGuard } from "../connectors/result-guard";
import { gmailHasSentTo } from "../connectors/curated/google";
import { outlookHasSentTo } from "../connectors/curated/microsoft";
import { activeReadExposure, recordReadExposure } from "../db/read-exposures";

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
import { createGetSkillTool, SERVER_INSTRUCTIONS } from "./tools/get-skill";
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

// An address plain enough to put into a mail search without changing what the search means.
const SEARCHABLE_ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

// A thrown tool call maps to a plain-English reason the agent sees; an internal failure is
// never surfaced verbatim (only the input-boundary's own fixed 4xx messages are safe).
const TOOL_FAILED_REASON = "The tool call could not be completed. A change may have occurred; inspect Activity and the service before retrying.";

// Every Warthog tool also takes the run `get_context` handed out for the conversation
// (docs/adr/agent-runs.md). It is optional and never changes what a call may do: a run the
// agent was not issued is simply not linked.
// A malformed run (an object, a long string) is dropped rather than refused, so it can
// never block the call it rides on.
export const RUN_FIELD = z
  .string()
  .max(64)
  .optional()
  .catch(undefined)
  .describe("The run id get_context gave you for this conversation. Pass it on every Warthog call, so the person can see this conversation's actions together.");

// The schema a tool advertises: its own plus the optional `run`. The tool body still
// validates against its own schema, which drops `run`, so the run never reaches its params.
export function withRunField(schema: z.ZodType): z.ZodType {
  if (!(schema instanceof z.ZodObject) || "run" in schema.shape) return schema;
  return schema.safeExtend({ run: RUN_FIELD });
}

// Links the current request to the run a call names, when it is one of this agent's.
type AttachRun = (connection: AgentConnection, run: unknown) => Promise<void>;

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
  attachRun: AttachRun,
): void {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: withRunField(tool.inputSchema), annotations: tool.annotations },
    async (args: unknown) => {
      // The connection is the verified bearer's; a request that never resolved one cannot
      // be scoped to a person, so it is refused rather than run (never a silent success).
      if (!connection) {
        return errorResult("This agent is not connected.");
      }
      try {
        await attachRun(connection, (args as { run?: unknown } | undefined)?.run);
        const outcome = await tool.handle(args, connection);
        return { ...toToolResult(outcome), _meta: { "app.warthog/requestId": requestObservation.getStore()?.requestId } };
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
        next: "The person has been asked. Call check_approval with this approval_id to wait for their decision. If they have not decided by expires_at, the request expires and is refused.",
      };
      return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
    }
    case "failed":
    case "unknown":
      return errorResult(outcome.reason);
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
  const catalogue = deps.catalogue ?? getProcessCatalogue(config);
  pipeline = createAgentCallPipeline({
    db,
    keyWrapper,
    clock,
    rateLimiter,
    recorder,
    executeTool,
    // Every executed connector result is checked before an agent reads it (sign-in codes and
    // links, card numbers and hidden characters hidden; mail turned into a readable view).
    resultGuard: createResultGuard({ serviceName: (id) => catalogue.get(id)?.name, category: (id) => catalogue.get(id)?.category }),
    // The "recently read" window per agent: opened when an agent is shown someone else's content,
    // read when it then wants to change or send something.
    readExposures: {
      record: async (connection, source) => recordReadExposure(db, { userId: connection.userId, agentId: connection.agentId, source, at: clock.now() }, await dataKeyFor(connection.userId)),
      active: async (connection) => activeReadExposure(db, connection.userId, connection.agentId, clock.now(), await dataKeyFor(connection.userId)),
    },
    // A held email's card says when the person has never emailed a recipient before, from a
    // search of their own Sent mail (nothing is stored but the answer, inside the approval).
    recipientHistory: async (call, connection) => {
      const lookup = call.connector === "google-gmail" ? gmailHasSentTo : call.connector === "microsoft-outlook-mail" ? outlookHasSentTo : undefined;
      const entry = call.connector ? catalogue.get(call.connector) : undefined;
      if (!lookup || !entry || !call.connector) throw new Error("no sent-mail lookup for this service");
      // The account the held call was prepared with (prepareCall ran before the hold).
      const connectionId = call.connectorAccountId;
      if (!connectionId) throw new Error("no selected account");
      const dek = await dataKeyFor(connection.userId);
      const recipients = [...new Set((Array.isArray(call.recipients) ? call.recipients : [call.recipients]).filter((r): r is string => typeof r === "string").map((r) => r.toLowerCase()))];
      const transport = { db, fetch: deps.fetch ?? createGuardedFetch() };
      // Only a plain address goes into a search, and at most five are searched; any other is
      // reported as not checked (never as "new", which wouldn't be true either).
      const searchable = recipients.filter((address) => SEARCHABLE_ADDRESS.test(address)).slice(0, 5);
      const sent = await Promise.all(searchable.map((address) => lookup({ entry, userId: connection.userId, connectionId, dek }, address, transport)));
      return {
        fresh: searchable.filter((_, index) => !sent[index]),
        unchecked: recipients.filter((address) => !searchable.includes(address)),
      };
    },
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
  const clock = systemClock;
  const dataKeyFor = async (userId: string) => {
    const user = await getUserById(db, userId);
    if (!user) throw new Error("No user data key");
    return wrapper.unwrap(user.wrappedDek);
  };
  const recorder = createRedactingRecorder({ db, clock, dekFor: dataKeyFor });
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
      platform: agent.platform,
    };
  }

  // Link this request to the run a call names (docs/adr/agent-runs.md), when Warthog issued
  // it to this connection's agent. Anything else is ignored, and a failure here is logged
  // but never stops the call: a run is bookkeeping, not permission.
  async function attachRun(connection: AgentConnection, run: unknown): Promise<void> {
    const observed = requestObservation.getStore();
    if (!observed || run === undefined) return;
    try {
      const found = await resolveRun(db, connection, run, await dataKeyFor(connection.userId), clock);
      if (found) observed.run = found;
    } catch (err) {
      logFailure("run_attach_failed", err);
    }
  }

  // Build a fresh MCP server for one request, registering the tools the registry resolves
  // for the verified connection (core tools + its permitted connector tools). Each handler
  // is bound to the resolved connection, so identity is taken ONLY from the verified bearer.
  async function buildServer(authInfo: AuthInfo | undefined): Promise<McpServer> {
    // The instructions every client receives on connect, before any tool is called: how to
    // treat content read through Warthog (docs/adr/read-side-protection.md).
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

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

    const envelope = requestObservation.getStore()?.body as { method?: string; params?: { name?: unknown; arguments?: unknown } } | undefined;
    if (connection && envelope?.method === "tools/call") {
      const requested = tools.find(tool => tool.name === envelope.params?.name);
      // The same schema the SDK checks (with `run`), so a call it refuses is always recorded.
      if (!requested || !withRunField(requested.inputSchema).safeParse(envelope.params?.arguments ?? {}).success) {
        // A refused call still belongs to the conversation that made it.
        const args = envelope.params?.arguments;
        await attachRun(connection, args !== null && typeof args === "object" ? (args as { run?: unknown }).run : undefined);
        const observation = requestObservation.getStore();
        if (observation) observation.boundaryRecorded = true;
        await recorder.record({ userId: connection.userId, agentId: connection.agentId, kind: "tool_rejected", source: "warthog", outcome: "refused",
          tool: requested?.name, payload: { requestId: requestObservation.getStore()?.requestId,
            summary: requested ? "Tool input rejected before execution" : "Unavailable tool rejected before execution",
            reason: requested ? "invalid_input" : "tool_unavailable" } });
      }
    }
    for (const tool of tools) {
      registerTool(server, tool, connection, attachRun);
    }
    return server;
  }

  const handler = createMcpHandler((ctx) => buildServer(ctx.authInfo), { legacy: "stateless" });
  // Which app each agent's requests come through, remembered without a write per request.
  const rememberClientOf = createClientMemory({ db, recorder, onError: (err) => logFailure("client_observation_failed", err) });

  return async function dispatch(connectionId: string, request: Request): Promise<Response> {
    // Hand the VERIFIED connection to the SDK as pass-through authInfo (clientId = the
    // connection id); the per-request factory reads it to scope the tools. The SDK never
    // reads identity from the body.
    const connection = await resolveConnection(connectionId);
    let body: unknown;
    try { if (request.method === "POST") body = await parseBody(z.unknown(), request.clone(), { maxBytes: 1024 * 1024 }); }
    catch {
      if (connection) await recorder.record({ userId: connection.userId, agentId: connection.agentId, kind: "protocol_rejected", source: "warthog", outcome: "refused", payload: { reason: "Malformed or oversized request", requestId: randomUUID() } });
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid request body" } }, { status: 400 });
    }
    const client = clientObservation(body, request.headers);
    if (connection && client) await rememberClientOf(connection, client, clock.now(), () => dataKeyFor(connection.userId));
    const via = clientSurface(request.headers.get(ANTHROPIC_CLIENT_HEADER), client?.name);
    return requestObservation.run({ requestId: randomUUID(), body, client, reportedRunId: reportedRunId(body), agentId: connection?.agentId, via }, async () => {
      const response = await handler.fetch(request, {
        authInfo: { token: connectionId, clientId: connectionId, scopes: [MCP_SCOPE] },
      });
      if (connection && response.status >= 400 && !requestObservation.getStore()?.boundaryRecorded) {
        await recorder.record({ userId: connection.userId, agentId: connection.agentId, kind: "protocol_rejected", source: "warthog", outcome: "refused", payload: { requestId: requestObservation.getStore()?.requestId, summary: "Request rejected by the protocol boundary", status: response.status } });
      }
      return response;
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
    case "failed":
    case "unknown":
      return { status: "failed", outcome: result.reason };
    case "executed":
      return successfulConnectorResult(result.result)
        ? { status: "executed", outcome: "Undone." }
        : { status: "failed", outcome: REVERSAL_FAILED };
    case "refused":
      return { status: "refused", outcome: result.reason };
    case "pending_approval":
      // The approval it waits on travels with it, so the undo's claim can follow that
      // request: declined or expired frees the entry again; approved reads as undone.
      return { status: "pending_approval", outcome: "This needs your approval before it can be undone. Open your Inbox to continue.",
        approvalId: result.approval_id };
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
