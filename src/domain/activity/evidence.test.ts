// What an activity entry's evidence reads as (`./evidence`, UI/UX pass content-01): the one
// screen members use to check what an agent did showed pretty-printed JSON with camelCase
// keys, the member's own user id, connection ids, request/attempt UUIDs, a SHA-256 "policy
// version" and quoted enum values. Entries now read as labelled plain-English lines, and
// the identifiers that make an entry checkable sit apart, unchanged, as technical details.
//
// Pure domain module: no React, no DB. Behaviour only.

import { test } from "node:test";
import assert from "node:assert/strict";

import { activityEvidence, withoutMatchedIntents, type ActivityEvidence } from "./evidence";

const USER = "7c23ea72-37f9-4ead-ac75-cb6b17202e3e";
const CONNECTION = "877655a6-2441-4765-a2b0-735cbea91f8c";
const REQUEST = "3a44a78e-e89f-40f7-b8b1-2d32163ec452";
const ATTEMPT = "ded26a88-4109-4def-b768-b76bcf9eff0e";
const FINGERPRINT = "a45e488286bb72b1cae9925c8723f63dc0bf9c33caf6fff35c5ec0d4f6109034";
const REFERENCE = "443fdb02-4c88-4ef0-8979-f53c428bf8d8";

// A change an agent made through the pipeline, exactly as the pipeline records it.
const addTask = {
  kind: "tool_call",
  tool: "create_task",
  outcome: "executed",
  seq: 14,
  entryHash: "f".repeat(64),
  payload: {
    params: { title: "Cancel the unused streaming trial" },
    requestId: REQUEST,
    attemptId: ATTEMPT,
    policyFingerprint: FINGERPRINT,
    decision: { decision: "allow", reason: "Allowed." },
    durationMs: 6,
    resultEvidence: { outcome: "executed", reference: REFERENCE },
  },
};

function value(evidence: ActivityEvidence, label: string, list: "facts" | "technical" = "facts"): string | undefined {
  return evidence[list].find((line) => line.label === label)?.value;
}

// Everything a member reads without opening Technical details.
function readable(evidence: ActivityEvidence): string {
  return [evidence.summary, evidence.detail, ...evidence.facts.map((line) => `${line.label} ${line.value}`)].join("\n");
}

test("an agent's change reads as what it asked for, Warthog's decision and the result", () => {
  const evidence = activityEvidence(addTask);
  assert.equal(value(evidence, "What it asked for"), "Title: Cancel the unused streaming trial");
  assert.equal(value(evidence, "Warthog's decision"), "Allowed");
  assert.equal(value(evidence, "Result"), "Done");
  const shown = readable(evidence);
  for (const raw of [REQUEST, ATTEMPT, FINGERPRINT, REFERENCE, "{", "\"", "resultEvidence", "executed", "Policy decision"]) {
    assert.ok(!shown.includes(raw), `the readable lines never show ${raw}: ${shown}`);
  }
});

test("the identifiers that make an entry checkable are kept, unchanged, as technical details", () => {
  const evidence = activityEvidence(addTask);
  assert.equal(value(evidence, "Entry number", "technical"), "14");
  assert.equal(value(evidence, "Request ID", "technical"), REQUEST);
  assert.equal(value(evidence, "Attempt ID", "technical"), ATTEMPT);
  assert.equal(value(evidence, "Policy version", "technical"), FINGERPRINT);
  assert.equal(value(evidence, "Result reference", "technical"), REFERENCE);
  assert.equal(value(evidence, "Time taken", "technical"), "6 ms");
  assert.equal(value(evidence, "Record fingerprint", "technical"), "f".repeat(64));
});

test("a new agent's access reads as a sentence, and the member's own ids are never shown", () => {
  const evidence = activityEvidence({
    kind: "agent_connected",
    outcome: "saved",
    payload: {
      actor: "account_owner",
      changes: {
        credentialKind: "access_key",
        grants: { userId: USER, connectionId: CONNECTION, identityAccess: true, highTierAccess: false, memoryRead: true, memoryWrite: true, tasksAccess: true, recordsAccess: true, grantedConnectors: [], cardAccess: false, rateLimit: 120 },
      },
    },
  });
  assert.equal(value(evidence, "How it connects"), "Access key");
  const access = value(evidence, "Access it was given") ?? "";
  for (const part of ["Everyday details on", "Protected details off", "Save memories on", "Services none", "Card requests off", "120 requests a minute"]) {
    assert.ok(access.includes(part), `the access sentence says "${part}": ${access}`);
  }
  assert.equal(evidence.changedBy, "you", "an owner's change is marked as the member's own");
  const everything = JSON.stringify(evidence);
  assert.ok(!everything.includes(USER), "the member's user id is never shown, not even as a technical detail");
  assert.ok(!everything.includes(CONNECTION), "nor a connection id");
  assert.ok(!everything.includes("account_owner"), "nor the raw actor code");
});

test("a blocked request names the reason in Warthog's words", () => {
  const evidence = activityEvidence({
    kind: "tool_call",
    tool: "request_card",
    outcome: "denied",
    payload: { params: { amount: 420, currency: "AUD", merchant: "Qantas" }, decision: { decision: "deny", reason: "Card access is turned off for this agent." }, resultEvidence: { outcome: "denied" } },
  });
  assert.equal(value(evidence, "Warthog's decision"), "Blocked. Card access is turned off for this agent.");
  assert.equal(value(evidence, "What it asked for"), "Amount: 420\nCurrency: AUD\nMerchant: Qantas");
  assert.equal(value(evidence, "Result"), "Denied");
});

