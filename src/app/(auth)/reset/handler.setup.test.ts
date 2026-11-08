// Review fix W5 — "Reset finished? Set up a new passkey": the re-enrolment steps of the
// account-reset handler (`./handler`). A completed reset leaves the person with no passkey
// they can use and no recovery code; these steps are the way back in.
//
//   setupSendCode — { email }: email a one-time code when the address has a finished
//                   reset; the same 200 either way (no enumeration).
//   setupVerify   — { email, code }: the email code, then passkey registration options
//                   only when the account's reset status is 'done'.
//   setupFinish   — { setupId, registrationResponse }: register the passkey, claim the
//                   reset 'done' → 'reenrolled', issue a new recovery code (shown once)
//                   and set the session cookie exactly as sign-in does.
//
// Every step refuses a missing or foreign Origin (403) and validates its body at the
// boundary. Real PGlite with the real migrations, the real passkey verifier driven by the
// software authenticator; delivery goes to an outbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

import { createResetHandler } from "./handler";
import { RESET_WAIT_MS } from "../../../server/auth/account-reset";
import { verifyRecoveryCode } from "../../../server/auth/recovery";
import { createSession, verifySession } from "../../../server/auth/session";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { createUser, type User } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import type { Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import { createAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

const T0 = new Date("2026-06-10T00:00:00.000Z");
const RP_ID = "warthog.com.au";
const GOOD_ORIGIN = `https://${RP_ID}`;
const FOREIGN_ORIGIN = "https://evil.example";
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-reset-hmac-key-0123456789abcdef", "utf8"));

// A clock the test can move forward (email codes allow one issue a minute per address).
function movableClock(start: Date): { clock: Clock; advance(ms: number): void } {
  let now = start.getTime();
  return { clock: { now: () => new Date(now) }, advance: (ms) => (now += ms) };
}

function makeHandler(db: Db, outbox: Outbox, clock: Clock) {
  return createResetHandler({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    senders: { push: outbox, email: outbox, sms: outbox },
    rpId: RP_ID,
    publicOrigin: GOOD_ORIGIN,
  });
}

function post(body: unknown, init: { origin?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = init.origin === undefined ? GOOD_ORIGIN : init.origin;
  if (origin !== null) headers.set("origin", origin);
  return new Request(`${GOOD_ORIGIN}/api/auth/reset/step`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function seedUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: "d3JhcHBlZA==" });
}

async function setResetStatus(db: Db, userId: string, status: string): Promise<void> {
  await db.query(
    `INSERT INTO account_resets (user_id, status, requested_at) VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status`,
    [userId, status, new Date(T0.getTime() - RESET_WAIT_MS - 60_000).toISOString()],
  );
}

async function resetStatus(db: Db, userId: string): Promise<string | null> {
  const row = await db.query("SELECT status FROM account_resets WHERE user_id = $1", [userId]);
  return (row.rows[0]?.status as string | undefined) ?? null;
}

function emailsTo(outbox: Outbox, email: string) {
  return outbox.list().filter((m) => m.channel === "email" && m.recipient === email);
}

function newestCode(outbox: Outbox, email: string): string {
  const mail = emailsTo(outbox, email).at(-1);
  assert.ok(mail, `an email went to ${email}`);
  const match = mail.body.match(/(?<!\d)\d{6}(?!\d)/);
  assert.ok(match, "the email carries a six-digit code");
  return match[0];
}

// send-code then verify; returns the verify response.
async function sendAndVerify(handler: ReturnType<typeof makeHandler>, outbox: Outbox, email: string) {
  assert.equal((await handler.setupSendCode(post({ email }))).status, 200);
  return handler.setupVerify(post({ email, code: newestCode(outbox, email) }));
}

async function verified(response: Response): Promise<{ setupId: string; registrationOptions: PublicKeyCredentialCreationOptionsJSON }> {
  assert.equal(response.status, 200);
  const body = (await response.json()) as { setupId: string; registrationOptions: PublicKeyCredentialCreationOptionsJSON };
  assert.equal(typeof body.setupId, "string");
  assert.equal(body.registrationOptions.rp.id, RP_ID, "the options carry the configured RP ID");
  return body;
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

test("the whole path: email code, a new passkey, a new recovery code shown once and a session", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const { clock } = movableClock(T0);
    const handler = makeHandler(db, outbox, clock);
    const person = await seedUser(db, "setup-ok");
    await setResetStatus(db, person.id, "done");
    const oldSession = await createSession(db, person.id, { clock, random: systemRandom });

    const { setupId, registrationOptions } = await verified(await sendAndVerify(handler, outbox, person.email));
    const registrationResponse = await createAuthenticator().register(registrationOptions);
    const res = await handler.setupFinish(post({ setupId, registrationResponse }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store", "the recovery code is never cached");
    const body = (await res.json()) as { recoveryCode: string };
    assert.equal(await verifyRecoveryCode(db, person.id, body.recoveryCode), true, "the shown code is the account's new code");

    const cookies = setCookies(res);
    const session = cookies.find((c) => c.startsWith("__Host-wh_session="));
    assert.ok(session, "the session cookie is set");
    assert.match(session, /HttpOnly/i);
    assert.match(session, /Secure/i);
    assert.ok(cookies.some((c) => c.startsWith("__Host-wh_device=")), "the device cookie is set, as at sign-in");
    const token = session.slice("__Host-wh_session=".length).split(";")[0]!;
    assert.equal((await verifySession(db, token, { clock }))?.userId, person.id, "the cookie signs the person in");
    assert.equal(await verifySession(db, oldSession.token, { clock }), null, "older sessions are signed out");

    assert.equal(await resetStatus(db, person.id), "reenrolled");
    const alerts = emailsTo(outbox, person.email).filter((m) => /after its reset/i.test(m.body));
    assert.equal(alerts.length, 1, "the person is told a new passkey was set up");
    assert.ok(!alerts[0]!.body.includes(body.recoveryCode), "the alert never carries the code");
  } finally {
    await db.close();
  }
});

test("send-code answers the same whether or not the address has a finished reset", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox, movableClock(T0).clock);
    const done = await seedUser(db, "setup-send-done");
    const pending = await seedUser(db, "setup-send-pending");
    const none = await seedUser(db, "setup-send-none");
    await setResetStatus(db, done.id, "done");
    await setResetStatus(db, pending.id, "pending");

    const answers = [];
    for (const email of [done.email, pending.email, none.email, "nobody@warthog.com.au"]) {
      const res = await handler.setupSendCode(post({ email }));
      assert.equal(res.status, 200);
      answers.push(await res.json());
    }
    for (const answer of answers) assert.deepEqual(answer, answers[0], "every answer is identical");
    assert.equal(emailsTo(outbox, done.email).length, 1, "a finished reset's address is emailed a code");
    for (const email of [pending.email, none.email, "nobody@warthog.com.au"]) {
      assert.equal(emailsTo(outbox, email).length, 0, `${email} is not emailed`);
    }
  } finally {
    await db.close();
  }
});

