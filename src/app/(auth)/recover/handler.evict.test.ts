// Recovery evicts the lost factors (sign-in audit, founder decision 13 November 2026).
//
// Recovery is email code + recovery code + a new passkey. The person recovering has lost
// their devices, and whoever holds those devices still holds their passkeys, their
// authenticator app and their signed-in sessions. So the register-passkey step, in the SAME
// transaction that saves the new passkey and replaces the recovery code, now:
//   • removes every OTHER passkey and the authenticator app;
//   • signs every session out;
//   • records an "account recovered" activity entry;
// and, once that commits, emails the account-recovered alert exactly once. The alert says
// plainly what was removed, names every agent still connected (agents and their keys are
// KEPT) and gives the support address. `finish` then only mints the new session.
//
// Real PGlite with the real migrations, the real passkey verifier driven by the software
// authenticator, the real recovery-code, session, access-key and activity modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

import { createRecoverHandler } from "./handler";

import { issueRecoveryCode } from "../../../server/auth/recovery";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { createSession, verifySession } from "../../../server/auth/session";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
} from "../../../server/auth/passkey";
import { createUser, type User } from "../../../server/db/users";
import { createAgent } from "../../../server/db/agents";
import { issueAccessKey, verifyAccessKey } from "../../../server/oauth/access-key";
import { createToken, resolveToken } from "../../../server/oauth/store";
import { localAesKeyWrapper, type KeyWrapper } from "../../../server/crypto/key-wrapper";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../test/authenticator";
import { SUPPORT_EMAIL } from "../../../components/public/operator";
import type { Db } from "../../../server/db/index";

const T0 = new Date("2026-05-01T00:00:00.000Z");
const RP_ID = "warthog.com.au";
const ORIGIN = "https://warthog.com.au";
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-recover-evict-hmac-key-0123456789", "utf8"));
const KEY_WRAPPER: KeyWrapper = localAesKeyWrapper(randomBytes(32));

function makeHandler(db: Db, outbox: Outbox = createOutbox(), clock: Clock = fixedClock(T0)) {
  return Object.assign(
    createRecoverHandler({
      db,
      clock,
      random: systemRandom,
      hmacKey: HMAC_KEY,
      emailSender: outbox,
      keyWrapper: KEY_WRAPPER,
      rpId: RP_ID,
      publicOrigin: ORIGIN,
    }),
    { outbox },
  );
}

