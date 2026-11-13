// "This wasn't me — close re-enrolment" (sign-in audit, founder decision 13 November 2026).
// A completed reset lets whoever reads the email set up a new passkey for 7 days. The
// signed-in owner can close that from the banner: POST /api/auth/reset/close, identity from
// the session cookie alone, refused without a fresh step-up ("confirm it's you"). After a
// close the set-up steps refuse plainly (409 reset_closed) and add nothing.
// Real PGlite with the real migrations, the real session, step-up and passkey modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

import { createResetHandler } from "./handler";
import { RESET_WAIT_MS } from "../../../server/auth/account-reset";
import { createSession, recordStepUp } from "../../../server/auth/session";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { createUser, type User } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import { createAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

const T0 = new Date("2026-06-10T00:00:00.000Z");
const RP_ID = "warthog.com.au";
const ORIGIN = `https://${RP_ID}`;
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-reset-close-hmac-key-0123456789ab", "utf8"));
const clock = fixedClock(T0);

function makeHandler(db: Db, outbox: Outbox = createOutbox()) {
  return createResetHandler({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    senders: { push: outbox, email: outbox, sms: outbox },
    rpId: RP_ID,
    publicOrigin: ORIGIN,
  });
}

function post(body: unknown, init: { origin?: string | null; token?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("origin", origin);
  if (init.token) headers.set("cookie", `__Host-wh_session=${init.token}`);
  return new Request(`${ORIGIN}/api/auth/reset/close`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function seedUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: "d3JhcHBlZA==" });
}

// A reset that completed a day ago, so it is inside its 7-day re-enrolment window.
async function completedReset(db: Db, userId: string): Promise<void> {
  await db.query(
    "INSERT INTO account_resets (user_id, status, requested_at) VALUES ($1, 'done', $2::timestamptz)",
    [userId, new Date(T0.getTime() - RESET_WAIT_MS - 24 * 60 * 60 * 1000).toISOString()],
  );
}

async function resetStatus(db: Db, userId: string): Promise<string | null> {
  const row = await db.query("SELECT status FROM account_resets WHERE user_id = $1", [userId]);
  return (row.rows[0]?.status as string | undefined) ?? null;
}

async function steppedUpToken(db: Db, userId: string): Promise<string> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  await recordStepUp(db, created.session.id, { clock });
  return created.token;
}

function newestCode(outbox: Outbox, email: string): string | undefined {
  return outbox
    .list()
    .filter((m) => m.channel === "email" && m.recipient === email)
    .map((m) => m.body.match(/(?<!\d)\d{6}(?!\d)/)?.[0])
    .filter((c): c is string => c !== undefined)
    .at(-1);
}

test("a signed-in owner who confirmed it's them can close re-enrolment", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const owner = await seedUser(db, "close-owner");
    await completedReset(db, owner.id);
    const res = await handler.close(post({}, { token: await steppedUpToken(db, owner.id) }));
    assert.equal(res.status, 200);
    assert.equal(await resetStatus(db, owner.id), "closed");
  } finally {
    await db.close();
  }
});

test("closing needs a fresh confirmation, a session and the right origin; refusals change nothing", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const owner = await seedUser(db, "close-refused");
    await completedReset(db, owner.id);
    const plain = (await createSession(db, owner.id, { clock, random: systemRandom })).token;

    const noStepUp = await handler.close(post({}, { token: plain }));
    assert.equal(noStepUp.status, 403);
    assert.deepEqual(await noStepUp.json(), { error: "step_up_required" });
    assert.equal((await handler.close(post({}))).status, 401, "no session");
    assert.equal((await handler.close(post({}, { token: await steppedUpToken(db, owner.id), origin: "https://evil.example" }))).status, 403);
    assert.equal((await handler.close(post({}, { token: await steppedUpToken(db, owner.id), origin: null }))).status, 403);
    assert.equal(await resetStatus(db, owner.id), "done", "nothing was closed");
  } finally {
    await db.close();
  }
});

test("closing is member-scoped: a body naming another account is ignored, and nothing to close is 404", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const owner = await seedUser(db, "close-scoped");
    const victim = await seedUser(db, "close-victim");
    await completedReset(db, victim.id);
    const res = await handler.close(post({ userId: victim.id }, { token: await steppedUpToken(db, owner.id) }));
    assert.equal(res.status, 404, "the owner has no completed reset of their own");
    assert.equal(await resetStatus(db, victim.id), "done", "the other account's reset is untouched");
  } finally {
    await db.close();
  }
});

test("after a close, setting up a new passkey is refused plainly and adds nothing", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox);
    const owner = await seedUser(db, "close-then-setup");
    await completedReset(db, owner.id);

    // Whoever reads the email verifies a code and gets the passkey options...
    assert.equal((await handler.setupSendCode(post({ email: owner.email }))).status, 200);
    const verified = await handler.setupVerify(post({ email: owner.email, code: newestCode(outbox, owner.email) }));
    assert.equal(verified.status, 200);
    const { setupId, registrationOptions } = (await verified.json()) as {
      setupId: string; registrationOptions: PublicKeyCredentialCreationOptionsJSON;
    };

    // ...then the owner closes re-enrolment before they finish.
    assert.equal((await handler.close(post({}, { token: await steppedUpToken(db, owner.id) }))).status, 200);

    const finished = await handler.setupFinish(post({ setupId, registrationResponse: await createAuthenticator().register(registrationOptions) }));
    assert.equal(finished.status, 409);
    assert.deepEqual(await finished.json(), { error: "reset_closed" });
    assert.equal(finished.headers.getSetCookie().length, 0, "no session");
    const passkeys = await db.query("SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1", [owner.id]);
    assert.equal(passkeys.rows[0]?.n, 0);

    // A fresh attempt gets no code, and a code still in hand is answered with the plain refusal.
    const before = outbox.list().length;
    assert.equal((await handler.setupSendCode(post({ email: owner.email }))).status, 200, "the same answer as any address");
    assert.equal(outbox.list().length, before, "no code is sent for a closed reset");
  } finally {
    await db.close();
  }
});

test("a code verified after the close is refused with reset_closed", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox);
    const owner = await seedUser(db, "close-then-verify");
    await completedReset(db, owner.id);
    assert.equal((await handler.setupSendCode(post({ email: owner.email }))).status, 200);
    const code = newestCode(outbox, owner.email);
    assert.equal((await handler.close(post({}, { token: await steppedUpToken(db, owner.id) }))).status, 200);

    const verified = await handler.setupVerify(post({ email: owner.email, code }));
    assert.equal(verified.status, 409);
    assert.deepEqual(await verified.json(), { error: "reset_closed" });
  } finally {
    await db.close();
  }
});
