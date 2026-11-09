// E04-S35 — A fresh sign-in counts as a step-up (`src/app/(auth)/signin/`).
//
// RED-first: these tests describe a behaviour the handler does NOT have yet. Today
// the sign-in handler mints a session (createSession) after a verified passkey
// assertion or authenticator code, but it NEVER records a step-up on that session —
// so `requireStepUp` returns false for every session a sign-in produces, and every
// sensitive change it guards (high-tier release, card release, security change,
// export, delete) is unreachable in production (the E04-S15 review finding). The
// tests below assert the FIXED behaviour (the new session carries a fresh step-up),
// so they fail against the current handler. Do NOT implement anything here to make
// them pass — the builder adds the recordStepUp call to `handler.ts` test-first.
//
// These tests pin BEHAVIOUR (what `requireStepUp` returns for the session a sign-in
// mints, judged against an injected clock, and what ends up stored after a failed
// sign-in), never the source text of the module — a later rename that preserves
// behaviour must not redden them. There is no browser, no Azure and no network: the
// person's account, their registered passkey and their TOTP secret are driven through
// the REAL sibling seams against an isolated in-memory PGlite (src/test/db), the
// WebAuthn assertion is produced by the software authenticator (src/test/authenticator),
// and a valid 30-second TOTP code is computed by a small reference RFC 6238 HOTP that
// lives in this test — the same discipline handler.test.ts / totp.test.ts use — so the
// test owns the exact code the handler must accept.
//
// The contract this task leans on (brief: "WHEN a sensitive action is requested … THE
// SYSTEM SHALL require a passkey or authenticator check completed within the previous 5
// minutes"; design §5: "step-up valid 5 minutes"): a passkey or TOTP check records a
// step-up via `recordStepUp`, and `requireStepUp(session, { clock })` then passes for
// the next five minutes. A sign-in IS a passkey/TOTP check, so the session it mints
// must carry that fresh step-up. `steppedUpAt` is factor-agnostic — it reads the same
// whether the passkey check or the TOTP check wrote it (step-up.ts) — so both sign-in
// methods are exercised.
//
// Acceptance criteria → tests:
//   AC1 "After a successful passkey sign-in, requireStepUp passes for the new session
//        and fails once five minutes have passed (injected clock)."
//   AC2 "After a successful authenticator-code sign-in, requireStepUp passes for the
//        new session."
//   AC3 "A failed sign-in records nothing and mints no session." — a rejected passkey
//        and a rejected TOTP code each leave zero sessions and zero recorded step-ups.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb() and distinct emails so accounts never collide on the
// users.email UNIQUE.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

import { createSigninHandler } from "./handler";
import { emailProofFor } from "../../../test/totp-signin";

