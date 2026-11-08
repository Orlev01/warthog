// E04-S11 — Sign-in server actions (`src/app/(auth)/signin/`).
//
// RED-first: the sign-in handler does not exist yet, so importing `./handler`
// throws and every test here fails until the builder adds it. That absence IS the
// point of test-first — do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (the HTTP outcome of each sign-in method, what ends up
// stored, and which person ends up signed in), never the source text of the module —
// a later rename that preserves behaviour must not redden them. There is no browser,
// no Azure and no network: the person's account, their registered passkey and their
// TOTP secret are driven through the REAL sibling seams against an isolated in-memory
// PGlite (src/test/db), and the WebAuthn assertion is produced by the software
// authenticator (src/test/authenticator), whose only non-test collaborator is the real
// @simplewebauthn/server verifier. A valid 30-second TOTP code is computed by a small
// reference RFC 6238 HOTP that lives in this test (the same discipline totp.test.ts
// uses), so the test owns the code the handler must accept and reject.
//
// Why a sibling `handler.ts` (not `actions.ts` or `page.tsx`): a Next "use server"
// actions file may export only async server actions, and a `page.tsx` entry file only
// its framework fields — neither can carry an injectable, unit-testable factory without
// breaking `next build`. So the testable seam lives in a plain sibling module
// (`handler.ts`, the convention's `createXHandler({ db })` pattern); the thin
// `actions.ts` / route verbs wrap it. These tests drive that seam directly with fakes.
//
// Why this contract (brief `sign_in_model`: "Sign-in uses the passkey (or email plus
// authenticator code)"; design §5: "Passkeys via SimpleWebAuthn … RP ID from config";
// "Authenticator app fallback: RFC 6238 TOTP"; "Sessions: random 256-bit id in a
// `__Host-wh_session` cookie"; "Every server action and route checks `Origin` … every
// member-scoped query is filtered by the session's user id"; INV-102
// validate-and-parameterize): a RETURNING person signs in with their second factor and
// gets a session. A passkey is a single, phishing-resistant factor; where passkeys are
// unavailable the authenticator-app (TOTP) code stands in, with the email naming the
// account. The email ONE-TIME code is the separate NEW-DEVICE flow (E04-S08) and is not
// part of this returning-device sign-in.
//
// The TOTP secret has no persistence yet (the vault_unlock_methods store is built much
// later, and this task may touch only the sign-in action/handler), so the handler reads
// it through an injected `totpSecrets` seam — the project's "external services sit
// behind interfaces with fakes" rule. The test injects a fake holding a known secret;
// the builder wires the real store when it exists. (If the builder instead backs TOTP a
// different way, this seam is the one piece of new contract this task defines.)
//
// ─── The contract this task defines (the builder implements exactly this) ────────────
//
//   createSigninHandler(deps): {
//     beginPasskey(req: Request):     Promise<Response>  // { email } -> 200 { options }
//     finishPasskey(req: Request):    Promise<Response>  // { email, authenticationResponse } -> 303 /home
//     signInWithTotp(req: Request):   Promise<Response>  // { email, totp } -> 303 /home
//   }
//
//   deps (one bundle; each method reads the subset it needs):
//     { db: Db; clock: Clock; random: Random;
//       rpId: string;            // WebAuthn RP ID (warthog.com.au), from config
//       publicOrigin: string;    // the configured public origin, for the Origin check
//       totpSecrets: TotpSecretStore }   // get(userId) -> the person's base32 TOTP secret
//
//   Every method verifies the request `Origin` against `publicOrigin` first: a missing
//   or foreign Origin is refused with 403 and changes nothing. Every method validates its
//   JSON body at the boundary (parseBody): malformed, oversized or mis-shaped input → a
//   4xx Response, never an uncontrolled 500 (INV-102). Every query the methods run is
//   parameterized, so a SQL-injection probe in an input field is bound as data and cannot
//   alter a query (INV-102).
//
//   beginPasskey  — body { email }. Resolves the account and issues a WebAuthn
//     authentication challenge for it (carrying the configured rpId), returning
//     200 { options } (a PublicKeyCredentialRequestOptionsJSON). No session yet.
//
//   finishPasskey — body { email, authenticationResponse }. Verifies the assertion
//     against that person's registered passkey and the challenge beginPasskey issued. On
//     success it mints a session and returns a redirect (303) to /home carrying the
//     `__Host-wh_session` Set-Cookie. An assertion that is not the claimed person's own
//     (or otherwise fails to verify) → a 4xx and NO session.
//
//   signInWithTotp — body { email, totp }. Resolves the account, reads its TOTP secret
//     (the injected seam) and verifies the 6-digit code for the current 30-second step
//     (±1). On success it mints a session and returns a 303 redirect to /home with the
//     `__Host-wh_session` Set-Cookie. A wrong / out-of-window code → a 4xx and NO session.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 sign-in succeeds with a passkey AND with email plus TOTP, sets the session
//       cookie, and rejects a wrong factor (a passkey that is not the person's own, and a
//       TOTP code outside the window).
//   AC2 every method verifies Origin (foreign Origin → 403, missing Origin → 403) at
//       entry and at the session-minting step, and a cross-site request mints no session.
//   AC3 a handler rejects malformed / oversized / mis-shaped input with a 4xx, and a
//       SQL-injection probe in an input field cannot alter a query (parameter binding).
//   AC4 on success the person is redirected to /home.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb(). Emails are distinct per test so accounts never collide on the
// users.email UNIQUE.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import type {
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

