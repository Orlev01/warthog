// E07-S13 — the `log_activity` core tool (design §6.2 MCP server + §9 activity
// record; constitution principle 14 "Warthog writes the record, SHALL label
// agent-submitted summaries as reported by that agent, SHALL never treat an agent
// report as the source of truth").
//
// An agent calls `log_activity` to report a high-level outcome it just performed
// (a summary, optionally an amount, currency and the reference of a card release it
// used). Warthog writes ONE activity entry for it, labelled `source:
// "agent_reported"` — never `"warthog"` — so the record always distinguishes what
// Warthog itself handled from what an agent merely claims.
//
// A SERVER module built purely from its one INJECTED seam (the activity recorder):
// it reads no `process.env` and holds no secret (INV-103) — the clock, the
// released-value matcher and any key live behind the recorder it is handed, never in
// here. The handler VALIDATES its input at the boundary (zod → a 4xx `HttpError`
// BEFORE anything is written, INV-102); the agent's summary and every reported value
// travel in the payload, which the recorder runs through redaction (`src/domain/
// redaction`) before the entry is stored, so a card number or secret in the summary
// is masked and never lands readable in the record. The owning user id and agent id
// are ALWAYS taken from the session `connection`, never from a value in the input;
// every write the recorder makes is parameterized downstream, so a SQL-shaped field
// travels as a bound value and cannot alter a query.

import { z } from "zod";

import { parseParams } from "../../http/validate";
import type { ActivityEntry, ActivityRecorder } from "../../activity/recorder";
import type { AgentConnection } from "../context";

// The activity `kind` for an agent's self-reported summary: distinct from the
// `tool_call` entries Warthog writes itself for a handled call.
const KIND = "agent_report";

// Field caps, so a grossly oversized value is refused at the boundary before any
// write (INV-102). `reason` matches the registry's envelope cap (design §6.2 "every
// tool takes an optional reason").
const MAX_REASON = 2000;
const MAX_CURRENCY = 10;
const MAX_CARD_RELEASE = 200;

// The validated input: the universal optional `reason` plus the optional reported
// amount (a positive number), currency and card-release reference. A z.object, so
// its `.shape` exposes each field (the registry and tests read `.shape.reason`).
const inputSchema = z.object({
  reason: z.string().max(MAX_REASON).optional(),
  amount: z.number().positive().optional(),
  currency: z.string().min(1).max(MAX_CURRENCY).optional(),
  cardRelease: z.string().min(1).max(MAX_CARD_RELEASE).optional(),
});

type LogActivityInput = z.infer<typeof inputSchema>;

// One resolvable MCP tool (the sibling `registry.ts`'s `ToolDefinition` shape),
// specialised to write the entry directly through the recorder rather than route a
// policy-gated call: `log_activity` records, it does not touch a connected service.
export interface LogActivityTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<ActivityEntry>;
}

export interface LogActivityDeps {
  readonly recorder: ActivityRecorder;
}

// Build the payload carried on the entry: only the fields the agent actually
// supplied, so the stored (redacted) payload stays minimal.
function payloadOf(parsed: LogActivityInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (parsed.reason !== undefined) payload.reason = parsed.reason;
  if (parsed.amount !== undefined) payload.amount = parsed.amount;
  if (parsed.currency !== undefined) payload.currency = parsed.currency;
  if (parsed.cardRelease !== undefined) payload.cardRelease = parsed.cardRelease;
  return payload;
}

export function createLogActivityTool(deps: LogActivityDeps): LogActivityTool {
  const { recorder } = deps;

  return {
    name: "log_activity",
    inputSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<ActivityEntry> {
      // VALIDATE at the boundary: a bad / oversized / mis-shaped input throws a 4xx
      // `HttpError` BEFORE the recorder is ever called.
      const parsed = parseParams(inputSchema, input);

      // Write ONE entry, labelled reported-by-agent, with the identity taken from
      // the session connection (never a body value). The recorder redacts the
      // payload before it is stored.
      return recorder.record({
        userId: connection.userId,
        kind: KIND,
        source: "agent_reported",
        agentId: connection.agentId,
        payload: payloadOf(parsed),
      });
    },
  };
}
