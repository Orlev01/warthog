// Agent runs (docs/adr/agent-runs.md): a run is issued to one person's agent, resolves only
// for that agent, keeps the agent's label encrypted and cleaned, and lists with its count.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { cleanRunLabel, isRunId, listRuns, resolveRun, startRun, updateRunLabel, RUN_LABEL_CHANGE_MS, RUN_LABEL_MAX, type RunLabelChange } from "./runs";
import { createAgent } from "../db/agents";
import { createUser } from "../db/users";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

const clock = fixedClock(new Date("2026-11-16T09:00:00.000Z"));
const later = fixedClock(new Date("2026-11-16T09:30:00.000Z"));

async function person(db: Db, email: string) {
  const user = await createUser(db, { email, wrappedDek: "synthetic" });
  const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Claude", platform: "Claude", status: "connected" }, clock);
  return { userId: user.id, agentId: agent.id, dek: new Uint8Array(randomBytes(32)) };
}

test("a run resolves only for the agent it was issued to", async () => {
  const db = await freshDb();
  try {
    const owner = await person(db, "runs-owner@warthog.com.au");
    const otherAgent = await createAgent(db, { userId: owner.userId, connectionId: randomUUID(), displayName: "ChatGPT", platform: "ChatGPT", status: "connected" }, clock);
    const stranger = await person(db, "runs-stranger@warthog.com.au");

    const run = await startRun(db, owner, { label: "Fixing the website tests", via: "Claude Code" }, owner.dek, clock);
    assert.ok(isRunId(run.id));
    assert.deepEqual(await resolveRun(db, owner, run.id, owner.dek, later), run);
    assert.deepEqual(await resolveRun(db, owner, run.id.toUpperCase(), owner.dek, later), run, "an id is case-insensitive");

    assert.equal(await resolveRun(db, { userId: owner.userId, agentId: otherAgent.id }, run.id, owner.dek, later), null, "another agent of the same person");
    assert.equal(await resolveRun(db, stranger, run.id, stranger.dek, later), null, "another person's agent");
    for (const bad of [undefined, 42, "", "not-a-run", `${run.id}x`, "'; DROP TABLE agent_runs; --"]) {
      assert.equal(await resolveRun(db, owner, bad, owner.dek, later), null, String(bad));
    }
  } finally { await db.close(); }
});

test("the label is stored encrypted and resolving marks the run seen", async () => {
  const db = await freshDb();
  try {
    const owner = await person(db, "runs-label@warthog.com.au");
    const run = await startRun(db, owner, { label: "Drafting the quote for Jarrod" }, owner.dek, clock);
    const stored = (await db.query("SELECT label_ct, via, started_at, last_seen_at FROM agent_runs WHERE id = $1", [run.id])).rows[0]!;
    assert.match(String(stored.label_ct), /^v1:/);
    assert.doesNotMatch(String(stored.label_ct), /Jarrod/);
    assert.equal(stored.via, null);

    await resolveRun(db, owner, run.id, owner.dek, later);
    const seen = (await db.query("SELECT started_at, last_seen_at FROM agent_runs WHERE id = $1", [run.id])).rows[0]!;
    assert.equal(new Date(seen.started_at as string).toISOString(), "2026-11-16T09:00:00.000Z");
    assert.equal(new Date(seen.last_seen_at as string).toISOString(), "2026-11-16T09:30:00.000Z");
    await resolveRun(db, owner, run.id, owner.dek, clock);
    const kept = (await db.query("SELECT last_seen_at FROM agent_runs WHERE id = $1", [run.id])).rows[0]!;
    assert.equal(new Date(kept.last_seen_at as string).toISOString(), "2026-11-16T09:30:00.000Z", "an older clock never moves it back");

    const unlabelled = await startRun(db, owner, { label: " \n\t " }, owner.dek, clock);
    assert.deepEqual(unlabelled, { id: unlabelled.id });
  } finally { await db.close(); }
});