test("verify gives registration options only for a finished reset, and only with the right code", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const { clock, advance } = movableClock(T0);
    const handler = makeHandler(db, outbox, clock);
    const person = await seedUser(db, "setup-verify");
    await setResetStatus(db, person.id, "done");

    await handler.setupSendCode(post({ email: person.email }));
    const code = newestCode(outbox, person.email);
    const wrong = await handler.setupVerify(post({ email: person.email, code: code === "000000" ? "111111" : "000000" }));
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json() as { registrationOptions?: unknown }).registrationOptions, undefined);

    // A pending reset: the code is proven but there is nothing to set up.
    await setResetStatus(db, person.id, "pending");
    const early = await handler.setupVerify(post({ email: person.email, code }));
    assert.equal(early.status, 409);
    assert.equal((await early.json() as { registrationOptions?: unknown }).registrationOptions, undefined);

    for (const status of ["cancelled", "reenrolled"]) {
      await setResetStatus(db, person.id, status);
      advance(61_000);
      const res = await sendAndVerify(handler, outbox, person.email);
      assert.ok(res.status >= 400 && res.status < 500, `${status}: refused (${res.status})`);
      assert.equal((await res.json() as { registrationOptions?: unknown }).registrationOptions, undefined);
    }
    const challenges = await db.query("SELECT count(*)::int AS n FROM passkey_challenges WHERE user_id = $1", [person.id]);
    assert.equal(Number(challenges.rows[0]?.n), 0, "no registration was begun for a reset that isn't finished");
  } finally {
    await db.close();
  }
});

