// E04-S10 — Sign-up server actions (`src/app/(auth)/signup/`).
//
// RED-first: the sign-up handler does not exist yet, so importing `./handler`
// throws and every test here fails until the builder adds it. That absence IS the
// point of test-first — do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (the HTTP outcome of each step, what ends up stored, and
// which device ends up signed in), never the source text of the module — a later
// rename that preserves behaviour must not redden them. There is no browser, no Azure
// and no network: the email code, the passkey round trip, the recovery code, the
// wrapped DEK and the session are all driven through the REAL sibling seams against an
// isolated in-memory PGlite (src/test/db), and the WebAuthn attestation is produced by
// the software authenticator (src/test/authenticator), whose only non-test collaborator
// is the real @simplewebauthn/server verifier.
//
// Why a sibling `handler.ts` (not `actions.ts` or `page.tsx`): a Next "use server"
// actions file may export only async server actions, and a `page.tsx` entry file only
// its framework fields — neither can carry an injectable, unit-testable factory without
// breaking `next build`. So the testable seam lives in a plain sibling module
// (`handler.ts`, the convention's `createXHandler({ db })` pattern); the thin
// `actions.ts` / route verbs wrap it. These tests drive that seam directly with fakes.
//
// Why this exists (brief "Create your account"; design §5: "Recovery code issued at
// sign-up (shown once, confirmed saved)"; "Every server action and route checks
// `Origin`"; constitution INV-22 "require every account to hold a passkey … second
// factor before any … feature becomes usable"; INV-102 validate-and-parameterize):
// sign-up is the front door and must not finish without a confirmed second factor. The
// person proves their email (one-time code), registers a passkey (the second factor),
// is shown a recovery code ONCE and must confirm "I have saved it" — and ONLY THEN is
// the account (the `users` row) and the signed-in session created, landing them on
// /home.
//
// ─── The contract this task defines (the builder implements exactly this) ────────────
//
//   createSignupHandler(deps): {
//     verifyEmail(req: Request):      Promise<Response>  // step 1: email one-time code
//     registerPasskey(req: Request):  Promise<Response>  // step 2: passkey + recovery code
//     confirmSignup(req: Request):    Promise<Response>  // step 3: "I have saved it" → create + sign in
//   }
//
//   deps (one bundle; each step reads the subset it needs):
//     { db: Db; clock: Clock; random: Random; hmacKey: Uint8Array;
//       emailSender: EmailSender; keyWrapper: KeyWrapper;
//       rpId: string;            // WebAuthn RP ID (warthog.com.au), from config
//       publicOrigin: string }   // the configured public origin, for the Origin check
//
//   Every step verifies the request `Origin` against `publicOrigin` first: a missing or
//   foreign Origin is refused with 403 and changes nothing (design §5 — "our own for
//   routes"). Every step validates its JSON body at the boundary (parseBody): malformed,
//   oversized or mis-shaped input → a 4xx Response, never an uncontrolled 500 (INV-102).
//   Every query the steps run is parameterized, so a SQL-injection probe in an input
//   field is bound as data and cannot alter a query (INV-102).
//
//   verifyEmail  — body { email, code }. Verifies the email one-time code (the real
//     verifyEmailCode). A wrong/expired/throttled code → 4xx (no sign-up started). A
//     valid code → 200 { signupId, registrationOptions } where registrationOptions is a
//     PublicKeyCredentialCreationOptionsJSON carrying the configured rpId; a pending
//     sign-up (email + registration challenge) is held in process memory under signupId.
//     NO `users` row is created here.
//
//   registerPasskey — body { signupId, registrationResponse }. Verifies the WebAuthn
//     attestation against the challenge the server issued for that pending sign-up. On
//     success it records the verified credential against the pending sign-up and issues
//     the one-time recovery code, returning 200 { recoveryCode } — the single place the
//     code is handed to the person (shown once). A bad attestation / unknown signupId →
//     4xx. Still NO `users` row.
//
//   confirmSignup — body { signupId, savedConfirmed }. Refuses to finish (4xx, nothing
//     created) unless BOTH savedConfirmed === true AND a passkey was registered for the
//     pending sign-up (the confirmed second factor). On success it creates the `users`
//     row (with a wrapped DEK), persists the passkey and the recovery code for the new
//     person, mints a session, and returns a redirect (303) to /home carrying the
//     `__Host-wh_session` Set-Cookie. The shown recovery code verifies and the registered
//     passkey authenticates against the new account.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 the flow verifies the email code, registers a passkey, issues the recovery code
//       and requires an 'I have saved it' confirmation BEFORE creating the user and
//       session — happy path end-to-end, no `users` row until confirmation, the shown
//       recovery code works, the registered passkey authenticates, a wrong code starts
//       nothing, and a missing confirmation creates nothing.
//   AC2 the action verifies Origin (foreign Origin → 403 at entry AND at finish) and
//       refuses to finish without a confirmed second factor (confirm with no passkey →
//       refused, nothing created).
//   AC3 a handler rejects malformed / oversized / mis-shaped input with a 4xx, and a
//       SQL-injection probe in an input field cannot alter a query (parameter binding).
//   AC4 on success the person is redirected to /home.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb() and createOutbox(). Codes, tokens, recovery codes and signupIds
// are drawn from the REAL random seam so nothing collides across tests (same discipline
// the session / new-device tests use).

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { createSignupHandler } from "./handler";

