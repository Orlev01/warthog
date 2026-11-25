// An agent that doesn't pass its conversation's run back still shows on the Now view: its own
// calls recorded outside any conversation can be listed and counted (`noRun`). Only the
// agent's own actions count: not the person's changes to it, and not a change's intent record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { listActivity, summariseActivity } from "./list";
import { createDbRecorder } from "./writer";
import { startRun } from "../agents/runs";
import { createAgent } from "../db/agents";
import { createUser } from "../db/users";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";

const clock = fixedClock(new Date("2026-11-25T09:00:00.000Z"));

test("an agent's own calls outside any conversation are listed and counted, nothing else", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "no-run@warthog.com.au", wrappedDek: "synthetic" });
    const dek = new Uint8Array(randomBytes(32));
    const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Codex", platform: "localhost", status: "connected" }, clock);
    const other = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Claude", platform: "Claude", status: "connected" }, clock);
    const run = await startRun(db, { userId: user.id, agentId: agent.id }, { label: "In a conversation" }, dek, clock);
    const recorder = createDbRecorder({ db, clock, dekFor: async () => dek });
    const entry = (fields: Parameters<typeof recorder.record>[0]) => recorder.record(fields);

    const inRun = await entry({ userId: user.id, agentId: agent.id, kind: "tool_call", source: "warthog", tool: "remember", runId: run.id });
    const loose = await entry({ userId: user.id, agentId: agent.id, kind: "tool_call", source: "warthog", tool: "search_memory" });
    await entry({ userId: user.id, agentId: agent.id, kind: "tool_attempt", source: "warthog", tool: "google-gmail__send" });
    const rejected = await entry({ userId: user.id, agentId: agent.id, kind: "tool_rejected", source: "warthog", tool: "remember", outcome: "refused" });
    const report = await entry({ userId: user.id, agentId: agent.id, kind: "agent_report", source: "agent_reported" });
    await entry({ userId: user.id, agentId: agent.id, kind: "permission_change", source: "warthog", outcome: "saved" });
    await entry({ userId: user.id, agentId: agent.id, kind: "client_observed", source: "warthog", outcome: "reported" });
    const otherLoose = await entry({ userId: user.id, agentId: other.id, kind: "tool_call", source: "warthog", tool: "get_context" });

    const listed = await listActivity(db, user.id, { agentId: agent.id, noRun: true }, dek);
    assert.deepEqual(listed.map((e) => e.seq).sort((a, b) => a - b), [loose.seq, rejected.seq, report.seq], "the agent's own calls and reports with no conversation");
    assert.ok(!listed.some((e) => e.seq === inRun.seq));

    const counts = new Map((await summariseActivity(db, user.id, { noRun: true }, "agent")).map((group) => [group.key, group.total]));
    assert.equal(counts.get(agent.id), 3);
    assert.equal(counts.get(other.id), 1);
    assert.deepEqual((await listActivity(db, user.id, { noRun: true }, dek)).map((e) => e.seq).sort((a, b) => a - b), [loose.seq, rejected.seq, report.seq, otherLoose.seq]);
  } finally { await db.close(); }
});