test("a second finish, a replay or a racing finish gets nothing", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const { clock, advance } = movableClock(T0);
    const handler = makeHandler(db, outbox, clock);
    const person = await seedUser(db, "setup-race");
    await setResetStatus(db, person.id, "done");

    // Two verified set-ups for the same finished reset, each with its own new passkey.
    const a = await verified(await sendAndVerify(handler, outbox, person.email));
    advance(61_000);
    const b = await verified(await sendAndVerify(handler, outbox, person.email));
    const responseA = await createAuthenticator().register(a.registrationOptions);
    const responseB = await createAuthenticator().register(b.registrationOptions);

    const results = await Promise.all([
      handler.setupFinish(post({ setupId: a.setupId, registrationResponse: responseA })),
      handler.setupFinish(post({ setupId: b.setupId, registrationResponse: responseB })),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 400], "exactly one racing finish succeeds");
    const loser = results.find((r) => r.status !== 200)!;
    assert.equal(setCookies(loser).length, 0, "the loser gets no cookie");
    assert.equal((await loser.json() as { recoveryCode?: unknown }).recoveryCode, undefined, "nor a code");

    // Replaying either finish gives nothing.
    for (const replay of [
      post({ setupId: a.setupId, registrationResponse: responseA }),
      post({ setupId: b.setupId, registrationResponse: responseB }),
    ]) {
      const res = await handler.setupFinish(replay);
      assert.equal(res.status, 400);
      assert.equal(setCookies(res).length, 0);
    }
    const passkeys = await db.query("SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1", [person.id]);
    assert.equal(Number(passkeys.rows[0]?.n), 1, "exactly one new passkey");
    const sessions = await db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [person.id]);
    assert.equal(Number(sessions.rows[0]?.n), 1, "exactly one session");
  } finally {
    await db.close();
  }
});

test("finish with an unknown set-up or a bad passkey gives nothing", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox, movableClock(T0).clock);
    const person = await seedUser(db, "setup-bad");
    await setResetStatus(db, person.id, "done");

    const { setupId, registrationOptions } = await verified(await sendAndVerify(handler, outbox, person.email));
    const registrationResponse = await createAuthenticator().register(registrationOptions);

    const unknown = await handler.setupFinish(post({ setupId: "f".repeat(64), registrationResponse }));
    assert.equal(unknown.status, 400);
    const tampered = { ...registrationResponse, response: { ...registrationResponse.response, attestationObject: "AAAA" } };
    const bad = await handler.setupFinish(post({ setupId, registrationResponse: tampered }));
    assert.equal(bad.status, 400);
    assert.equal(setCookies(bad).length, 0);
    assert.equal(await resetStatus(db, person.id), "done", "the reset is still there to try again");
  } finally {
    await db.close();
  }
});

test("every set-up step refuses a missing or foreign Origin, and bad bodies are a 4xx", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox, movableClock(T0).clock);
    const person = await seedUser(db, "setup-origin");
    await setResetStatus(db, person.id, "done");
    for (const origin of [null, FOREIGN_ORIGIN]) {
      assert.equal((await handler.setupSendCode(post({ email: person.email }, { origin }))).status, 403);
      assert.equal((await handler.setupVerify(post({ email: person.email, code: "123456" }, { origin }))).status, 403);
      assert.equal((await handler.setupFinish(post({ setupId: "x", registrationResponse: {} }, { origin }))).status, 403);
    }
    assert.equal(outbox.list().length, 0, "nothing was sent");

    for (const body of ["{ not json", JSON.stringify({ email: 42 }), JSON.stringify({ setupId: "x", registrationResponse: null })]) {
      for (const step of [handler.setupSendCode, handler.setupVerify, handler.setupFinish]) {
        const res = await step(post(body));
        assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
      }
    }
  } finally {
    await db.close();
  }
});