import { createSigninHandler } from "./handler";

import { verifySession } from "../../../server/auth/session";
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
} from "../../../server/auth/passkey";
import { enrollTotp } from "../../../server/auth/totp";
import { createUser, getUserByEmail, type User } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

// A frozen instant: the TOTP code is computed for this clock's 30-second step, and the
// session is created and verified at the same clock, so both are inside their windows
// with no wall-clock dependence.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The configured WebAuthn RP ID — passed through deps (never a module constant), so the
// "RP ID from config" discipline is exercised end to end.
const RP_ID = "warthog.com.au";

// The HMAC key the new-device cookie is bound under (review fix B7).
const SIGNIN_HMAC_KEY = new Uint8Array(Buffer.from("warthog-signin-device-key-0123456789abcd", "utf8"));

// The configured public origin the handler checks the request `Origin` against, and a
// foreign origin a cross-site request would carry.
const GOOD_ORIGIN = "https://warthog.com.au";
const FOREIGN_ORIGIN = "https://evil.example";

// A placeholder wrapped-DEK reference; createUser stores it verbatim. Its value is
// irrelevant here — we only need a genuine `users` row so passkeys, TOTP secrets and
// sessions can hang off a real userId (the account id every member-scoped row filters by).
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

// Build the handler under test with the real seams and the test fakes. Each test uses
// its own db + totp-secret store, so nothing leaks across tests.
function makeHandler(
  db: Db,
  totpSecrets: TotpSecretStore,
  clock: Clock = fixedClock(T0),
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

// A JSON POST request carrying an `Origin` header. `origin: null` sends no Origin at all
// (the cross-site / no-origin case). A raw string body is sent verbatim (for malformed
// JSON); anything else is JSON-encoded.
function signinRequest(body: unknown, origin: string | null = GOOD_ORIGIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request("https://warthog.com.au/api/signin", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
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
  assert.equal(
    body.options.rpId,
    RP_ID,
    "the authentication options carry the configured RP ID (from config, not hard-coded)",
  );
  assert.equal(
    typeof body.options.challenge,
    "string",
    "the authentication options carry a server-issued challenge",
  );
  return body.options;
}

// ─── A reference RFC 6238 TOTP, independent of the module under test ─────────────────
// Decodes the base32 secret to raw key bytes, then HOTP(key, floor(t/30)) over SHA-1 with
// dynamic truncation to 6 digits — so the test owns the exact code the handler's verify
// must accept (current step) and reject (outside the ±1 window). Same shape as totp.test.
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
// AC1 + AC4 — the passkey happy path: email names the account, the passkey is the
// factor, a session is minted and the person lands on /home.
// =====================================================================================

test("sign-in with a passkey mints a session for the person and redirects to /home", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()), clock);
    const auth = createAuthenticator();
    const email = "passkey-signin@warthog.com.au";

    const user = await freshUser(db, "passkey-signin");
    await registerPasskeyFor(db, auth, user);

    // begin issues the challenge; it does NOT sign anyone in.
    const options = await beginPasskeyFor(handler, email);
    assert.equal(await sessionCount(db), 0, "beginPasskey creates no session");

    const authenticationResponse = await auth.authenticate(options);
    const res = await handler.finishPasskey(signinRequest({ email, authenticationResponse }));

    assert.ok(res.status >= 300 && res.status < 400, `finishPasskey must redirect, got ${res.status}`);
    assert.equal(res.headers.get("location"), "/home", "on success the person is redirected to /home");

    const token = sessionTokenFromCookie(res.headers.get("set-cookie"));
    const session = await verifySession(db, token, { clock });
    assert.ok(session, "the issued session token verifies");
    assert.equal(session.userId, user.id, "the session belongs to the signed-in person");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 + AC4 — the TOTP happy path: email plus the authenticator code.
// =====================================================================================

test("sign-in with email plus TOTP mints a session and redirects to /home", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const entries = new Map<string, string>();
    const handler = makeHandler(db, totpSecretsOf(entries), clock);
    const email = "totp-signin@warthog.com.au";

    const user = await freshUser(db, "totp-signin");
    const secret = await enrolTotpFor(entries, email, user, db);

    // The code the authenticator app shows for the current 30-second step.
    const totp = codeForStep(secret, stepAt(T0));

    const res = await handler.signInWithTotp(signinRequest({ email, totp }));
    assert.ok(res.status >= 300 && res.status < 400, `TOTP sign-in must redirect, got ${res.status}`);
    assert.equal(res.headers.get("location"), "/home", "on success the person is redirected to /home");

    const token = sessionTokenFromCookie(res.headers.get("set-cookie"));
    const session = await verifySession(db, token, { clock });
    assert.ok(session, "the issued session token verifies");
    assert.equal(session.userId, user.id, "the session belongs to the signed-in person");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — rejects a wrong factor (passkey): an assertion that is not the person's own.
// =====================================================================================

test("sign-in rejects a passkey that is not the claimed person's own, and mints no session", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()), clock);
    const personAuth = createAuthenticator();
    const otherAuth = createAuthenticator();

    const person = await freshUser(db, "owner");
    const other = await freshUser(db, "intruder");
    await registerPasskeyFor(db, personAuth, person);
    await registerPasskeyFor(db, otherAuth, other);

    // The challenge is issued for `person`, but the assertion is signed by `other`'s
    // authenticator — a credential `person` never registered.
    const options = await beginPasskeyFor(handler, person.email);
    const authenticationResponse = await otherAuth.authenticate(options);

    const res = await handler.finishPasskey(
      signinRequest({ email: person.email, authenticationResponse }),
    );
    assert.ok(
      res.status >= 400 && res.status < 500,
      `a foreign passkey is rejected with a 4xx, got ${res.status}`,
    );
    assert.equal(await sessionCount(db), 0, "a rejected passkey mints no session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — rejects a wrong factor (TOTP): a code outside the ±1-step window.
// =====================================================================================

test("sign-in rejects a wrong TOTP code and mints no session", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const entries = new Map<string, string>();
    const handler = makeHandler(db, totpSecretsOf(entries), clock);
    const email = "wrong-totp@warthog.com.au";

    const user = await freshUser(db, "wrong-totp");
    const secret = await enrolTotpFor(entries, email, user, db);

    // A code several steps away is outside the accepted {step-1, step, step+1} window.
    // Guard that it differs from every in-window code so the rejection is about the
    // window, not an (astronomically unlikely) collision.
    const step = stepAt(T0);
    const windowCodes = new Set([-1, 0, +1].map((d) => codeForStep(secret, step + d)));
    const wrong = codeForStep(secret, step + 5);
    assert.ok(!windowCodes.has(wrong), "the out-of-window code must differ from the in-window codes");

    const res = await handler.signInWithTotp(signinRequest({ email, totp: wrong }));
    assert.ok(
      res.status >= 400 && res.status < 500,
      `a wrong TOTP code is rejected with a 4xx, got ${res.status}`,
    );
    assert.equal(await sessionCount(db), 0, "a rejected TOTP code mints no session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the action verifies Origin (at entry and at the session-minting step).
// =====================================================================================

test("a request from a foreign or missing Origin is refused (403) and mints no session", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const entries = new Map<string, string>();
    const handler = makeHandler(db, totpSecretsOf(entries), clock);
    const email = "origin-check@warthog.com.au";

    const user = await freshUser(db, "origin-check");
    const secret = await enrolTotpFor(entries, email, user, db);
    const totp = codeForStep(secret, stepAt(T0));

    // begin (entry): a foreign Origin and a missing Origin are both forbidden.
    const beginForeign = await handler.beginPasskey(signinRequest({ email }, FOREIGN_ORIGIN));
    assert.equal(beginForeign.status, 403, "beginPasskey from a foreign Origin is forbidden");
    const beginNoOrigin = await handler.beginPasskey(signinRequest({ email }, null));
    assert.equal(beginNoOrigin.status, 403, "beginPasskey with no Origin is forbidden");

    // signInWithTotp (session-minting): a cross-site request with a VALID code is still
    // refused for the Origin alone, and mints nothing.
    const totpForeign = await handler.signInWithTotp(signinRequest({ email, totp }, FOREIGN_ORIGIN));
    assert.equal(totpForeign.status, 403, "a foreign-Origin TOTP sign-in is forbidden");
    const totpNoOrigin = await handler.signInWithTotp(signinRequest({ email, totp }, null));
    assert.equal(totpNoOrigin.status, 403, "a TOTP sign-in with no Origin is forbidden");

    assert.equal(await sessionCount(db), 0, "a cross-site sign-in mints no session");
  } finally {
    await db.close();
  }
});

test("the passkey finish step verifies Origin: a cross-site assertion cannot mint a session", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()), clock);
    const auth = createAuthenticator();

    const person = await freshUser(db, "finish-origin");
    await registerPasskeyFor(db, auth, person);

    // Reach a genuine, verifiable assertion over the GOOD origin (so the only reason to
    // reject the finish is the Origin).
    const options = await beginPasskeyFor(handler, person.email);
    const authenticationResponse = await auth.authenticate(options);

    const res = await handler.finishPasskey(
      signinRequest({ email: person.email, authenticationResponse }, FOREIGN_ORIGIN),
    );
    assert.equal(res.status, 403, "a foreign-Origin finish is forbidden");
    assert.equal(await sessionCount(db), 0, "a cross-site finish mints no session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — validate-and-parameterize: 4xx on bad input, and a SQL-injection probe is bound.
// =====================================================================================

test("signInWithTotp rejects malformed and mis-shaped input with a 4xx (never a 500)", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()));

    // Malformed JSON, and two mis-shaped bodies — all carry a valid Origin, so the ONLY
    // reason to reject is the input itself.
    const badBodies: unknown[] = [
      "{ not valid json at all",
      {},
      { email: 123, totp: [] },
    ];
    for (const body of badBodies) {
      const res = await handler.signInWithTotp(signinRequest(body));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("beginPasskey rejects malformed and mis-shaped input with a 4xx (never a 500)", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()));

    const badBodies: unknown[] = ["{ not valid json", {}, { email: 123 }];
    for (const body of badBodies) {
      const res = await handler.beginPasskey(signinRequest(body));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }
  } finally {
    await db.close();
  }
});

