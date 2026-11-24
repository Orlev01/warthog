import { getContextSchema } from "./get-context";
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
import type {
  AgentCall,
  AgentCallResult,
  AgentCallPipeline,
} from "../pipeline";
import type { AgentConnection } from "../context";
import type { ConnectionPermissions } from "../../db/agent-permissions";
import { accountPolicy, toolPermitted, untagId } from "../../../domain/permissions/account-access";
import { MAIL_CONNECTOR_IDS } from "../../../domain/content/mail-connectors";
import { rememberSchema, searchMemorySchema } from "./memory";
import { getSkillSchema } from "./get-skill";
import { inputSchema as checkApprovalSchema } from "./check-approval";
import { inputSchema as collectReleaseSchema } from "./collect-release";
import {
  completeTaskSchema,
  createTaskSchema,
  listTasksSchema,
  updateTaskSchema,
} from "./tasks";
import {
  listRecordsSchema,
  saveRecordSchema,
  updateRecordSchema,
} from "./records";
import { logActivitySchema } from "./log-activity";
import { requestMakesChange } from "../../connectors/request-tool";
import { coreToolMetadata, connectorToolMetadata, type ToolAnnotations } from "./metadata";
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
  readonly title: string;
  readonly annotations: ToolAnnotations;
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
  readonly title?: string;
  readonly schema?: z.ZodType;
  readonly requiresApproval?: boolean;
  // The person is always asked first, whatever the agent may do alone (a LinkedIn post).
  readonly alwaysAsk?: boolean;
  readonly name: string;
  readonly description?: string;
  readonly makesChange?: boolean;
  readonly messageChannel?: "email" | "chat" | "post";
  readonly recipients?: (body: string | undefined) => readonly string[];
  // Recipients read from the validated input itself (structured email fields), when the tool
  // has no raw body.
  readonly recipientsOf?: (params: Record<string, unknown>) => readonly string[];
  // The tool sends something to other people (an email, a calendar invitation).
  readonly outbound?: boolean;
  // It always does, whatever its input lists (editing an event notifies its existing guests).
  readonly alwaysOutbound?: boolean;
  // The general request tool of a service that can send a message on a GET: every request,
  // GET included, is classified as a change (catalogue `get_is_change`).
  readonly getIsChange?: boolean;
}

// Connector id → its (unqualified) tools, by bare name or full declaration. The resolver
// namespaces them `<connector>__<tool>` and keeps only the ones a connection is permitted.
export type ConnectorToolset = Record<
  string,
  readonly (string | ConnectorToolDeclaration)[]
>;

