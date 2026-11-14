// The sign-in guard (sign-in audit, 14 November 2026): a session is minted, and a new sign-in
// method stored, only while what proved it is still on the account. The unit tests cover each
// proof; the race tests land a recovery's eviction (or a regeneration) inside the gap between a
// path's check and its write, the moment the audit left open, and expect the path refused with
// nothing written. PGlite has one connection, so these cover the re-check; the lock waits
// themselves are certified against PostgreSQL 16 in scripts/verify-local-postgres-security.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createSessionWhileProofHolds, stillSignedIn, whileSignedIn, type SignInProof } from "./sign-in-guard";
import { createSession, lockAccountForEviction, recordStepUp, verifySession, type Session } from "./session";
import { evictLostFactors } from "./recover-session";
import { issueEmailCode } from "./email-code";
import { issueRecoveryCode, verifyRecoveryCode } from "./recovery";
import {
  approveDeviceSignInRequest,
  collectNewDeviceApproval,
  listDeviceSignInRequests,
  requestNewDeviceApproval,
  signInNewDeviceWithRecoveryCode,
} from "./new-device";
import { createTotpEnrolment } from "./totp-enrolment";
import { createTotpSecretStore } from "./totp-store";
import { createUser, type User } from "../db/users";
import { withTransaction, type Db } from "../db/index";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { systemRandom, type Random } from "../seams/random";
import { createOutbox, type Outbox } from "../notify/outbox";
import { freshDb } from "../../test/db";

// The RFC 6238 vector: this secret's code at T0 is 050471.
const T0 = new Date(1111111111 * 1000);
const STEP = Math.floor(T0.getTime() / 30_000);
const VECTOR_CODE = "050471";
const clock = { now: () => T0 };
const hmacKey = new Uint8Array(32).fill(9);
const keyWrapper = localAesKeyWrapper(randomBytes(32));
const vectorRandom: Random = {
  randomBytes: (size) => (size === 20 ? Buffer.from("12345678901234567890") : systemRandom.randomBytes(size)),
};