function post(body: unknown): Request {
  return new Request(`${ORIGIN}/api/auth/recover`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

function emailsTo(outbox: Outbox, recipient: string): string[] {
  return outbox.list().filter((m) => m.channel === "email" && m.recipient === recipient).map((m) => m.body);
}

// The alerts the outbox holds for this person: every email that is not a one-time code.
function alertsTo(outbox: Outbox, recipient: string): string[] {
  return emailsTo(outbox, recipient).filter((body) => /recovered/i.test(body));
}

function emailedCode(outbox: Outbox, email: string): string {
  const code = emailsTo(outbox, email)
    .map((body) => body.match(/(?<!\d)\d{6}(?!\d)/)?.[0])
    .filter((c): c is string => c !== undefined)
    .at(-1);
  assert.ok(code, "identify emails a one-time code");
  return code;
}

// The account as it was before the devices were lost: two passkeys on two devices, an
// authenticator app, two signed-in sessions, a current recovery code, and three agents —
// two connected (one with an access key, one over OAuth) and one already disconnected.
interface Seeded {
  user: User;
  recoveryCode: string;
  oldDevices: SoftwareAuthenticator[];
  oldTokens: string[];
  accessKey: string;
  oauthTokenHash: string;
}

async function seedAccount(db: Db, label: string): Promise<Seeded> {
  const clock = fixedClock(T0);
  const user = await createUser(db, {
    email: `${label}@warthog.com.au`,
    wrappedDek: await KEY_WRAPPER.wrap(randomBytes(32)),
  });
  const oldDevices = [createAuthenticator(), createAuthenticator()];
  for (const device of oldDevices) {
    const options = await beginPasskeyRegistration(db, { userId: user.id, userName: user.email }, { rpId: RP_ID, origin: ORIGIN, clock });
    const registered = await finishPasskeyRegistration(db, { userId: user.id, response: await device.register(options) }, { rpId: RP_ID, origin: ORIGIN, clock });
    assert.equal(registered.ok, true, "test setup: an old passkey registers");
  }
  await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'old-authenticator-ciphertext')", [user.id]);
  const oldTokens = [
    (await createSession(db, user.id, { clock, random: systemRandom })).token,
    (await createSession(db, user.id, { clock, random: systemRandom })).token,
  ];
  const { code } = await issueRecoveryCode(db, user.id, { random: systemRandom });

  const keyAgent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Claude Desktop", platform: "claude" }, clock);
  const { key } = await issueAccessKey(db, { connectionId: keyAgent.connectionId }, { random: systemRandom });
  const oauthAgent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "ChatGPT", platform: "chatgpt" }, clock);
  const oauthTokenHash = randomBytes(32).toString("hex");
  await createToken(db, { tokenHash: oauthTokenHash, connectionId: oauthAgent.connectionId, kind: "access", expiresAt: new Date(T0.getTime() + 3600_000) });
  await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Old Gemini", platform: "gemini", status: "disconnected" }, clock);

  return { user, recoveryCode: code, oldDevices, oldTokens, accessKey: key, oauthTokenHash };
}

// identify → email code → recovery code, returning the handle and registration options.
async function throughVerifyCode(
  handler: ReturnType<typeof makeHandler>,
  email: string,
  recoveryCode: string,
): Promise<{ recoveryId: string; registrationOptions: PublicKeyCredentialCreationOptionsJSON }> {
  const identified = await handler.identify(post({ email }));
  assert.equal(identified.status, 200);
  const { recoveryId } = (await identified.json()) as { recoveryId: string };
  const verified = await handler.verifyEmail(post({ recoveryId, code: emailedCode(handler.outbox, email) }));
  assert.equal(verified.status, 200);
  const coded = await handler.verifyCode(post({ recoveryId, recoveryCode }));
  assert.equal(coded.status, 200);
  const { registrationOptions } = (await coded.json()) as { registrationOptions: PublicKeyCredentialCreationOptionsJSON };
  return { recoveryId, registrationOptions };
}

async function count(db: Db, table: "passkeys" | "totp_secrets" | "sessions", userId: string): Promise<number> {
  const rows = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
  return Number(rows.rows[0]?.n ?? -1);
}

// Whether a device's passkey still signs this person in: a real assertion ceremony.
async function passkeySignsIn(db: Db, userId: string, device: SoftwareAuthenticator): Promise<boolean> {
  const options = await beginPasskeyAuthentication(db, { userId }, { rpId: RP_ID });
  try {
    const assertion = await device.authenticate(options);
    const result = await finishPasskeyAuthentication(db, { userId, response: assertion }, { rpId: RP_ID });
    return result.ok;
  } catch {
    return false;
  }
}

async function recoveredEntries(db: Db, userId: string): Promise<number> {
  const rows = await db.query(
    "SELECT count(*)::int AS n FROM activity_entries WHERE user_id = $1 AND kind = 'account_recovered'",
    [userId],
  );
  return Number(rows.rows[0]?.n ?? -1);
}

