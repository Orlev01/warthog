// E07-S11 — MCP core tool registry (design §6.2 MCP server; constitution principle
// 13 "deterministic code", 15 "agents reach services only through Warthog").
//
// One place the MCP surface is enumerated: the always-available CORE tools, each
// wired to the agent-call pipeline, plus a helper that namespaces and resolves the
// connector tools one connection is permitted. The route and the dev console serve
// whatever `resolveTools` returns (design §6.2 "Tool list for an agent = Warthog
// core tools + the connector tools it is permitted, namespaced <connector>__<tool>;
// if the total exceeds 80, connector tools collapse into find_tools + call_tool").
//
// A SERVER module built purely from its one INJECTED seam (the pipeline): it reads
// no `process.env` and holds no secret (INV-103) — configuration flows into the
// pipeline it is handed, never into this module. A tool handler VALIDATES its input
// at the boundary (zod → a 4xx `HttpError` BEFORE the pipeline runs, INV-102) and
// then maps it to an `AgentCall`, taking the caller's identity ALWAYS from the
// session `connection` (never a value in the input). Every member-scoped read/write
// and the SQL-injection safety live downstream in the pipeline's parameterized
// stores, so a probe in an input field travels as a bound value and cannot alter a
// query.

import { z } from "zod";

import { parseParams } from "../../http/validate";
import type { AgentCall, AgentCallResult, AgentCallPipeline } from "../pipeline";
import type { AgentConnection } from "../context";
import type { ConnectionPermissions } from "../../db/agent-permissions";

// --- the pinned contract (documented in `registry.test.ts`) ----------------

// One resolvable MCP tool: its name, the zod OBJECT schema its input is validated
// against (whose `.shape` always carries an optional string `reason`, design §6.2
// "every tool takes an optional reason"), and a handler that validates the input and
// routes the call through the pipeline under the session connection's identity.
export interface ToolDefinition {
  readonly name: string;
  readonly inputSchema: z.ZodType; // a z.object(...) exposing an optional `reason` in its .shape
  handle(input: unknown, connection: AgentConnection): Promise<AgentCallResult>;
}

// Connector id → its (unqualified) tool names. The resolver namespaces them
// `<connector>__<tool>` and keeps only the ones a connection is permitted.
export type ConnectorToolset = Record<string, readonly string[]>;

export interface ToolRegistry {
  readonly coreTools: readonly ToolDefinition[]; // the always-available core tools
  get(name: string): ToolDefinition | undefined; // look one up by name
  resolveTools( // the list served to a connection
    permissions: ConnectionPermissions,
    connectorTools: ConnectorToolset,
  ): readonly ToolDefinition[];
}

export interface ToolRegistryDeps {
  readonly pipeline: AgentCallPipeline;
}

// --- shared schema pieces + constants --------------------------------------

// Every tool takes an optional `reason` (design §6.2). It is capped so a grossly
// oversized input is refused at validation before the pipeline runs (INV-102).
const MAX_REASON = 2000;
const reason = z.string().max(MAX_REASON).optional();

// Caps for the card-request fields, so an oversized value is refused at the boundary.
const MAX_CURRENCY = 10;
const MAX_MERCHANT = 500;

// Over this many permitted connector tools, the connector set collapses into
// find_tools + call_tool (design §6.2). Far from any test boundary (a handful stays
// expanded; a very large set collapses), so the exact figure is this module's call.
const CONNECTOR_TOOL_LIMIT = 80;

// The `<connector>__<tool>` namespace separator (design §6.2).
const NAMESPACE = "__";

// --- core tool specs -------------------------------------------------------

// A core tool: its name, whether it makes a change (its tool class), the zod object
// its input is validated against, and an optional map to the policy-relevant
// `AgentCall` fields beyond the envelope (connector / tool / makesChange / reason /
// params) — the two request tools name their `request` kind and card fields here.
interface CoreToolSpec {
  readonly name: string;
  readonly makesChange: boolean;
  readonly schema: z.ZodType;
  readonly extra?: (parsed: Record<string, unknown>) => Partial<AgentCall>;
}

// A simple tool whose only validated envelope is the optional `reason`; its other
// arguments (if any) are forwarded as `params` and validated by its tool body (a
// later task), the pipeline never trusting them for policy.
const envelope = z.object({ reason });