import { issueEmailCode } from "../../../server/auth/email-code";
import { verifyRecoveryCode } from "../../../server/auth/recovery";
import { verifySession } from "../../../server/auth/session";
import {
  beginPasskeyAuthentication,
  finishPasskeyAuthentication,
} from "../../../server/auth/passkey";
import { getUserByEmail } from "../../../server/db/users";
import { localAesKeyWrapper } from "../../../server/crypto/key-wrapper";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { freshDb } from "../../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

// A frozen instant: the email code is issued and verified at the same clock, so it is
// comfortably inside its 10-minute window with no wall-clock dependence.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The configured WebAuthn RP ID — passed through deps (never a module constant), so the
// "RP ID from config" discipline is exercised end to end.
const RP_ID = "warthog.com.au";

// The configured public origin the handler checks the request `Origin` against, and a
// foreign origin a cross-site request would carry.
const GOOD_ORIGIN = "https://warthog.com.au";
const FOREIGN_ORIGIN = "https://evil.example";

// One keyed HMAC for the email-code first factor: the test issues the code and the
// handler verifies it under the SAME key, so the emailed code verifies.
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-signup-hmac-key-0123456789abcd", "utf8"));

// A local 256-bit KEK for the dev/test key wrapper, so the handler can wrap a fresh DEK
// for the new account with no Azure Key Vault. Its exact value is irrelevant — we never
// unwrap it here; we only need createUser to receive a valid wrapped-DEK reference.
const LOCAL_KEK = new Uint8Array(32).fill(0x2a);

// Build the handler under test with the real seams and the test fakes. Each test uses
// its own db + outbox, so pending sign-ups and delivered mail never leak across tests.
function makeHandler(db: Db, outbox: Outbox, clock: Clock = fixedClock(T0)) {
  return createSignupHandler({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    emailSender: outbox,
    keyWrapper: localAesKeyWrapper(LOCAL_KEK),
    rpId: RP_ID,
    publicOrigin: GOOD_ORIGIN,
  });
}

