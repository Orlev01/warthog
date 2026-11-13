// Starting the admin handoff (src/server/admin/handoff.ts): only a signed-in, live admin
// with a step-up fresher than five minutes gets a handoff URL on the derived admin origin;
// every refusal is a plain reason; the audit metric carries only the outcome; a metrics
// failure never changes the result.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";
import type { RecordMetricInput } from "../metrics/record";
import { startAdminHandoff } from "./handoff";
import { exchangeHandoff } from "./session";
import { createAccount, signIn, steerableClock } from "./test-fixtures";

const ADMIN_ORIGIN = "https://admin.example.test";

test("a live admin with a fresh step-up gets a single-use exchange URL on the admin origin", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const { userId } = await createAccount(db, { role: "admin" });
    const { token } = await signIn(db, userId, clock);
    const metrics: RecordMetricInput[] = [];
    const result = await startAdminHandoff(token, { db, clock, random: systemRandom, adminOrigin: ADMIN_ORIGIN, recordMetric: async (m) => { metrics.push(m); } });
    assert.ok(result.ok, "admitted");
    const url = new URL(result.url);
    assert.equal(url.origin, ADMIN_ORIGIN);
    assert.equal(url.pathname, "/session");
    const handoff = url.searchParams.get("handoff")!;
    assert.match(handoff, /^[0-9a-f]{64}$/);
    assert.ok(await exchangeHandoff(db, handoff, { clock, random: systemRandom }), "the URL's token is a real handoff");
    assert.deepEqual(metrics.map((m) => [m.name, m.dimensions?.outcome]), [["admin.handoff", "minted"]]);
    assert.ok(!JSON.stringify(metrics).includes(handoff) && !JSON.stringify(metrics).includes(userId), "no identity or token in metrics");
  } finally {
    await db.close();
  }
});

test("no session, a member, a tombstone and a stale step-up are each refused with a plain reason", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const deps = { db, clock, random: systemRandom, adminOrigin: ADMIN_ORIGIN };
    assert.deepEqual(await startAdminHandoff(null, deps), { ok: false, reason: "signed_out" });
    assert.deepEqual(await startAdminHandoff("unknown", deps), { ok: false, reason: "signed_out" });

    const member = await createAccount(db, { role: "member" });
    assert.deepEqual(await startAdminHandoff((await signIn(db, member.userId, clock)).token, deps), { ok: false, reason: "not_admin" });

    const admin = await createAccount(db, { role: "admin" });
    const stale = await signIn(db, admin.userId, clock);
    clock.advance(5 * 60 * 1000 + 1);
    assert.deepEqual(await startAdminHandoff(stale.token, deps), { ok: false, reason: "step_up_required" });

    const ghost = await createAccount(db, { role: "admin" });
    const ghostSession = await signIn(db, ghost.userId, clock);
    await db.query("UPDATE users SET wrapped_dek = '' WHERE id = $1", [ghost.userId]);
    const refused = await startAdminHandoff(ghostSession.token, deps);
    assert.equal(refused.ok, false, "a tombstone cannot start a handoff");

    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM admin_sessions")).rows[0]!.n), 0, "nothing was minted");
  } finally {
    await db.close();
  }
});

test("a failing metrics seam never fails the handoff", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const { userId } = await createAccount(db, { role: "admin" });
    const { token } = await signIn(db, userId, clock);
    const result = await startAdminHandoff(token, { db, clock, random: systemRandom, adminOrigin: ADMIN_ORIGIN, recordMetric: async () => { throw new Error("metrics down"); } });
    assert.ok(result.ok);
  } finally {
    await db.close();
  }
});