// Operator fix (E04-S11 review veto): finishPasskey's assertion field must be shape-checked
// at the boundary. `null` (and other non-object shapes) once slipped past the schema and was
// dereferenced inside the verifier — an anonymous, uncontrolled 500.
test("finishPasskey rejects a mis-shaped assertion with a 4xx and mints no session (never a 500)", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()));
    const auth = createAuthenticator();
    const email = "misshaped-assertion@warthog.com.au";
    const user = await freshUser(db, "misshaped-assertion");
    await registerPasskeyFor(db, auth, user);

    const badAssertions: unknown[] = [null, 42, "garbage", true, [], {}, { id: 5 }, { response: {} }];
    for (const authenticationResponse of badAssertions) {
      await beginPasskeyFor(handler, email); // a live challenge, so only the shape can fail
      let status: number;
      try {
        status = (await handler.finishPasskey(signinRequest({ email, authenticationResponse }))).status;
      } catch (error) {
        assert.fail(`assertion ${JSON.stringify(authenticationResponse)} threw instead of a 4xx: ${error}`);
      }
      assert.ok(
        status >= 400 && status < 500,
        `assertion ${JSON.stringify(authenticationResponse)} must be a 4xx, got ${status}`,
      );
    }
    assert.equal(await sessionCount(db), 0, "no mis-shaped assertion mints a session");
  } finally {
    await db.close();
  }
});