test("labels are cleaned, bounded and redacted", () => {
  assert.equal(cleanRunLabel(undefined), undefined);
  assert.equal(cleanRunLabel("  Fixing\n the   tests\u0007 "), "Fixing the tests");
  assert.equal(cleanRunLabel("x".repeat(500))?.length, RUN_LABEL_MAX);
  assert.doesNotMatch(cleanRunLabel("Paying with 4111 1111 1111 1111 now") ?? "", /4111 1111 1111 1111/);
  const released = cleanRunLabel("Using passport PA1234567", (token) => token === "pa1234567") ?? "";
  assert.doesNotMatch(released, /PA1234567/);

  // Redaction sees the whole text before it is cut, and the cut never leaves part of a token.
  const nearLimit = cleanRunLabel(`${"word ".repeat(17)}x 4111 1111 1111 1111 and more`) ?? "";
  assert.doesNotMatch(nearLimit, /4111/, "a card number straddling the limit is never partly kept");
  const passport = cleanRunLabel(`${"a".repeat(92)} PA1234567 tail`, (token) => token === "pa1234567") ?? "";
  assert.doesNotMatch(passport, /PA123/, "a released value at the limit is redacted, not cut short of the matcher");
  const straddling = cleanRunLabel(`${"a".repeat(90)} 4111 1111 1111 1111`) ?? "";
  assert.doesNotMatch(straddling, /\[[^\]]*$/, "a redaction marker cut part-way is dropped whole");
  assert.equal(straddling, "a".repeat(90));
  const words = cleanRunLabel("abcdefghij ".repeat(20)) ?? "";
  assert.ok(words.length <= RUN_LABEL_MAX && !words.endsWith(" ") && words.endsWith("abcdefghij"), "cut at a word boundary");
});

test("runs list newest first with their entry counts, scoped to the person", async () => {
  const db = await freshDb();
  try {
    const owner = await person(db, "runs-list@warthog.com.au");
    const stranger = await person(db, "runs-list-stranger@warthog.com.au");
    const first = await startRun(db, owner, { label: "First" }, owner.dek, clock);
    const second = await startRun(db, owner, { label: "Second", via: "Claude Code" }, owner.dek, clock);
    await resolveRun(db, owner, first.id, owner.dek, later);
    await startRun(db, stranger, { label: "Not yours" }, stranger.dek, clock);

    const runs = await listRuns(db, owner.userId, owner.dek, { agentId: owner.agentId });
    assert.deepEqual(runs.map((run) => run.label), ["First", "Second"]);
    assert.equal(runs[1]!.via, "Claude Code");
    assert.equal(runs[0]!.actions, 0);

    const named = await listRuns(db, owner.userId, owner.dek, { runIds: [second.id, "nonsense"] });
    assert.deepEqual(named.map((run) => run.id), [second.id]);
    assert.deepEqual(await listRuns(db, stranger.userId, stranger.dek, { runIds: [second.id] }), [], "another person's run is never listed");
  } finally { await db.close(); }
});

test("the activity writer links an entry to its run, and never loses an entry over a bad run", async () => {
  const { createDbRecorder } = await import("../activity/writer");
  const { listActivity } = await import("../activity/list");
  const db = await freshDb();
  try {
    const owner = await person(db, "runs-writer@warthog.com.au");
    const stranger = await person(db, "runs-writer-stranger@warthog.com.au");
    const theirs = await startRun(db, stranger, { label: "Theirs" }, stranger.dek, clock);
    const run = await startRun(db, owner, { label: "Mine" }, owner.dek, clock);
    const recorder = createDbRecorder({ db, clock, dekFor: async () => owner.dek });
    const linked = await recorder.record({ userId: owner.userId, agentId: owner.agentId, kind: "tool_call", source: "warthog", tool: "remember", runId: run.id, payload: { run } });
    const foreign = await recorder.record({ userId: owner.userId, agentId: owner.agentId, kind: "tool_call", source: "warthog", tool: "remember", runId: theirs.id });
    const missing = await recorder.record({ userId: owner.userId, agentId: owner.agentId, kind: "tool_call", source: "warthog", tool: "remember", runId: "not-a-run" });
    assert.deepEqual([linked.seq, foreign.seq, missing.seq], [1, 2, 3], "every entry is recorded");
    assert.deepEqual((await listActivity(db, owner.userId, { runId: run.id }, owner.dek)).map((entry) => entry.seq), [1]);
    assert.deepEqual((await listActivity(db, owner.userId, { runId: theirs.id }, owner.dek)), [], "another person's run is never linked");
    assert.deepEqual((await listActivity(db, owner.userId, { runId: "nonsense" }, owner.dek)), [], "a malformed filter matches nothing");
    const links = await db.query("SELECT entry_seq FROM activity_entry_runs WHERE user_id = $1", [owner.userId]);
    assert.deepEqual(links.rows.map((row) => Number(row.entry_seq)), [1]);
  } finally { await db.close(); }
});

