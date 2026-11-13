// Authenticator set-up from Settings › Security (follow-up S1). Until now an authenticator
// app could only be added at sign-up; a member who signed up with a passkey hit a dead end.
// This seam lets a SIGNED-IN member add one, under the same rules as sign-up enrolment
// (docs/adr/authenticator-signup.md) plus the step-up gate every Security change carries:
//
//   • begin and verify both need a fresh "confirm it's you" (requireStepUp);
//   • begin issues a pending secret held only in a bounded, expiring process store, keyed by
//     the session's own account; asking again returns the SAME secret and QR and neither
//     resets the attempt counter nor extends the time-to-live;
//   • verify takes a six-digit code; five wrong codes end the pending enrolment's attempts;
//     only one verify runs at a time (single-flight);
//   • success stores the secret DEK-encrypted through the existing envelope (totp-store) with
//     the accepted time step, so the enrolment code cannot be replayed to sign in or confirm;
//   • an account that already has an authenticator is refused (no replacement here);
//   • the member is emailed a new-sign-in-method alert, best effort.
//
// Real migrations on an in-memory PGlite; the RFC 6238 SHA-1 vector supplies a known secret
// and code. Pins behaviour only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createTotpEnrolment, TOTP_ENROLMENT_TTL_MS } from "./totp-enrolment";
import { discardPendingSignIns } from "./recover-session";
import { createTotpSecretStore } from "./totp-store";
import { checkTotpSignIn } from "./totp-attempts";
import { createSession, recordStepUp, type Session } from "./session";
import { createUser } from "../db/users";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { systemRandom, type Random } from "../seams/random";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

// RFC 6238 appendix B, SHA-1: the secret "12345678901234567890" in base32, and the code it
// gives at Unix time 1111111111.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const CODE = "050471";
const T0_MS = 1111111111 * 1000;
const MINUTE_MS = 60_000;

// The random seam: twenty-byte draws (the TOTP secret) come from the RFC vector so the code is
// known; everything else (session ids) is real entropy.
const vectorRandom: Random = {
  randomBytes: (size) => (size === 20 ? Buffer.from("12345678901234567890") : systemRandom.randomBytes(size)),
};

async function fixture(options: { random?: Random } = {}) {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  let now = T0_MS;
  const clock = { now: () => new Date(now) };
  const emails: { recipient: string; body: string }[] = [];
  let failEmail = false;
  const totpSecrets = createTotpSecretStore({ db, keyWrapper });
  const enrolment = createTotpEnrolment({
    db,
    clock,
    random: options.random ?? vectorRandom,
    totpSecrets,
    alerts: {
      emailSender: {
        async sendEmail(message) {
          if (failEmail) throw new Error("provider down");
          emails.push(message);
        },
      },
    },
  });
  async function person(label: string): Promise<string> {
    const user = await createUser(db, {
      email: `${label}-${randomBytes(4).toString("hex")}@example.test`,
      wrappedDek: await keyWrapper.wrap(randomBytes(32)),
    });
    return user.id;
  }
  // A session stepped up "now" (passes requireStepUp), or a plain one (does not).
  async function session(userId: string, steppedUp = true): Promise<Session> {
    const created = await createSession(db, userId, { clock, random: systemRandom });
    return steppedUp ? recordStepUp(db, created.session.id, { clock }) : created.session;
  }
  return {
    db,
    clock,
    enrolment,
    totpSecrets,
    emails,
    person,
    session,
    advance: (ms: number) => { now += ms; },
    failEmails: () => { failEmail = true; },
  };
}

async function storedRow(db: Db, userId: string) {
  return (await db.query("SELECT secret_enc, last_step FROM totp_secrets WHERE user_id = $1", [userId])).rows[0];
}

test("begin and verify both need a fresh confirmation; without one nothing is issued or stored", async () => {
  const f = await fixture();
  try {
    const userId = await f.person("stale");
    const stale = await f.session(userId, false);
    assert.deepEqual(await f.enrolment.begin(stale), { ok: false, reason: "step_up_required" });
    assert.deepEqual(await f.enrolment.verify(stale, CODE), { ok: false, reason: "step_up_required" });

    // A confirmation older than five minutes is stale too.
    const fresh = await f.session(userId);
    assert.equal((await f.enrolment.begin(fresh)).ok, true);
    f.advance(5 * MINUTE_MS + 1);
    assert.deepEqual(await f.enrolment.verify(fresh, CODE), { ok: false, reason: "step_up_required" });
    assert.equal(await storedRow(f.db, userId), undefined, "nothing is stored without a fresh confirmation");
  } finally {
    await f.db.close();
  }
});

