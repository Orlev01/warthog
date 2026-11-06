// E04-S39 — Sign-up keeps the person's name (the server half:
// `src/app/(auth)/signup/handler.ts`).
//
// RED-first: the behaviour under test — carrying the name entered at the details
// step from `sendCode` through to `confirmSignup`, where it is saved as the
// person's low-tier 'name' identity field (DEK-encrypted), plus validating that
// name at `sendCode` — does NOT exist yet. `sendCode` currently takes only
// `{ email }` and throws the name away, so every assertion below fails until the
// builder adds it. That absence IS the point of test-first — do NOT implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR (the HTTP outcome of each step, what ends up stored and
// in what form, what gets sent) through the REAL sibling seam `createSignupHandler`
// against an isolated in-memory PGlite (src/test/db) with the REAL migrations, the
// software WebAuthn authenticator (src/test/authenticator) and the real
// email-code / recovery / session / identity-field stores. Nothing here asserts on
// the source text of any module, so a later behaviour-preserving refactor stays
// green. There is no browser, no Azure and no network.
//
// The seam under test is the sibling `handler.ts` factory — a Next page/actions
// entry file cannot carry an injectable factory without breaking `next build`, so
// the testable seam is this plain sibling; the thin actions/route verbs wrap it.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────
//   AC1  After a sign-up that entered the name 'Sam Rivera', the person's low-tier
//        'name' field reads back 'Sam Rivera', and a direct SELECT of that row never
//        contains the plaintext name (it is stored DEK-encrypted, never in a
//        plaintext column — including never in a plaintext `users` column).
//   AC3  A sign-up with an empty or over-long name (more than 100 characters) is
//        rejected at send-code with a 4xx and plain-English copy, and sends nothing.
//        A well-formed name (incl. the 100-char boundary) is accepted.
//
// (AC2 — the home greeting — lives with the home loader; AC4 — controlled inputs —
// lives with the views. Those are separate test files beside their own seams.)
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb() and createOutbox(). Emails, codes, recovery codes and
// signupIds are drawn from the REAL random seam so nothing collides across tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { createSignupHandler } from "./handler";

import { getUserByEmail } from "../../../server/db/users";
import { listIdentityFields } from "../../../server/db/identity-fields";
import { localAesKeyWrapper, type KeyWrapper } from "../../../server/crypto/key-wrapper";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { freshDb } from "../../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

// A frozen instant: the code is issued and verified at the same clock, comfortably
// inside its 10-minute window with no wall-clock dependence.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The configured WebAuthn RP ID and public origin — passed through deps (never a
// module constant), plus a foreign origin a cross-site request would carry.
const RP_ID = "warthog.com.au";
const GOOD_ORIGIN = "https://warthog.com.au";

// One keyed HMAC for the email-code first factor, so the code sendCode delivers is
// the code verifyEmail then accepts.
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-signup-hmac-key-0123456789abcd", "utf8"));

// A local 256-bit KEK for the dev/test key wrapper. The SAME wrapper is used to
// build the handler AND, in AC1, to unwrap the new account's wrapped DEK so the
// test can decrypt and read back the low-tier name the handler stored.
const LOCAL_KEK = new Uint8Array(32).fill(0x2a);
const keyWrapper: KeyWrapper = localAesKeyWrapper(LOCAL_KEK);

// The exact name the acceptance criterion names.
const NAME = "Sam Rivera";

// Build the handler under test with the real seams and the shared key wrapper.
function makeHandler(db: Db, outbox: Outbox, clock: Clock = fixedClock(T0)) {
  return createSignupHandler({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    emailSender: outbox,
    keyWrapper,
    rpId: RP_ID,
    publicOrigin: GOOD_ORIGIN,
  });
}