test("signInWithTotp rejects an oversized body with a 4xx before doing any work", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()));

    // A schema-valid shape padded past any reasonable body cap (~2 MiB). The size guard
    // must reject it with a 4xx rather than process it.
    const huge = {
      email: "huge@warthog.com.au",
      totp: "123456",
      pad: "x".repeat(2 * 1024 * 1024),
    };
    const res = await handler.signInWithTotp(signinRequest(huge));
    assert.ok(res.status >= 400 && res.status < 500, `an oversized body must be a 4xx, got ${res.status}`);
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the email field is bound as data and cannot alter a query", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const entries = new Map<string, string>();
    const handler = makeHandler(db, totpSecretsOf(entries), clock);

    // A real account exists; if the probe below were concatenated into SQL rather than
    // bound, the trailing statement would drop the table and take this row with it.
    const survivor = await freshUser(db, "survivor");
    await enrolTotpFor(entries, survivor.email, survivor, db);

    // Fire the classic injection probe through the email field with a valid Origin. It is
    // handled (a client-side 4xx, never an uncontrolled 500): whether rejected at the
    // validation boundary or reaching the account lookup bound as a parameter, it never
    // runs as SQL.
    const probe = "robert'); DROP TABLE users; --@warthog.com.au";
    const res = await handler.signInWithTotp(signinRequest({ email: probe, totp: "000000" }));
    assert.ok(res.status < 500, `the probe must be handled, not crash the server (got ${res.status})`);

    // The injection did NOT execute: the users table still exists and still holds the
    // baseline account, and the sessions table is intact too.
    assert.equal(
      (await getUserByEmail(db, survivor.email))?.id,
      survivor.id,
      "the baseline account survived — the probe was data, not SQL",
    );
    await db.query("SELECT 1 FROM sessions LIMIT 1");
    assert.equal(await sessionCount(db), 0, "the probe signed nobody in");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B4 — one sign-in assertion mints at most one session, even for a synced
