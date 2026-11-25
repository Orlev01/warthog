// What type of activity an entry is, and which outcome group it falls in (`./category`).
// The founder asked for the audit log to be organised by activity type — reads, changes and
// the rest — instead of one long thread. These rules read only plaintext metadata, so the
// same table drives SQL filtering and counting (`server/activity/category-sql`).
//
// Pure domain module: no React, no DB. Behaviour only.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_CATEGORIES,
  ATTENTION_OUTCOMES,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  activityCategory,
  agentRole,
  categoryCount,
  isActivityCategory,
  outcomeGroup,
  outcomeLabel,
} from "./category";

const reads = new Set(["search_memory", "get_context", "google-gmail__search"]);
const isRead = (tool: string) => reads.has(tool);
const cat = (kind: string, tool?: string, source = "warthog") => activityCategory({ kind, tool, source }, isRead);

test("an agent call is a read only when its tool is known to be read-only", () => {
  assert.equal(cat("tool_call", "search_memory"), "read");
  assert.equal(cat("tool_call", "google-gmail__search"), "read");
  assert.equal(cat("tool_attempt", "get_context"), "read");
  assert.equal(cat("tool_call", "remember"), "change");
  assert.equal(cat("tool_call", "google-gmail__send"), "change");
});

test("a tool whose effect Warthog cannot confirm counts as a change, never a read", () => {
  assert.equal(cat("tool_call", "unknown-service__request"), "change");
  assert.equal(cat("tool_call", "call_tool"), "change");
  assert.equal(cat("tool_call"), "change", "a tool call with no tool name is a change");
});

test("an agent's own report is never counted as a read or change", () => {
  assert.equal(cat("agent_report", undefined, "agent_reported"), "report");
  assert.equal(cat("run_status"), "report", "a conversation's status is the agent's own claim");
  assert.equal(cat("tool_call", "log_activity"), "report", "the Warthog row of the reporting call");
  assert.equal(cat("tool_attempt", "log_activity"), "report");
  assert.equal(cat("tool_call", "search_memory", "agent_reported"), "report", "agent-reported source always wins");
});

test("approvals, sensitive requests and releases group together", () => {
  for (const kind of ["approval_decision", "card_release", "identity_release"]) {
    assert.equal(cat(kind, "google-gmail__send"), "approval", kind);
  }
  for (const tool of ["request_card", "request_identity_detail", "check_approval", "collect_release"]) {
    assert.equal(cat("tool_call", tool), "approval", tool);
  }
});

test("rejected requests, connection and account changes have their own types", () => {
  assert.equal(cat("tool_rejected", "google-gmail__send"), "rejected", "a rejected call is not counted as a change");
  assert.equal(cat("protocol_rejected"), "rejected");
  for (const kind of ["agent_connected", "agent_key_revoked", "agent_key_replaced", "connection_change", "permission_change", "agent_defaults_change", "skill_access_change", "memory_scope_change", "client_observed"]) {
    assert.equal(cat(kind), "access", kind);
  }
  for (const kind of ["rule_created", "rule_updated", "rule_paused", "rule_deleted", "approval_expiry_change", "memory_created", "memory_updated", "memory_deleted", "account_imported"]) {
    assert.equal(cat(kind), "account", kind);
  }
});

test("a kind the rules do not know lands in Other, so new kinds never disappear", () => {
  assert.equal(cat("something_new"), "other");
});

test("every type has a label and a description", () => {
  for (const category of ACTIVITY_CATEGORIES) {
    assert.ok(CATEGORY_LABELS[category].length > 0, category);
    assert.ok(CATEGORY_DESCRIPTIONS[category].length > 0, category);
  }
  assert.ok(isActivityCategory("read"));
  assert.ok(!isActivityCategory("../settings"));
  assert.ok(!isActivityCategory(undefined));
});

test("outcomes group into done, waiting, blocked and failed; anything else is other", () => {
  assert.equal(outcomeGroup("executed"), "done");
  assert.equal(outcomeGroup("saved"), "done");
  assert.equal(outcomeGroup("pending_approval"), "waiting");
  assert.equal(outcomeGroup("attempted"), "waiting");
  assert.equal(outcomeGroup("denied"), "blocked");
  assert.equal(outcomeGroup("refused"), "blocked");
  assert.equal(outcomeGroup("rate_limited"), "blocked");
  assert.equal(outcomeGroup("failed"), "failed");
  assert.equal(outcomeGroup("unknown"), "failed", "an unknown result needs checking");
  assert.equal(outcomeGroup("needs_reconnect"), "failed");
  assert.equal(outcomeGroup("The reversal couldn't be completed."), "other", "an older Undo sentence is not a code");
  assert.equal(outcomeGroup(undefined), "other");
  assert.deepEqual([...ATTENTION_OUTCOMES].sort(), ["denied", "error", "expired", "failed", "needs_reconnect", "rate_limited", "refused", "unknown"]);
});

test("an agent acts in its calls and reports, but is the subject of an owner's change", () => {
  assert.equal(agentRole("tool_call"), "actor");
  assert.equal(agentRole("agent_report"), "actor");
  assert.equal(agentRole("run_status"), "actor");
  assert.equal(agentRole("tool_rejected"), "actor");
  assert.equal(agentRole("permission_change"), "subject");
  assert.equal(agentRole("approval_decision"), "subject");
  assert.equal(agentRole("connection_change"), "subject");
});

// UI/UX pass (content-04): outcomes read in the words people use, never the engine's codes.
test("outcomes read as Done, Waiting for you, Blocked, Failed and Undone, never as engine codes", () => {
  assert.equal(outcomeLabel("executed"), "Done");
  assert.equal(outcomeLabel("saved"), "Done", "an owner's saved change reads as done, not 'Saved'");
  assert.equal(outcomeLabel("reported"), "Done");
  assert.equal(outcomeLabel("pending_approval"), "Waiting for you");
  assert.equal(outcomeLabel("attempted"), "Not confirmed", "an intent record never claims the change finished");
  assert.equal(outcomeLabel("refused"), "Blocked");
  assert.equal(outcomeLabel("denied"), "Denied");
  assert.equal(outcomeLabel("rate_limited"), "Too many requests");
  assert.equal(outcomeLabel("needs_reconnect"), "Reconnect needed");
  assert.equal(outcomeLabel("reversed"), "Undone");
  assert.equal(outcomeLabel("connected"), "Connected");
});

test("an outcome label accepts the tidied form older loaders pass, and is idempotent", () => {
  assert.equal(outcomeLabel("Pending approval"), "Waiting for you");
  assert.equal(outcomeLabel("Executed"), "Done");
  assert.equal(outcomeLabel("Needs reconnect"), "Reconnect needed");
  assert.equal(outcomeLabel(outcomeLabel("pending_approval")), "Waiting for you");
  assert.equal(outcomeLabel("The reversal couldn't be completed."), "The reversal couldn't be completed.");
  assert.equal(outcomeLabel(undefined), "");
});

test("counts read correctly in a sentence: one read, two rejected requests", () => {
  assert.equal(categoryCount("read", 1), "1 read");
  assert.equal(categoryCount("read", 2), "2 reads");
  assert.equal(categoryCount("approval", 1), "1 approval or release");
  assert.equal(categoryCount("rejected", 1), "1 rejected request");
  assert.equal(categoryCount("access", 12), "12 connection and access changes");
});
