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
import { rememberSchema, searchMemorySchema } from "./memory";
import { getSkillSchema } from "./get-skill";
import { inputSchema as checkApprovalSchema } from "./check-approval";
import { inputSchema as collectReleaseSchema } from "./collect-release";
import { completeTaskSchema, createTaskSchema, listTasksSchema, updateTaskSchema } from "./tasks";
import { listRecordsSchema, saveRecordSchema, updateRecordSchema } from "./records";
import { logActivitySchema } from "./log-activity";
import { requestMakesChange } from "../../connectors/request-tool";
import {
  connectorRequestSchema,
  connectorToolSchema,
  REQUEST_TOOL,
} from "../../connectors/tool-routing";

// --- the pinned contract (documented in `registry.test.ts`) ----------------

// One resolvable MCP tool: its name, a plain-English description of what it does and
// when to use it (what tools/list shows the agent), the zod OBJECT schema its input is
// validated against — the tool body's REAL schema, so tools/list advertises every field
// the body needs (whose `.shape` always carries an optional string `reason`, design §6.2
// "every tool takes an optional reason") — and a handler that validates the input and
// routes the call through the pipeline under the session connection's identity.
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType; // a z.object(...) exposing an optional `reason` in its .shape
  handle(input: unknown, connection: AgentConnection): Promise<AgentCallResult>;
}

// One connector tool as the connector engine declares it: its unqualified name, a plain
// description, its tool class (absent ⇒ treated as a change, the stricter gate), and —
// for a tool that sends a message — the channel plus how to read its recipients from the
// validated body, so the rules engine's send-message and recipient rules can match. The
// general `request` tool is classified per call by its HTTP method instead.
export interface ConnectorToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly makesChange?: boolean;
  readonly messageChannel?: "email" | "chat" | "post";
  readonly recipients?: (body: string | undefined) => readonly string[];
}

// Connector id → its (unqualified) tools, by bare name or full declaration. The resolver
// namespaces them `<connector>__<tool>` and keeps only the ones a connection is permitted.
export type ConnectorToolset = Record<string, readonly (string | ConnectorToolDeclaration)[]>;

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

// Caps for the high-tier request fields: a field name or custom label is short; a purpose
// is a sentence or two.
const MAX_FIELD = 100;
const MAX_PURPOSE = 500;

// Over this many permitted connector tools, the connector set collapses into
// find_tools + call_tool (design §6.2). Far from any test boundary (a handful stays
// expanded; a very large set collapses), so the exact figure is this module's call.
const CONNECTOR_TOOL_LIMIT = 80;

// The `<connector>__<tool>` namespace separator (design §6.2).
const NAMESPACE = "__";

// --- core tool specs -------------------------------------------------------

// A core tool: its name, a plain-English description (what tools/list shows the
// agent), whether it makes a change (its tool class), the zod object its input is
// validated against — the tool body's OWN exported schema, so what is advertised and
// what the body validates are one definition and cannot drift — and an optional map to
// the policy-relevant `AgentCall` fields beyond the envelope (connector / tool /
// makesChange / reason / params) — the two request tools name their `request` kind and
// card fields here.
interface CoreToolSpec {
  readonly name: string;
  readonly description: string;
  readonly makesChange: boolean;
  readonly schema: z.ZodType;
  readonly extra?: (parsed: Record<string, unknown>) => Partial<AgentCall>;
}

// A tool whose only argument is the optional `reason` (get_context takes nothing else).
const envelope = z.object({ reason });

// request_card's input: the purchase it is for (amount, currency, merchant) plus the
// universal optional reason, shown to the person when they decide.
const requestCardSchema = z.object({
  amount: z.number().positive().describe("The purchase amount, in major units (e.g. 49.95)."),
  currency: z.string().min(1).max(MAX_CURRENCY).describe("The ISO 4217 currency code, e.g. AUD."),
  merchant: z.string().min(1).max(MAX_MERCHANT).describe("Who the purchase is with."),
  reason,
});

// request_identity_detail's input: WHICH high-tier detail is wanted and WHY (brief: "request
// a high-tier identity detail with a stated purpose"; the person sees the agent, the field
// and the purpose before they decide), plus the universal optional reason.
const requestIdentityDetailSchema = z.object({
  field: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FIELD)
    .describe(
      "Which detail you need: date_of_birth, passport, driver_licence, car_registration, or the label of a custom field.",
    ),
  purpose: z.string().trim().min(1).max(MAX_PURPOSE).describe("What you will use it for, shown to the person."),
  reason,
});