// passkey whose signature counter stays at 0 (modelled by holding the stored counter at 0).
// =====================================================================================

test("a sign-in assertion replayed to finish-passkey mints no second session", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()), clock);
    const auth = createAuthenticator();
    const email = "replayed-signin@warthog.com.au";
    const user = await freshUser(db, "replayed-signin");
    await registerPasskeyFor(db, auth, user);

    const options = await beginPasskeyFor(handler, email);
    const authenticationResponse = await auth.authenticate(options);
    const first = await handler.finishPasskey(signinRequest({ email, authenticationResponse }));
    assert.equal(first.status, 303, "the first finish signs the person in");

    await db.query(`UPDATE passkeys SET counter = 0 WHERE user_id = $1`, [user.id]);
    const replay = await handler.finishPasskey(signinRequest({ email, authenticationResponse }));
    assert.equal(replay.status, 401, "the replay is refused");
    assert.equal(await sessionCount(db), 1, "exactly one session was minted");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B8 — sign-in finds the account whatever case or spacing the email is typed in.
// =====================================================================================

test("sign-in with a passkey works when the email is typed in another case with spaces", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, totpSecretsOf(new Map()), clock);
    const auth = createAuthenticator();
    await registerPasskeyFor(db, auth, await freshUser(db, "case-signin"));
    const typed = "  Case-Signin@Warthog.COM.au ";

    const options = await beginPasskeyFor(handler, typed);
    const authenticationResponse = await auth.authenticate(options);
    const res = await handler.finishPasskey(signinRequest({ email: typed, authenticationResponse }));
    assert.equal(res.status, 303, "the account is found and the person signed in");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B7 — a sign-in from a browser the person has not signed in on before emails
// them a new-device alert (no code in it) and marks the browser; a later sign-in from
// that browser sends nothing. A failed alert never fails the sign-in.
// =====================================================================================

function signinRequestWithCookie(body: unknown, cookie: string | null, userAgent?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json", origin: GOOD_ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (userAgent) headers["user-agent"] = userAgent;
  return new Request("https://warthog.com.au/api/signin", { method: "POST", headers, body: JSON.stringify(body) });
}

function deviceCookieIn(res: Response): string | null {
  const cookies = res.headers.getSetCookie();
  const device = cookies.find((c) => c.startsWith("__Host-wh_device="));
  return device ? device.split(";")[0]! : null;
}