// 25 Nov — status updates (docs/adr/agent-runs.md): an agent may change what its conversation
// says it is working on. The change is cleaned like a new label, only ever applies to the
// agent's own run, is spaced out, and commits with its activity entry.
test("an agent updates its own run's description, cleaned and encrypted, with what it replaced", async () => {
  const db = await freshDb();
  try {
    const owner = await person(db, "runs-update@warthog.com.au");
    const run = await startRun(db, owner, { label: "Fixing the website tests" }, owner.dek, clock);
    const recorded: RunLabelChange[] = [];
    const record = async (_tx: Db, change: RunLabelChange) => { recorded.push(change); };

    const change = await updateRunLabel(db, owner, run.id, "  Writing the\n release notes ", owner.dek, later, () => false, record);
    assert.deepEqual(change, { run: { id: run.id, label: "Writing the release notes" }, previous: "Fixing the website tests" });
    assert.deepEqual(recorded, [change], "the change is handed to the recorder");
    assert.deepEqual(await resolveRun(db, owner, run.id, owner.dek, later), { id: run.id, label: "Writing the release notes" });
    const stored = (await db.query("SELECT label_ct, label_changed_at FROM agent_runs WHERE id = $1", [run.id])).rows[0]!;
    assert.doesNotMatch(String(stored.label_ct), /release notes/);
    assert.equal(new Date(stored.label_changed_at as string).toISOString(), "2026-11-16T09:30:00.000Z");

    const card = await startRun(db, owner, {}, owner.dek, clock);
    const redacted = await updateRunLabel(db, owner, card.id, "Paying with 4111 1111 1111 1111", owner.dek, clock, () => false, record);
    assert.doesNotMatch(redacted?.run.label ?? "", /4111 1111/);
    assert.equal(redacted?.previous, undefined, "a run with no description had nothing to replace");
  } finally { await db.close(); }
});

test("an unchanged, empty or too-soon description, or someone else's run, changes nothing", async () => {
  const db = await freshDb();
  try {
    const owner = await person(db, "runs-update-none@warthog.com.au");
    const otherAgent = await createAgent(db, { userId: owner.userId, connectionId: randomUUID(), displayName: "ChatGPT", platform: "ChatGPT", status: "connected" }, clock);
    const stranger = await person(db, "runs-update-stranger@warthog.com.au");
    const run = await startRun(db, owner, { label: "Fixing the website tests" }, owner.dek, clock);
    let calls = 0;
    const record = async () => { calls += 1; };

    assert.equal(await updateRunLabel(db, owner, run.id, "Fixing the  website tests", owner.dek, later, () => false, record), null, "the same words");
    assert.equal(await updateRunLabel(db, owner, run.id, " \n ", owner.dek, later, () => false, record), null, "nothing left after cleaning");
    assert.equal(await updateRunLabel(db, { userId: owner.userId, agentId: otherAgent.id }, run.id, "Hijacked", owner.dek, later, () => false, record), null, "another agent of the same person");
    assert.equal(await updateRunLabel(db, stranger, run.id, "Hijacked", stranger.dek, later, () => false, record), null, "another person's agent");
    for (const bad of [undefined, 42, "not-a-run"]) assert.equal(await updateRunLabel(db, owner, bad, "Hijacked", owner.dek, later, () => false, record), null, String(bad));
    assert.equal(calls, 0, "nothing is recorded for a change that didn't happen");
    assert.equal((await resolveRun(db, owner, run.id, owner.dek, later))?.label, "Fixing the website tests");

    // At most one change a minute: the first change is always allowed.
    assert.ok(await updateRunLabel(db, owner, run.id, "Step two", owner.dek, later, () => false, record));
    const soon = fixedClock(new Date(later.now().getTime() + RUN_LABEL_CHANGE_MS - 1000));
    assert.equal(await updateRunLabel(db, owner, run.id, "Step three", owner.dek, soon, () => false, record), null);
    const after = fixedClock(new Date(later.now().getTime() + RUN_LABEL_CHANGE_MS));
    assert.equal((await updateRunLabel(db, owner, run.id, "Step three", owner.dek, after, () => false, record))?.run.label, "Step three");
    assert.equal(calls, 2);
  } finally { await db.close(); }
});

