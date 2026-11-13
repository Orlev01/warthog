// Removing the authenticator app from Settings › Security (sign-in audit, founder decision
// 13 November 2026). Like removing a passkey it needs a fresh "confirm it's you", is scoped
// to the session's own account, and never leaves the account without a way to sign in: with
// no passkey it is refused (last_sign_in_method), checked under the account row lock so a
// parallel passkey removal can't race it to zero. The member is emailed when it goes.
// Real PGlite with the real migrations, session, step-up and passkey modules.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSecurityActions } from "./actions";
import { createSession, recordStepUp, type Session } from "../../../../../server/auth/session";
import { beginPasskeyRegistration, finishPasskeyRegistration } from "../../../../../server/auth/passkey";
import { createUser } from "../../../../../server/db/users";
import { fixedClock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { freshDb } from "../../../../../test/db";
import { createAuthenticator } from "../../../../../test/authenticator";
import { SUPPORT_EMAIL } from "../../../../../components/public/operator";
import type { Db } from "../../../../../server/db/index";

const T0 = new Date("2026-05-01T00:00:00.000Z");
const RP_ID = "warthog.com.au";
const clock = fixedClock(T0);

function makeActions(db: Db, sent: { recipient: string; body: string }[] = [], fail = false) {
  return createSecurityActions({
    db,
    clock,
    random: systemRandom,
    rpId: RP_ID,
    alerts: {
      emailSender: {
        sendEmail: async (message) => {
          if (fail) throw new Error("email down");
          sent.push(message);
        },
      },
    },
  });
}

async function person(db: Db, email: string): Promise<string> {
  return (await createUser(db, { email, wrappedDek: "opaque" })).id;
}

async function withPasskey(db: Db, userId: string): Promise<void> {
  const options = await beginPasskeyRegistration(db, { userId, userName: userId }, { rpId: RP_ID });
  const result = await finishPasskeyRegistration(db, { userId, response: await createAuthenticator().register(options) }, { rpId: RP_ID });
  assert.equal(result.ok, true);
}

async function withAuthenticator(db: Db, userId: string): Promise<void> {
  await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'opaque-secret')", [userId]);
}

async function hasAuthenticator(db: Db, userId: string): Promise<boolean> {
  const rows = await db.query("SELECT 1 FROM totp_secrets WHERE user_id = $1", [userId]);
  return rows.rows.length > 0;
}

async function steppedUp(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  return recordStepUp(db, created.session.id, { clock });
}

test("with a passkey and a fresh confirmation, the authenticator app is removed and the member is told", async () => {
  const db = await freshDb();
  try {
    const sent: { recipient: string; body: string }[] = [];
    const actions = makeActions(db, sent);
    const alice = await person(db, "remove-app@warthog.com.au");
    await withPasskey(db, alice);
    await withAuthenticator(db, alice);
    const session = await steppedUp(db, alice);

    assert.deepEqual(await actions.removeAuthenticator(session), { ok: true });
    assert.equal(await hasAuthenticator(db, alice), false);
    assert.equal((await actions.load(session)).authenticatorEnabled, false);
    assert.equal(sent.length, 1, "one alert");
    assert.equal(sent[0]!.recipient, "remove-app@warthog.com.au");
    assert.match(sent[0]!.body, /authenticator app was removed/i);
    assert.ok(sent[0]!.body.includes(SUPPORT_EMAIL));
    assert.ok(!/(?<!\d)\d{6}(?!\d)/.test(sent[0]!.body), "no code in the alert");
  } finally {
    await db.close();
  }
});

test("without a passkey the authenticator app is the last way in, so removal is refused", async () => {
  const db = await freshDb();
  try {
    const sent: { recipient: string; body: string }[] = [];
    const actions = makeActions(db, sent);
    const alice = await person(db, "app-only@warthog.com.au");
    await withAuthenticator(db, alice);
    const session = await steppedUp(db, alice);

    assert.deepEqual(await actions.removeAuthenticator(session), { ok: false, reason: "last_sign_in_method" });
    assert.equal(await hasAuthenticator(db, alice), true, "the authenticator app survives");
    assert.equal(sent.length, 0, "no alert");
  } finally {
    await db.close();
  }
});

test("removal needs a fresh confirmation; without one nothing changes", async () => {
  const db = await freshDb();
  try {
    const sent: { recipient: string; body: string }[] = [];
    const actions = makeActions(db, sent);
    const alice = await person(db, "app-stale@warthog.com.au");
    await withPasskey(db, alice);
    await withAuthenticator(db, alice);
    const stale = (await createSession(db, alice, { clock, random: systemRandom })).session;

    assert.deepEqual(await actions.removeAuthenticator(stale), { ok: false, reason: "step_up_required" });
    const old = await recordStepUp(db, stale.id, { clock: fixedClock(new Date(T0.getTime() - 10 * 60_000)) });
    assert.deepEqual(await actions.removeAuthenticator(old), { ok: false, reason: "step_up_required" }, "a confirmation older than five minutes");
    assert.equal(await hasAuthenticator(db, alice), true);
    assert.equal(sent.length, 0);
  } finally {
    await db.close();
  }
});

test("removal is member-scoped: only the session's own authenticator app goes", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await person(db, "app-alice@warthog.com.au");
    const bob = await person(db, "app-bob@warthog.com.au");
    await withPasskey(db, alice);
    await withPasskey(db, bob);
    await withAuthenticator(db, bob);

    assert.deepEqual(await actions.removeAuthenticator(await steppedUp(db, alice)), { ok: false, reason: "not_found" },
      "Alice has no authenticator app to remove");
    assert.equal(await hasAuthenticator(db, bob), true, "Bob's is untouched");
  } finally {
    await db.close();
  }
});

test("a failed alert never undoes the removal", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db, [], true);
    const alice = await person(db, "app-alert-down@warthog.com.au");
    await withPasskey(db, alice);
    await withAuthenticator(db, alice);
    assert.deepEqual(await actions.removeAuthenticator(await steppedUp(db, alice)), { ok: true });
    assert.equal(await hasAuthenticator(db, alice), false);
  } finally {
    await db.close();
  }
});

test("removing the only passkey and the authenticator app in parallel leaves one of them", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await person(db, "app-race@warthog.com.au");
    await withPasskey(db, alice);
    await withAuthenticator(db, alice);
    const session = await steppedUp(db, alice);
    const onlyPasskey = (await actions.load(session)).passkeys[0]!.id;

    const results = await Promise.all([actions.removeAuthenticator(session), actions.removePasskey(session, onlyPasskey)]);
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one removal goes through");
    assert.deepEqual(results.find((r) => !r.ok), { ok: false, reason: "last_sign_in_method" });
    const passkeys = await db.query("SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1", [alice]);
    assert.equal(Number(passkeys.rows[0]?.n) + (await hasAuthenticator(db, alice) ? 1 : 0), 1, "one sign-in method remains");
  } finally {
    await db.close();
  }
});