// A JSON POST request carrying an `Origin` header. `origin: null` sends no Origin at all
// (the cross-site / no-origin case). A raw string body is sent verbatim (for malformed
// JSON); anything else is JSON-encoded.
function signupRequest(body: unknown, origin: string | null = GOOD_ORIGIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request("https://warthog.com.au/api/signup", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Pull the standalone 6-digit code out of a delivered email body (robust to the copy).
function extractCode(body: string): string {
  const match = body.match(/(?<!\d)\d{6}(?!\d)/);
  assert.ok(match, `the email body must carry a standalone 6-digit code: ${JSON.stringify(body)}`);
  return match[0];
}

// Issue an email one-time code for `email` through the REAL issuer and read the plaintext
// back from the delivered email — exactly how the person receives it. This is the first
// factor the sign-up flow verifies; sign-up itself does not issue the code.
async function issueCodeFor(db: Db, email: string, clock: Clock, outbox: Outbox): Promise<string> {
  await issueEmailCode(db, email, { purpose: "signup",
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    emailSender: outbox,
  });
  const delivered = outbox
    .list()
    .filter((m) => m.channel === "email" && m.recipient === email)
    .at(-1);
  assert.ok(delivered, `issuing a code must deliver an email to ${email}`);
  return extractCode(delivered.body);
}

// A 6-digit string that is NOT `code` (a genuine wrong guess of the same shape).
function wrongCode(code: string): string {
  const first = code[0] === "0" ? "1" : "0";
  return first + code.slice(1);
}

// The session token the browser would hold, pulled out of the `Set-Cookie` the finish
// step emits (the `__Host-wh_session` cookie, value up to the first `;`).
function sessionTokenFromCookie(setCookie: string | null): string {
  assert.ok(setCookie, "the finish step must set a session cookie");
  assert.ok(
    setCookie.startsWith("__Host-wh_session="),
    `the session cookie must be the host-locked __Host-wh_session cookie: ${JSON.stringify(setCookie)}`,
  );
  return setCookie.slice("__Host-wh_session=".length).split(";")[0]!;
}

// Count the sessions currently stored (there is no account id to filter by before the
// account is created, so a total count is the right "nobody is signed in" probe on a
// freshly-migrated, isolated database).
async function sessionCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM sessions");
  return Number(result.rows[0]?.n ?? -1);
}

// Drive steps 1 and 2 (email code → passkey + recovery code) for a fresh person and
// return the pending sign-up's handle plus the recovery code shown once. Asserts the two
// steps themselves succeeded, so a test that depends on reaching confirmation fails for
// the right reason if an earlier step regresses.
async function throughRegisterPasskey(
  handler: ReturnType<typeof makeHandler>,
  auth: SoftwareAuthenticator,
  db: Db,
  outbox: Outbox,
  email: string,
  clock: Clock,
): Promise<{ signupId: string; recoveryCode: string }> {
  const code = await issueCodeFor(db, email, clock, outbox);

  const verifyRes = await handler.verifyEmail(signupRequest({ email, code }));
  assert.equal(verifyRes.status, 200, "a valid email code starts the sign-up");
  const started = (await verifyRes.json()) as {
    signupId: string;
    registrationOptions: PublicKeyCredentialCreationOptionsJSON;
  };
  assert.equal(typeof started.signupId, "string", "verifyEmail hands back a sign-up handle");
  assert.ok(started.signupId.length > 0, "the sign-up handle is non-empty");
  assert.equal(
    started.registrationOptions.rp.id,
    RP_ID,
    "the registration options carry the configured RP ID (from config, not hard-coded)",
  );
  assert.equal(
    typeof started.registrationOptions.challenge,
    "string",
    "the registration options carry a server-issued challenge",
  );

  const registrationResponse: RegistrationResponseJSON = await auth.register(
    started.registrationOptions,
  );

  const registerRes = await handler.registerPasskey(
    signupRequest({ signupId: started.signupId, registrationResponse }),
  );
  assert.equal(registerRes.status, 200, "a valid attestation registers the passkey");
  const issued = (await registerRes.json()) as { recoveryCode: string };
  assert.equal(typeof issued.recoveryCode, "string", "the recovery code is shown once");
  assert.ok(issued.recoveryCode.length > 0, "the recovery code is non-empty");

  return { signupId: started.signupId, recoveryCode: issued.recoveryCode };
}

// =====================================================================================
// AC1 + AC4 — the happy path: email → passkey → recovery (shown) → confirm → signed in,
// with NO account or session created until the person confirms they saved the code.
// =====================================================================================

test("sign-up creates the account and a signed-in session only after the recovery code is confirmed, then redirects to /home", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const email = "newcomer@warthog.com.au";

    const { signupId, recoveryCode } = await throughRegisterPasskey(
      handler,
      auth,
      db,
      outbox,
      email,
      clock,
    );

    // Before confirmation: the second factor is registered and the recovery code shown,
    // but the account and session do NOT exist yet — sign-up must not finish without the
    // "I have saved it" confirmation (AC1).
    assert.equal(
      await getUserByEmail(db, email),
      null,
      "no account exists until the person confirms they saved the recovery code",
    );
    assert.equal(await sessionCount(db), 0, "no session exists until confirmation");

    // Confirm "I have saved it" → the account and session are created and the person is
    // sent to /home (AC4).
    const confirmRes = await handler.confirmSignup(
      signupRequest({ signupId, savedConfirmed: true }),
    );
    assert.ok(
      confirmRes.status >= 300 && confirmRes.status < 400,
      `confirmation must redirect, got ${confirmRes.status}`,
    );
    assert.equal(
      confirmRes.headers.get("location"),
      "/home",
      "on success the person is redirected to /home",
    );

    // The account now exists, and the Set-Cookie is a real, verifiable session for it.
    const person = await getUserByEmail(db, email);
    assert.ok(person, "the account is created on confirmation");
    const token = sessionTokenFromCookie(confirmRes.headers.get("set-cookie"));
    const session = await verifySession(db, token, { clock });
    assert.ok(session, "the issued session token verifies");
    assert.equal(session.userId, person.id, "the session belongs to the newly created person");

    // The recovery code the person was shown is the one that actually works (it was
    // persisted as the account's recovery code, not merely displayed).
    assert.equal(
      await verifyRecoveryCode(db, person.id, recoveryCode),
      true,
      "the recovery code shown at sign-up verifies against the new account",
    );
  } finally {
    await db.close();
  }
});

