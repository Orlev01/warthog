// The admin handoff and session (src/server/admin/session.ts; docs/design/admin-portal.md §2).
// Behaviour pinned: a handoff exchanges exactly once within 60 seconds for a host-locked
// `__Host-wh_admin` cookie; minting again replaces the earlier unexchanged proof; verify
// slides the admin idle timer and refuses after 60 minutes idle, 12 hours absolute, the app
// session's own windows, the app session's deletion (cascade), demotion or a tombstone;
// sign-out ends only that admin session; malformed tokens never throw.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";
import {
  ADMIN_ABSOLUTE_MS, ADMIN_COOKIE_NAME, ADMIN_IDLE_MS, HANDOFF_TTL_MS,
  deleteAdminSession, exchangeHandoff, mintHandoff, verifyAdminSession, clearedAdminCookie,
} from "./session";
import { createAccount, signIn, steerableClock } from "./test-fixtures";

const START = new Date("2026-11-13T01:00:00Z");

async function adminWithHandoff(db: Awaited<ReturnType<typeof freshDb>>) {
  const clock = steerableClock(START);
  const { userId } = await createAccount(db, { role: "admin" });
  const { session } = await signIn(db, userId, clock);
  const minted = await mintHandoff(db, { sessionId: session.id, userId }, { clock, random: systemRandom });
  return { clock, userId, session, minted };
}

test("a handoff exchanges once for a host-locked admin cookie, and never twice", async () => {
  const db = await freshDb();
  try {
    const { clock, userId, session, minted } = await adminWithHandoff(db);
    assert.match(minted.token, /^[0-9a-f]{64}$/, "256 bits, hex");
    assert.equal(minted.expiresAt.getTime() - START.getTime(), HANDOFF_TTL_MS);
    const stored = await db.query("SELECT handoff_hash, token_hash FROM admin_sessions");
    assert.notEqual(stored.rows[0]!.handoff_hash, minted.token, "only a hash is stored");
    assert.equal(stored.rows[0]!.token_hash, null);

    clock.advance(10_000);
    const exchanged = await exchangeHandoff(db, minted.token, { clock, random: systemRandom });
    assert.ok(exchanged, "a fresh handoff exchanges");
    assert.equal(exchanged.session.userId, userId);
    assert.equal(exchanged.session.sessionId, session.id);
    assert.match(exchanged.token, /^[0-9a-f]{64}$/);
    assert.equal(
      exchanged.cookie,
      `${ADMIN_COOKIE_NAME}=${exchanged.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ADMIN_ABSOLUTE_MS / 1000}`,
    );
    assert.equal(await exchangeHandoff(db, minted.token, { clock, random: systemRandom }), null, "single use");
    assert.equal(await exchangeHandoff(db, "not-a-token", { clock, random: systemRandom }), null, "garbage never throws");
  } finally {
    await db.close();
  }
});

test("an expired handoff, or one whose person was demoted, does not exchange", async () => {
  const db = await freshDb();
  try {
    const { clock, minted } = await adminWithHandoff(db);
    clock.advance(HANDOFF_TTL_MS + 1);
    assert.equal(await exchangeHandoff(db, minted.token, { clock, random: systemRandom }), null, "61 seconds is too late");

    const second = await adminWithHandoff(db);
    await db.query("UPDATE users SET role = 'member' WHERE id = $1", [second.userId]);
    assert.equal(await exchangeHandoff(db, second.minted.token, { clock: second.clock, random: systemRandom }), null, "demoted before exchange");
  } finally {
    await db.close();
  }
});

test("minting again replaces the earlier unexchanged handoff for that app session", async () => {
  const db = await freshDb();
  try {
    const { clock, userId, session, minted } = await adminWithHandoff(db);
    const again = await mintHandoff(db, { sessionId: session.id, userId }, { clock, random: systemRandom });
    assert.equal(await exchangeHandoff(db, minted.token, { clock, random: systemRandom }), null, "the first proof is gone");
    assert.ok(await exchangeHandoff(db, again.token, { clock, random: systemRandom }), "the latest proof works");
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM admin_sessions")).rows[0]!.n), 1);
  } finally {
    await db.close();
  }
});