// A JSON POST request carrying the configured Origin (so the ONLY reason to reject
// is the input itself). A raw string body is sent verbatim; anything else is encoded.
function signupRequest(body: unknown, origin: string = GOOD_ORIGIN): Request {
  return new Request("https://warthog.com.au/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Pull the standalone 6-digit code out of a delivered email body.
function extractCode(body: string): string {
  const match = body.match(/(?<!\d)\d{6}(?!\d)/);
  assert.ok(match, `the email body must carry a standalone 6-digit code: ${JSON.stringify(body)}`);
  return match[0];
}

// The email messages the outbox recorded for `recipient` (scoped narrowly to one
// address so another address's mail never counts here).
function emailsTo(outbox: Outbox, recipient: string) {
  return outbox.list().filter((m) => m.channel === "email" && m.recipient === recipient);
}

// A step's user-facing rejection copy must read as plain English — a real phrase a
// person can act on, never a raw machine token (snake_case) and never a crash.
function assertPlainEnglish(message: unknown, ctx: string): void {
  assert.equal(typeof message, "string", `${ctx}: expected plain-English copy, got ${typeof message}`);
  const text = (message as string).trim();
  assert.ok(text.length >= 8, `${ctx}: copy must be a real message, got: "${text}"`);
  assert.ok(/\s/.test(text), `${ctx}: copy must read as words, not one machine token, got: "${text}"`);
  assert.ok(!/_/.test(text), `${ctx}: copy must not be a raw machine code (snake_case), got: "${text}"`);
}

// ─── The full happy-path flow, carrying the name from send-code ─────────────────────
// Drive the whole sign-up with the name entered at the details step and sent ONLY
// with send-code (never re-sent on the later steps), exactly as the client flow does.
// Returns the created person's id and the DEK unwrapped from their wrapped DEK, so a
// test can read the low-tier fields the handler stored back out, decrypted.
async function signUpWithName(
  handler: ReturnType<typeof makeHandler>,
  auth: SoftwareAuthenticator,
  db: Db,
  outbox: Outbox,
  email: string,
  name: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  // send-code carries the name (and the email). It must succeed and deliver a code.
  const sent = await handler.sendCode(signupRequest({ email, name }));
  assert.equal(sent.status, 200, "send-code with a well-formed name and email returns 200");
  const delivered = emailsTo(outbox, email).at(-1);
  assert.ok(delivered, `send-code must deliver a code email to ${email}`);
  const code = extractCode(delivered.body);

  // verify-email carries NO name — the name was captured at send-code and kept with
  // the pending sign-up, so it must survive to confirm without being re-sent.
  const verifyRes = await handler.verifyEmail(signupRequest({ email, code }));
  assert.equal(verifyRes.status, 200, "a valid email code starts the sign-up");
  const started = (await verifyRes.json()) as {
    signupId: string;
    registrationOptions: PublicKeyCredentialCreationOptionsJSON;
  };

  const registrationResponse: RegistrationResponseJSON = await auth.register(
    started.registrationOptions,
  );
  const registerRes = await handler.registerPasskey(
    signupRequest({ signupId: started.signupId, registrationResponse }),
  );
  assert.equal(registerRes.status, 200, "a valid attestation registers the passkey");

  // confirm carries NO name either — only the handle and the saved confirmation.
  const confirmRes = await handler.confirmSignup(
    signupRequest({ signupId: started.signupId, savedConfirmed: true }),
  );
  assert.ok(
    confirmRes.status >= 300 && confirmRes.status < 400,
    `confirmation must redirect, got ${confirmRes.status}`,
  );
  assert.equal(confirmRes.headers.get("location"), "/home", "on success the person lands on /home");

  const person = await getUserByEmail(db, email);
  assert.ok(person, "the account is created on confirmation");
  const dek = await keyWrapper.unwrap(person.wrappedDek);
  return { userId: person.id, dek };
}

// =====================================================================================
// AC1 — the name entered at sign-up is saved as the low-tier 'name' field, decrypted
// only under the account's own DEK, and never written in plaintext.
// =====================================================================================

test("a sign-up that entered 'Sam Rivera' saves it as the low-tier 'name' identity field, read back decrypted", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const email = "newcomer@warthog.com.au"; // deliberately does NOT contain the name

    const { userId, dek } = await signUpWithName(handler, auth, db, outbox, email, NAME);

    // The person's low-tier fields, decrypted under their own DEK, carry the name as a
    // 'name' kind reading back exactly what was entered.
    const fields = await listIdentityFields(db, userId, dek);
    const nameFields = fields.filter((f) => f.kind === "name");
    assert.equal(nameFields.length, 1, "exactly one low-tier 'name' field is saved at sign-up");
    assert.equal(nameFields[0]!.value, NAME, "the low-tier 'name' field reads back 'Sam Rivera'");
  } finally {
    await db.close();
  }
});