const CORE_TOOL_SPECS: readonly CoreToolSpec[] = [
  {
    name: "get_context",
    description:
      "Fetch everything you have been granted in one call: the person's profile you may see, the skills and preferences scoped to you, the rules you must follow, the shared memory you may read, your open tasks and Warthog's house skill. Call this first.",
    makesChange: false,
    schema: envelope,
  },
  {
    name: "get_skill",
    description: "Fetch the full text of one skill by its title (get_context lists the titles you can use).",
    makesChange: false,
    schema: getSkillSchema,
  },
  {
    name: "request_identity_detail",
    description:
      "Ask the person to release one high-tier identity detail (such as a passport or driver licence) for a stated purpose. The person approves each request; you get pending_approval, wait with check_approval, then collect the value once with collect_release.",
    makesChange: false,
    schema: requestIdentityDetailSchema,
    extra: (p) => ({ request: "high_tier", field: p.field as string, purpose: p.purpose as string }),
  },
  {
    name: "request_card",
    description:
      "Ask to use one of the person's saved cards for one purchase, with its amount, currency and merchant. Warthog checks the person's rules and budgets first and refuses with a reason if one fails; otherwise you get pending_approval, wait with check_approval, then collect the card details once with collect_release.",
    makesChange: true,
    schema: requestCardSchema,
    extra: (p) => ({
      request: "card",
      amount: p.amount as number,
      // An ISO code: "aud" or " AUD " must not read as a foreign currency.
      currency: (p.currency as string).trim().toUpperCase(),
      merchant: p.merchant as string,
    }),
  },
  {
    name: "check_approval",
    description:
      "Check on a request that is waiting for the person's approval, by the approval_id you were given, optionally waiting up to wait_seconds for a decision. Once approved, Warthog carries out the held request and returns its result.",
    makesChange: false,
    schema: checkApprovalSchema,
  },
  {
    name: "collect_release",
    description:
      "Collect an approved high-tier detail or card. A release can be collected once, within 5 minutes of the person approving it.",
    makesChange: false,
    schema: collectReleaseSchema,
  },
  {
    name: "remember",
    description:
      "Save a short fact or note to the person's memory, kept to you or shared with their other agents according to your sharing setting.",
    makesChange: true,
    schema: rememberSchema,
  },
  {
    name: "search_memory",
    description: "Search the memories you may read (shared memories plus your own), optionally filtered by a text query.",
    makesChange: false,
    schema: searchMemorySchema,
  },
  {
    name: "list_tasks",
    description: "List the person's tasks that are assigned to you or to any agent.",
    makesChange: false,
    schema: listTasksSchema,
  },
  {
    name: "create_task",
    description: "Create a task with a title, optionally assigned to one agent (otherwise any agent may pick it up).",
    makesChange: true,
    schema: createTaskSchema,
  },
  {
    name: "update_task",
    description: "Update one of your tasks by id: change its status or append a note.",
    makesChange: true,
    schema: updateTaskSchema,
  },
  {
    name: "complete_task",
    description: "Mark one of your tasks as done, by id.",
    makesChange: true,
    schema: completeTaskSchema,
  },
  {
    name: "list_records",
    description:
      "List the person's life-admin records: subscriptions, receipts and warranties, and renewals and appointments.",
    makesChange: false,
    schema: listRecordsSchema,
  },
  {
    name: "save_record",
    description:
      "Save a new life-admin record (a subscription, a receipt or warranty, or a renewal or appointment) with its details and an optional due date.",
    makesChange: true,
    schema: saveRecordSchema,
  },
  {
    name: "update_record",
    description: "Update a life-admin record by id, resupplying its details and optionally its status or due date.",
    makesChange: true,
    schema: updateRecordSchema,
  },
  {
    name: "log_activity",
    description:
      "Log a high-level summary of something you did to the person's activity feed (put the summary in reason), optionally with an amount, currency and the card release it relates to. It is labelled as reported by you.",
    makesChange: true,
    schema: logActivitySchema,
  },
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
    description: spec.description,
    inputSchema: spec.schema,
    async handle(input: unknown, connection: AgentConnection): Promise<AgentCallResult> {
      const parsed = parseParams(spec.schema, input) as Record<string, unknown>;
      // The VALIDATED fields are what travel on (and are recorded): an extra field the
      // schema does not know is dropped here rather than forwarded or stored.
      const call: AgentCall = {
        connector: null,
        tool: spec.name,
        makesChange: spec.makesChange,
        reason: parsed.reason as string | undefined,
        params: parsed,
        ...(spec.extra?.(parsed) ?? {}),
      };
      return pipeline.handleAgentCall(connection, call);
    },
  };
}

// Build a permitted connector tool, namespaced `<connector>__<tool>`, from the connector
// engine's declaration. The general `request` tool takes {method, path, query, body} and
// is a read for GET/HEAD and a change otherwise; any other tool takes {query, body} and
// carries its declared class (an undeclared one routes as a change, the stricter gate),
// message channel and recipients onto the call the pipeline's policy gate checks.
function buildConnectorTool(
  connectorId: string,
  tool: string | ConnectorToolDeclaration,
  pipeline: AgentCallPipeline,
): ToolDefinition {
  const declaration: ConnectorToolDeclaration = typeof tool === "string" ? { name: tool } : tool;
  const name = `${connectorId}${NAMESPACE}${declaration.name}`;
  const isRequest = declaration.name === REQUEST_TOOL;
  const schema = isRequest ? connectorRequestSchema : connectorToolSchema;
  return {
    name,
    description:
      declaration.description ?? `Use the ${declaration.name} tool of the person's ${connectorId} service.`,
    inputSchema: schema,
    async handle(input: unknown, connection: AgentConnection): Promise<AgentCallResult> {
      const parsed = parseParams(schema, input) as Record<string, unknown> & { body?: string };
      const call: AgentCall = {
        connector: connectorId,
        tool: name,
        makesChange: isRequest ? requestMakesChange(String(parsed.method)) : (declaration.makesChange ?? true),
        messageChannel: declaration.messageChannel,
        recipients: declaration.recipients?.(parsed.body),
        reason: parsed.reason as string | undefined,
        params: parsed,
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
    buildCoreTool(
      {
        name: "find_tools",
        description: "Find the connected-service tools you may use, when there are too many to list.",
        makesChange: false,
        schema: envelope,
      },
      pipeline,
    ),
    buildCoreTool(
      {
        name: "call_tool",
        description: "Call one of the connected-service tools found with find_tools, by its name.",
        makesChange: true,
        schema: envelope,
      },
      pipeline,
    ),
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
        for (const tool of tools) {
          connectorDefs.push(buildConnectorTool(connectorId, tool, pipeline));
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
