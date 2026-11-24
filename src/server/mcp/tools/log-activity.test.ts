// E07-S13 — the `log_activity` core tool (`src/server/mcp/tools/log-activity.ts`,
// design §6.2 MCP server + §9 activity record; constitution principle 14 "Warthog
// writes the record, SHALL label agent-submitted summaries as reported by that
// agent, SHALL never treat an agent report as the source of truth").
//
// RED-first: `./log-activity` does not exist yet, so importing `createLogActivityTool`
// throws and every test here fails until the builder writes the minimum code to pass.
// That absence IS the point of test-first; do NOT implement anything to make these
// pass — the builder writes `log-activity.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the tool WRITES and from where it takes identity),
// never the source text of any module — a later rename that preserves behaviour must
// not redden them. The tool body is exercised against the REAL redacting/chaining
// in-memory recorder (`../../activity/recorder`), so "what did it actually store, and
// was it redacted?" is observed on the stored entry; identity is asserted by handing
// the SAME body through two different session connections.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import { z } from "zod";
//   import type { AgentConnection } from "../context";
//   import type { ActivityEntry, ActivityRecorder } from "../../activity/recorder";
//
//   interface LogActivityTool {
//     readonly name: string;           // "log_activity"
//     readonly inputSchema: z.ZodType;  // a z.object(...) exposing an OPTIONAL string `reason` in its .shape,
//                                        // plus optional `amount` (positive number), `currency`, `cardRelease`.
//     // Validate `input` (a bad / oversized / mis-shaped input THROWS HttpError 4xx
//     // BEFORE anything is written); then write ONE activity entry through the
//     // recorder with source "agent_reported", the agent id and owning user id taken
//     // from `connection` (never a body value), the summary/amount/currency/
//     // cardRelease/reason carried in the recorder-redacted payload.
//     handle(input: unknown, connection: AgentConnection): Promise<ActivityEntry>;
//   }
//
//   function createLogActivityTool(deps: { recorder: ActivityRecorder }): LogActivityTool;
//
// The obligation acceptance criteria (4xx validation BEFORE any write, SQL-injection
// parameter binding, secrets-from-env) live in the sibling
// `log-activity.obligations.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLogActivityTool } from "./log-activity";
import {
  createInMemoryRecorder,
  type ActivityEntry,
  type ActivityEntryInput,
  type ActivityRecorder,
} from "../../activity/recorder";
import { fixedClock } from "../../seams/clock";
import type { AgentConnection } from "../context";

const NOW = new Date("2026-11-20T09:30:00.000Z");
const USER = "owner-person-1";
const CONN_ID = "conn-7b3";
const AGENT_ID = "agent-9f2";

// The resolved session connection a tool body acts for (exactly E07-S09's shape).
// The owning user id and agent id are the connection's — NEVER a body value.
function connectionFor(userId: string, agentId = AGENT_ID, connectionId = CONN_ID): AgentConnection {
  return { userId, connectionId, agentId, active: true };
}

// Wrap the REAL redacting/chaining in-memory recorder so a test can observe both what
// the tool handed the recorder and the stored (post-redaction) entry it returns. The
// optional per-user released-value matcher lets a redaction test flag one token.
function capturingRecorder(matchesReleased?: (userId: string, token: string) => boolean) {
  const base = createInMemoryRecorder({ clock: fixedClock(NOW), matchesReleased });
  const inputs: ActivityEntryInput[] = [];
  const entries: ActivityEntry[] = [];
  const recorder: ActivityRecorder = {
    async record(input: ActivityEntryInput): Promise<ActivityEntry> {
      inputs.push(input);
      const entry = await base.record(input);
      entries.push(entry);
      return entry;
    },
  };
  return { recorder, inputs, entries };
}

// Read a tool's `reason` sub-schema defensively (the input schema is a z.object, which
// exposes `.shape` at runtime). Returns undefined when the schema is not an object or
// has no `reason`, so the test asserts a HELPFUL failure rather than throwing.
function reasonSubschema(schema: unknown): { safeParse(v: unknown): { success: boolean } } | undefined {
  const shape = (schema as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> } | null)?.shape;
  return shape?.reason;
}

const payloadOf = (entry: ActivityEntry): Record<string, unknown> =>
  entry.payload as Record<string, unknown>;

// ===========================================================================
// AC "log_activity writes an activity entry with source agent_reported and the agent
// id, with the reason stored."
// ===========================================================================

test("log_activity writes ONE agent_reported entry, with the agent id and the reason stored", async () => {
  const { recorder, entries } = capturingRecorder();
  const tool = createLogActivityTool({ recorder });

  await tool.handle(
    { reason: "booked the flights and emailed the itinerary" },
    connectionFor(USER),
  );

  assert.equal(entries.length, 1, "exactly one activity entry is written");
  const entry = entries[0]!;
  assert.equal(entry.source, "agent_reported", "the entry is labelled reported-by-agent");
  assert.equal(entry.agentId, AGENT_ID, "the agent id comes from the connection");
  assert.equal(entry.userId, USER, "the owning user comes from the connection");
  assert.equal(
    payloadOf(entry).reason,
    "booked the flights and emailed the itinerary",
    "the agent's reason (its summary) is stored",
  );
});