test("recovery removes the old passkeys and the authenticator app; the old passkeys no longer sign in", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const seeded = await seedAccount(db, "evict-factors");
    const { user } = seeded;
    assert.equal(await passkeySignsIn(db, user.id, seeded.oldDevices[0]!), true, "test setup: the old passkey works before recovery");

    const newDevice = createAuthenticator();
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, user.email, seeded.recoveryCode);
    const registered = await handler.registerPasskey(post({ recoveryId, registrationResponse: await newDevice.register(registrationOptions) }));
    assert.equal(registered.status, 200);

    assert.equal(await count(db, "passkeys", user.id), 1, "only the new passkey is left");
    assert.equal(await count(db, "totp_secrets", user.id), 0, "the authenticator app is gone");
    for (const device of seeded.oldDevices) {
      assert.equal(await passkeySignsIn(db, user.id, device), false, "an old passkey no longer signs in");
    }
    assert.equal(await passkeySignsIn(db, user.id, newDevice), true, "the new passkey signs in");
  } finally {
    await db.close();
  }
});

test("recovery signs every other session out at the passkey step, even if finish never runs", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const seeded = await seedAccount(db, "evict-sessions");
    const other = await createUser(db, { email: "evict-bystander@warthog.com.au", wrappedDek: await KEY_WRAPPER.wrap(randomBytes(32)) });
    const bystander = await createSession(db, other.id, { clock: fixedClock(T0), random: systemRandom });

    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, seeded.user.email, seeded.recoveryCode);
    const registered = await handler.registerPasskey(post({ recoveryId, registrationResponse: await createAuthenticator().register(registrationOptions) }));
    assert.equal(registered.status, 200);

    // The recovery is abandoned here: finish is never called.
    for (const token of seeded.oldTokens) {
      assert.equal(await verifySession(db, token, { clock: fixedClock(T0) }), null, "an old session no longer verifies");
    }
    assert.equal(await count(db, "sessions", seeded.user.id), 0, "nobody is signed in to the recovered account");
    assert.ok(await verifySession(db, bystander.token, { clock: fixedClock(T0) }), "another account stays signed in");
    assert.equal(alertsTo(handler.outbox, seeded.user.email).length, 1, "the alert went out without finish");
    assert.equal(await recoveredEntries(db, seeded.user.id), 1, "the recovery is on the activity record");
  } finally {
    await db.close();
  }
});

test("the recovery alert is sent once at the passkey step, says what was removed and names every connected agent", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const seeded = await seedAccount(db, "evict-alert");
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, seeded.user.email, seeded.recoveryCode);
    const before = alertsTo(handler.outbox, seeded.user.email).length;
    assert.equal(before, 0, "no recovery alert before the passkey step");

    const registered = await handler.registerPasskey(post({ recoveryId, registrationResponse: await createAuthenticator().register(registrationOptions) }));
    const { recoveryCode: newCode } = (await registered.json()) as { recoveryCode: string };
    const alerts = alertsTo(handler.outbox, seeded.user.email);
    assert.equal(alerts.length, 1, "exactly one alert");
    const alert = alerts[0]!;
    assert.match(alert, /old passkeys and authenticator app were removed/i);
    assert.match(alert, /signed out/i);
    assert.ok(alert.includes("Claude Desktop") && alert.includes("ChatGPT"), "every connected agent is named");
    assert.ok(!alert.includes("Old Gemini"), "a disconnected agent is not listed as connected");
    assert.match(alert, /still connected/i, "the agents are described as kept, never as removed");
    assert.ok(alert.includes(SUPPORT_EMAIL), "the support address is given");
    assert.ok(!alert.includes(newCode) && !alert.includes(seeded.recoveryCode), "no recovery code in the alert");
    assert.ok(!/(?<!\d)\d{6}(?!\d)/.test(alert), "no one-time code in the alert");

    // Retrying either step never alerts again.
    const retried = await handler.registerPasskey(post({ recoveryId, registrationResponse: await createAuthenticator().register(registrationOptions) }));
    assert.ok(retried.status >= 400, "a retried passkey step is refused");
    const finished = await handler.finish(post({ recoveryId }));
    assert.equal(finished.status, 303);
    const again = await handler.finish(post({ recoveryId }));
    assert.equal(again.status, 400, "a repeated finish mints nothing");
    assert.equal(alertsTo(handler.outbox, seeded.user.email).length, 1, "still exactly one alert");
    assert.equal(await count(db, "sessions", seeded.user.id), 1, "one session, from the one finish");
    assert.equal(await recoveredEntries(db, seeded.user.id), 1, "one activity entry");
  } finally {
    await db.close();
  }
});