test("the passkey registered during sign-up authenticates the new person (the second factor is real)", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const email = "passkey-owner@warthog.com.au";

    const { signupId } = await throughRegisterPasskey(handler, auth, db, outbox, email, clock);
    const confirmRes = await handler.confirmSignup(
      signupRequest({ signupId, savedConfirmed: true }),
    );
    assert.ok(confirmRes.status >= 300 && confirmRes.status < 400, "confirmation redirects");

    const person = await getUserByEmail(db, email);
    assert.ok(person, "the account is created on confirmation");

    // Drive a real WebAuthn authentication with the SAME authenticator that registered
    // during sign-up: the credential was persisted for the new account and verifies.
    const options = await beginPasskeyAuthentication(db, { userId: person.id }, { rpId: RP_ID });
    const assertion = await auth.authenticate(options);
    const result = await finishPasskeyAuthentication(
      db,
      { userId: person.id, response: assertion },
      { rpId: RP_ID },
    );
    assert.equal(result.ok, true, "the sign-up passkey authenticates the new person");
  } finally {
    await db.close();
  }
});

test("the recovery code shown once at sign-up is never copied into a notification channel", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const email = "no-leak@warthog.com.au";

    const { signupId, recoveryCode } = await throughRegisterPasskey(
      handler,
      auth,
      db,
      outbox,
      email,
      clock,
    );
    await handler.confirmSignup(signupRequest({ signupId, savedConfirmed: true }));

    // The recovery code is delivered ONLY in the register step's response (shown on
    // screen). It must not be copied into any push / email / SMS the outbox recorded
    // (design/project rule: recovery codes appear in plain text nowhere except the single
    // message that delivers a person their own code). Scoped to the outbox message bodies
    // — the random 26-ish-char code has no legitimate reason to appear on a channel.
    for (const message of outbox.list()) {
      assert.ok(
        !message.body.includes(recoveryCode),
        `the recovery code must not appear in a ${message.channel} message`,
      );
    }
  } finally {
    await db.close();
  }
});

test("a wrong email code is refused and starts no sign-up (the first factor gates it)", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "bad-code@warthog.com.au";
    const code = await issueCodeFor(db, email, clock, outbox);

    const res = await handler.verifyEmail(signupRequest({ email, code: wrongCode(code) }));
    assert.ok(res.status >= 400 && res.status < 500, `a wrong code is a 4xx, got ${res.status}`);

    // Nothing was started: no account, and the response carried no sign-up handle to
    // carry forward.
    const body = (await res.json().catch(() => ({}))) as { signupId?: unknown };
    assert.equal(body.signupId, undefined, "a refused code hands back no sign-up handle");
    assert.equal(await getUserByEmail(db, email), null, "a refused code creates no account");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 (confirmation gate) + AC2 (second-factor gate) — sign-up must not finish without
// BOTH a confirmed "I have saved it" AND a registered second factor.
// =====================================================================================

test("confirmation is required: without 'I have saved it', no account or session is created", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const email = "unconfirmed@warthog.com.au";

    const { signupId } = await throughRegisterPasskey(handler, auth, db, outbox, email, clock);

    const res = await handler.confirmSignup(signupRequest({ signupId, savedConfirmed: false }));
    assert.ok(
      res.status >= 400 && res.status < 500,
      `an unconfirmed finish is refused with a 4xx, got ${res.status}`,
    );
    assert.equal(await getUserByEmail(db, email), null, "no account is created without confirmation");
    assert.equal(await sessionCount(db), 0, "no session is created without confirmation");
  } finally {
    await db.close();
  }
});

