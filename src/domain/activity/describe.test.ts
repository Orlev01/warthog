// Review fix W2.1 — what an activity entry reads as on the Activity page and the Home feed
// (`./describe`). The build's E2E found every agent call listed as "Tool call" next to a raw
// id; a person should read WHAT the agent did, in plain words, and WHICH agent did it.
//
// Pure domain module: no React, no DB. Behaviour only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { agentLabel, entryTitle, kindLabel, toolLabel } from "./describe";

test("Warthog's own tools read in plain words", () => {
  assert.equal(toolLabel("remember"), "Save a memory");
  assert.equal(toolLabel("search_memory"), "Search memory");
  assert.equal(toolLabel("create_task"), "Add a task");
  assert.equal(toolLabel("complete_task"), "Mark a task done");
  assert.equal(toolLabel("save_record"), "Save a record");
  assert.equal(toolLabel("request_card"), "Ask to use a card");
  assert.equal(toolLabel("request_identity_detail"), "Ask for an identity detail");
  assert.equal(toolLabel("get_context"), "Read its context");
});

test("a connected service's tool reads as its own tool name, without the service prefix", () => {
  assert.equal(toolLabel("google_calendar__create_event"), "Create event");
  assert.equal(toolLabel("gmail__send"), "Send");
  assert.equal(toolLabel("google-calendar__request"), "Request");
});

test("an unknown tool name is tidied into words rather than shown as a code", () => {
  assert.equal(toolLabel("frobnicate_widgets"), "Frobnicate widgets");
  assert.equal(toolLabel("some-tool"), "Some tool");
});

test("an agent call is titled by its tool; any other entry by its kind's plain label", () => {
  assert.equal(entryTitle({ kind: "tool_call", tool: "remember" }), "Save a memory");
  assert.equal(entryTitle({ kind: "tool_call" }), "Agent request", "a tool call with no tool keeps its kind's label");
  assert.equal(entryTitle({ kind: "connection_change" }), "Connection change");
  assert.equal(entryTitle({ kind: "card_release", tool: "request_card" }), "Card release");
});

// UI/UX pass (content-03): the title used humanise(kind), so members saw "Agent key replaced"
// and "Tool rejected" while the Event filter offered the proper labels for the same entries.
test("titles use the same plain labels as the Event filter", () => {
  assert.equal(entryTitle({ kind: "agent_key_replaced" }), "Access key replaced");
  assert.equal(entryTitle({ kind: "agent_key_revoked" }), "Access key revoked");
  assert.equal(entryTitle({ kind: "tool_rejected", tool: "remember" }), "Request blocked");
  assert.equal(entryTitle({ kind: "protocol_rejected" }), "Request couldn't be read");
  assert.equal(entryTitle({ kind: "client_observed" }), "Client details reported");
  assert.equal(entryTitle({ kind: "identity_release" }), "Identity detail release");
  assert.equal(entryTitle({ kind: "run_status" }), "Conversation status update");
  for (const kind of ["agent_key_replaced", "tool_rejected", "client_observed", "memory_scope_change"]) {
    assert.equal(entryTitle({ kind }), kindLabel(kind), `${kind}: title and filter label agree`);
  }
});

test("a connection change says what happened to the connection", () => {
  assert.equal(entryTitle({ kind: "connection_change", outcome: "connected", connectorId: "google-gmail" }), "Service connected");
  assert.equal(entryTitle({ kind: "connection_change", outcome: "disconnected", connectorId: "google-gmail" }), "Service disconnected");
  assert.equal(entryTitle({ kind: "connection_change", outcome: "disconnected", agentId: "a1" }), "Agent disconnected");
  assert.equal(entryTitle({ kind: "connection_change", outcome: "something_new" }), "Connection change");
});

test("an agent is shown by the name the person gave it, never its raw id", () => {
  const names = new Map([["0f6e3c1a-1111-4222-8333-944455556666", "Claude on my laptop"]]);
  assert.equal(agentLabel(names, "0f6e3c1a-1111-4222-8333-944455556666"), "Claude on my laptop");
  assert.equal(agentLabel(names, undefined), undefined, "an entry with no agent names none");
  const unknown = agentLabel(names, "28e3dfa1-7fc1-47da-8d0c-583cf7794c38");
  assert.equal(unknown, "Removed agent", "an id with no agent of theirs behind it reads as a removed agent");
  assert.ok(!unknown?.includes("28e3dfa1"), "no part of the raw id is shown");
});

test("recorded kinds read in words for filters, and an intent record names the change it starts", () => {
  assert.equal(kindLabel("tool_call"), "Agent request");
  assert.equal(kindLabel("tool_attempt"), "Change started");
  assert.equal(kindLabel("card_release"), "Card release");
  assert.equal(kindLabel("brand_new_kind"), "Brand new kind");
  assert.equal(entryTitle({ kind: "tool_attempt", tool: "remember" }), "Started: Save a memory");
});