// ===========================================================================
// Identity is ALWAYS the session connection's — never a body value. The SAME body
// handed through two different connections yields two entries, each carrying its own
// connection's owning user id and agent id; the source is always agent_reported, so a
// client can never relabel its own report as a Warthog record.
// ===========================================================================

test("log_activity takes the owning user and agent id from the connection, never the body", async () => {
  const { recorder, entries } = capturingRecorder();
  const tool = createLogActivityTool({ recorder });

  const body = { reason: "the identical reported summary" };
  await tool.handle(body, connectionFor("person-A", "agent-A", "conn-A"));
  await tool.handle(body, connectionFor("person-B", "agent-B", "conn-B"));

  assert.equal(entries.length, 2, "each call writes its own entry");

  assert.equal(entries[0]!.userId, "person-A", "the first entry is scoped to the first connection's user");
  assert.equal(entries[0]!.agentId, "agent-A", "the first entry carries the first connection's agent id");
  assert.equal(entries[1]!.userId, "person-B", "the second entry is scoped to the second connection's user");
  assert.equal(entries[1]!.agentId, "agent-B", "the second entry carries the second connection's agent id");

  for (const entry of entries) {
    assert.equal(entry.source, "agent_reported", "every log_activity entry is reported-by-agent, never 'warthog'");
  }
});

// ===========================================================================
// AC "… an agent-reported activity summary (optional amount, currency, card-release
// reference) …" — the optional fields, when supplied, are recorded on the entry.
// ===========================================================================

test("log_activity records the optional amount, currency and card-release reference", async () => {
  const { recorder, entries } = capturingRecorder();
  const tool = createLogActivityTool({ recorder });

  await tool.handle(
    { reason: "paid the deposit", amount: 73.5, currency: "AUD", cardRelease: "rel-2026-abc" },
    connectionFor(USER),
  );

  const payload = payloadOf(entries[0]!);
  assert.equal(payload.amount, 73.5, "the reported amount is recorded");
  assert.equal(payload.currency, "AUD", "the reported currency is recorded");
  assert.equal(payload.cardRelease, "rel-2026-abc", "the card-release reference is recorded");
});

// ===========================================================================
// AC "Any card number or secret in the summary is redacted before the entry is
// written." The summary travels through the recorder's redaction (design §4.3), so a
// Luhn-valid card number is masked to its last four digits and the full number lands
// nowhere in the stored entry.
// ===========================================================================

test("a card number in the summary is masked before the entry is written", async () => {
  const { recorder, entries } = capturingRecorder();
  const tool = createLogActivityTool({ recorder });

  await tool.handle(
    { reason: "paid with card 4242424242424242 at the shop" },
    connectionFor(USER),
  );

  const reason = payloadOf(entries[0]!).reason as string;
  assert.ok(reason.includes("[card"), "the card number is replaced by the masked card token");
  assert.ok(reason.includes("4242"), "the masked token keeps only the last four digits");
  assert.ok(!reason.includes("4242424242424242"), "the full card number is not stored in the summary");
  // The full PAN appears NOWHERE in the stored entry — a redaction security invariant.
  assert.ok(
    !JSON.stringify(entries[0]).includes("4242424242424242"),
    "the full card number appears nowhere in the written entry",
  );
});

test("a released secret value in the summary is redacted before the entry is written", async () => {
  // The per-user released-value matcher recognises one token the agent was handed
  // (it is consulted with the NORMALISED token — lower-cased, alphanumerics only).
  const RELEASED = "tokenabc12345";
  const { recorder, entries } = capturingRecorder(
    (userId, token) => userId === USER && token === RELEASED,
  );
  const tool = createLogActivityTool({ recorder });

  await tool.handle(
    { reason: "used TOKENABC12345 to unlock the door" },
    connectionFor(USER),
  );

  const reason = payloadOf(entries[0]!).reason as string;
  assert.ok(reason.includes("[released value]"), "the released value is replaced");
  assert.ok(!/TOKENABC12345/i.test(reason), "the released value is not stored in clear");
});

// ===========================================================================
// The tool names itself and carries the universal optional `reason` field (design
// §6.2 "every tool takes an optional reason").
// ===========================================================================

test("the log_activity tool is named and carries an optional string `reason` in its input schema", () => {
  const { recorder } = capturingRecorder();
  const tool = createLogActivityTool({ recorder });

  assert.equal(tool.name, "log_activity", "the tool names itself log_activity");

  const reason = reasonSubschema(tool.inputSchema);
  assert.ok(reason, "the input schema exposes a `reason` field");
  assert.equal(reason!.safeParse(undefined).success, true, "`reason` is OPTIONAL");
  assert.equal(reason!.safeParse("a short note").success, true, "`reason` accepts a string");
  assert.equal(reason!.safeParse(12345).success, false, "`reason` rejects a non-string");
});

// Dogfood, 25 Nov 2026: the reply carried the person's user id and the audit chain's hashes,
// which an agent has no use for.
test("log_activity answers with what was logged and when, not Warthog's own record of it", async () => {
  const { recorder } = capturingRecorder();
  const tool = createLogActivityTool({ recorder });
  const result = await tool.handle({ reason: "booked the flights" }, connectionFor(USER));
  assert.deepEqual(Object.keys(result).sort(), ["occurredAt", "status"]);
  assert.equal(result.status, "logged");
});