async function person(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@example.test`, wrappedDek: await keyWrapper.wrap(randomBytes(32)) });
}

async function steppedUpSession(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  return recordStepUp(db, created.session.id, { clock });
}

// What recovery does once the new passkey is saved, keeping `keep` (any other id evicts all).
async function evict(db: Db, userId: string, keep = "the-new-passkey"): Promise<void> {
  await withTransaction(db, async (tx) => {
    await lockAccountForEviction(tx, userId);
    await evictLostFactors(tx, userId, keep);
  });
}

async function sessionsOf(db: Db, userId: string): Promise<number> {
  return (await db.query("SELECT id FROM sessions WHERE user_id = $1", [userId])).rows.length;
}

// Run `then` once, right after the first statement matching `pattern` returns: the gap
// between a path's check and its write.
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

async function deviceCode(db: Db, email: string, outbox: Outbox): Promise<string> {
  const issued = await issueEmailCode(db, email, { purpose: "device", clock, random: systemRandom, hmacKey, emailSender: outbox });
  assert.equal(issued.ok, true);
  const code = outbox.list().at(-1)?.body.match(/\b\d{6}\b/)?.[0];
  assert.ok(code);
  return code;
}

test("a session is minted while each kind of proof is still on the account, and carries a step-up when asked", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "proofs-hold");
    await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, 'cred', 'k', 0)", [user.id]);
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc, last_step) VALUES ($1, 'x', $2::bigint)", [user.id, STEP]);
    await issueRecoveryCode(db, user.id, { random: systemRandom });
    const salt = (await db.query("SELECT salt FROM recovery_codes WHERE user_id = $1", [user.id])).rows[0]!.salt;
    const approver = await steppedUpSession(db, user.id);
    const proofs: SignInProof[] = [
      { kind: "passkey", credentialId: "cred" },
      { kind: "authenticator", step: STEP },
      { kind: "recovery_code", generation: salt as string },
      { kind: "approval", sessionId: approver.id },
    ];
    for (const proof of proofs) {
      const created = await createSessionWhileProofHolds(db, user.id, proof, { clock, random: systemRandom });
      assert.ok(created, `${proof.kind} holds, so a session is minted`);
      assert.equal(created.session.steppedUpAt, null);
      assert.ok(await verifySession(db, created.token, { clock }));
    }
    const stepped = await createSessionWhileProofHolds(db, user.id, proofs[0]!, { clock, random: systemRandom }, { stepUp: true });
    assert.deepEqual(stepped?.session.steppedUpAt, T0);
    assert.deepEqual((await verifySession(db, stepped!.token, { clock }))?.steppedUpAt, T0);
  } finally {
    await db.close();
  }
});

test("no session is minted once the proof is gone, and nothing is written", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "proofs-gone");
    const other = await person(db, "someone-else");
    await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, 'theirs', 'k', 0)", [other.id]);
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc, last_step) VALUES ($1, 'x', $2::bigint)", [user.id, STEP - 1]);
    await issueRecoveryCode(db, user.id, { random: systemRandom });
    const otherSession = await steppedUpSession(db, other.id);
    const refused: [string, SignInProof][] = [
      ["a passkey that isn't on this account", { kind: "passkey", credentialId: "theirs" }],
      ["an authenticator whose last accepted code is older", { kind: "authenticator", step: STEP }],
      ["a replaced recovery code", { kind: "recovery_code", generation: "an-older-salt" }],
      ["an approving session of another account", { kind: "approval", sessionId: otherSession.id }],
    ];
    for (const [label, proof] of refused) {
      assert.equal(await createSessionWhileProofHolds(db, user.id, proof, { clock, random: systemRandom }), null, label);
    }
    assert.equal(await sessionsOf(db, user.id), 0);
  } finally {
    await db.close();
  }
});

test("a deleted account gets no session even with its proof in place", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "deleted");
    await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, 'cred', 'k', 0)", [user.id]);
    await db.query("UPDATE users SET wrapped_dek = '' WHERE id = $1", [user.id]);
    await assert.rejects(
      createSessionWhileProofHolds(db, user.id, { kind: "passkey", credentialId: "cred" }, { clock, random: systemRandom }),
      (error: unknown) => (error as { status?: number }).status === 401,
    );
    assert.equal(await sessionsOf(db, user.id), 0);
  } finally {
    await db.close();
  }
});

test("a signed-in change runs only while its session exists", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "signed-in-change");
    const session = await steppedUpSession(db, user.id);
    assert.equal(await whileSignedIn(db, session, async () => "changed"), "changed");
    assert.equal(await withTransaction(db, (tx) => stillSignedIn(tx, session)), true);
    await evict(db, user.id);
    let ran = false;
    assert.equal(await whileSignedIn(db, session, async () => { ran = true; return "changed"; }), null);
    assert.equal(ran, false, "the change never runs for a session that has ended");
    assert.equal(await withTransaction(db, (tx) => stillSignedIn(tx, session)), false);
  } finally {
    await db.close();
  }
});

test("a new-device recovery-code sign-in gets no session when the code is replaced before it mints", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const user = await person(db, "device-recovery-race");
    const { code: recoveryCode } = await issueRecoveryCode(db, user.id, { random: systemRandom });
    const code = await deviceCode(db, user.email, outbox);
    // The owner recovers (which replaces the code) just after this device's code was checked.
    const racing = afterStatement(db, /SELECT auth_hash, salt FROM recovery_codes/, async () => {
      await issueRecoveryCode(db, user.id, { random: systemRandom });
      await evict(db, user.id);
    });
    const result = await signInNewDeviceWithRecoveryCode(racing, { email: user.email, code, recoveryCode },
      { clock, random: systemRandom, hmacKey, emailSender: outbox });
    assert.deepEqual(result, { ok: false, reason: "recovery_rejected" });
    assert.equal(await sessionsOf(db, user.id), 0);
    assert.equal(await verifyRecoveryCode(db, user.id, recoveryCode), false);
  } finally {
    await db.close();
  }
});

test("a sign-in request approved from a session that recovery signed out can't be collected", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const deps = { clock, random: systemRandom, hmacKey, emailSender: outbox, pushSender: outbox };
    const user = await person(db, "approval-race");
    const approver = await steppedUpSession(db, user.id);
    const started = await requestNewDeviceApproval(db, { email: user.email, code: await deviceCode(db, user.email, outbox),
      deviceLabel: "a phone" }, deps);
    if (!started.ok) assert.fail("the request starts");
    const approvalId = listDeviceSignInRequests(approver, { clock })[0]!.id;
    assert.deepEqual(await approveDeviceSignInRequest({ approvalId, approvingSession: approver }, { clock }), { ok: true });
    // The approving device is evicted before the request is collected (and before recovery
    // discards the pending requests, which runs after its commit).
    await evict(db, user.id);
    assert.deepEqual(await collectNewDeviceApproval(db, { requestId: started.requestId }, deps), { ok: false, reason: "not_approved" });
    assert.equal(await sessionsOf(db, user.id), 0);
  } finally {
    await db.close();
  }
});

test("an authenticator set-up finished by a session recovery has just signed out stores nothing", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "enrol-race");
    const session = await steppedUpSession(db, user.id);
    const enrolment = createTotpEnrolment({ db, clock, random: vectorRandom, totpSecrets: createTotpSecretStore({ db, keyWrapper }) });
    assert.equal((await enrolment.begin(session)).ok, true);
    // The session passed its checks (it is a stepped-up object in hand); then recovery evicts.
    await evict(db, user.id);
    assert.deepEqual(await enrolment.verify(session, VECTOR_CODE), { ok: false, reason: "signed_out" });
    assert.equal((await db.query("SELECT 1 FROM totp_secrets WHERE user_id = $1", [user.id])).rows.length, 0);
  } finally {
    await db.close();
  }
});

test("an authenticator set-up by a live session still stores the app", async () => {
  const db = await freshDb();
  try {
    const user = await person(db, "enrol-live");
    const session = await steppedUpSession(db, user.id);
    const enrolment = createTotpEnrolment({ db, clock, random: vectorRandom, totpSecrets: createTotpSecretStore({ db, keyWrapper }) });
    assert.equal((await enrolment.begin(session)).ok, true);
    assert.deepEqual(await enrolment.verify(session, VECTOR_CODE), { ok: true });
    const row = (await db.query("SELECT last_step FROM totp_secrets WHERE user_id = $1", [user.id])).rows[0];
    assert.equal(Number(row?.last_step), STEP);
  } finally {
    await db.close();
  }
});