test("begin shows a secret and QR once per pending enrolment; asking again returns the same ones and stores nothing", async () => {
  const f = await fixture();
  try {
    const userId = await f.person("begin");
    const s = await f.session(userId);
    const first = await f.enrolment.begin(s);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.secret, SECRET);
    assert.match(first.qr, /^data:image\/png;base64,/);
    const again = await f.enrolment.begin(s);
    assert.deepEqual(again, first, "asking for the QR again returns the same pending secret");
    assert.equal(await storedRow(f.db, userId), undefined, "a pending secret is never written before verification");
    assert.equal(await f.totpSecrets.get(userId), null);
  } finally {
    await f.db.close();
  }
});

test("a correct code stores the secret encrypted with its accepted step, so the code cannot be replayed", async () => {
  const f = await fixture();
  try {
    const userId = await f.person("verify");
    const s = await f.session(userId);
    assert.equal((await f.enrolment.begin(s)).ok, true);
    assert.deepEqual(await f.enrolment.verify(s, CODE), { ok: true });

    const row = await storedRow(f.db, userId);
    assert.ok(row, "the authenticator is now on the account");
    assert.ok(!String(row.secret_enc).includes(SECRET), "the stored secret is ciphertext, never plain text");
    assert.equal(Number(row.last_step), Math.floor(T0_MS / 1000 / 30), "the accepted time step is recorded");
    assert.equal(await f.totpSecrets.get(userId), SECRET, "the envelope decrypts back to the enrolled secret");

    // The enrolment code is spent: neither sign-in nor confirm-it's-you accepts it again.
    assert.deepEqual(
      await checkTotpSignIn(f.db, { userId, secret: SECRET, code: CODE }, { clock: f.clock }),
      { ok: false, reason: "invalid" },
    );
    // The pending enrolment is gone and a second one is refused: nothing is replaced.
    assert.deepEqual(await f.enrolment.verify(s, CODE), { ok: false, reason: "already_enrolled" });
    assert.deepEqual(await f.enrolment.begin(s), { ok: false, reason: "already_enrolled" });
  } finally {
    await f.db.close();
  }
});

test("an account that already has an authenticator is refused, and its secret is untouched", async () => {
  const f = await fixture();
  try {
    const userId = await f.person("existing");
    await f.totpSecrets.set(userId, "JBSWY3DPEHPK3PXP");
    const s = await f.session(userId);
    assert.deepEqual(await f.enrolment.begin(s), { ok: false, reason: "already_enrolled" });
    assert.equal(await f.totpSecrets.get(userId), "JBSWY3DPEHPK3PXP");
  } finally {
    await f.db.close();
  }
});

test("five wrong codes use up the attempts; asking for the QR again does not reset them", async () => {
  const f = await fixture();
  try {
    const userId = await f.person("attempts");
    const s = await f.session(userId);
    assert.equal((await f.enrolment.begin(s)).ok, true);
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(await f.enrolment.verify(s, "000000"), { ok: false, reason: "invalid_code" }, `attempt ${i + 1}`);
    }
    assert.deepEqual(await f.enrolment.verify(s, CODE), { ok: false, reason: "too_many_attempts" });
    assert.equal((await f.enrolment.begin(s)).ok, true, "the QR can still be shown");
    assert.deepEqual(
      await f.enrolment.verify(s, CODE),
      { ok: false, reason: "too_many_attempts" },
      "re-asking for the QR never resets the counter",
    );
    // A malformed value is refused before it is counted or checked.
    assert.deepEqual(await f.enrolment.verify(s, "12345"), { ok: false, reason: "invalid_code" });
    assert.equal(await storedRow(f.db, userId), undefined);
  } finally {
    await f.db.close();
  }
});

