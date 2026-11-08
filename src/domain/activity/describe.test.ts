// Review fix W2.1 — what an activity entry reads as on the Activity page and the Home feed
// (`./describe`). The build's E2E found every agent call listed as "Tool call" next to a raw
// id; a person should read WHAT the agent did, in plain words, and WHICH agent did it.
//
// Pure domain module: no React, no DB. Behaviour only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { agentLabel, entryTitle, toolLabel } from "./describe";

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

test("an agent call is titled by its tool; any other entry by its kind", () => {
  assert.equal(entryTitle({ kind: "tool_call", tool: "remember" }), "Save a memory");
  assert.equal(entryTitle({ kind: "tool_call" }), "Tool call", "a tool call with no tool keeps its kind");
  assert.equal(entryTitle({ kind: "connection_change" }), "Connection change");
  assert.equal(entryTitle({ kind: "card_release", tool: "request_card" }), "Card release");
});

test("an agent is shown by the name the person gave it, never its raw id", () => {
  const names = new Map([["0f6e3c1a-1111-4222-8333-944455556666", "Claude on my laptop"]]);
  assert.equal(agentLabel(names, "0f6e3c1a-1111-4222-8333-944455556666"), "Claude on my laptop");
  assert.equal(agentLabel(names, undefined), undefined, "an entry with no agent names none");
  const unknown = agentLabel(names, "28e3dfa1-7fc1-47da-8d0c-583cf7794c38");
  assert.ok(unknown?.startsWith("Unknown agent"), `an id with no agent behind it reads as unknown, got ${unknown}`);
  assert.ok(!unknown?.includes("28e3dfa1-7fc1-47da-8d0c-583cf7794c38"), "the full raw id is never shown");
});