import { verifySession } from "../../../server/auth/session";
import { requireStepUp } from "../../../server/auth/step-up";
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
} from "../../../server/auth/passkey";
import { enrollTotp } from "../../../server/auth/totp";
import { createUser, type User } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import type { Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

// A frozen instant the sign-in happens at. The TOTP code is computed for this clock's
// 30-second step, and the step-up is recorded at this clock, so both are inside their
// windows with no wall-clock dependence.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The step-up stays fresh for five minutes (design §5), so a clock one second past that
// window is the earliest moment a step-up is stale. We never hard-code the handler's
// internals — we simply advance the injected clock past the five-minute boundary.
const STEP_UP_WINDOW_MS = 5 * MINUTE_MS;

// The configured WebAuthn RP ID — passed through deps (never a module constant), so the
// "RP ID from config" discipline is exercised end to end.
const RP_ID = "warthog.com.au";

// The HMAC key the new-device cookie is bound under (review fix B7).
const SIGNIN_HMAC_KEY = new Uint8Array(Buffer.from("warthog-signin-device-key-0123456789abcd", "utf8"));

// The configured public origin the handler checks the request `Origin` against.
const GOOD_ORIGIN = "https://warthog.com.au";

// A placeholder wrapped-DEK reference; createUser stores it verbatim. Its value is
// irrelevant here — we only need a genuine `users` row so passkeys, TOTP secrets and
// sessions can hang off a real userId.
const WRAPPED_DEK = "wrapped-dek-placeholder";

// The injected TOTP-secret store the handler reads a person's base32 secret through.
// Modelled as an interface here so the test's fake is a plain object; the handler
// declares the structurally-identical shape in its deps.
interface TotpSecretStore {
  get(userId: string): Promise<string | null>;
}

// Build a TOTP-secret store fake from a userId -> base32-secret map. A userId with no
// secret returns null (the person has not enrolled TOTP).
function totpSecretsOf(entries: Map<string, string>): TotpSecretStore {
  return {
    async get(userId: string): Promise<string | null> {
      return entries.get(userId) ?? null;
    },
  };
}

// A clock whose "now" a test advances, so the five-minute window is crossed
// deterministically (same shape as session.test.ts / step-up.test.ts). The sign-in and
// the first requireStepUp read it at `start`; advancing it then ages the step-up out.
function mutableClock(start: Date): { clock: Clock; advance(ms: number): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// Build the handler under test with the real seams and the test fakes. Each test uses
// its own db + totp-secret store + clock, so nothing leaks across tests.
function makeHandler(
  db: Db,
  totpSecrets: TotpSecretStore,
  clock: Clock,
  outbox: Outbox = createOutbox(),
) {
  return createSigninHandler({
    db,
    clock,
    random: systemRandom,
    hmacKey: SIGNIN_HMAC_KEY,
    emailSender: outbox,
    rpId: RP_ID,
    publicOrigin: GOOD_ORIGIN,
    totpSecrets,
  });
}

// A JSON POST request carrying the good `Origin` header (every sign-in here is
// same-origin; the Origin check itself is covered by handler.test.ts).
function signinRequest(body: unknown): Request {
  return new Request("https://warthog.com.au/api/signin", {
    method: "POST",
    headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
    body: JSON.stringify(body),
  });
}

// The session token the browser would hold, pulled out of the `Set-Cookie` a successful
// sign-in emits (the `__Host-wh_session` cookie, value up to the first `;`).
function sessionTokenFromCookie(setCookie: string | null): string {
  assert.ok(setCookie, "a successful sign-in must set a session cookie");
  assert.ok(
    setCookie.startsWith("__Host-wh_session="),
    `the session cookie must be the host-locked __Host-wh_session cookie: ${JSON.stringify(setCookie)}`,
  );
  return setCookie.slice("__Host-wh_session=".length).split(";")[0]!;
}

// Count the sessions currently stored. Each test uses its own freshly-migrated,
// isolated database, so a total count is the right "nobody is signed in" probe.
async function sessionCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM sessions");
  return Number(result.rows[0]?.n ?? -1);
}

// Count the sessions that carry a recorded step-up. A failed sign-in must leave this at
// zero: it records no step-up (and, having minted no session, has nothing to record one
// on). Each test's db is isolated, so a total count is the right "no step-up recorded"
// probe.
async function steppedUpSessionCount(db: Db): Promise<number> {
  const result = await db.query(
    "SELECT count(*)::int AS n FROM sessions WHERE stepped_up_at IS NOT NULL",
  );
  return Number(result.rows[0]?.n ?? -1);
}

// Create a genuine person row and return it. Distinct labels give distinct (unique)
// emails within a test, so two users never collide on the users.email UNIQUE.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// Register a passkey for `user` through the real begin → authenticator → finish path, so
// a credential the handler can later verify an assertion against exists. The passed
// `auth` instance now holds the keypair it signs with.
async function registerPasskeyFor(
  db: Db,
  auth: SoftwareAuthenticator,
  user: User,
): Promise<void> {
  const options = await beginPasskeyRegistration(
    db,
    { userId: user.id, userName: user.email },
    { rpId: RP_ID },
  );
  const response = await auth.register(options);
  const result = await finishPasskeyRegistration(db, { userId: user.id, response }, { rpId: RP_ID });
  if (!result.ok) assert.fail(`setup registration must verify: ${JSON.stringify(result)}`);
}

// Drive the handler's own begin step for `email` and return the options it issued (so a
// subsequent authenticate signs over the challenge the handler stored). Asserts begin
// succeeded and carries the configured rpId, so a finish test fails for the right reason
// if begin regresses.
async function beginPasskeyFor(
  handler: ReturnType<typeof makeHandler>,
  email: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const res = await handler.beginPasskey(signinRequest({ email }));
  assert.equal(res.status, 200, "beginPasskey starts the sign-in with a challenge");
  const body = (await res.json()) as { options: PublicKeyCredentialRequestOptionsJSON };
  assert.ok(body.options, "beginPasskey hands back authentication options");
  return body.options;
}

// ─── A reference RFC 6238 TOTP, independent of the module under test ─────────────────
// Decodes the base32 secret to raw key bytes, then HOTP(key, floor(t/30)) over SHA-1 with
// dynamic truncation to 6 digits — so the test owns the exact code the handler's verify
// must accept (current step) and reject (outside the ±1 window). Same shape as handler.test.
const STEP_SECONDS = 30;
const DIGITS = 6;
const MODULUS = 10 ** DIGITS;
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function hotpSha1(key: Uint8Array, counter: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(key)).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % MODULUS).toString().padStart(DIGITS, "0");
}