test("a sign-in from a new browser alerts the account holder once; the same browser later does not", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = makeHandler(db, totpSecretsOf(new Map()), clock, outbox);
    const auth = createAuthenticator();
    const user = await freshUser(db, "new-browser");
    await registerPasskeyFor(db, auth, user);
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

    const signIn = async (cookie: string | null) => {
      const options = await beginPasskeyFor(handler, user.email);
      const authenticationResponse = await auth.authenticate(options);
      return handler.finishPasskey(signinRequestWithCookie({ email: user.email, authenticationResponse }, cookie, ua));
    };

    const first = await signIn(null);
    assert.equal(first.status, 303);
    const alerts = outbox.list().filter((m) => m.channel === "email" && m.recipient === user.email);
    assert.equal(alerts.length, 1, "one new-device alert goes to the account holder");
    assert.match(alerts[0]!.body, /new device/i);
    assert.match(alerts[0]!.body, /Chrome on Windows/, "the alert names the browser in plain words");
    assert.ok(!/(?<!\d)\d{6}(?!\d)/.test(alerts[0]!.body), "the alert carries no code");
    const cookie = deviceCookieIn(first);
    assert.ok(cookie, "the browser is marked as one the person has signed in on");

    const second = await signIn(cookie);
    assert.equal(second.status, 303);
    assert.equal(
      outbox.list().filter((m) => m.channel === "email" && m.recipient === user.email).length,
      1,
      "a recognised browser sends no further alert",
    );
  } finally {
    await db.close();
  }
});

test("a TOTP sign-in from a new browser alerts too", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const user = await freshUser(db, "totp-new-browser");
    const secrets = new Map<string, string>();
    const secret = await enrolTotpFor(secrets, user.email, user, db);
    const handler = makeHandler(db, totpSecretsOf(secrets), clock, outbox);

    const res = await handler.signInWithTotp(
      signinRequestWithCookie({ email: user.email, totp: codeForStep(secret, stepAt(T0)) }, null),
    );
    assert.equal(res.status, 303);
    assert.equal(outbox.list().filter((m) => m.recipient === user.email).length, 1, "one alert");
  } finally {
    await db.close();
  }
});

test("an alert that cannot be delivered does not fail the sign-in", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const failing = Object.assign(createOutbox(), {
      async sendEmail(): Promise<void> {
        throw new Error("email provider down");
      },
    });
    const handler = makeHandler(db, totpSecretsOf(new Map()), clock, failing);
    const auth = createAuthenticator();
    const user = await freshUser(db, "alert-down");
    await registerPasskeyFor(db, auth, user);

    const options = await beginPasskeyFor(handler, user.email);
    const authenticationResponse = await auth.authenticate(options);
    const res = await handler.finishPasskey(signinRequest({ email: user.email, authenticationResponse }));
    assert.equal(res.status, 303, "the person is still signed in");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix W3.5 — authenticator-app sign-in is limited and single use: a code that
// already signed someone in cannot be replayed, and after 5 failures in 15 minutes the
// account's attempts are slowed (429 with Retry-After), even for the right code.
// =====================================================================================

test("a TOTP code cannot be used twice, and 5 failures slow further attempts", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const entries = new Map<string, string>();
    const handler = makeHandler(db, totpSecretsOf(entries), clock);
    const user = await freshUser(db, "totp-limited");
    const secret = await enrolTotpFor(entries, user.email, user, db);
    const totp = codeForStep(secret, stepAt(T0));

    assert.equal((await handler.signInWithTotp(signinRequest({ email: user.email, totp }))).status, 303);
    const replay = await handler.signInWithTotp(signinRequest({ email: user.email, totp }));
    assert.equal(replay.status, 401, "the same code is refused the second time");

    const wrong = totp === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) {
      assert.equal((await handler.signInWithTotp(signinRequest({ email: user.email, totp: wrong }))).status, 401);
    }
    const nextCode = codeForStep(secret, stepAt(T0) + 1);
    const slowed = await handler.signInWithTotp(signinRequest({ email: user.email, totp: nextCode }));
    assert.equal(slowed.status, 429, "after 5 failures even the right code waits");
    assert.ok(Number(slowed.headers.get("retry-after")) > 0, "it says how long to wait");
  } finally {
    await db.close();
  }
});
