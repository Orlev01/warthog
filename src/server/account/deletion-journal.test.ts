import assert from "node:assert/strict";
import { test } from "node:test";
import { captureDeletionJournal, createDeletionJournal, planDeletionReconciliation, type JournalRecord } from "./deletion-journal";

const userId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-11-12T03:00:00.000Z");
const requested: JournalRecord = { version: 1, userId, event: "requested", at: "2026-11-12T01:00:00.000Z" };
const completed: JournalRecord = { ...requested, event: "completed", at: "2026-11-12T01:01:00.000Z" };
const snapshot = (records: JournalRecord[]) => ({
  coverageFrom: "2026-11-10T00:00:00.000Z", capturedAt: now.toISOString(), retentionDays: 42, records,
});
const restorePoint = new Date("2026-11-11T00:00:00.000Z");

test("journal uses create-only opaque account markers with no contact, key or content", async () => {
  const rows = new Map<string, string>();
  const journal = createDeletionJournal({ async create(name, body) { if (!rows.has(name)) rows.set(name, body); } }, () => now);
  await journal.requested(userId);
  await journal.requested(userId);
  await journal.completed(userId);
  assert.deepEqual([...rows.keys()], [`v1/${userId}/requested.json`, `v1/${userId}/completed.json`]);
  assert.deepEqual(Object.keys(JSON.parse([...rows.values()][0]!)).sort(), ["at", "event", "userId", "version"]);
  await assert.rejects(journal.requested("../../other-person"), /Invalid deletion journal account/);
});

test("a failed journal write is not acknowledged", async () => {
  const journal = createDeletionJournal({ async create() { throw new Error("unavailable"); } }, () => now);
  await assert.rejects(journal.requested(userId), /unavailable/);
});

test("reconciliation retains completed deletions independently of database purge", () => {
  assert.deepEqual(planDeletionReconciliation(snapshot([requested, completed]), restorePoint, now), [userId]);
});

test("an ambiguous intent blocks reopening instead of guessing whether commit succeeded", () => {
  assert.throws(() => planDeletionReconciliation(snapshot([requested]), restorePoint, now), /Unresolved deletion intent/);
});

test("recovery refuses gaps, stale snapshots, future points and expired coverage", () => {
  const valid = snapshot([requested, completed]);
  for (const [data, point, clock] of [
    [valid, new Date("2026-11-09T00:00:00Z"), now],
    [valid, new Date("2026-11-13T00:00:00Z"), now],
    [{ ...valid, capturedAt: "2026-11-12T02:50:00.000Z" }, restorePoint, now],
    [{ ...valid, coverageFrom: "2026-01-01T00:00:00.000Z" }, new Date("2026-09-01"), now],
    [{ ...valid, retentionDays: 7 }, restorePoint, now],
  ] as const) assert.throws(() => planDeletionReconciliation(data, point, clock));
});

test("malformed records and completion without an observed request fail closed", () => {
  assert.throws(() => planDeletionReconciliation(snapshot([completed]), restorePoint, now), /Missing deletion request/);
  assert.throws(() => planDeletionReconciliation(snapshot([{ ...requested, userId: "bad" }, completed]), restorePoint, now));
  assert.throws(() => planDeletionReconciliation(snapshot([requested, { ...completed, at: "2026-11-11T00:00:00.000Z" }]), restorePoint, now));
});

test("coverage activation is create-only and remains outside the expiring event prefix", async () => {
  const rows = new Map<string, string>();
  let clock = now;
  const journal = createDeletionJournal({ async create(name, body) { if (!rows.has(name)) rows.set(name, body); } }, () => clock);
  await journal.initialize();
  clock = new Date(now.getTime() + 1000);
  await journal.initialize();
  assert.deepEqual(JSON.parse(rows.get("coverage.json")!), { version: 1, coverageFrom: now.toISOString(), retentionDays: 42 });
});

test("capture reads every listed event and binds its content to its immutable object path", async () => {
  const objects = new Map([
    ["coverage.json", JSON.stringify({ version: 1, coverageFrom: "2026-11-10T00:00:00.000Z", retentionDays: 42 })],
    [`v1/${userId}/requested.json`, JSON.stringify(requested)],
    [`v1/${userId}/completed.json`, JSON.stringify(completed)],
  ]);
  const reader = { async read(name: string) { return objects.get(name)!; }, async *list() { yield* [...objects.keys()].filter(n => n.startsWith("v1/")); } };
  const data = await captureDeletionJournal(reader, () => now);
  assert.deepEqual(planDeletionReconciliation(data, restorePoint, now), [userId]);
  objects.set(`v1/${userId}/completed.json`, JSON.stringify({ ...completed, userId: "22222222-2222-4222-8222-222222222222" }));
  await assert.rejects(captureDeletionJournal(reader, () => now), /path/);
});

test("capture refuses missing coverage, extra fields, oversized objects and concurrent writes", async () => {
  const coverage = JSON.stringify({ version: 1, coverageFrom: "2026-11-10T00:00:00.000Z", retentionDays: 42 });
  for (const [header, event] of [
    ["{}", JSON.stringify(requested)],
    [coverage, JSON.stringify({ ...requested, email: "must-not-be-retained@example.test" })],
    [coverage, " ".repeat(1025)],
    [coverage, JSON.stringify({ ...requested, at: "2026-11-12T04:00:00.000Z" })],
  ]) {
    await assert.rejects(captureDeletionJournal({ async read(name) { return name === "coverage.json" ? header! : event!; }, async *list() { yield `v1/${userId}/requested.json`; } }, () => now));
  }
});