function stepAt(instant: Date): number {
  return Math.floor(instant.getTime() / 1000 / STEP_SECONDS);
}

function codeForStep(secretB32: string, step: number): string {
  return hotpSha1(base32Decode(secretB32), step);
}

// Enrol a TOTP secret for `user` through the REAL enroller, hand it to the injected
// store, and return the secret so the test can compute valid/invalid codes for it.
async function enrolTotpFor(
  entries: Map<string, string>,
  email: string,
  user: User,
  db: Db,
): Promise<string> {
  const { secret } = await enrollTotp(
    { account: email, issuer: "Warthog" },
    { random: systemRandom },
  );
  entries.set(user.id, secret);
  // The account's totp_secrets row, which carries its attempt count and last used step
  // (review fix W3.5); the secret itself is read through the fake store above.
  await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'v1:test')", [user.id]);
  return secret;
}

// =====================================================================================
// AC1 — a successful passkey sign-in records a step-up on the new session: requireStepUp
// passes immediately, then fails once five minutes have passed (injected clock).
// =====================================================================================

test("a fresh passkey sign-in records a step-up: requireStepUp passes for the new session, then fails after five minutes", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()), c.clock);
    const auth = createAuthenticator();
    const email = "stepup-passkey@warthog.com.au";

    const user = await freshUser(db, "stepup-passkey");
    await registerPasskeyFor(db, auth, user);

    const options = await beginPasskeyFor(handler, email);
    const authenticationResponse = await auth.authenticate(options);
    const res = await handler.finishPasskey(signinRequest({ email, authenticationResponse }));
    assert.ok(
      res.status >= 300 && res.status < 400,
      `the passkey sign-in must succeed (redirect), got ${res.status}`,
    );

    // Read back the newly-minted session to see the step-up the sign-in recorded on it.
    const token = sessionTokenFromCookie(res.headers.get("set-cookie"));
    const session = await verifySession(db, token, { clock: c.clock });
    assert.ok(session, "the issued session token verifies");
    assert.equal(session.userId, user.id, "the session belongs to the signed-in person");
    assert.ok(
      session.steppedUpAt != null,
      "the passkey sign-in recorded a step-up on the new session",
    );

    // Within the five-minute window, the next sensitive change is allowed.
    assert.equal(
      requireStepUp(session, { clock: c.clock }),
      true,
      "requireStepUp passes on the session a fresh passkey sign-in just minted",
    );

    // Once five minutes have passed, that step-up has aged out and requireStepUp fails.
    c.advance(STEP_UP_WINDOW_MS + 1 * SECOND_MS);
    assert.equal(
      requireStepUp(session, { clock: c.clock }),
      false,
      "requireStepUp fails once five minutes have passed since the sign-in",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — a successful authenticator-code sign-in records a step-up on the new session:
// requireStepUp passes for it (step-up is factor-agnostic — TOTP records it the same way
// the passkey check does).
// =====================================================================================

test("a fresh authenticator-code sign-in records a step-up: requireStepUp passes for the new session", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const entries = new Map<string, string>();
    const handler = makeHandler(db, totpSecretsOf(entries), c.clock);
    const email = "stepup-totp@warthog.com.au";

    const user = await freshUser(db, "stepup-totp");
    const secret = await enrolTotpFor(entries, email, user, db);

    // The code the authenticator app shows for the current 30-second step.
    const totp = codeForStep(secret, stepAt(T0));

    const res = await handler.signInWithTotp(signinRequest({ signinId: await emailProofFor(handler, db, email, { clock: c.clock, hmacKey: SIGNIN_HMAC_KEY, origin: GOOD_ORIGIN }), totp }));
    assert.ok(
      res.status >= 300 && res.status < 400,
      `the authenticator-code sign-in must succeed (redirect), got ${res.status}`,
    );

    const token = sessionTokenFromCookie(res.headers.get("set-cookie"));
    const session = await verifySession(db, token, { clock: c.clock });
    assert.ok(session, "the issued session token verifies");
    assert.equal(session.userId, user.id, "the session belongs to the signed-in person");
    assert.ok(
      session.steppedUpAt != null,
      "the authenticator-code sign-in recorded a step-up on the new session",
    );

    assert.equal(
      requireStepUp(session, { clock: c.clock }),
      true,
      "requireStepUp passes on the session a fresh authenticator-code sign-in just minted",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a failed sign-in records nothing and mints no session (passkey case): a rejected
// assertion mints no session and records no step-up anywhere.
// =====================================================================================

test("a failed passkey sign-in records no step-up and mints no session", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()), c.clock);
    const personAuth = createAuthenticator();
    const otherAuth = createAuthenticator();

    const person = await freshUser(db, "fail-owner");
    const other = await freshUser(db, "fail-intruder");
    await registerPasskeyFor(db, personAuth, person);
    await registerPasskeyFor(db, otherAuth, other);

    // The challenge is issued for `person`, but the assertion is signed by `other`'s
    // authenticator — a credential `person` never registered, so the finish fails.
    const options = await beginPasskeyFor(handler, person.email);
    const authenticationResponse = await otherAuth.authenticate(options);
    const res = await handler.finishPasskey(
      signinRequest({ email: person.email, authenticationResponse }),
    );

    assert.ok(
      res.status >= 400 && res.status < 500,
      `a foreign passkey is rejected with a 4xx, got ${res.status}`,
    );
    assert.equal(await sessionCount(db), 0, "a failed passkey sign-in mints no session");
    assert.equal(
      await steppedUpSessionCount(db),
      0,
      "a failed passkey sign-in records no step-up",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a failed sign-in records nothing and mints no session (TOTP case): a code outside
// the ±1-step window mints no session and records no step-up anywhere.
// =====================================================================================

test("a failed authenticator-code sign-in records no step-up and mints no session", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const entries = new Map<string, string>();
    const handler = makeHandler(db, totpSecretsOf(entries), c.clock);
    const email = "fail-totp@warthog.com.au";

    const user = await freshUser(db, "fail-totp");
    const secret = await enrolTotpFor(entries, email, user, db);

    // A code several steps away is outside the accepted {step-1, step, step+1} window.
    // Guard that it differs from every in-window code so the rejection is about the
    // window, not an (astronomically unlikely) collision.
    const step = stepAt(T0);
    const windowCodes = new Set([-1, 0, +1].map((d) => codeForStep(secret, step + d)));
    const wrong = codeForStep(secret, step + 5);
    assert.ok(!windowCodes.has(wrong), "the out-of-window code must differ from the in-window codes");

    const res = await handler.signInWithTotp(signinRequest({ signinId: await emailProofFor(handler, db, email, { clock: c.clock, hmacKey: SIGNIN_HMAC_KEY, origin: GOOD_ORIGIN }), totp: wrong }));
    assert.ok(
      res.status >= 400 && res.status < 500,
      `a wrong TOTP code is rejected with a 4xx, got ${res.status}`,
    );
    assert.equal(await sessionCount(db), 0, "a failed TOTP sign-in mints no session");
    assert.equal(
      await steppedUpSessionCount(db),
      0,
      "a failed TOTP sign-in records no step-up",
    );
  } finally {
    await db.close();
  }
});