test("two concurrent exchanges of one handoff yield exactly one admin session", async () => {
  const db = await freshDb();
  try {
    const { clock, minted } = await adminWithHandoff(db);
    const results = await Promise.all([
      exchangeHandoff(db, minted.token, { clock, random: systemRandom }),
      exchangeHandoff(db, minted.token, { clock, random: systemRandom }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    await db.close();
  }
});

test("verify slides the idle timer and refuses after the idle and absolute windows", async () => {
  const db = await freshDb();
  try {
    const { clock, minted } = await adminWithHandoff(db);
    const exchanged = (await exchangeHandoff(db, minted.token, { clock, random: systemRandom }))!;
    clock.advance(ADMIN_IDLE_MS - 1000);
    const seen = await verifyAdminSession(db, exchanged.token, { clock });
    assert.ok(seen, "just inside the idle window");
    assert.equal(seen.lastSeenAt.getTime(), clock.now().getTime(), "the idle timer slid");
    clock.advance(ADMIN_IDLE_MS - 1000);
    assert.ok(await verifyAdminSession(db, exchanged.token, { clock }), "sliding kept it alive");
    clock.advance(ADMIN_IDLE_MS + 1);
    assert.equal(await verifyAdminSession(db, exchanged.token, { clock }), null, "idle for over an hour");

    const fresh = await adminWithHandoff(db);
    const live = (await exchangeHandoff(db, fresh.minted.token, { clock: fresh.clock, random: systemRandom }))!;
    // Keep touching it every half hour; the absolute cap still ends it at 12 hours.
    for (let t = 0; t < ADMIN_ABSOLUTE_MS; t += ADMIN_IDLE_MS / 2) {
      fresh.clock.advance(ADMIN_IDLE_MS / 2);
      if (fresh.clock.now().getTime() - START.getTime() < ADMIN_ABSOLUTE_MS) {
        // Also keep the APP session alive, as the member portal would on each visit.
        await db.query("UPDATE sessions SET last_seen_at = $1", [fresh.clock.now().toISOString()]);
        assert.ok(await verifyAdminSession(db, live.token, { clock: fresh.clock }), `alive at +${t + ADMIN_IDLE_MS / 2}ms`);
      }
    }
    fresh.clock.set(new Date(START.getTime() + ADMIN_ABSOLUTE_MS + 1000));
    await db.query("UPDATE sessions SET last_seen_at = $1", [fresh.clock.now().toISOString()]);
    assert.equal(await verifyAdminSession(db, live.token, { clock: fresh.clock }), null, "12 hours is the cap");
  } finally {
    await db.close();
  }
});

test("verify refuses once the app session is gone, the person is demoted or tombstoned, or the token is garbage", async () => {
  const db = await freshDb();
  try {
    const { clock, userId, session, minted } = await adminWithHandoff(db);
    const live = (await exchangeHandoff(db, minted.token, { clock, random: systemRandom }))!;
    assert.ok(await verifyAdminSession(db, live.token, { clock }));
    assert.equal(await verifyAdminSession(db, "garbage", { clock }), null);
    assert.equal(await verifyAdminSession(db, "", { clock }), null);

    await db.query("UPDATE users SET role = 'member' WHERE id = $1", [userId]);
    assert.equal(await verifyAdminSession(db, live.token, { clock }), null, "demoted");
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
    assert.ok(await verifyAdminSession(db, live.token, { clock }), "restored");

    await db.query("UPDATE users SET wrapped_dek = '' WHERE id = $1", [userId]);
    assert.equal(await verifyAdminSession(db, live.token, { clock }), null, "a tombstone cannot administer");
    await db.query("UPDATE users SET wrapped_dek = 'wrapped' WHERE id = $1", [userId]);

    await db.query("DELETE FROM sessions WHERE id = $1", [session.id]);
    assert.equal(await verifyAdminSession(db, live.token, { clock }), null, "app sign-out revokes admin access");
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM admin_sessions")).rows[0]!.n), 0, "the row cascaded away");
  } finally {
    await db.close();
  }
});

test("signing out of admin ends only that admin session; the app session and cookie clearing are explicit", async () => {
  const db = await freshDb();
  try {
    const { clock, session, minted } = await adminWithHandoff(db);
    const live = (await exchangeHandoff(db, minted.token, { clock, random: systemRandom }))!;
    await deleteAdminSession(db, live.token);
    assert.equal(await verifyAdminSession(db, live.token, { clock }), null);
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM sessions WHERE id = $1", [session.id])).rows[0]!.n), 1, "the app session stays");
    assert.equal(clearedAdminCookie(), `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    await deleteAdminSession(db, "garbage"); // matches nothing, never throws
  } finally {
    await db.close();
  }
});
