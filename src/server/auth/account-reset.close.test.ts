// A completed reset must not stay quietly re-enrollable (sign-in audit, founder decision
// 13 November 2026). When the 7-day reset completes:
//   • every registered channel (push, email, each verified mobile) is told, once;
//   • the account can be re-enrolled for 7 days after completion (was 30);
//   • a signed-in owner sees a banner while it is completed but not re-enrolled
//     (getCompletedAccountReset), and can close re-enrolment ("This wasn't me"): a
//     status-guarded 'done' → 'closed' update, like cancel's 'pending' → 'cancelled';
//   • re-enrolment after a close is refused, and a close racing a re-enrolment is safe:
//     exactly one of them wins.
// Real PGlite with the real migrations, the real passkey verifier and the real executor.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  closeAccountReset,
  completeAccountReset,
  getCompletedAccountReset,
  hasCompletedReset,
  reenrolAfterReset,
  REENROL_WINDOW_MS,
  RESET_WAIT_MS,
  type ResetExecutor,
} from "./account-reset";
import { beginPasskeyRegistration } from "./passkey";
import { createUser, type User } from "../db/users";
import { renderEmail } from "../notify/email";
import { createOutbox, type Outbox } from "../notify/outbox";
import { systemRandom } from "../seams/random";
import { fixedClock, type Clock } from "../seams/clock";
import { freshDb } from "../../test/db";
import { createAuthenticator } from "../../test/authenticator";
import { SUPPORT_EMAIL } from "../../components/public/operator";
import type { Db } from "../db/index";

const DAY_MS = 24 * 60 * 60 * 1000;
const RP_ID = "warthog.com.au";
const REQUESTED_AT = new Date("2026-06-01T00:00:00.000Z");
const COMPLETED_AT = new Date(REQUESTED_AT.getTime() + RESET_WAIT_MS);

const noopExecutor: ResetExecutor = {
  async eraseVaultData() {},
  async revokeAgentsAndConnections() {},
};

function senders(outbox: Outbox) {
  return { push: outbox, email: outbox, sms: outbox };
}

async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: "opaque" });
}

async function setReset(db: Db, userId: string, status: string, requestedAt = REQUESTED_AT): Promise<void> {
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

async function addMobile(db: Db, userId: string, number: string, verified: boolean): Promise<void> {
  await db.query(
    `INSERT INTO mobile_numbers (user_id, number, verified, code_hmac, code_expires_at, created_at, verified_at)
     VALUES ($1, $2, $3, NULL, NULL, $4::timestamptz, $5::timestamptz)`,
    [userId, number, verified, REQUESTED_AT.toISOString(), verified ? REQUESTED_AT.toISOString() : null],
  );
}

function completeDeps(outbox: Outbox, clock: Clock = fixedClock(COMPLETED_AT)) {
  return { executor: noopExecutor, clock, senders: senders(outbox) };
}

async function registration(db: Db, user: User, clock: Clock) {
  const options = await beginPasskeyRegistration(db, { userId: user.id, userName: user.email }, { rpId: RP_ID, origin: `https://${RP_ID}`, clock });
  return createAuthenticator().register(options);
}

test("completing a reset alerts push, email and each verified mobile once", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "complete-alert");
    await addMobile(db, person.id, "+61400000001", true);
    await addMobile(db, person.id, "+61400000002", false);
    await setReset(db, person.id, "pending");
    const outbox = createOutbox();

    assert.deepEqual(await completeAccountReset(db, { userId: person.id }, completeDeps(outbox)), { ok: true });

    const sent = outbox.list();
    assert.deepEqual(
      sent.map((m) => `${m.channel}:${m.recipient}`).sort(),
      [`email:${person.email}`, `push:${person.id}`, "sms:+61400000001"].sort(),
      "every registered channel, and only verified mobiles",
    );
    const body = sent[0]!.body;
    for (const message of sent) assert.equal(message.body, body, "one fixed message on every channel");
    assert.match(body, /reset/i);
    assert.match(body, /7 days/);
    assert.match(body, /close re-enrolment/i, "it says how to stop it");
    assert.ok(body.includes(SUPPORT_EMAIL), "it gives the support address");
    assert.ok(!/(?<!\d)\d{6}(?!\d)/.test(body), "no code");

    // A retried or duplicate completion transitions nothing and sends nothing.
    assert.equal((await completeAccountReset(db, { userId: person.id }, completeDeps(outbox))).ok, false);
    assert.equal(outbox.list().length, sent.length, "no second alert");
  } finally {
    await db.close();
  }
});


test("the reset-finished email is branded and keeps the 7-day warning, how to close it and the support address", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "complete-branded");
    await setReset(db, person.id, "pending");
    const outbox = createOutbox();
    await completeAccountReset(db, { userId: person.id }, completeDeps(outbox));
    const email = outbox.list().find((m) => m.channel === "email")!.email!;
    assert.equal(email.subject, "Your Warthog account reset has finished");
    assert.equal(email.heading, "Your account reset has finished");
    const text = email.paragraphs.join(" ");
    assert.match(text, /saved cards and protected details were erased/);
    assert.match(text, /For the next 7 days/);
    assert.match(text, /This wasn't me — close re-enrolment/);
    assert.ok(text.includes(SUPPORT_EMAIL));
    assert.equal(email.action, undefined, "no link");
    assert.doesNotMatch(renderEmail(email).html, /href=/);
  } finally {
    await db.close();
  }
});