const CORE_TOOL_SPECS: readonly CoreToolSpec[] = [
  { name: "get_context", makesChange: false, schema: envelope },
  { name: "get_skill", makesChange: false, schema: envelope },
  {
    name: "request_identity_detail",
    makesChange: false,
    schema: envelope,
    extra: () => ({ request: "high_tier" }),
  },
  {
    name: "request_card",
    makesChange: true,
    schema: z.object({
      amount: z.number().positive(),
      currency: z.string().min(1).max(MAX_CURRENCY),
      merchant: z.string().min(1).max(MAX_MERCHANT),
      reason,
    }),
    extra: (p) => ({
      request: "card",
      amount: p.amount as number,
      currency: p.currency as string,
      merchant: p.merchant as string,
    }),
  },
  { name: "check_approval", makesChange: false, schema: envelope },
  { name: "collect_release", makesChange: false, schema: envelope },
  { name: "remember", makesChange: true, schema: envelope },
  { name: "search_memory", makesChange: false, schema: envelope },
  { name: "list_tasks", makesChange: false, schema: envelope },
  { name: "create_task", makesChange: true, schema: envelope },
  { name: "update_task", makesChange: true, schema: envelope },
  { name: "complete_task", makesChange: true, schema: envelope },
  { name: "list_records", makesChange: false, schema: envelope },
  { name: "save_record", makesChange: true, schema: envelope },
  { name: "update_record", makesChange: true, schema: envelope },
  { name: "log_activity", makesChange: true, schema: envelope },
];

// --- tool-definition builders ----------------------------------------------

// Build a core tool: VALIDATE the input against its schema (a bad / oversized /
// mis-shaped input throws a 4xx `HttpError` BEFORE the pipeline runs and is never
// routed), map it to an `AgentCall` (a core tool has no connector), and route it
// through the pipeline under the SESSION connection — the caller's identity is
// always the connection's, never a value in the input.
function buildCoreTool(spec: CoreToolSpec, pipeline: AgentCallPipeline): ToolDefinition {
  return {
    name: spec.name,
    inputSchema: spec.schema,
    async handle(input: unknown, connection: AgentConnection): Promise<AgentCallResult> {
      const parsed = parseParams(spec.schema, input) as Record<string, unknown>;
      const call: AgentCall = {
        connector: null,
        tool: spec.name,
        makesChange: spec.makesChange,
        reason: parsed.reason as string | undefined,
        params: input,
        ...(spec.extra?.(parsed) ?? {}),
      };
      return pipeline.handleAgentCall(connection, call);
    },
  };
}

// Build a permitted connector tool, namespaced `<connector>__<tool>`. Its arguments
// are validated and classified (reads vs changes) by the connector catalogue (a
// later task, E09); until then its envelope is the optional `reason` and it routes
// conservatively as a change, so an unknown tool gets the stricter policy gate.
function buildConnectorTool(
  connectorId: string,
  toolName: string,
  pipeline: AgentCallPipeline,
): ToolDefinition {
  const name = `${connectorId}${NAMESPACE}${toolName}`;
  return {
    name,
    inputSchema: envelope,
    async handle(input: unknown, connection: AgentConnection): Promise<AgentCallResult> {
      const parsed = parseParams(envelope, input) as Record<string, unknown>;
      const call: AgentCall = {
        connector: connectorId,
        tool: name,
        makesChange: true,
        reason: parsed.reason as string | undefined,
        params: input,
      };
      return pipeline.handleAgentCall(connection, call);
    },
  };
}

// --- the registry ----------------------------------------------------------

export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const { pipeline } = deps;

  const coreTools: readonly ToolDefinition[] = CORE_TOOL_SPECS.map((spec) =>
    buildCoreTool(spec, pipeline),
  );

  // The collapse helpers served IN PLACE OF a large permitted connector set (design
  // §6.2). They are not part of the always-available core, so a small set is never
  // collapsed into them.
  const collapseHelpers: readonly ToolDefinition[] = [
    buildCoreTool({ name: "find_tools", makesChange: false, schema: envelope }, pipeline),
    buildCoreTool({ name: "call_tool", makesChange: true, schema: envelope }, pipeline),
  ];

  const byName = new Map<string, ToolDefinition>(
    [...coreTools, ...collapseHelpers].map((tool) => [tool.name, tool]),
  );

  return {
    coreTools,

    get(name: string): ToolDefinition | undefined {
      return byName.get(name);
    },

    resolveTools(
      permissions: ConnectionPermissions,
      connectorTools: ConnectorToolset,
    ): readonly ToolDefinition[] {
      // Namespace each PERMITTED connector's tools; a connector that is not granted
      // contributes nothing.
      const connectorDefs: ToolDefinition[] = [];
      for (const connectorId of permissions.grantedConnectors) {
        const tools = connectorTools[connectorId];
        if (!tools) continue;
        for (const toolName of tools) {
          connectorDefs.push(buildConnectorTool(connectorId, toolName, pipeline));
        }
      }

      // Over the limit the connector tools collapse into find_tools + call_tool; the
      // core tools are always served either way.
      if (connectorDefs.length > CONNECTOR_TOOL_LIMIT) {
        return [...coreTools, ...collapseHelpers];
      }
      return [...coreTools, ...connectorDefs];
    },
  };
}