test("recovery keeps agents and their keys: the access key and the OAuth token still work", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const seeded = await seedAccount(db, "evict-keeps-agents");
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, seeded.user.email, seeded.recoveryCode);
    await handler.registerPasskey(post({ recoveryId, registrationResponse: await createAuthenticator().register(registrationOptions) }));
    await handler.finish(post({ recoveryId }));

    assert.ok(await verifyAccessKey(db, seeded.accessKey), "the access key still verifies");
    assert.ok(await resolveToken(db, seeded.oauthTokenHash), "the OAuth token is kept");
    const statuses = await db.query("SELECT display_name, status FROM agents WHERE user_id = $1 ORDER BY display_name", [seeded.user.id]);
    assert.deepEqual(
      statuses.rows.map((row) => [row.display_name, row.status]),
      [["ChatGPT", "connected"], ["Claude Desktop", "connected"], ["Old Gemini", "disconnected"]],
      "no agent's status changed",
    );
  } finally {
    await db.close();
  }
});

test("finish only mints the new session: a session made with the new passkey after the passkey step survives", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const seeded = await seedAccount(db, "evict-finish-mints");
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, seeded.user.email, seeded.recoveryCode);
    await handler.registerPasskey(post({ recoveryId, registrationResponse: await createAuthenticator().register(registrationOptions) }));
    // The person signs in on another device with the new passkey before tapping Continue here.
    const elsewhere = await createSession(db, seeded.user.id, { clock: fixedClock(T0), random: systemRandom });

    const finished = await handler.finish(post({ recoveryId }));
    assert.equal(finished.status, 303);
    assert.ok(await verifySession(db, elsewhere.token, { clock: fixedClock(T0) }), "finish signs nobody out");
    assert.equal(await count(db, "sessions", seeded.user.id), 2);
  } finally {
    await db.close();
  }
});

test("duplicate or competing passkey steps evict once and alert once", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const first = makeHandler(db, outbox);
    const second = makeHandler(db, outbox, fixedClock(new Date(T0.getTime() + 60_000)));
    const seeded = await seedAccount(db, "evict-race");
    const a = await throughVerifyCode(first, seeded.user.email, seeded.recoveryCode);
    const b = await throughVerifyCode(second, seeded.user.email, seeded.recoveryCode);
    const responseA = await createAuthenticator().register(a.registrationOptions);
    const responseB = await createAuthenticator().register(b.registrationOptions);

    const results = await Promise.all([
      first.registerPasskey(post({ recoveryId: a.recoveryId, registrationResponse: responseA })),
      first.registerPasskey(post({ recoveryId: a.recoveryId, registrationResponse: responseA })),
      second.registerPasskey(post({ recoveryId: b.recoveryId, registrationResponse: responseB })),
    ]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, "exactly one passkey step succeeds");
    assert.equal(await count(db, "passkeys", seeded.user.id), 1, "one passkey is left: the winner's");
    assert.equal(await count(db, "totp_secrets", seeded.user.id), 0);
    assert.equal(await count(db, "sessions", seeded.user.id), 0);
    assert.equal(alertsTo(outbox, seeded.user.email).length, 1, "one alert");
    assert.equal(await recoveredEntries(db, seeded.user.id), 1, "one activity entry");
  } finally {
    await db.close();
  }
});