test("a pending enrolment expires; asking again inside its lifetime does not extend it", async () => {
  const f = await fixture();
  try {
    const userId = await f.person("ttl");
    const s = await f.session(userId);
    assert.equal((await f.enrolment.begin(s)).ok, true);
    f.advance(TOTP_ENROLMENT_TTL_MS - MINUTE_MS);
    const keep = await f.session(userId); // a fresh confirmation, so only expiry is in play
    assert.equal((await f.enrolment.begin(keep)).ok, true, "re-asked one minute before expiry");
    f.advance(MINUTE_MS);
    const late = await f.session(userId);
    assert.deepEqual(await f.enrolment.verify(late, CODE), { ok: false, reason: "no_enrolment" });
    assert.equal(await storedRow(f.db, userId), undefined);
  } finally {
    await f.db.close();
  }
});

test("only one verification runs at a time, and the pending secret stores exactly once", async () => {
  const f = await fixture();
  try {
    const userId = await f.person("flight");
    const s = await f.session(userId);
    assert.equal((await f.enrolment.begin(s)).ok, true);
    const results = await Promise.all([f.enrolment.verify(s, CODE), f.enrolment.verify(s, CODE)]);
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one verification succeeds");
    const refused = results.find((r) => !r.ok);
    assert.deepEqual(refused, { ok: false, reason: "in_progress" });
    const rows = await f.db.query("SELECT count(*)::int AS n FROM totp_secrets WHERE user_id = $1", [userId]);
    assert.equal(rows.rows[0]?.n, 1);
  } finally {
    await f.db.close();
  }
});

test("concurrent begins share one pending secret rather than replacing it", async () => {
  const f = await fixture({ random: systemRandom });
  try {
    const userId = await f.person("race");
    const s = await f.session(userId);
    const [a, b] = await Promise.all([f.enrolment.begin(s), f.enrolment.begin(s)]);
    assert.ok(a.ok && b.ok);
    assert.equal(a.secret, b.secret, "both tabs show the same secret");
  } finally {
    await f.db.close();
  }
});

test("a pending enrolment belongs to its own account only", async () => {
  const f = await fixture({ random: systemRandom });
  try {
    const alice = await f.person("alice");
    const bob = await f.person("bob");
    const aliceSession = await f.session(alice);
    const bobSession = await f.session(bob);
    const aliceStart = await f.enrolment.begin(aliceSession);
    assert.ok(aliceStart.ok);
    assert.deepEqual(await f.enrolment.verify(bobSession, CODE), { ok: false, reason: "no_enrolment" });
    const bobStart = await f.enrolment.begin(bobSession);
    assert.ok(bobStart.ok);
    assert.notEqual(bobStart.secret, aliceStart.secret, "another account never sees this account's secret");
  } finally {
    await f.db.close();
  }
});

// Recovery and reset re-enrolment evict the lost devices. A set-up the lost device began
// (holding its secret) must not survive that, or the owner adding an authenticator
// afterwards would be handed a secret the other device already has.
test("evicting the lost factors discards a pending set-up, so the owner gets a new secret", async () => {
  const f = await fixture({ random: systemRandom });
  try {
    const userId = await f.person("evict");
    const lost = await f.enrolment.begin(await f.session(userId));
    assert.ok(lost.ok);
    discardPendingSignIns(userId, { clock: f.clock });
    const owner = await f.enrolment.begin(await f.session(userId));
    assert.ok(owner.ok);
    assert.notEqual(owner.secret, lost.secret, "the lost device's secret is never handed out again");
  } finally {
    await f.db.close();
  }
});

test("success emails a new-sign-in-method alert with no secret or code; a failed send never undoes it", async () => {
  const f = await fixture();
  try {
    const userId = await f.person("alert");
    const s = await f.session(userId);
    assert.equal((await f.enrolment.begin(s)).ok, true);
    assert.deepEqual(await f.enrolment.verify(s, CODE), { ok: true });
    assert.equal(f.emails.length, 1);
    assert.match(f.emails[0]!.body, /authenticator app was added/i);
    assert.ok(!f.emails[0]!.body.includes(SECRET) && !f.emails[0]!.body.includes(CODE), "the alert carries no secret or code");

    const other = await f.person("alert-fail");
    const o = await f.session(other);
    f.failEmails();
    assert.equal((await f.enrolment.begin(o)).ok, true);
    assert.deepEqual(await f.enrolment.verify(o, CODE), { ok: true }, "a send failure never fails the set-up");
    assert.ok(await storedRow(f.db, other));
  } finally {
    await f.db.close();
  }
});
