// Review fix W5 — setting up a new passkey after a completed account reset
// (`./account-reset`: hasCompletedReset, reenrolAfterReset).
//
// A completed reset erases the protected details and revokes every agent and connection,
// but the person still has no passkey they can use and no recovery code, so without a way
// back the reset is a dead end. Re-enrolment is that way back: once the person has proved
// their email again, a reset whose status is 'done' lets them register ONE new passkey.
// In one transaction the new passkey is stored, the reset is claimed 'done' → 'reenrolled'
// (so it can be used once only), the lost factors are removed (every other passkey, any
// authenticator app and every old session), a new recovery code is issued and a session
// is minted.
//
// Real PGlite with the real migrations, the real passkey verifier driven by the software
// authenticator, the real recovery-code and session modules.

import { test } from "node:test";
import assert from "node:assert/strict";

import { hasCompletedReset, reenrolAfterReset, RESET_WAIT_MS, REENROL_WINDOW_MS } from "./account-reset";
import { beginPasskeyRegistration } from "./passkey";
import { issueRecoveryCode, verifyRecoveryCode } from "./recovery";
import { createSession, verifySession } from "./session";
import { createUser, type User } from "../db/users";
import { systemRandom } from "../seams/random";
import { fixedClock, type Clock } from "../seams/clock";
import { freshDb } from "../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../test/authenticator";
import type { Db } from "../db/index";

const RP_ID = "warthog.com.au";
const DAY_MS = 24 * 60 * 60 * 1000;
// "Now" is one day after the reset finished (requested eight days ago).
const NOW = new Date("2026-06-10T00:00:00.000Z");
const REQUESTED_AT = new Date(NOW.getTime() - RESET_WAIT_MS - DAY_MS);
const CLOCK = fixedClock(NOW);

function depsFor(clock: Clock = CLOCK) {
  return { rpId: RP_ID, origin: `https://${RP_ID}`, clock, random: systemRandom };
}

async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: "d3JhcHBlZA==" });
}

async function setResetStatus(db: Db, userId: string, status: string, requestedAt = REQUESTED_AT): Promise<void> {
  await db.query(
    `INSERT INTO account_resets (user_id, status, requested_at) VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, requested_at = EXCLUDED.requested_at`,
    [userId, status, requestedAt.toISOString()],
  );
}

async function resetStatus(db: Db, userId: string): Promise<string | null> {
  const row = await db.query("SELECT status FROM account_resets WHERE user_id = $1", [userId]);
  return (row.rows[0]?.status as string | undefined) ?? null;
}

async function passkeyIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.query("SELECT credential_id FROM passkeys WHERE user_id = $1 ORDER BY credential_id", [userId]);
  return rows.rows.map((row) => row.credential_id as string);
}

async function count(db: Db, table: "sessions" | "totp_secrets", userId: string): Promise<number> {
  const rows = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
  return Number(rows.rows[0]?.n ?? 0);
}

// The person as they were before losing everything: an old passkey (now lost), an
// authenticator app, a signed-in session somewhere and an old recovery code.
async function seedLostFactors(db: Db, user: User): Promise<{ oldToken: string; oldCode: string; oldPasskey: string }> {
  const lostDevice = createAuthenticator();
  const options = await beginPasskeyRegistration(db, { userId: user.id, userName: user.email }, depsFor());
  const response = await lostDevice.register(options);
  await db.query(
    "INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, $2, 'old-public-key', 0)",
    [user.id, response.id],
  );
  await db.query("DELETE FROM passkey_challenges WHERE user_id = $1", [user.id]);
  await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'old-totp-ciphertext')", [user.id]);
  const session = await createSession(db, user.id, { clock: CLOCK, random: systemRandom });
  const { code } = await issueRecoveryCode(db, user.id, { random: systemRandom });
  return { oldToken: session.token, oldCode: code, oldPasskey: response.id };
}

// A registration ceremony for a NEW passkey on a new device.
async function newRegistration(db: Db, user: User, device: SoftwareAuthenticator = createAuthenticator()) {
  const options = await beginPasskeyRegistration(db, { userId: user.id, userName: user.email }, depsFor());
  return device.register(options);
}

test("hasCompletedReset is true only for the person's own 'done' reset", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "has-done");
    const other = await freshUser(db, "has-done-other");
    assert.equal(await hasCompletedReset(db, { userId: person.id }, { clock: CLOCK }), false, "no reset at all");
    for (const status of ["pending", "cancelled", "reenrolled"]) {
      await setResetStatus(db, person.id, status);
      assert.equal(await hasCompletedReset(db, { userId: person.id }, { clock: CLOCK }), false, status);
    }
    await setResetStatus(db, person.id, "done");
    assert.equal(await hasCompletedReset(db, { userId: person.id }, { clock: CLOCK }), true);
    assert.equal(await hasCompletedReset(db, { userId: other.id }, { clock: CLOCK }), false, "member-scoped");
  } finally {
    await db.close();
  }
});

test("re-enrolment registers the new passkey, claims the reset, removes the lost factors and issues a new code", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "reenrol-ok");
    const { oldToken, oldCode, oldPasskey } = await seedLostFactors(db, person);
    await setResetStatus(db, person.id, "done");

    const response = await newRegistration(db, person);
    const result = await reenrolAfterReset(db, { userId: person.id, response }, depsFor());
    assert.ok(result.ok, `re-enrolment succeeds: ${JSON.stringify(result)}`);

    assert.equal(await resetStatus(db, person.id), "reenrolled", "the reset is claimed, once");
    assert.deepEqual(await passkeyIds(db, person.id), [response.id], "only the new passkey is left");
    assert.notEqual(response.id, oldPasskey);
    assert.equal(await count(db, "totp_secrets", person.id), 0, "the old authenticator app is removed");

    assert.equal(await verifyRecoveryCode(db, person.id, oldCode), false, "the old recovery code no longer works");
    assert.equal(await verifyRecoveryCode(db, person.id, result.recoveryCode), true, "the new one does");

    assert.equal(await verifySession(db, oldToken, { clock: CLOCK }), null, "old sessions are signed out");
    const minted = await verifySession(db, result.session.token, { clock: CLOCK });
    assert.equal(minted?.userId, person.id, "the minted session is the person's");
    assert.equal(await count(db, "sessions", person.id), 1, "the new session is the only one");
    assert.match(result.session.cookie, /^__Host-wh_session=/, "the cookie is the sign-in session cookie");
  } finally {
    await db.close();
  }
});

