// E07-S11 — MCP core tool registry (`src/server/mcp/tools/registry.ts`, design §6.2
// MCP server; constitution principle 13 "deterministic code", 15 "agents reach
// services only through Warthog").
//
// RED-first: `./registry` does not exist yet, so importing `createToolRegistry`
// throws and every test here fails until the builder writes the minimum code to
// pass. That absence IS the point of test-first; do NOT implement anything to make
// these pass — the builder writes `registry.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the registry EXPOSES and what a handler DOES),
// never the source text of any module — a later rename that preserves behaviour must
// not redden them. Core-tool handlers are exercised against an INJECTED pipeline spy
// (so "did it route to the pipeline, with which call?" is observed directly), and
// the connector-tool resolver is a pure function over a connection's permissions and
// a supplied connector→tools map (the catalogue loader is a later task, E09, so the
// permitted connector tools are handed in as data).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import { z } from "zod";
//   import type { AgentCall, AgentCallResult, AgentCallPipeline } from "../pipeline";
//   import type { AgentConnection } from "../context";
//   import type { ConnectionPermissions } from "../../db/agent-permissions";
//
//   // One resolvable MCP tool: its name, the zod OBJECT schema its input is validated
//   // against (whose shape always carries an optional string `reason`, design §6.2
//   // "every tool takes an optional reason"), and a handler that validates the input
//   // and routes the call through the pipeline.
//   interface ToolDefinition {
//     readonly name: string;
//     readonly inputSchema: z.ZodType;  // a z.object(...) exposing an optional `reason` in its .shape
//     // Validate `input`; on a bad input THROW HttpError (4xx) BEFORE the pipeline runs;
//     // on a good one map it to an AgentCall and return handleAgentCall(connection, call).
//     // The caller's identity is ALWAYS `connection` (the session's), never a body value.
//     handle(input: unknown, connection: AgentConnection): Promise<AgentCallResult>;
//   }
//
//   // Connector id → its (unqualified) tool names. The resolver namespaces them
//   // `<connector>__<tool>` and keeps only the ones a connection is permitted.
//   type ConnectorToolset = Record<string, readonly string[]>;
//
//   interface ToolRegistry {
//     readonly coreTools: readonly ToolDefinition[];            // the always-available core tools
//     get(name: string): ToolDefinition | undefined;            // look one up by name
//     resolveTools(                                             // the list served to a connection
//       permissions: ConnectionPermissions,
//       connectorTools: ConnectorToolset,
//     ): readonly ToolDefinition[];
//   }
//
//   function createToolRegistry(deps: { pipeline: AgentCallPipeline }): ToolRegistry;
//
// The obligation acceptance criteria (4xx validation, SQL-injection parameter binding,
// secrets-from-env) live in the sibling `registry.obligations.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { createToolRegistry } from "./registry";
import type { AgentCall, AgentCallResult, AgentCallPipeline } from "../pipeline";
import type { AgentConnection } from "../context";
import type { ConnectionPermissions } from "../../db/agent-permissions";

// The core tools Warthog always makes available (design §6.2). Every one must be in
// the registry; the registry may namespace connector tools on top of these, and may
// register the collapse helpers (find_tools / call_tool) too, but THESE sixteen are
// the always-available core.
const EXPECTED_CORE_TOOLS = [
  "get_context",
  "get_skill",
  "request_identity_detail",
  "request_card",
  "check_approval",
  "collect_release",
  "remember",
  "search_memory",
  "list_tasks",
  "create_task",
  "update_task",
  "complete_task",
  "list_records",
  "save_record",
  "update_record",
  "log_activity",
] as const;

const CONN = "11111111-1111-1111-1111-111111111111";

// The resolved session connection a handler acts for (exactly E07-S09's shape).
function connectionFor(userId: string): AgentConnection {
  return { userId, connectionId: CONN, agentId: CONN, active: true };
}

// A full ConnectionPermissions record; a test overrides only what it is about.
function permsWith(
  grantedConnectors: string[],
  overrides: Partial<ConnectionPermissions> = {},
): ConnectionPermissions {
  return {
    userId: "user-1",
    connectionId: CONN,
    grantedConnectors,
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  };
}

// A pipeline spy that records every handleAgentCall and returns a canned result, so a
// handler's "did it route to the pipeline, and with what call?" is observed directly.
function spyPipeline(result: AgentCallResult = { status: "executed", result: { ok: true } }) {
  const calls: { connection: AgentConnection; call: AgentCall }[] = [];
  const pipeline: AgentCallPipeline = {
    async handleAgentCall(connection: AgentConnection, call: AgentCall): Promise<AgentCallResult> {
      calls.push({ connection, call });
      return result;
    },
    async executeApprovedHold() {
      return { status: "refused" as const, reason: "unused in these tests" };
    },
  };
  return { pipeline, calls };
}

