import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarReversalFromResult, calendarReversalForEntry } from "./calendar-reversal";

test("calendar reversal metadata retains only a bounded opaque id from successful provider responses", () => {
  for (const provider of ["google-calendar", "microsoft-outlook-calendar"]) {
    const target = calendarReversalFromResult(`${provider}__create`, { status: 201,
      body: JSON.stringify({ id: "opaque+event/id=", summary: "Private", attendees: [{ email: "private@example.test" }] }),
    });
    assert.deepEqual(target, { tool: `${provider}__delete`, eventId: "opaque+event/id=" });
    assert.deepEqual(calendarReversalForEntry({ source: "warthog", kind: "tool_call", outcome: "executed",
      tool: `${provider}__create`, payload: { reversal: target } }), target);
  }
});

test("missing, malformed, unsafe and unsuccessful calendar results cannot create reversal targets", () => {
  for (const result of [null, {}, { status: 500, body: '{"id":"event"}' },
    { status: 201, body: "invalid json" }, { status: 201, body: "{}" }, { status: 201, body: "null" },
    { status: 201, body: '{"id":42}' }, { status: 201, body: '{"id":"https://evil.test"}' },
    { status: 201, body: '{"id":"[released value]"}' }, { status: 201, body: '{"id":"event"}', truncated: true },
    { status: 201, body: JSON.stringify({ id: "x".repeat(1025) }) },
  ]) assert.equal(calendarReversalFromResult("google-calendar__create", result), undefined);
  assert.equal(calendarReversalFromResult("google-calendar__delete", { status: 201, body: '{"id":"event"}' }), undefined);
});

test("old, agent-authored, failed and mismatched activity entries are unavailable for automatic undo", () => {
  const entry = { source: "warthog", kind: "tool_call", outcome: "executed", tool: "google-calendar__create",
    payload: { reversal: { tool: "google-calendar__delete", eventId: "event" } },
  };
  for (const changed of [{ payload: {} }, { source: "agent" }, { outcome: "refused" }, { kind: "agent_note" },
    { tool: "microsoft-outlook-calendar__create" },
    { payload: { reversal: { tool: "google-calendar__delete", eventId: "[released value]" } } },
  ]) assert.equal(calendarReversalForEntry({ ...entry, ...changed }), undefined);
});