test("a reset that is pending, cancelled, never requested or already used gives nothing", async () => {
  const db = await freshDb();
  try {
    for (const status of [null, "pending", "cancelled", "reenrolled"]) {
      const person = await freshUser(db, `reenrol-refused-${status ?? "none"}`);
      const { oldCode, oldPasskey } = await seedLostFactors(db, person);
      if (status) await setResetStatus(db, person.id, status);

      const response = await newRegistration(db, person);
      const result = await reenrolAfterReset(db, { userId: person.id, response }, depsFor());
      assert.equal(result.ok, false, `status ${status}: refused`);
      assert.deepEqual(await passkeyIds(db, person.id), [oldPasskey], `status ${status}: no passkey stored or removed`);
      assert.equal(await verifyRecoveryCode(db, person.id, oldCode), true, `status ${status}: the code is unchanged`);
      assert.equal(await count(db, "sessions", person.id), 1, `status ${status}: no session minted or removed`);
      assert.equal(await count(db, "totp_secrets", person.id), 1, `status ${status}: the authenticator app is kept`);
      assert.equal(await resetStatus(db, person.id), status, `status ${status}: unchanged`);
    }
  } finally {
    await db.close();
  }
});

test("two re-enrolments racing each other: exactly one claims the reset", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "reenrol-race");
    await seedLostFactors(db, person);
    await setResetStatus(db, person.id, "done");

    const first = await newRegistration(db, person);
    const second = await newRegistration(db, person);
    const results = await Promise.all([
      reenrolAfterReset(db, { userId: person.id, response: first }, depsFor()),
      reenrolAfterReset(db, { userId: person.id, response: second }, depsFor()),
    ]);

    const winners = results.filter((result) => result.ok);
    assert.equal(winners.length, 1, "only one of the racing re-enrolments succeeds");
    assert.equal(await resetStatus(db, person.id), "reenrolled");
    const left = await passkeyIds(db, person.id);
    assert.equal(left.length, 1, "exactly one passkey is left");
    assert.ok([first.id, second.id].includes(left[0]!), "and it is one of the new ones");
    assert.equal(await count(db, "sessions", person.id), 1, "exactly one session is minted");
  } finally {
    await db.close();
  }
});

test("replaying a successful re-enrolment gives nothing", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "reenrol-replay");
    await seedLostFactors(db, person);
    await setResetStatus(db, person.id, "done");

    const response = await newRegistration(db, person);
    const first = await reenrolAfterReset(db, { userId: person.id, response }, depsFor());
    assert.ok(first.ok);
    const replay = await reenrolAfterReset(db, { userId: person.id, response }, depsFor());
    assert.equal(replay.ok, false, "the same registration cannot re-enrol twice");

    // Even a fresh ceremony cannot use the reset again.
    const again = await reenrolAfterReset(db, { userId: person.id, response: await newRegistration(db, person) }, depsFor());
    assert.equal(again.ok, false, "a used reset gives nothing");
    assert.deepEqual(await passkeyIds(db, person.id), [response.id]);
    assert.equal(await count(db, "sessions", person.id), 1);
  } finally {
    await db.close();
  }
});

test("a registration that does not verify leaves the reset ready to try again", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "reenrol-bad");
    const { oldPasskey } = await seedLostFactors(db, person);
    await setResetStatus(db, person.id, "done");

    const response = await newRegistration(db, person);
    const tampered = { ...response, response: { ...response.response, attestationObject: "AAAA" } };
    const bad = await reenrolAfterReset(db, { userId: person.id, response: tampered }, depsFor());
    assert.equal(bad.ok, false);
    assert.equal(await resetStatus(db, person.id), "done", "the reset is still there to use");
    assert.deepEqual(await passkeyIds(db, person.id), [oldPasskey], "nothing was stored or removed");

    // The failed attempt burned its challenge: the untampered response cannot reuse it.
    const reuse = await reenrolAfterReset(db, { userId: person.id, response }, depsFor());
    assert.equal(reuse.ok, false, "a spent challenge does not verify");

    const retry = await reenrolAfterReset(db, { userId: person.id, response: await newRegistration(db, person) }, depsFor());
    assert.ok(retry.ok, "a fresh ceremony succeeds");
  } finally {
    await db.close();
  }
});

test("a reset left unused for too long can no longer be used to set up a passkey", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "reenrol-lapsed");
    await seedLostFactors(db, person);
    const lapsed = new Date(NOW.getTime() - RESET_WAIT_MS - REENROL_WINDOW_MS - DAY_MS);
    await setResetStatus(db, person.id, "done", lapsed);

    assert.equal(await hasCompletedReset(db, { userId: person.id }, { clock: CLOCK }), false);
    const result = await reenrolAfterReset(db, { userId: person.id, response: await newRegistration(db, person) }, depsFor());
    assert.equal(result.ok, false, "a lapsed reset gives nothing; the person asks for a new reset");
    assert.equal(await resetStatus(db, person.id), "done");
  } finally {
    await db.close();
  }
});