test("sign-up refuses to finish without a confirmed second factor (no passkey registered)", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "no-passkey@warthog.com.au";
    const code = await issueCodeFor(db, email, clock, outbox);

    // Verify the email, then jump straight to confirm WITHOUT registering a passkey.
    const verifyRes = await handler.verifyEmail(signupRequest({ email, code }));
    assert.equal(verifyRes.status, 200, "the email code is accepted");
    const { signupId } = (await verifyRes.json()) as { signupId: string };

    const res = await handler.confirmSignup(signupRequest({ signupId, savedConfirmed: true }));
    assert.ok(
      res.status >= 400 && res.status < 500,
      `finishing with no second factor is refused with a 4xx, got ${res.status}`,
    );
    assert.equal(await getUserByEmail(db, email), null, "no account is created without a passkey");
    assert.equal(await sessionCount(db), 0, "no session is created without a passkey");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the action verifies Origin (both at entry and at the finish step).
// =====================================================================================

test("a request from a foreign Origin is refused at entry (403) and starts no sign-up", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "cross-site@warthog.com.au";
    const code = await issueCodeFor(db, email, clock, outbox);

    // A well-formed body (valid email + code), so the ONLY reason to reject is the Origin.
    const foreign = await handler.verifyEmail(signupRequest({ email, code }, FOREIGN_ORIGIN));
    assert.equal(foreign.status, 403, "a foreign Origin is forbidden");
    assert.equal(await getUserByEmail(db, email), null, "a cross-site request starts no sign-up");

    // A request with NO Origin header is refused the same way (it cannot be proven
    // same-origin).
    const noOrigin = await handler.verifyEmail(signupRequest({ email, code }, null));
    assert.equal(noOrigin.status, 403, "a request with no Origin is forbidden");
  } finally {
    await db.close();
  }
});

test("the finish step verifies Origin: a foreign-Origin confirmation cannot create the account", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const email = "finish-origin@warthog.com.au";

    // Reach a pending, passkey-registered sign-up over the good origin.
    const { signupId } = await throughRegisterPasskey(handler, auth, db, outbox, email, clock);

    // A cross-site confirmation (correctly-shaped body) is refused for the Origin alone,
    // and creates nothing — sign-up cannot be driven to completion from another site.
    const res = await handler.confirmSignup(
      signupRequest({ signupId, savedConfirmed: true }, FOREIGN_ORIGIN),
    );
    assert.equal(res.status, 403, "a foreign-Origin finish is forbidden");
    assert.equal(await getUserByEmail(db, email), null, "a cross-site finish creates no account");
    assert.equal(await sessionCount(db), 0, "a cross-site finish mints no session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — validate-and-parameterize: 4xx on bad input, and a SQL-injection probe is bound.
// =====================================================================================

test("verifyEmail rejects malformed and mis-shaped input with a 4xx (never a 500)", async () => {
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox);

    // Malformed JSON, and two mis-shaped bodies — all carry a valid Origin, so the ONLY
    // reason to reject is the input itself.
    const badBodies: unknown[] = [
      "{ not valid json at all",
      {},
      { email: 123, code: [] },
    ];
    for (const body of badBodies) {
      const res = await handler.verifyEmail(signupRequest(body));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("verifyEmail rejects an oversized body with a 4xx before doing any work", async () => {
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox);

    // A schema-valid shape padded past any reasonable body cap (~2 MiB). The size guard
    // must reject it with a 4xx rather than process it.
    const huge = {
      email: "huge@warthog.com.au",
      code: "123456",
      pad: "x".repeat(2 * 1024 * 1024),
    };
    const res = await handler.verifyEmail(signupRequest(huge));
    assert.ok(res.status >= 400 && res.status < 500, `an oversized body must be a 4xx, got ${res.status}`);
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the email field is bound as data and cannot alter a query", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);

    // A real account exists; if the probe below were concatenated into SQL rather than
    // bound, the trailing statement would drop the table and take this row with it.
    const safeAuth = createAuthenticator();
    const safeEmail = "survivor@warthog.com.au";
    const { signupId } = await throughRegisterPasskey(handler, safeAuth, db, outbox, safeEmail, clock);
    await handler.confirmSignup(signupRequest({ signupId, savedConfirmed: true }));
    const survivor = await getUserByEmail(db, safeEmail);
    assert.ok(survivor, "a baseline account exists before the probe");

    // Fire the classic injection probe through the email field with a valid Origin. It is
    // handled (a client-side 4xx, never an uncontrolled 500): whether it is rejected at
    // the validation boundary or reaches the query bound as a parameter, it never runs as
    // SQL.
    const probe = "robert'); DROP TABLE users; --@warthog.com.au";
    const res = await handler.verifyEmail(signupRequest({ email: probe, code: "000000" }));
    assert.ok(res.status < 500, `the probe must be handled, not crash the server (got ${res.status})`);

    // The injection did NOT execute: the users table still exists and still holds the
    // baseline account, and the email_codes table the first factor reads is intact too.
    assert.equal(
      (await getUserByEmail(db, safeEmail))?.id,
      survivor.id,
      "the baseline account survived — the probe was data, not SQL",
    );
    await db.query("SELECT 1 FROM email_codes LIMIT 1");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B9 — confirming a sign-up writes the account in ONE transaction: a failure
// part-way leaves nothing behind (so the address can sign up again), and an address
// taken in the meantime is a clear 409, not a 500 with a half-made account.
// =====================================================================================

// A Db that forwards to `db` but fails the first statement matching `pattern` once armed.
function failingOnce(db: Db, pattern: RegExp): { db: Db; arm(): void } {
  let armed = false;
  return {
    db: {
      async query(text, values) {
        if (armed && pattern.test(text)) {
          armed = false;
          throw new Error("simulated database failure");
        }
        return db.query(text, values);
      },
      async close() {},
    },
    arm() {
      armed = true;
    },
  };
}

async function rowsFor(db: Db, email: string): Promise<{ users: number; passkeys: number; recovery: number }> {
  const users = await db.query(`SELECT id FROM users WHERE lower(email) = $1`, [email]);
  const id = users.rows[0]?.id ?? null;
  const count = async (table: string) =>
    Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [id])).rows[0]?.n ?? 0);
  return {
    users: users.rows.length,
    passkeys: id ? await count("passkeys") : 0,
    recovery: id ? await count("recovery_codes") : 0,
  };
}

test("a failure part-way through confirming leaves no account behind, and the address can sign up again", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const flaky = failingOnce(db, /INSERT INTO recovery_codes/);
    const handler = makeHandler(flaky.db, outbox, clock);
    const email = "halfway@warthog.com.au";
    const { signupId } = await throughRegisterPasskey(handler, createAuthenticator(), db, outbox, email, clock);

    flaky.arm();
    await assert.rejects(handler.confirmSignup(signupRequest({ signupId, savedConfirmed: true })));
    assert.deepEqual(await rowsFor(db, email), { users: 0, passkeys: 0, recovery: 0 }, "nothing was left behind");
    assert.equal(await sessionCount(db), 0, "no session was minted");

    // The person tries again (a minute later, so a fresh code may be sent) and succeeds.
    const later = fixedClock(new Date(T0.getTime() + 61_000));
    const retryHandler = makeHandler(db, outbox, later);
    const retry = await throughRegisterPasskey(retryHandler, createAuthenticator(), db, outbox, email, later);
    const done = await retryHandler.confirmSignup(signupRequest({ signupId: retry.signupId, savedConfirmed: true }));
    assert.equal(done.status, 303, "the retry creates the account");
    assert.deepEqual(await rowsFor(db, email), { users: 1, passkeys: 1, recovery: 1 });
  } finally {
    await db.close();
  }
});