test("a passkey step that fails to verify removes nothing and alerts nobody", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const seeded = await seedAccount(db, "evict-bad-attestation");
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, seeded.user.email, seeded.recoveryCode);
    const response = await createAuthenticator().register(registrationOptions);
    const tampered = { ...response, response: { ...response.response, clientDataJSON: Buffer.from("{}").toString("base64url") } };

    const refused = await handler.registerPasskey(post({ recoveryId, registrationResponse: tampered }));
    assert.equal(refused.status, 400);
    assert.equal(await count(db, "passkeys", seeded.user.id), 2, "the old passkeys are untouched");
    assert.equal(await count(db, "totp_secrets", seeded.user.id), 1, "the authenticator app is untouched");
    assert.equal(await count(db, "sessions", seeded.user.id), 2, "nobody was signed out");
    assert.equal(alertsTo(handler.outbox, seeded.user.email).length, 0, "no alert");
    assert.equal(await recoveredEntries(db, seeded.user.id), 0, "no activity entry");
  } finally {
    await db.close();
  }
});

test("a sign-in request approved before the recovery can't be collected after it", async () => {
  const db = await freshDb();
  try {
    const { requestNewDeviceApproval, approveDeviceSignInRequest, collectNewDeviceApproval, listDeviceSignInRequests } =
      await import("../../../server/auth/new-device");
    const { issueEmailCode } = await import("../../../server/auth/email-code");
    const { recordStepUp } = await import("../../../server/auth/session");
    const clock = fixedClock(T0);
    const handler = makeHandler(db);
    const seeded = await seedAccount(db, "evict-device-request");

    // The person gets as far as the passkey step...
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, seeded.user.email, seeded.recoveryCode);

    // ...while whoever holds an old session approves a new device of their own, a minute
    // later (one code per address at a time), but hasn't collected it yet.
    const codes = createOutbox();
    const later = fixedClock(new Date(T0.getTime() + 2 * 60_000));
    await issueEmailCode(db, seeded.user.email, { purpose: "device", clock: later, random: systemRandom, hmacKey: HMAC_KEY, emailSender: codes });
    const requested = await requestNewDeviceApproval(
      db,
      { email: seeded.user.email, code: emailedCode(codes, seeded.user.email), deviceLabel: "Chrome on Mac" },
      { clock: later, random: systemRandom, hmacKey: HMAC_KEY, emailSender: codes, pushSender: codes },
    );
    assert.ok(requested.ok);
    const approver = await createSession(db, seeded.user.id, { clock, random: systemRandom });
    const stepped = await recordStepUp(db, approver.session.id, { clock });
    const [waiting] = listDeviceSignInRequests(stepped, { clock });
    assert.ok(waiting);
    assert.deepEqual(await approveDeviceSignInRequest({ approvalId: waiting.id, approvingSession: stepped }, { clock }), { ok: true });

    const registered = await handler.registerPasskey(post({ recoveryId, registrationResponse: await createAuthenticator().register(registrationOptions) }));
    assert.equal(registered.status, 200);

    const collected = await collectNewDeviceApproval(db, { requestId: requested.requestId }, { clock, random: systemRandom, emailSender: codes });
    assert.equal(collected.ok, false, "the approved request was discarded with the sessions");
    assert.equal(await count(db, "sessions", seeded.user.id), 0);
  } finally {
    await db.close();
  }
});

test("an account deleted mid-recovery can't be recovered: nothing is added, removed or sent", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const seeded = await seedAccount(db, "evict-deleted");
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, seeded.user.email, seeded.recoveryCode);
    await db.query("UPDATE users SET wrapped_dek = '' WHERE id = $1", [seeded.user.id]);

    const refused = await handler.registerPasskey(post({ recoveryId, registrationResponse: await createAuthenticator().register(registrationOptions) }));
    assert.equal(refused.status, 400);
    assert.equal(await count(db, "passkeys", seeded.user.id), 2);
    assert.equal(await count(db, "totp_secrets", seeded.user.id), 1);
    assert.equal(alertsTo(handler.outbox, seeded.user.email).length, 0);
  } finally {
    await db.close();
  }
});