test("the saved name is DEK-encrypted at rest: the plaintext appears in no identity_fields column", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const email = "atrest@warthog.com.au";

    const { userId } = await signUpWithName(handler, auth, db, outbox, email, NAME);

    // Scan every cell of the person's identity_fields rows. The name is personal
    // content stored DEK-encrypted, so the plaintext must never appear in a column.
    // Scoped to this person's rows in the one table under test — the ciphertext may
    // legitimately differ, but the plaintext name must be nowhere.
    const rows = await db.query("SELECT * FROM identity_fields WHERE user_id = $1", [userId]);
    assert.ok(rows.rows.length >= 1, "the name field row was stored");
    for (const row of rows.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(NAME), "the plaintext name must never be written to a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("the name is never stored in a plaintext users column", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const email = "nouser@warthog.com.au";

    const { userId } = await signUpWithName(handler, auth, db, outbox, email, NAME);

    // The account row carries only its metadata (email, role, wrapped DEK) — the name
    // lives in the DEK-encrypted identity-fields store, never as a plaintext users cell.
    const rows = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
    assert.equal(rows.rows.length, 1, "the account row exists");
    for (const cell of Object.values(rows.rows[0]!)) {
      if (typeof cell === "string") {
        assert.ok(!cell.includes(NAME), "the plaintext name must never be written to a users column");
      }
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — the name is validated at send-code: empty or over-long is a 4xx with plain
// copy and sends nothing; a well-formed name (incl. the 100-char boundary) is accepted.
// =====================================================================================

test("send-code rejects an empty name with a 4xx and plain-English copy, and sends nothing", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "emptyname@warthog.com.au";

    const res = await handler.sendCode(signupRequest({ email, name: "" }));
    assert.ok(res.status >= 400 && res.status < 500, `an empty name must be a 4xx, got ${res.status}`);
    assert.equal(emailsTo(outbox, email).length, 0, "a rejected name sends no code");

    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    assertPlainEnglish(body.error, "empty-name rejection");
  } finally {
    await db.close();
  }
});

test("send-code rejects an over-long name (more than 100 characters) with a 4xx and plain copy, and sends nothing", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "longname@warthog.com.au";

    const res = await handler.sendCode(signupRequest({ email, name: "a".repeat(101) }));
    assert.ok(res.status >= 400 && res.status < 500, `an over-long name must be a 4xx, got ${res.status}`);
    assert.equal(emailsTo(outbox, email).length, 0, "an over-long name sends no code");

    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    assertPlainEnglish(body.error, "over-long-name rejection");
  } finally {
    await db.close();
  }
});

test("send-code accepts a well-formed name and still delivers exactly one code", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "goodname@warthog.com.au";

    const res = await handler.sendCode(signupRequest({ email, name: NAME }));
    assert.equal(res.status, 200, "a well-formed name is accepted");
    assert.equal(emailsTo(outbox, email).length, 1, "a code is delivered once");
  } finally {
    await db.close();
  }
});

test("send-code accepts a name at the 100-character boundary", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "boundary@warthog.com.au";

    // Exactly 100 characters is within the limit (the limit is "more than 100").
    const res = await handler.sendCode(signupRequest({ email, name: "b".repeat(100) }));
    assert.equal(res.status, 200, "a 100-character name is within the limit and accepted");
    assert.equal(emailsTo(outbox, email).length, 1, "a code is delivered for a boundary-length name");
  } finally {
    await db.close();
  }
});