test("confirming for an address that already has an account is a 409 and changes nothing", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "taken-meanwhile@warthog.com.au";
    const { signupId } = await throughRegisterPasskey(handler, createAuthenticator(), db, outbox, email, clock);

    // Someone completes a sign-up for the same address first (in another case).
    await db.query(`INSERT INTO users (email, wrapped_dek) VALUES ($1, $2)`, ["Taken-Meanwhile@warthog.com.au", "x"]);

    const res = await handler.confirmSignup(signupRequest({ signupId, savedConfirmed: true }));
    assert.equal(res.status, 409, "the taken address is reported, not a 500");
    assert.equal(res.headers.get("set-cookie"), null, "no session cookie");
    assert.equal(await sessionCount(db), 0, "no session was minted");
    const passkeys = await db.query(`SELECT count(*)::int AS n FROM passkeys`);
    assert.equal(Number(passkeys.rows[0]?.n), 0, "no orphan passkey was stored");
  } finally {
    await db.close();
  }
});

// Review fix B7 — the browser a person signs up on is marked as recognised, so their next
// sign-in there raises no "new device" alert.
test("confirming sign-up marks the browser as one the person signs in on", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const { signupId } = await throughRegisterPasskey(
      handler, createAuthenticator(), db, outbox, "marked-browser@warthog.com.au", clock,
    );
    const res = await handler.confirmSignup(signupRequest({ signupId, savedConfirmed: true }));
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies[0]?.startsWith("__Host-wh_session="), "the session cookie comes first");
    assert.ok(cookies.some((c) => c.startsWith("__Host-wh_device=")), "the browser is marked");
  } finally {
    await db.close();
  }
});
