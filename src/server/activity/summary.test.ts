// Organising the audit log by type, agent and service (`./list`: the category/attention
// filters and `summariseActivity`; `./category-sql`). The founder asked for the Activity
// screen to stop being one long thread: views by agent and by activity type need EXACT
// counts over a person's whole record, computed from plaintext metadata in SQL so nothing is
// decrypted, and the list a group drills into must apply exactly the same rules.
//
//   • the SQL CASE classifies every row exactly as the TypeScript classifier does;
//   • category / attention / no-agent filters narrow the list and page correctly;
//   • summaries are member-scoped — another person's entries and disputes never count —
//     and never decrypt (a corrupt payload cannot break them);
//   • one change is counted once (its pre-execution `tool_attempt` row is not counted);
//   • every filter value is a bound parameter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { activityConditions, listActivity, summariseActivity } from "./list";
import { categoryCaseSql } from "./category-sql";
import { isReadOnlyTool } from "./tool-effects";
import { createDbRecorder } from "./writer";
import type { ActivityEntryInput } from "./recorder";
import { activityCategory } from "@/domain/activity/category";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";

async function makeUser(db: Db, who: string): Promise<{ id: string; dek: Uint8Array }> {
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: Buffer.from(who).toString("base64") });
  return { id: user.id, dek: randomBytes(32) };
}

let minute = 0;
async function record(db: Db, person: { id: string; dek: Uint8Array }, fields: Partial<Omit<ActivityEntryInput, "userId">>): Promise<number> {
  minute += 1;
  const at = new Date(Date.UTC(2026, 10, 1, 9, minute)).toISOString();
  const recorder = createDbRecorder({ db, clock: fixedClock(new Date(at)), dekFor: async () => person.dek });
  const entry = await recorder.record({
    userId: person.id,
    kind: fields.kind ?? "tool_call",
    source: fields.source ?? "warthog",
    agentId: fields.agentId,
    connectorId: fields.connectorId,
    tool: fields.tool,
    outcome: fields.outcome,
    payload: fields.payload ?? { summary: "entry" },
  });
  return entry.seq;
}

async function dispute(db: Db, userId: string, seq: number): Promise<void> {
  await db.query(
    "INSERT INTO activity_disputes (user_id, entry_seq, dispute_seq, note_ct, created_at) VALUES ($1, $2, 1, 'x', now())",
    [userId, seq],
  );
}

const SAMPLES: Partial<ActivityEntryInput>[] = [
  { kind: "tool_call", tool: "search_memory", outcome: "executed" },
  { kind: "tool_call", tool: "google-gmail__search", connectorId: "google-gmail", outcome: "executed" },
  { kind: "tool_call", tool: "google-gmail__send", connectorId: "google-gmail", outcome: "denied" },
  { kind: "tool_attempt", tool: "remember", outcome: "attempted" },
  { kind: "tool_call", tool: "remember", outcome: "executed" },
  { kind: "tool_call", tool: "unknown__request", connectorId: "unknown", outcome: "failed" },
  { kind: "tool_call" },
  { kind: "tool_call", tool: "log_activity", outcome: "executed" },
  { kind: "agent_report", source: "agent_reported" },
  { kind: "tool_call", tool: "request_card", outcome: "pending_approval" },
  { kind: "approval_decision", tool: "google-gmail__send", outcome: "approved" },
  { kind: "card_release", outcome: "released" },
  { kind: "tool_rejected", tool: "google-gmail__send", outcome: "refused" },
  { kind: "protocol_rejected", outcome: "refused" },
  { kind: "permission_change", outcome: "saved" },
  { kind: "connection_change", connectorId: "google-gmail", outcome: "connected" },
  { kind: "rule_created", outcome: "saved" },
  { kind: "brand_new_kind" },
];

test("the SQL classification matches the TypeScript classification for every kind of row", async () => {
  const db = await freshDb();
  try {
    const person = await makeUser(db, "parity");
    for (const sample of SAMPLES) await record(db, person, sample);
    const values: unknown[] = [person.id];
    const param = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const rows = await db.query(
      `SELECT kind, source, tool, ${categoryCaseSql(param)} AS category FROM activity_entries WHERE user_id = $1 ORDER BY seq`,
      values,
    );
    assert.equal(rows.rows.length, SAMPLES.length);
    for (const row of rows.rows) {
      const expected = activityCategory(
        { kind: String(row.kind), source: String(row.source), tool: row.tool == null ? undefined : String(row.tool) },
        isReadOnlyTool,
      );
      assert.equal(row.category, expected, `${row.kind}/${row.tool}`);
    }
  } finally {
    await db.close();
  }
});

