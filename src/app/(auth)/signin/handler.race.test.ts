// Sign-in versus recovery (sign-in audit, 14 November 2026). A sign-in on a lost device checks
// its passkey or authenticator code, then mints its session. A recovery that evicts the lost
// devices in between used to leave that session standing; now the session is minted only
// while the passkey or the app that accepted the code is still on the account
// (src/server/auth/sign-in-guard.ts). Each test lands the eviction in that gap.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

import { createSigninHandler } from "./handler";
import { emailProofFor } from "../../../test/totp-signin";
import { beginPasskeyRegistration, finishPasskeyRegistration } from "../../../server/auth/passkey";
import { lockAccountForEviction } from "../../../server/auth/session";
import { evictLostFactors } from "../../../server/auth/recover-session";
import { createUser, type User } from "../../../server/db/users";
import { withTransaction, type Db } from "../../../server/db/index";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock } from "../../../server/seams/clock";
import { createOutbox } from "../../../server/notify/outbox";
import { createAuthenticator } from "../../../test/authenticator";
import { freshDb } from "../../../test/db";

const T0 = new Date(1111111111 * 1000);
const clock = fixedClock(T0);
const RP_ID = "warthog.com.au";
const ORIGIN = "https://warthog.com.au";
const HMAC_KEY = new Uint8Array(32).fill(5);
// The RFC 6238 vector secret and its code at T0.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const CODE = "050471";

function handlerFor(db: Db, secrets = new Map<string, string>()) {
  return createSigninHandler({
    db, clock, random: systemRandom, hmacKey: HMAC_KEY, emailSender: createOutbox(), rpId: RP_ID, publicOrigin: ORIGIN,
    totpSecrets: { get: async (userId) => secrets.get(userId) ?? null },
  });
}

function post(body: unknown): Request {
  return new Request(`${ORIGIN}/api/auth/signin`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

// Recovery's eviction once the new passkey is saved: every other passkey, the app, every session.
async function evict(db: Db, userId: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    await lockAccountForEviction(tx, userId);
    await evictLostFactors(tx, userId, "the-new-passkey");
  });
}

// Run `then` once, right after the first statement matching `pattern` returns.
function afterStatement(db: Db, pattern: RegExp, then: () => Promise<void>): Db {
  let fired = false;
  return {
    inTransaction: db.inTransaction,
    async query(text, values) {
      const result = await db.query(text, values);
      if (!fired && pattern.test(text)) {
        fired = true;
        await then();
      }
      return result;
    },
    close: () => db.close(),
    ...(db.transaction ? { transaction: <T>(fn: (tx: Db) => Promise<T>) => db.transaction!(fn) } : {}),
  };
}

async function person(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: "wrapped-dek-placeholder" });
}

async function sessionsOf(db: Db, userId: string): Promise<number> {
  return (await db.query("SELECT id FROM sessions WHERE user_id = $1", [userId])).rows.length;
}

test("a passkey sign-in whose passkey a recovery evicts before the session is minted is refused", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "passkey-race");
    const lostDevice = createAuthenticator();
    const registration = await lostDevice.register(
      await beginPasskeyRegistration(db, { userId: user.id, userName: user.email }, { rpId: RP_ID }));
    assert.equal((await finishPasskeyRegistration(db, { userId: user.id, response: registration }, { rpId: RP_ID })).ok, true);

    // The assertion verifies (the counter advances), then the owner's recovery commits.
    const racing = afterStatement(db, /UPDATE passkeys SET counter/, () => evict(db, user.id));
    const handler = handlerFor(racing);
    const begun = await handler.beginPasskey(post({ email: user.email }));
    const { options } = (await begun.json()) as { options: PublicKeyCredentialRequestOptionsJSON };
    const response = await handler.finishPasskey(post({ email: user.email, authenticationResponse: await lostDevice.authenticate(options) }));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_assertion" });
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await sessionsOf(db, user.id), 0);
  } finally {
    await db.close();
  }
});

test("an authenticator sign-in whose app a recovery removes before the session is minted is refused", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "totp-race");
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'opaque')", [user.id]);
    // The code is accepted (its step recorded), then the owner's recovery commits.
    const racing = afterStatement(db, /SET last_step/, () => evict(db, user.id));
    const handler = handlerFor(racing, new Map([[user.id, SECRET]]));
    const signinId = await emailProofFor(handler, db, user.email, { clock, hmacKey: HMAC_KEY, origin: ORIGIN });
    const response = await handler.signInWithTotp(post({ signinId, totp: CODE }));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_code" });
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await sessionsOf(db, user.id), 0);
  } finally {
    await db.close();
  }
});

test("with no recovery in between, the authenticator sign-in still mints a stepped-up session", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "totp-no-race");
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'opaque')", [user.id]);
    const handler = handlerFor(db, new Map([[user.id, SECRET]]));
    const signinId = await emailProofFor(handler, db, user.email, { clock, hmacKey: HMAC_KEY, origin: ORIGIN });
    const response = await handler.signInWithTotp(post({ signinId, totp: CODE }));

    assert.equal(response.status, 303);
    const sessions = await db.query("SELECT stepped_up_at FROM sessions WHERE user_id = $1", [user.id]);
    assert.equal(sessions.rows.length, 1);
    assert.deepEqual(new Date(sessions.rows[0]!.stepped_up_at as string), T0);
  } finally {
    await db.close();
  }
});
