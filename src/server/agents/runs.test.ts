// Agent runs (docs/adr/agent-runs.md): a run is issued to one person's agent, resolves only
// for that agent, keeps the agent's label encrypted and cleaned, and lists with its count.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { cleanRunLabel, isRunId, listRuns, resolveRun, startRun, RUN_LABEL_MAX } from "./runs";
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