test("a description change that can't be recorded is rolled back", async () => {
  const db = await freshDb();
  try {
    const owner = await person(db, "runs-update-rollback@warthog.com.au");
    const run = await startRun(db, owner, { label: "Before" }, owner.dek, clock);
    await assert.rejects(updateRunLabel(db, owner, run.id, "After", owner.dek, later, () => false, async () => { throw new Error("audit write failed"); }));
    assert.equal((await resolveRun(db, owner, run.id, owner.dek, later))?.label, "Before");
    const stored = (await db.query("SELECT label_changed_at FROM agent_runs WHERE id = $1", [run.id])).rows[0]!;
    assert.equal(stored.label_changed_at, null);
  } finally { await db.close(); }
});

test("the person's recent runs list across agents, with each one's latest action", async () => {
  const { createDbRecorder } = await import("../activity/writer");
  const db = await freshDb();
  try {
    const owner = await person(db, "runs-recent@warthog.com.au");
    const gemini = await createAgent(db, { userId: owner.userId, connectionId: randomUUID(), displayName: "Gemini CLI", platform: "localhost", status: "connected" }, clock);
    const stranger = await person(db, "runs-recent-stranger@warthog.com.au");
    const old = await startRun(db, owner, { label: "Last week" }, owner.dek, fixedClock(new Date("2026-11-09T09:00:00.000Z")));
    const claude = await startRun(db, owner, { label: "Fixing the website tests" }, owner.dek, clock);
    const research = await startRun(db, { userId: owner.userId, agentId: gemini.id }, { label: "Researching coffee tables" }, owner.dek, clock);
    await startRun(db, stranger, { label: "Not yours" }, stranger.dek, clock);
    const recorder = createDbRecorder({ db, clock, dekFor: async () => owner.dek });
    await recorder.record({ userId: owner.userId, agentId: owner.agentId, kind: "tool_call", source: "warthog", tool: "remember", outcome: "executed", runId: claude.id });
    await recorder.record({ userId: owner.userId, agentId: owner.agentId, kind: "tool_attempt", source: "warthog", tool: "google-gmail__send", connectorId: "google-gmail", runId: claude.id });
    await recorder.record({ userId: owner.userId, agentId: owner.agentId, kind: "tool_call", source: "warthog", tool: "google-gmail__send", connectorId: "google-gmail", outcome: "pending_approval", runId: claude.id });
    await recorder.record({ userId: owner.userId, agentId: owner.agentId, kind: "run_status", source: "agent_reported", outcome: "reported", runId: claude.id });
    await recorder.record({ userId: owner.userId, agentId: owner.agentId, kind: "tool_call", source: "warthog", tool: "get_context", outcome: "executed", runId: claude.id });

    const recent = await listRuns(db, owner.userId, owner.dek, { since: "2026-11-15T09:00:00.000Z" });
    assert.deepEqual(new Set(recent.map((run) => run.id)), new Set([claude.id, research.id]), "both agents' runs, not last week's, never another person's");
    assert.ok(!recent.some((run) => run.id === old.id));
    const latest = recent.find((run) => run.id === claude.id)!.latest;
    assert.deepEqual(latest && { kind: latest.kind, tool: latest.tool, outcome: latest.outcome, connectorId: latest.connectorId }, { kind: "tool_call", tool: "google-gmail__send", outcome: "pending_approval", connectorId: "google-gmail" }, "the latest action Warthog recorded, not an intent, a status change or a check-in");
    assert.equal(recent.find((run) => run.id === research.id)!.latest, undefined, "a run with no entries has no latest action");
    assert.equal(recent.find((run) => run.id === claude.id)!.labelChangedAt, undefined);
  } finally { await db.close(); }
});