// Read a tool's `reason` sub-schema defensively (the input schema is a z.object, which
// exposes `.shape` at runtime). Returns undefined when the schema is not an object or
// has no `reason` — so the test asserts a HELPFUL failure rather than throwing.
function reasonSubschema(schema: unknown): z.ZodType | undefined {
  const shape = (schema as { shape?: Record<string, z.ZodType> } | null)?.shape;
  return shape?.reason;
}

const names = (tools: readonly { name: string }[]): string[] => tools.map((t) => t.name);

// ===========================================================================
// AC "The registry includes the core tools …"
// ===========================================================================

test("the registry includes every always-available core tool", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });

  const core = names(registry.coreTools);
  for (const name of EXPECTED_CORE_TOOLS) {
    assert.ok(core.includes(name), `the registry must include the core tool "${name}"`);
  }

  // Each core tool is also resolvable by name through get().
  for (const name of EXPECTED_CORE_TOOLS) {
    const def = registry.get(name);
    assert.ok(def, `get("${name}") must return a tool definition`);
    assert.equal(def!.name, name, "the looked-up tool carries its own name");
  }
});

// ===========================================================================
// AC "… and every tool definition carries an optional reason field."
// ===========================================================================

test("every core tool's input schema carries an OPTIONAL string `reason` field", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });

  for (const def of registry.coreTools) {
    const reason = reasonSubschema(def.inputSchema);
    assert.ok(reason, `tool "${def.name}" must expose a \`reason\` field in its input schema`);

    // Optional: an absent reason validates (the agent need not supply one).
    assert.equal(
      reason!.safeParse(undefined).success,
      true,
      `\`reason\` on "${def.name}" must be OPTIONAL`,
    );
    // Typed string: a provided reason must be a string …
    assert.equal(
      reason!.safeParse("because the user asked").success,
      true,
      `\`reason\` on "${def.name}" must accept a string`,
    );
    // … and a non-string reason is rejected (so it is a real string field, not `any`).
    assert.equal(
      reason!.safeParse(12345).success,
      false,
      `\`reason\` on "${def.name}" must reject a non-string`,
    );
  }
});

// Review fix D1: every tool tools/list serves says what it does in words (not just its
// name), and routes only its VALIDATED fields — an unknown extra field is dropped rather
// than forwarded to the body or stored in the activity record.
test("every core tool carries a plain-English description, not just its name", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });
  for (const def of registry.coreTools) {
    assert.ok(def.description.trim().length > 20, `"${def.name}" must describe what it does`);
    assert.notEqual(def.description, def.name, `"${def.name}"'s description must not be its name`);
  }
});

test("a core tool routes only its validated fields as params", async () => {
  const { pipeline, calls } = spyPipeline();
  const registry = createToolRegistry({ pipeline });
  await registry.get("remember")!.handle(
    { content: "likes tea", reason: "noted", userId: "SPOOF" },
    connectionFor("session-person"),
  );
  assert.deepEqual(calls[0]!.call.params, { content: "likes tea", reason: "noted" });
});

// ===========================================================================
// A core-tool handler is WIRED TO THE PIPELINE: it maps the tool input to an
// AgentCall and routes it through handleAgentCall, taking the caller's identity from
// the session connection it is given (never from the input).
// ===========================================================================

test("a core READ tool's handler routes the call through the pipeline under the session connection", async () => {
  const { pipeline, calls } = spyPipeline({ status: "executed", result: { context: "ok" } });
  const registry = createToolRegistry({ pipeline });

  const getContext = registry.get("get_context");
  assert.ok(getContext, "get_context is a core tool");

  const session = connectionFor("session-person");
  const result = await getContext!.handle({ reason: "catching up" }, session);

  assert.equal(calls.length, 1, "a valid call is routed to the pipeline exactly once");
  const routed = calls[0];
  assert.equal(routed.call.tool, "get_context", "the routed call names the tool");
  assert.equal(routed.call.connector, null, "a core tool has no connector");
  assert.equal(routed.call.makesChange, false, "get_context is a read (makes no change)");
  assert.equal(
    routed.connection.userId,
    session.userId,
    "the pipeline is called with the SESSION connection's identity",
  );
  assert.equal(
    routed.connection.connectionId,
    session.connectionId,
    "the session connection is forwarded unchanged",
  );
  assert.deepEqual(result, { status: "executed", result: { context: "ok" } }, "the handler returns the pipeline's result");
});

// ===========================================================================
// AC "Resolving the tool list for a connection returns the core tools plus only the
// connector tools it is permitted, namespaced <connector>__<tool>."
// ===========================================================================