export interface ToolRegistry {
  readonly coreTools: readonly ToolDefinition[]; // the always-available core tools
  get(name: string): ToolDefinition | undefined; // look one up by name
  resolveTools( // the list served to a connection
    permissions: ConnectionPermissions,
    connectorTools: ConnectorToolset,
    options?: { expanded?: boolean },
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
export const findToolsSchema = z.object({
  query: z.string().max(200).optional(),
  cursor: z.number().int().nonnegative().max(100_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  reason,
});
export const callToolSchema = z
  .object({
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.unknown()).default({}),
    reason,
  })
  .refine(
    (v) => JSON.stringify(v).length <= 64_000,
    "Tool arguments are too large",
  );

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

// Schema for core tools that take only an optional reason.
const envelope = z.object({ reason });

// request_card's input: the purchase it is for (amount, currency, merchant) plus the
// universal optional reason, shown to the person when they decide.
const requestCardSchema = z.object({
  amount: z
    .number()
    .positive()
    .describe("The purchase amount, in major units (e.g. 49.95)."),
  currency: z
    .string()
    .min(1)
    .max(MAX_CURRENCY)
    .describe("The ISO 4217 currency code, e.g. AUD."),
  merchant: z
    .string()
    .min(1)
    .max(MAX_MERCHANT)
    .describe("Who the purchase is with."),
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
  purpose: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PURPOSE)
    .describe("What you will use it for, shown to the person."),
  reason,
});

const CORE_TOOL_SPECS: readonly CoreToolSpec[] = [
  {
    name: "get_context",
    description:
      "Fetch your granted context: the person's profile you may see, the skills and preferences scoped to you, the rules you must follow, the shared memory you may read, your open tasks, a short summary of their life-admin records (what is due soon, what is waiting for them to check) and Warthog's house skill. Call this first in every conversation, with working_on saying in a few words what the conversation is for: it starts this conversation's run, and you pass run.id as run on every later Warthog call. Follow next.memory and next.skills with memory_cursor and skill_cursor (and your run) to retrieve further pages.",
    makesChange: false,
    schema: getContextSchema,
  },
  {
    name: "get_skill",
    description:
      "Fetch a skill by title and, when available, its ID from get_context. Supporting files use the optional file path.",
    makesChange: false,
    schema: getSkillSchema,
  },
  {
    name: "request_identity_detail",
    description:
      "Ask the person to release one high-tier identity detail (such as a passport or driver licence) for a stated purpose. The person approves each request; you get pending_approval, wait with check_approval, then collect the value once with collect_release.",
    makesChange: false,
    schema: requestIdentityDetailSchema,
    extra: (p) => ({
      request: "high_tier",
      field: p.field as string,
      purpose: p.purpose as string,
    }),
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
      "Collect an approved high-tier detail or card using its approval_id from check_approval. A release can be collected once, within 5 minutes of the person approving it. A high-tier detail comes back as its value. A card comes back as JSON with everything a checkout needs: number, securityCode, expiryMonth, expiryYear, cardholderName and billingAddress (cardholderName or billingAddress is null if the person has not saved one). Use it for the one purchase that was approved, and do not store it.",
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
    description:
      "Search a bounded page of memories you may read, optionally filtered by text. Follow nextCursor with cursor until null, even if a page has no matches.",
    makesChange: false,
    schema: searchMemorySchema,
  },
  {
    name: "list_tasks",
    description:
      "List the person's tasks that are assigned to you or to any agent.",
    makesChange: false,
    schema: listTasksSchema,
  },
  {
    name: "create_task",
    description:
      "Create a task with a title, optionally assigned to one agent (otherwise any agent may pick it up).",
    makesChange: true,
    schema: createTaskSchema,
  },
  {
    name: "update_task",
    description:
      "Update one of your tasks by id: change status or append a note. Updating a shared task claims it for ten minutes; further updates renew the claim. Set status open to release it. Another agent cannot change it until the claim expires.",
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
      "Use this when the person asks about their own life admin: a vehicle's rego, number plate or insurance; health insurance; their super fund; electricity, internet or phone accounts; subscriptions and what they cost; when a passport, licence or visa expires; their lease, mortgage or home insurance; pets; receipts and warranties; or what is due soon. Returns the records saved in Warthog, each with what its due date means (expires, renews, due), who saved it and whether the person has checked it, plus a monthly total for recurring costs. Filter by category, type, words or dueWithinDays; follow nextCursor for more. Answers come from saved records, so no email search is needed when one matches.",
    makesChange: false,
    schema: listRecordsSchema,
  },
  {
    name: "save_record",
    description:
      "Use this when you have learned life-admin details worth keeping, from the person or from their email: a vehicle and its rego or insurance, health insurance, a super fund, a utility or phone account, a subscription, an ID document's expiry date, a lease, a pet, a receipt or warranty, or a renewal or appointment. Give each record a type (such as \"vehicle.registration\"), its fields and its due date, and save up to 25 at once in records. A record matching one already saved is updated instead of duplicated. What you save is a suggestion until the person confirms it, and a record they have checked is never overwritten: your change waits for them. Never include tax file numbers, passwords, PINs, card numbers, BSB and account numbers, or passport, licence or Medicare numbers. The \"Life admin records\" skill lists every type and its fields.",
    makesChange: true,
    schema: saveRecordSchema,
  },
  {
    name: "update_record",
    description:
      "Use this when one saved life-admin record needs a change you know about: a new due date, cost or status, a corrected detail, or linking it to its vehicle, home or pet. Pass the id from list_records; set changes only the fields it names (null removes one). A change to a record the person has checked waits for them to accept it.",
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
function buildCoreTool(
  spec: CoreToolSpec,
  pipeline: AgentCallPipeline,
): ToolDefinition {
  return {
    name: spec.name,
    ...coreToolMetadata(spec.name),
    description: spec.description,
    inputSchema: spec.schema,
    async handle(
      input: unknown,
      connection: AgentConnection,
    ): Promise<AgentCallResult> {
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

// The optional account every connector tool takes (docs/adr/several-accounts-per-agent.md):
// which of the person's accounts of the service the call uses, when the agent may use more
// than one. It is only a name; the pipeline binds it among the agent's own accounts.
export const ACCOUNT_FIELD = z
  .string()
  .max(320)
  .optional()
  .catch(undefined)
  .describe("Which account of this service to use: its address (or handle) from get_context serviceAccounts. Only needed when you can use more than one.");

export function withAccountField(schema: z.ZodType): z.ZodType {
  if (!(schema instanceof z.ZodObject) || "account" in schema.shape) return schema;
  return schema.safeExtend({ account: ACCOUNT_FIELD });
}

// A mail message id from search or read carries its inbox (`<handle>.<id>`): a read's query.id,
// or the reply.id of a draft or send. The service's own id replaces it in the params, and the
// handle is returned for binding. A bare id is left as it is.
function liftTaggedId(parsed: Record<string, unknown>): string | undefined {
  const query = parsed.query as Record<string, string> | undefined;
  const fromQuery = query && typeof query === "object" && typeof query.id === "string" ? untagId(query.id) : null;
  if (fromQuery) {
    parsed.query = { ...query, id: fromQuery.id };
    return fromQuery.handle;
  }
  const reply = parsed.reply as { id?: unknown } | undefined;
  const fromReply = reply && typeof reply === "object" && typeof reply.id === "string" ? untagId(reply.id) : null;
  if (fromReply) {
    parsed.reply = { ...reply, id: fromReply.id };
    return fromReply.handle;
  }
  return undefined;
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
  const declaration: ConnectorToolDeclaration =
    typeof tool === "string" ? { name: tool } : tool;
  const name = `${connectorId}${NAMESPACE}${declaration.name}`;
  const isRequest = declaration.name === REQUEST_TOOL;
  const schema = withAccountField(
    declaration.schema ??
    (isRequest ? connectorRequestSchema : connectorToolSchema),
  );
  return {
    name,
    ...connectorToolMetadata(
      declaration.title ?? `${connectorId}: ${declaration.name.replace(/_/g, " ")}`,
      !isRequest && !declaration.requiresApproval && declaration.makesChange === false,
    ),
    description:
      declaration.description ??
      `Use the ${declaration.name} tool of the person's ${connectorId} service.`,
    inputSchema: schema,
    async handle(
      input: unknown,
      connection: AgentConnection,
    ): Promise<AgentCallResult> {
      const { account, ...parsed } = parseParams(schema, input) as Record<string, unknown> & {
        body?: string;
        account?: string;
      };
      // The account the agent named. An agent whose client still has the older tool list can
      // name it inside `query` instead; never for the request tool, whose query goes to the
      // service as it is.
      let requestedAccount = account;
      const query = parsed.query as Record<string, string> | undefined;
      if (!isRequest && query && typeof query === "object" && typeof query.account === "string") {
        const { account: fromQuery, ...rest } = query;
        requestedAccount ??= fromQuery;
        parsed.query = rest;
      }
      // The inbox a mail message id says it's in (docs/adr/several-accounts-per-agent.md).
      const idHandle = MAIL_CONNECTOR_IDS.has(connectorId) ? liftTaggedId(parsed) : undefined;
      const makesChange = isRequest
        ? declaration.getIsChange === true || requestMakesChange(String(parsed.method))
        : (declaration.makesChange ?? true);
      const recipients = declaration.recipientsOf ? declaration.recipientsOf(parsed) : declaration.recipients?.(parsed.body);
      const call: AgentCall = {
        connector: connectorId,
        tool: name,
        makesChange,
        requiresApproval: declaration.requiresApproval,
        ...(declaration.alwaysAsk ? { alwaysAsk: true } : {}),
        unknownSemantics: isRequest || declaration.requiresApproval,
        messageChannel: declaration.messageChannel,
        recipients,
        // It sends to other people: an email, an invitation that has guests, or a write
        // through a messaging service.
        outbound: declaration.outbound === true && makesChange
          && (isRequest || declaration.alwaysOutbound === true || declaration.messageChannel !== undefined || (recipients?.length ?? 0) > 0),
        reason: parsed.reason as string | undefined,
        params: parsed,
        ...(requestedAccount ? { requestedAccount } : {}),
        ...(idHandle ? { idHandle } : {}),
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

  // find_tools and call_tool: served IN PLACE OF a large permitted connector set (design §6.2),
  // and alongside a small one, so an agent whose app still has an older tool list can reach a
  // service the person granted since (docs/adr/several-accounts-per-agent.md).
  const collapseHelpers: readonly ToolDefinition[] = [
    buildCoreTool(
      {
        name: "find_tools",
        description:
          "Find the connected-service tools you may use, by name or description, including any the person granted after your tool list was loaded. Results include schemas and a pagination cursor.",
        makesChange: false,
        schema: findToolsSchema,
      },
      pipeline,
    ),
    buildCoreTool(
      {
        name: "call_tool",
        description:
          "Call a tool from find_tools with its exact name and input object in arguments. Use it for a tool that isn't in your tool list yet.",
        makesChange: false,
        schema: callToolSchema,
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
      options: { expanded?: boolean } = {},
    ): readonly ToolDefinition[] {
      // Namespace each PERMITTED connector's tools; a connector that is not granted
      // contributes nothing.
      // A service's tools are offered once however many of its accounts the agent has; a tool is
      // offered when any of those accounts' settings allow it, and each call is then bound to one
      // account whose settings the policy checks (docs/adr/several-accounts-per-agent.md).
      const connectorDefs: ToolDefinition[] = [];
      for (const connectorId of permissions.grantedConnectors) {
        const tools = connectorTools[connectorId];
        if (!tools) continue;
        const accounts = permissions.accounts.filter((account) => account.connectorId === connectorId);
        const policies = (accounts.length > 0 ? accounts : [undefined]).map((account) => accountPolicy(account, permissions));
        for (const tool of tools) {
          const declaration = typeof tool === "string" ? { name: tool } : tool;
          const use = {
            name: `${connectorId}${NAMESPACE}${declaration.name}`,
            makesChange: declaration.makesChange ?? true,
            request: declaration.name === REQUEST_TOOL,
          };
          if (!policies.some((policy) => toolPermitted(policy, use))) continue;
          connectorDefs.push(buildConnectorTool(connectorId, tool, pipeline));
        }
      }

      // find_tools itself lists the connector tools alone.
      if (options.expanded) return [...coreTools, ...connectorDefs];
      // call_tool routes to a permitted tool by name: the actual tool is audited and gated with
      // its own trusted declaration, and unknown targets take the normal audited refusal path.
      const callTool: ToolDefinition = {
        ...collapseHelpers[1]!,
        async handle(input, connection) {
          const parsed = parseParams(callToolSchema, input);
          const target = connectorDefs.find(
            (tool) => tool.name === parsed.name,
          );
          if (!target) return collapseHelpers[1]!.handle(parsed, connection);
          return target.handle(
            {
              ...parsed.arguments,
              ...(parsed.reason ? { reason: parsed.reason } : {}),
            },
            connection,
          );
        },
      };
      // Over the limit the connector tools collapse into find_tools + call_tool; the core tools
      // are always served either way.
      if (connectorDefs.length > CONNECTOR_TOOL_LIMIT) return [...coreTools, collapseHelpers[0]!, callTool];
      return [...coreTools, ...connectorDefs, collapseHelpers[0]!, callTool];
    },
  };
}
