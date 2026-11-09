import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, loadMigrations, runMigrations } from "../db/index";
import { reserveSmsSegments } from "./sms-budget";

test("SMS limits survive sender recreation, include failed attempts and roll back partial reservations", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const limits = { monthly: 5, daily: 4, recipientHourly: 2, recipientDailyMessages: 3 };
    const key = new Uint8Array(32).fill(9);
    const time = new Date("2026-11-09T01:00:00Z");
    const send = (phone: string, segments: number, now = time) => reserveSmsSegments(db, key, limits, phone, segments, now);
    await send("+61400000001", 2);
    await assert.rejects(send("+61400000001", 1), /limit/);
    await send("+61400000002", 2);
    await assert.rejects(send("+61400000003", 1), /limit/);
    await send("+61400000001", 1, new Date("2026-11-10T01:00:00Z"));
    await assert.rejects(send("+61400000002", 1, new Date("2026-11-10T01:00:00Z")), /limit/);
    const rows = await db.query("SELECT * FROM sms_usage_buckets");
    assert.ok(!JSON.stringify(rows).includes("+614"), "phone numbers must not be persisted as budget keys");
    await send("+61400000001", 2, new Date("2026-12-01T01:00:00Z"));
  } finally { await db.close(); }
});

test("recipient daily message limit counts messages across hours and retains failed attempts", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const limits = { monthly: 50, daily: 20, recipientHourly: 6, recipientDailyMessages: 2 };
    const key = new Uint8Array(32).fill(9);
    const send = (segments: number, time: string) => reserveSmsSegments(db, key, limits, "+447700900123", segments, new Date(time));
    await send(2, "2026-11-09T01:00:00Z");
    await send(2, "2026-11-09T02:00:00Z");
    await assert.rejects(send(1, "2026-11-09T03:00:00Z"), /limit/);
    const total = await db.query("SELECT used FROM sms_usage_buckets WHERE bucket = 'day:2026-11-09'");
    assert.equal(Number(total.rows[0]?.used), 4, "failed reservation rolls back all segment buckets");
    await send(1, "2026-11-10T03:00:00Z");
  } finally { await db.close(); }
});