test("resolveTools always includes the core tools", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });

  const resolved = names(registry.resolveTools(permsWith(["gmail"]), { gmail: ["messages_list"] }));
  for (const name of EXPECTED_CORE_TOOLS) {
    assert.ok(resolved.includes(name), `the resolved list must include the core tool "${name}"`);
  }
});

test("resolveTools includes ONLY the permitted connectors' tools, namespaced <connector>__<tool>", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });

  // gmail is granted; slack is NOT. Both have tools in the supplied set.
  const resolved = names(
    registry.resolveTools(permsWith(["gmail"]), {
      gmail: ["messages_list", "messages_send"],
      slack: ["post_message"],
    }),
  );

  assert.ok(resolved.includes("gmail__messages_list"), "a permitted connector's tool is namespaced <connector>__<tool>");
  assert.ok(resolved.includes("gmail__messages_send"), "every permitted connector tool is listed, namespaced");
  assert.ok(
    !resolved.includes("slack__post_message"),
    "a connector that is NOT permitted contributes no tools",
  );
  // The bare (un-namespaced) tool name must not leak in — the namespace is required.
  assert.ok(!resolved.includes("messages_list"), "connector tools appear only namespaced, never bare");
});

test("resolveTools namespaces a hyphenated connector id with the <connector>__<tool> separator", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });

  const resolved = names(
    registry.resolveTools(permsWith(["google-calendar"]), { "google-calendar": ["events_list"] }),
  );
  assert.ok(
    resolved.includes("google-calendar__events_list"),
    "the connector id and tool are joined by a double underscore",
  );
});

// ===========================================================================
// AC "When the permitted tool count exceeds 80 the connector tools collapse into
// find_tools plus call_tool."  (Tested far from the boundary — a handful stays
// expanded, a very large set collapses — so the exact threshold and whether the core
// tools count toward it stay the implementation's call.)
// ===========================================================================

test("a small permitted connector set stays expanded (no find_tools / call_tool)", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });

  const fiveTools = ["messages_list", "messages_send", "messages_get", "threads_list", "labels_list"];
  const resolved = names(registry.resolveTools(permsWith(["gmail"]), { gmail: fiveTools }));

  for (const tool of fiveTools) {
    assert.ok(resolved.includes(`gmail__${tool}`), `a small set lists "gmail__${tool}" individually`);
  }
  assert.ok(!resolved.includes("find_tools"), "a small set is not collapsed, so there is no find_tools");
  assert.ok(!resolved.includes("call_tool"), "a small set is not collapsed, so there is no call_tool");
});

test("a very large permitted connector set collapses into find_tools + call_tool", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });

  const manyTools = Array.from({ length: 200 }, (_unused, i) => `tool_${i}`);
  const resolved = names(registry.resolveTools(permsWith(["bigco"]), { bigco: manyTools }));

  assert.ok(resolved.includes("find_tools"), "over the limit, the connector tools collapse into find_tools");
  assert.ok(resolved.includes("call_tool"), "over the limit, the connector tools collapse into call_tool");

  // The individual connector tools are gone (collapsed away), …
  assert.ok(!resolved.includes("bigco__tool_0"), "a collapsed connector tool is not listed individually");
  assert.ok(!resolved.includes("bigco__tool_199"), "no individual collapsed connector tool is listed");

  // … but the core tools are still all present.
  for (const name of EXPECTED_CORE_TOOLS) {
    assert.ok(resolved.includes(name), `collapsing connector tools keeps the core tool "${name}"`);
  }
});

// Review fix: an agent's currency code reaches the pipeline as an ISO code ("usd" and
// " AUD " are AUD/USD), so a lower-case code is never treated as a foreign currency.
test("request_card hands the pipeline the currency code upper-cased and trimmed", async () => {
  const { pipeline, calls } = spyPipeline();
  const registry = createToolRegistry({ pipeline });

  await registry.get("request_card")!.handle(
    { amount: 10, currency: " aud ", merchant: "Acme" },
    connectionFor("user-1"),
  );

  assert.equal(calls[0]?.call.currency, "AUD");
});

// Review fix W6: a card release now hands over everything a checkout needs, so
// collect_release tells the agent which fields a card comes back with.
test("collect_release's description names every field a released card carries", () => {
  const { pipeline } = spyPipeline();
  const registry = createToolRegistry({ pipeline });
  const def = registry.coreTools.find((tool) => tool.name === "collect_release");
  assert.ok(def, "collect_release is a core tool");
  for (const field of ["number", "securityCode", "expiryMonth", "expiryYear", "cardholderName", "billingAddress"]) {
    assert.ok(def!.description.includes(field), `the description names "${field}"; got: ${def!.description}`);
  }
});