test("the list narrows by activity type, needs-attention and no-agent, in SQL", async () => {
  const db = await freshDb();
  try {
    const person = await makeUser(db, "filters");
    const agent = "0f6e3c1a-1111-4222-8333-944455556666";
    for (const sample of SAMPLES) await record(db, person, { ...sample, agentId: sample.kind === "rule_created" ? undefined : agent });
    const disputedSeq = await record(db, person, { kind: "tool_call", tool: "search_memory", outcome: "executed", agentId: agent });
    await dispute(db, person.id, disputedSeq);

    const reads = await listActivity(db, person.id, { category: "read" }, person.dek);
    assert.deepEqual(reads.map((e) => e.tool).sort(), ["google-gmail__search", "search_memory", "search_memory"]);

    const changes = await listActivity(db, person.id, { category: "change" }, person.dek);
    assert.ok(changes.every((e) => e.kind === "tool_call" || e.kind === "tool_attempt"));
    assert.ok(!changes.some((e) => e.tool === "log_activity"), "a report is never a change");

    const attention = await listActivity(db, person.id, { attention: true }, person.dek);
    assert.deepEqual(
      attention.map((e) => e.outcome ?? "").sort(),
      ["denied", "executed", "failed", "refused", "refused"],
      "blocked and failed outcomes, plus the disputed entry",
    );

    const noAgent = await listActivity(db, person.id, { noAgent: true }, person.dek);
    assert.deepEqual(noAgent.map((e) => e.kind), ["rule_created"]);

    const paged = await listActivity(db, person.id, { category: "access" }, person.dek, { limit: 1 });
    assert.equal(paged.length, 1);
    const next = await listActivity(db, person.id, { category: "access" }, person.dek, { limit: 1, beforeSeq: paged[0]!.seq });
    assert.equal(next.length, 1);
    assert.notEqual(next[0]!.seq, paged[0]!.seq, "a type filter pages with the feed cursor");
  } finally {
    await db.close();
  }
});

test("summaries count each group exactly, with type, outcome and dispute splits", async () => {
  const db = await freshDb();
  try {
    const person = await makeUser(db, "groups");
    const claude = "0f6e3c1a-1111-4222-8333-944455556666";
    const chatgpt = "28e3dfa1-7fc1-47da-8d0c-583cf7794c38";
    await record(db, person, { agentId: claude, tool: "search_memory", outcome: "executed" });
    await record(db, person, { agentId: claude, kind: "tool_attempt", tool: "remember", outcome: "attempted" });
    const change = await record(db, person, { agentId: claude, tool: "remember", outcome: "executed" });
    await record(db, person, { agentId: claude, tool: "google-gmail__send", connectorId: "google-gmail", outcome: "denied" });
    await record(db, person, { agentId: chatgpt, tool: "get_context", outcome: "executed" });
    await record(db, person, { kind: "rule_created", outcome: "saved" });
    await dispute(db, person.id, change);

    const byAgent = await summariseActivity(db, person.id, {}, "agent");
    assert.deepEqual(byAgent.map((g) => g.key), [null, chatgpt, claude], "most recently active group first");
    const c = byAgent.find((g) => g.key === claude)!;
    assert.equal(c.total, 3, "the tool_attempt intent row is not counted");
    assert.equal(c.byCategory.read, 1);
    assert.equal(c.byCategory.change, 2);
    assert.equal(c.byOutcome.done, 2);
    assert.equal(c.byOutcome.blocked, 1);
    assert.equal(c.disputed, 1);

    const byType = await summariseActivity(db, person.id, {}, "category");
    assert.equal(byType.find((g) => g.key === "read")?.total, 2);
    assert.equal(byType.find((g) => g.key === "account")?.total, 1);

    const byService = await summariseActivity(db, person.id, { agentId: claude }, "service");
    assert.deepEqual(new Map(byService.map((g) => [g.key, g.total])), new Map<string | null, number>([["google-gmail", 1], [null, 2]]));

    const attempts = await summariseActivity(db, person.id, { kind: "tool_attempt" }, "agent");
    assert.equal(attempts[0]?.total, 1, "asking for intent rows by kind counts them");
  } finally {
    await db.close();
  }
});

test("summaries never count another person's entries or disputes, and never decrypt", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "member-a");
    const b = await makeUser(db, "member-b");
    const agent = "0f6e3c1a-1111-4222-8333-944455556666";
    await record(db, a, { agentId: agent, tool: "search_memory", outcome: "executed" });
    const bSeq = await record(db, b, { agentId: agent, tool: "search_memory", outcome: "executed" });
    await record(db, b, { agentId: agent, tool: "remember", outcome: "failed" });
    // B disputes an entry at the SAME seq number A's entry has.
    await dispute(db, b.id, bSeq);
    // A corrupt payload: a summary must not need to decrypt it.
    await db.query("UPDATE activity_entries SET payload_ct = 'not-a-ciphertext' WHERE user_id = $1", [a.id]).catch(() => {});

    const groups = await summariseActivity(db, a.id, {}, "agent");
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.total, 1);
    assert.equal(groups[0]!.disputed, 0, "B's dispute on the same seq never marks A's entry");
    assert.equal(groups[0]!.byOutcome.failed, 0);
  } finally {
    await db.close();
  }
});

test("every filter value travels as a bound parameter; the SQL text has only fixed names", () => {
  const values: unknown[] = [];
  const probe = "x'; DROP TABLE activity_entries; --";
  const conditions = activityConditions("user-1", { agentId: probe, connectorId: probe, kind: probe, outcome: probe, category: "read", attention: true }, values);
  const text = conditions.join(" AND ");
  assert.ok(!text.includes("DROP TABLE"), text);
  assert.equal(values[0], "user-1", "the member scope is the first bound value");
  assert.ok(values.includes(probe));
  assert.match(text, /^user_id = \$1/);
});