test("a completion whose alerts can't be sent still completes", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "complete-alert-down");
    await setReset(db, person.id, "pending");
    const down = { async sendPush() { throw new Error("down"); }, async sendEmail() { throw new Error("down"); }, async sendSms() { throw new Error("down"); } };
    const result = await completeAccountReset(db, { userId: person.id }, {
      executor: noopExecutor,
      clock: fixedClock(COMPLETED_AT),
      senders: { push: down, email: down, sms: down },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(await resetStatus(db, person.id), "done");
  } finally {
    await db.close();
  }
});

test("re-enrolment stays open for 7 days after completion, then closes by itself", async () => {
  const db = await freshDb();
  try {
    assert.equal(REENROL_WINDOW_MS, 7 * DAY_MS);
    const person = await freshUser(db, "window");
    await setReset(db, person.id, "done");
    const lastMoment = fixedClock(new Date(COMPLETED_AT.getTime() + 7 * DAY_MS - 1));
    const lapsed = fixedClock(new Date(COMPLETED_AT.getTime() + 7 * DAY_MS));
    assert.equal(await hasCompletedReset(db, { userId: person.id }, { clock: lastMoment }), true);
    assert.equal(await hasCompletedReset(db, { userId: person.id }, { clock: lapsed }), false);
    assert.ok(await getCompletedAccountReset(db, { userId: person.id }, { clock: lastMoment }));
    assert.equal(await getCompletedAccountReset(db, { userId: person.id }, { clock: lapsed }), null);
  } finally {
    await db.close();
  }
});

test("the completed-reset banner data is only for a completed, not-yet-re-enrolled reset of the person's own", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "banner");
    const other = await freshUser(db, "banner-other");
    const clock = fixedClock(new Date(COMPLETED_AT.getTime() + DAY_MS));
    assert.equal(await getCompletedAccountReset(db, { userId: person.id }, { clock }), null, "no reset");
    for (const status of ["pending", "cancelled", "reenrolled", "closed"]) {
      await setReset(db, person.id, status);
      assert.equal(await getCompletedAccountReset(db, { userId: person.id }, { clock }), null, `${status} shows no banner`);
    }
    await setReset(db, person.id, "done");
    const found = await getCompletedAccountReset(db, { userId: person.id }, { clock });
    assert.deepEqual(found, {
      completedAt: COMPLETED_AT,
      reenrolUntil: new Date(COMPLETED_AT.getTime() + REENROL_WINDOW_MS),
    });
    assert.equal(await getCompletedAccountReset(db, { userId: other.id }, { clock }), null, "another person sees nothing");
  } finally {
    await db.close();
  }
});

test("closing re-enrolment moves a completed reset to closed; only the person's own, only once", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "close");
    const other = await freshUser(db, "close-other");
    const clock = fixedClock(new Date(COMPLETED_AT.getTime() + DAY_MS));
    await setReset(db, person.id, "done");
    await setReset(db, other.id, "done");

    assert.deepEqual(await closeAccountReset(db, { userId: person.id }, { clock }), { ok: true });
    assert.equal(await resetStatus(db, person.id), "closed");
    assert.equal(await resetStatus(db, other.id), "done", "another person's reset is untouched");
    assert.deepEqual(await closeAccountReset(db, { userId: person.id }, { clock }), { ok: false, reason: "no_completed_reset" });
    assert.equal(await hasCompletedReset(db, { userId: person.id }, { clock }), false);

    for (const status of ["pending", "cancelled", "reenrolled"]) {
      await setReset(db, other.id, status);
      assert.deepEqual(await closeAccountReset(db, { userId: other.id }, { clock }), { ok: false, reason: "no_completed_reset" });
      assert.equal(await resetStatus(db, other.id), status, `a ${status} reset is not closed`);
    }
  } finally {
    await db.close();
  }
});

test("re-enrolment after a close is refused and changes nothing", async () => {
  const db = await freshDb();
  try {
    const person = await freshUser(db, "after-close");
    const clock = fixedClock(new Date(COMPLETED_AT.getTime() + DAY_MS));
    await setReset(db, person.id, "done");
    const response = await registration(db, person, clock);
    await closeAccountReset(db, { userId: person.id }, { clock });

    const result = await reenrolAfterReset(db, { userId: person.id, response }, { rpId: RP_ID, origin: `https://${RP_ID}`, clock, random: systemRandom });
    assert.deepEqual(result, { ok: false, reason: "reset_closed" });
    const passkeys = await db.query("SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1", [person.id]);
    assert.equal(passkeys.rows[0]?.n, 0, "no passkey was added");
    assert.equal(await resetStatus(db, person.id), "closed");
  } finally {
    await db.close();
  }
});

test("a close racing a re-enrolment: exactly one wins", async () => {
  for (let round = 0; round < 3; round += 1) {
    const db = await freshDb();
    try {
      const person = await freshUser(db, `race-${round}`);
      const clock = fixedClock(new Date(COMPLETED_AT.getTime() + DAY_MS));
      await setReset(db, person.id, "done");
      const response = await registration(db, person, clock);
      const deps = { rpId: RP_ID, origin: `https://${RP_ID}`, clock, random: systemRandom };

      const [closed, reenrolled] = await Promise.all([
        closeAccountReset(db, { userId: person.id }, { clock }),
        reenrolAfterReset(db, { userId: person.id, response }, deps),
      ]);
      assert.equal([closed.ok, reenrolled.ok].filter(Boolean).length, 1, "exactly one succeeds");
      const status = await resetStatus(db, person.id);
      const passkeys = Number((await db.query("SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1", [person.id])).rows[0]?.n);
      if (closed.ok) {
        assert.equal(status, "closed");
        assert.equal(passkeys, 0, "a closed reset added no passkey");
      } else {
        assert.equal(status, "reenrolled");
        assert.equal(passkeys, 1);
      }
    } finally {
      await db.close();
    }
  }
});
