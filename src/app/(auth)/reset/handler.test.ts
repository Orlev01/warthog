// Review fix W3.3 — the account-reset HTTP steps (`./handler`). The reset state machine
// (`src/server/auth/account-reset.ts`) existed with no way in: nothing routed a request
// or a cancel. These tests pin the steps the reset screens and the signed-in banner use:
//
//   sendCode — { email }: email a one-time code when the address has an account; the same
//              200 either way, so the step reveals nothing about which addresses exist.
//   request  — { email, code }: start the 7-day reset (requestAccountReset); a wrong code
//              is a 400 and starts nothing.
//   cancel   — the signed-in person (session cookie only, never a body value) cancels
//              their own pending reset.
//
// Every step refuses a missing or foreign Origin (403) and validates its body at the
// boundary (a 4xx, never a 500). Real PGlite with the real migrations; delivery goes to
// an outbox.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createResetHandler } from "./handler";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { createSession } from "../../../server/auth/session";
import { createUser, type User } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";

const T0 = new Date("2026-05-01T00:00:00.000Z");
const GOOD_ORIGIN = "https://warthog.com.au";
const FOREIGN_ORIGIN = "https://evil.example";
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-reset-hmac-key-0123456789abcdef", "utf8"));

function makeHandler(db: Db, outbox: Outbox, clock: Clock = fixedClock(T0)) {
  return createResetHandler({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    senders: { push: outbox, email: outbox, sms: outbox },
    rpId: "warthog.com.au",
    publicOrigin: GOOD_ORIGIN,
  });
}

function post(body: unknown, init: { origin?: string | null; cookie?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = init.origin === undefined ? GOOD_ORIGIN : init.origin;
  if (origin !== null) headers.set("origin", origin);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${GOOD_ORIGIN}/api/auth/reset/step`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function seedUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: "d3JhcHBlZA==" });
}

// The six-digit code in the newest email to `email`.
function emailedCode(outbox: Outbox, email: string): string {
  const mail = outbox.list().filter((m) => m.channel === "email" && m.recipient === email).at(-1);
  assert.ok(mail, `an email went to ${email}`);
  const match = mail.body.match(/(?<!\d)\d{6}(?!\d)/);
  assert.ok(match, "the email carries a six-digit code");
  return match[0];
}

async function resetStatus(db: Db, userId: string): Promise<string | null> {
  const row = await db.query("SELECT status FROM account_resets WHERE user_id = $1", [userId]);
  return (row.rows[0]?.status as string | undefined) ?? null;
}

test("sendCode emails a code to an account's address and answers the same for an unknown one", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox);
    const person = await seedUser(db, "reset-send");

    const known = await handler.sendCode(post({ email: person.email }));
    const unknown = await handler.sendCode(post({ email: "nobody@warthog.com.au" }));
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), await unknown.json(), "the two answers are identical");
    assert.ok(emailedCode(outbox, person.email), "the account holder is emailed a code");
    assert.equal(outbox.list().filter((m) => m.recipient === "nobody@warthog.com.au").length, 0);
  } finally {
    await db.close();
  }
});

test("request starts the 7-day reset with the emailed code; a wrong code starts nothing", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox);
    const person = await seedUser(db, "reset-request");
    await handler.sendCode(post({ email: person.email }));
    const code = emailedCode(outbox, person.email);

    const wrong = await handler.request(post({ email: person.email, code: code === "000000" ? "111111" : "000000" }));
    assert.equal(wrong.status, 400);
    assert.equal(await resetStatus(db, person.id), null, "a wrong code starts nothing");

    const res = await handler.request(post({ email: person.email, code }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; completesAt: string };
    assert.equal(body.ok, true);
    assert.equal(new Date(body.completesAt).getTime(), T0.getTime() + 7 * 24 * 60 * 60 * 1000, "it says when it completes");
    assert.equal(await resetStatus(db, person.id), "pending");
    assert.ok(
      outbox.list().some((m) => m.channel === "email" && /reset of your Warthog account/i.test(m.body)),
      "the person is alerted",
    );
  } finally {
    await db.close();
  }
});

test("every step refuses a missing or foreign Origin and changes nothing", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox);
    const person = await seedUser(db, "reset-origin");
    for (const origin of [null, FOREIGN_ORIGIN]) {
      assert.equal((await handler.sendCode(post({ email: person.email }, { origin }))).status, 403);
      assert.equal((await handler.request(post({ email: person.email, code: "123456" }, { origin }))).status, 403);
      assert.equal((await handler.cancel(post({}, { origin }))).status, 403);
    }
    assert.equal(outbox.list().length, 0, "nothing was sent");
  } finally {
    await db.close();
  }
});

test("malformed or oversized bodies are a 4xx, never a 500", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db, createOutbox());
    for (const body of ["{ not json", JSON.stringify({ email: 42 }), JSON.stringify({ email: "a".repeat(100_000) })]) {
      const sent = await handler.sendCode(post(body));
      assert.ok(sent.status >= 400 && sent.status < 500, `sendCode: got ${sent.status}`);
      const requested = await handler.request(post(body));
      assert.ok(requested.status >= 400 && requested.status < 500, `request: got ${requested.status}`);
    }
  } finally {
    await db.close();
  }
});

test("cancel needs a signed-in session and cancels only that person's pending reset", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, outbox);
    const person = await seedUser(db, "reset-cancel");
    const other = await seedUser(db, "reset-cancel-other");
    for (const who of [person, other]) {
      await handler.sendCode(post({ email: who.email }));
      assert.equal((await handler.request(post({ email: who.email, code: emailedCode(outbox, who.email) }))).status, 200);
    }

    assert.equal((await handler.cancel(post({}))).status, 401, "no session, no cancel");
    assert.equal(await resetStatus(db, person.id), "pending");

    const session = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });
    const cookie = `__Host-wh_session=${session.token}`;
    const res = await handler.cancel(post({ userId: other.id }, { cookie }));
    assert.equal(res.status, 200);
    assert.equal(await resetStatus(db, person.id), "cancelled", "the signed-in person's reset is cancelled");
    assert.equal(await resetStatus(db, other.id), "pending", "a user id in the body is ignored");

    const again = await handler.cancel(post({}, { cookie }));
    assert.equal(again.status, 404, "nothing left to cancel");
  } finally {
    await db.close();
  }
});