test("a request refused before it ran says why, without the stored code", () => {
  const evidence = activityEvidence({ kind: "tool_rejected", outcome: "refused", payload: { requestId: REQUEST, summary: "Tool input rejected before execution", reason: "invalid_input" } });
  assert.equal(evidence.summary, "Blocked before it ran: the request wasn't in a form Warthog accepts.");
  assert.ok(!readable(evidence).includes("invalid_input"));
  assert.ok(!readable(evidence).includes("Agent's reason"), "a rejection code is Warthog's reason, never the agent's");
  assert.equal(value(evidence, "Request ID", "technical"), REQUEST);
});

test("an agent's reason is labelled as the agent's, once", () => {
  const evidence = activityEvidence({ kind: "tool_call", tool: "search_memory", outcome: "executed", payload: { reason: "Checking your seat preference", resultEvidence: { outcome: "executed" } } });
  assert.equal(evidence.summary, "Agent's reason: Checking your seat preference");
  const shown = readable(evidence);
  assert.ok(!/Stated reason|Supplied reason/.test(shown));
  assert.equal(shown.split("Checking your seat preference").length - 1, 1, "the reason appears once, in the summary");
});

test("a changed setting reads as before → after", () => {
  const evidence = activityEvidence({
    kind: "permission_change",
    outcome: "saved",
    payload: { before: { userId: USER, tasksAccess: false, rateLimit: 60, changeTools: "off" }, after: { userId: USER, tasksAccess: true, rateLimit: 60, changeTools: "ask_first" }, skillChoices: [{ id: REQUEST, granted: true }, { id: ATTEMPT, granted: false }] },
  });
  assert.equal(value(evidence, "What changed"), "Tasks: off → on\nMake changes in services: off → ask me first");
  assert.equal(value(evidence, "Skill choices"), "1 allowed, 1 not allowed");
  assert.equal(evidence.changedBy, "you");
});

test("an intent record explains itself and pairs with its result; an unmatched one stays", () => {
  const intent = activityEvidence({ ...addTask, kind: "tool_attempt", outcome: "attempted", payload: { ...addTask.payload, resultEvidence: { outcome: "attempted" } } });
  assert.equal(intent.intent, true);
  assert.equal(intent.attemptId, ATTEMPT);
  assert.match(value(intent, "About this entry") ?? "", /doesn't confirm the change finished/);
  const result = { ...activityEvidence(addTask), seq: 15 };
  const orphan = { ...activityEvidence({ ...addTask, kind: "tool_attempt", payload: { ...addTask.payload, attemptId: "other" } }), seq: 13 };
  const rows = [result, { ...intent, seq: 14 }, orphan];
  assert.deepEqual(withoutMatchedIntents(rows).map((row) => row.seq), [15, 13], "the matched intent is dropped; an unmatched one stays");
  assert.deepEqual(withoutMatchedIntents(rows, (row) => row.seq === 14).map((row) => row.seq), [15, 14, 13], "a kept row (a disputed one) stays");
});

test("an older call with no recorded result says so plainly", () => {
  const evidence = activityEvidence({ kind: "tool_call", tool: "remember", outcome: "executed", payload: {} });
  assert.match(value(evidence, "Result") ?? "", /^Done, as recorded at the time\./);
  assert.ok(!readable(evidence).includes("Historical outcome"));
});

test("unknown payload fields are never dumped", () => {
  const evidence = activityEvidence({ kind: "brand_new_kind", payload: { secretish: "do not show", nested: { deep: 1 } } });
  assert.ok(!JSON.stringify(evidence).includes("do not show"));
  assert.equal(evidence.detail, "No other details were recorded for this entry.");
});

test("an entry names its agent conversation and the product it came through, as reported", () => {
  const RUN = "5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e";
  const evidence = activityEvidence({ ...addTask, payload: { ...addTask.payload, run: { id: RUN, label: "Tidying the trial subscriptions" }, via: "Claude Code" } });
  assert.deepEqual(evidence.conversation, { id: RUN, label: "Tidying the trial subscriptions" });
  assert.equal(evidence.via, "Claude Code");
  assert.equal(value(evidence, "Conversation (as the agent described it)"), "Tidying the trial subscriptions");
  assert.equal(value(evidence, "Came through (as the app reported it)"), "Claude Code");
  assert.equal(value(evidence, "Conversation ID", "technical"), RUN);

  const unnamed = activityEvidence({ ...addTask, payload: { ...addTask.payload, run: { id: RUN } } });
  assert.deepEqual(unnamed.conversation, { id: RUN });
  assert.equal(value(unnamed, "Conversation (as the agent described it)"), undefined);

  const before = activityEvidence(addTask);
  assert.equal(before.conversation, undefined, "older entries have no conversation");
  assert.equal(before.via, undefined);
  for (const junk of [{ run: "x" }, { run: { id: 7 } }, { run: { id: "" } }]) {
    assert.equal(activityEvidence({ ...addTask, payload: { ...addTask.payload, ...junk } }).conversation, undefined);
  }
});

test("what Warthog's read check kept from the agent reads in words, counts only", () => {
  const read = { ...addTask, tool: "google-gmail__read", payload: { ...addTask.payload, resultEvidence: { outcome: "executed", status: 200, guard: { outcome: "masked", counts: { codes: 1, signInLinks: 2, hiddenCharacters: 3 } } } } };
  assert.match(value(activityEvidence(read), "Result") ?? "", /Kept from the agent: 1 sign-in code, 2 sign-in links/);
  const withheld = { ...read, payload: { ...read.payload, resultEvidence: { outcome: "executed", guard: { outcome: "withheld" } } } };
  assert.match(value(activityEvidence(withheld), "Result") ?? "", /couldn't check this, so the agent wasn't shown it/);
});
