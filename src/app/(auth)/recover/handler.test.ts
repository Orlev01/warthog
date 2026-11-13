// E04-S29 — Account-recovery server actions (`src/app/(auth)/recover/handler.ts`).
//
// RED-first: the recover handler does not exist yet, so importing `./handler`
// throws and every test here fails until the builder adds it. That absence IS the
// point of test-first — do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (the HTTP outcome of each step, what ends up stored, and
// which device ends up signed in), never the source text of the module — a later
// rename that preserves behaviour must not redden them. There is no browser, no Azure
// and no network: the recovery code, the passkey round trip, the new recovery code and
// the session are all driven through the REAL sibling seams against an isolated
// in-memory PGlite (src/test/db), and the WebAuthn attestation is produced by the
// software authenticator (src/test/authenticator), whose only non-test collaborator is
// the real @simplewebauthn/server verifier.
//
// Why a sibling `handler.ts` (not `actions.ts` or `page.tsx`): a Next "use server"
// actions file may export only async server actions, and a `page.tsx` entry file only
// its framework fields — neither can carry an injectable, unit-testable factory without
// breaking `next build`. So the testable seam lives in a plain sibling module
// (`handler.ts`, the convention's `createXHandler({ db })` pattern); the thin
// `actions.ts` / route verbs wrap it. These tests drive that seam directly with fakes.
//
// Why this exists (brief "Recover your account"; design §4.2, §5: the one-time recovery
// code "restores access … if every passkey is lost", and after recovery the person
// "receives a new recovery code that replaces the old one"; INV-22 "require every
// account to hold a passkey … second factor"; INV-102 validate-and-parameterize): the
// recovery modules exist but nothing serves them, so a person who loses every device
// cannot get back in. This handler is that front door: it identifies the person by
// email, verifies their recovery code, registers a NEW passkey (the new second factor),
// issues a NEW recovery code shown ONCE (which replaces the old one), then mints a
// session and lands them on /home.
//
// ─── The contract this task defines (the builder implements exactly this) ────────────
//
//   createRecoverHandler(deps): {
//     identify(req: Request):        Promise<Response>  // step 1: { email } -> start recovery
//     verifyEmail(req: Request):     Promise<Response>  // step 1b: the emailed one-time code
//     verifyCode(req: Request):      Promise<Response>  // step 2: verify the recovery code
//     registerPasskey(req: Request): Promise<Response>  // step 3: new passkey + new recovery code
//     finish(req: Request):          Promise<Response>  // step 4: mint a session -> /home
//   }
//
//   deps (one bundle; each step reads the subset it needs):
//     { db: Db; clock: Clock; random: Random;
//       hmacKey: Uint8Array; emailSender: EmailSender;   // the email one-time code
//       rpId: string;            // WebAuthn RP ID (warthog.com.au), from config
//       publicOrigin: string }   // the configured public origin, for the Origin check
//
//   Every step verifies the request `Origin` against `publicOrigin` first: a missing or
//   foreign Origin is refused with 403 and changes nothing (design §5). Every step
//   validates its JSON body at the boundary (parseBody): malformed, oversized or
//   mis-shaped input → a 4xx Response, never an uncontrolled 500 (INV-102). Every query
//   the steps run is parameterized, so a SQL-injection probe in an input field is bound
//   as data and cannot alter a query (INV-102). The new recovery code is handed to the
//   person only in the registerPasskey response and reaches no notification channel.
//
//   identify      — body { email }. Resolves the account and starts a pending recovery,
//     returning 200 { recoveryId } — the handle that carries the remaining steps (the
//     release-store / new-device pattern, as sign-up's signupId). No session is created.
//     For an existing account it emails a one-time code (review fix B2: the brief's
//     recovery is "email code plus recovery code").
//
//   verifyEmail   — body { recoveryId, code }. Verifies the emailed one-time code; only a
//     recovery whose email code verified may present its recovery code.
//
//   verifyCode    — body { recoveryId, recoveryCode }. Verifies the presented recovery
//     code against the pending recovery's account (the real verifyRecoveryCode). A wrong
//     code → 4xx and nothing changes (no session, no passkey, the old code still works).
//     A valid code → 200 { registrationOptions }, a PublicKeyCredentialCreationOptions
//     carrying the configured rpId, so the person can register a new passkey.
//
//   registerPasskey — body { recoveryId, registrationResponse }. Verifies the WebAuthn
//     attestation against the challenge the server issued, registers the new passkey for
//     the account, and issues the NEW recovery code (which REPLACES the old one),
//     returning 200 { recoveryCode } — the single place the new code is handed to the
//     person (shown once). A bad attestation / unknown recovery → 4xx.
//
//   finish        — body { recoveryId }. Refuses (4xx, nothing minted) unless a new
//     passkey was registered for the pending recovery (the new second factor). On
//     success it mints a session and returns a redirect (303) to /home carrying the
//     `__Host-wh_session` Set-Cookie. The new passkey authenticates against the account.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 a person with a valid recovery code who registers a new passkey ends with a
//       session and a 303 to /home, and the OLD recovery code no longer verifies while
//       the NEW one does (happy path end-to-end); the new passkey authenticates; and
//       finishing without a new passkey mints no session (the second-factor gate).
//   AC2 a wrong recovery code is a 4xx with no session and no new passkey (and the old
//       code keeps working — it was not replaced).
//   AC3 every step verifies Origin: a missing or foreign Origin is 403 and changes
//       nothing (no session, no passkey, the old recovery code untouched).
//   AC4 a handler rejects malformed / oversized / mis-shaped input with a 4xx, and a
//       SQL-injection probe in an input field cannot alter a query (parameter binding).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb(). Recovery codes and recoveryIds are drawn from the REAL random
// seam so nothing collides across tests (the same discipline the session / sign-up
// tests use).

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { createRecoverHandler } from "./handler";

import { issueRecoveryCode, verifyRecoveryCode } from "../../../server/auth/recovery";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { verifySession } from "../../../server/auth/session";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
} from "../../../server/auth/passkey";
import { createUser, getUserByEmail, type User } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../test/authenticator";
import { withTransaction, type Db } from "../../../server/db/index";
import { localAesKeyWrapper } from "../../../server/crypto/key-wrapper";
import { randomBytes } from "node:crypto";

// A frozen instant: the session is minted and verified at the same clock, so it is
// comfortably inside its idle/absolute windows with no wall-clock dependence.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The configured WebAuthn RP ID — passed through deps (never a module constant), so the
// "RP ID from config" discipline is exercised end to end.
const RP_ID = "warthog.com.au";

// The configured public origin the handler checks the request `Origin` against, and a
// foreign origin a cross-site request would carry.
const GOOD_ORIGIN = "https://warthog.com.au";
const FOREIGN_ORIGIN = "https://evil.example";

// The test KEK the account's data key is wrapped under. Recovery unwraps it once, to write
// its "account recovered" activity entry encrypted like every other entry.
const KEY_WRAPPER = localAesKeyWrapper(randomBytes(32));

// Build the handler under test with the real seams and the test fakes. Recovery drives
// the recovery/passkey/session modules only — it issues no email and creates no account,
// so there is no emailSender / keyWrapper in the bundle.
// The HMAC key the email one-time code is stored under (issue and verify share it).
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-recover-hmac-key-0123456789abcd", "utf8"));

// The handler under test, with the outbox its email codes and alerts land in attached,
// so a test reads the emailed code exactly as the person would.
function makeHandler(db: Db, clock: Clock = fixedClock(T0), outbox: Outbox = createOutbox()) {
  const handler = createRecoverHandler({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    emailSender: outbox,
    keyWrapper: KEY_WRAPPER,
    rpId: RP_ID,
    publicOrigin: GOOD_ORIGIN,
  });
  return Object.assign(handler, { outbox });
}

// The emails the outbox holds for one address, in send order.
function emailsTo(outbox: Outbox, recipient: string) {
  return outbox.list().filter((m) => m.channel === "email" && m.recipient === recipient);
}

// The newest one-time code emailed to `email` (a standalone six-digit run in the body).
function emailedCode(outbox: Outbox, email: string): string {
  const latest = emailsTo(outbox, email)
    .map((m) => m.body.match(/(?<!\d)\d{6}(?!\d)/)?.[0])
    .filter((c): c is string => c !== undefined)
    .at(-1);
  assert.ok(latest, `identify must email a one-time code to ${email}`);
  return latest;
}

// A six-digit code that is not `code`.
function wrongEmailCode(code: string): string {
  return (code[0] === "0" ? "1" : "0") + code.slice(1);
}

// A JSON POST request carrying an `Origin` header. `origin: null` sends no Origin at all
// (the cross-site / no-origin case). A raw string body is sent verbatim (for malformed
// JSON); anything else is JSON-encoded.
function recoverRequest(body: unknown, origin: string | null = GOOD_ORIGIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request("https://warthog.com.au/api/recover", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Create a genuine account with a current recovery code, and return the user plus the
// plaintext code the person would have saved at sign-up (the "old" code recovery
// replaces). Distinct labels keep emails unique within a test.
async function seedAccount(db: Db, label: string): Promise<{ user: User; recoveryCode: string }> {
  const user = await createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: await KEY_WRAPPER.wrap(randomBytes(32)) });
  const { code } = await issueRecoveryCode(db, user.id, { random: systemRandom });
  return { user, recoveryCode: code };
}

// A genuinely different recovery code of the SAME 26-char base32 shape: flip the first
// character. It stays well-formed, so verifyCode exercises the hash comparison (a real
// wrong guess), not an input-format rejection at the boundary.
function wrongCode(code: string): string {
  const first = code[0] === "A" ? "B" : "A";
  return first + code.slice(1);
}

// The session token the browser would hold, pulled out of the `Set-Cookie` the finish
// step emits (the host-locked `__Host-wh_session` cookie, value up to the first `;`).
function sessionTokenFromCookie(setCookie: string | null): string {
  assert.ok(setCookie, "the finish step must set a session cookie");
  assert.ok(
    setCookie.startsWith("__Host-wh_session="),
    `the session cookie must be the host-locked __Host-wh_session cookie: ${JSON.stringify(setCookie)}`,
  );
  return setCookie.slice("__Host-wh_session=".length).split(";")[0]!;
}

// How many member-scoped rows this person has in `table` — the "is anyone signed in /
// does a passkey exist" probe, filtered by the account id (parameterized, as feature
// code must be).
async function countFor(db: Db, table: "sessions" | "passkeys", userId: string): Promise<number> {
  const result = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
  return Number(result.rows[0]?.n ?? -1);
}

// Step 1 — identify by email over the good origin and return the pending recovery's
// handle. Asserts the step itself succeeded so a later step fails for the right reason.
async function startIdentify(handler: ReturnType<typeof makeHandler>, email: string): Promise<string> {
  const res = await handler.identify(recoverRequest({ email }));
  assert.equal(res.status, 200, "identify accepts an existing account's email and starts recovery");
  const body = (await res.json()) as { recoveryId: string };
  assert.equal(typeof body.recoveryId, "string", "identify hands back a recovery handle");
  assert.ok(body.recoveryId.length > 0, "the recovery handle is non-empty");
  return body.recoveryId;
}

// Step 1b — identify, then verify the one-time code identify emailed, returning the
// handle of a recovery whose email is proven.
async function throughVerifyEmail(handler: ReturnType<typeof makeHandler>, email: string): Promise<string> {
  const recoveryId = await startIdentify(handler, email);
  const code = emailedCode(handler.outbox, email);
  const res = await handler.verifyEmail(recoverRequest({ recoveryId, code }));
  assert.equal(res.status, 200, "the emailed one-time code is accepted");
  return recoveryId;
}

// Steps 1–2 — identify, verify the email code, then verify the recovery code, returning
// the handle plus the passkey registration options the valid codes unlock.
async function throughVerifyCode(
  handler: ReturnType<typeof makeHandler>,
  email: string,
  recoveryCode: string,
): Promise<{ recoveryId: string; registrationOptions: PublicKeyCredentialCreationOptionsJSON }> {
  const recoveryId = await throughVerifyEmail(handler, email);

  const res = await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode }));
  assert.equal(res.status, 200, "a valid recovery code is accepted");
  const body = (await res.json()) as { registrationOptions: PublicKeyCredentialCreationOptionsJSON };
  assert.equal(
    body.registrationOptions.rp.id,
    RP_ID,
    "the registration options carry the configured RP ID (from config, not hard-coded)",
  );
  assert.equal(
    typeof body.registrationOptions.challenge,
    "string",
    "the registration options carry a server-issued challenge",
  );
  return { recoveryId, registrationOptions: body.registrationOptions };
}

// Steps 1–3 — through registering the new passkey, returning the handle plus the NEW
// recovery code shown once. Asserts the register step succeeded.
async function throughRegisterPasskey(
  handler: ReturnType<typeof makeHandler>,
  auth: SoftwareAuthenticator,
  email: string,
  recoveryCode: string,
): Promise<{ recoveryId: string; newRecoveryCode: string }> {
  const { recoveryId, registrationOptions } = await throughVerifyCode(handler, email, recoveryCode);

  const registrationResponse: RegistrationResponseJSON = await auth.register(registrationOptions);
  const res = await handler.registerPasskey(recoverRequest({ recoveryId, registrationResponse }));
  assert.equal(res.status, 200, "a valid attestation registers the new passkey");
  const body = (await res.json()) as { recoveryCode: string };
  assert.equal(typeof body.recoveryCode, "string", "the new recovery code is shown once");
  assert.ok(body.recoveryCode.length > 0, "the new recovery code is non-empty");
  return { recoveryId, newRecoveryCode: body.recoveryCode };
}

test("rotating a recovery code invalidates an older verified recovery before it can add a passkey", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const { user, recoveryCode } = await seedAccount(db, "revoked-recovery");
    const pending = await throughVerifyCode(handler, user.email, recoveryCode);
    const registrationResponse = await createAuthenticator().register(pending.registrationOptions);
    const replacement = await issueRecoveryCode(db, user.id, { random: systemRandom });

    const result = await handler.registerPasskey(recoverRequest({ recoveryId: pending.recoveryId, registrationResponse }));
    assert.equal(result.status, 400);
    assert.equal(await countFor(db, "passkeys", user.id), 0, "a revoked proof must not create a durable sign-in factor");
    assert.equal(await verifyRecoveryCode(db, user.id, replacement.code), true, "the owner's replacement code survives");
    assert.equal((await handler.finish(recoverRequest({ recoveryId: pending.recoveryId }))).status, 400);
    assert.equal(await countFor(db, "sessions", user.id), 0);
  } finally { await db.close(); }
});

test("two pending recoveries using the same code cannot both register after one rotates it", async () => {
  const db = await freshDb();
  try {
    const { user, recoveryCode } = await seedAccount(db, "competing-recoveries");
    const first = makeHandler(db);
    const second = makeHandler(db, fixedClock(new Date(T0.getTime() + 60_000)));
    const a = await throughVerifyCode(first, user.email, recoveryCode);
    const b = await throughVerifyCode(second, user.email, recoveryCode);
    const responseA = await createAuthenticator().register(a.registrationOptions);
    const responseB = await createAuthenticator().register(b.registrationOptions);

    const results = await Promise.all([
      first.registerPasskey(recoverRequest({ recoveryId: a.recoveryId, registrationResponse: responseA })),
      second.registerPasskey(recoverRequest({ recoveryId: b.recoveryId, registrationResponse: responseB })),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
    assert.equal(await countFor(db, "passkeys", user.id), 1);
    const winner = await results.find((result) => result.status === 200)!.json() as { recoveryCode: string };
    assert.equal(await verifyRecoveryCode(db, user.id, winner.recoveryCode), true);
    assert.equal(await verifyRecoveryCode(db, user.id, recoveryCode), false);
  } finally { await db.close(); }
});

test("a failed recovery-code replacement rolls back the newly registered passkey", async () => {
  const db = await freshDb();
  try {
    const { user, recoveryCode } = await seedAccount(db, "recovery-rollback");
    const failing: Db = {
      query: (text, values) => db.query(text, values),
      transaction: (fn) => withTransaction(db, (tx) => fn({
        ...tx,
        query: (text, values) => text.includes("INSERT INTO recovery_codes")
          ? Promise.reject(new Error("synthetic recovery-code failure")) : tx.query(text, values),
      })),
      close: async () => {},
    };
    const handler = makeHandler(failing);
    const pending = await throughVerifyCode(handler, user.email, recoveryCode);
    const registrationResponse = await createAuthenticator().register(pending.registrationOptions);
    await assert.rejects(handler.registerPasskey(recoverRequest({ recoveryId: pending.recoveryId, registrationResponse })),
      /synthetic recovery-code failure/);
    assert.equal(await countFor(db, "passkeys", user.id), 0);
    assert.equal(await verifyRecoveryCode(db, user.id, recoveryCode), true);
    assert.equal((await handler.finish(recoverRequest({ recoveryId: pending.recoveryId }))).status, 400);
  } finally { await db.close(); }
});

test("duplicate passkey registration on one recovery cannot invalidate its successful completion", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const { user, recoveryCode } = await seedAccount(db, "duplicate-recovery");
    const pending = await throughVerifyCode(handler, user.email, recoveryCode);
    const registrationResponse = await createAuthenticator().register(pending.registrationOptions);
    const results = await Promise.all([
      handler.registerPasskey(recoverRequest({ recoveryId: pending.recoveryId, registrationResponse })),
      handler.registerPasskey(recoverRequest({ recoveryId: pending.recoveryId, registrationResponse })),
    ]);
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.equal(await countFor(db, "passkeys", user.id), 1);
    assert.equal((await handler.finish(recoverRequest({ recoveryId: pending.recoveryId }))).status, 303);
  } finally { await db.close(); }
});

// =====================================================================================
// AC1 — the happy path: identify → recovery code → new passkey → new code (shown) →
// finish → signed in. No session until the new passkey is registered; the old code dies
// and the new one lives; and the person lands on /home.
// =====================================================================================

test("recovery: a valid code + a new passkey ends in a session and a 303 to /home, replacing the old recovery code", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock);
    const auth = createAuthenticator();
    const { user, recoveryCode: oldCode } = await seedAccount(db, "recoverer");

    const { recoveryId, newRecoveryCode } = await throughRegisterPasskey(
      handler,
      auth,
      user.email,
      oldCode,
    );

    // The new code shown is genuinely new, and still nobody is signed in — the session is
    // minted only at finish.
    assert.notEqual(newRecoveryCode, oldCode, "recovery issues a fresh code, not the old one");
    assert.equal(await countFor(db, "sessions", user.id), 0, "no session exists before finishing");

    // Finish: mint the session and send the person to /home (AC1).
    const finishRes = await handler.finish(recoverRequest({ recoveryId }));
    assert.ok(
      finishRes.status >= 300 && finishRes.status < 400,
      `finishing recovery must redirect, got ${finishRes.status}`,
    );
    assert.equal(finishRes.headers.get("location"), "/home", "on success the person is redirected to /home");

    // The Set-Cookie is a real, verifiable session for the recovered account.
    const token = sessionTokenFromCookie(finishRes.headers.get("set-cookie"));
    const session = await verifySession(db, token, { clock });
    assert.ok(session, "the issued session token verifies");
    assert.equal(session.userId, user.id, "the session belongs to the recovered person");

    // The old recovery code is dead and the new one is live — recovery replaced it.
    assert.equal(
      await verifyRecoveryCode(db, user.id, oldCode),
      false,
      "after recovery the OLD recovery code no longer verifies",
    );
    assert.equal(
      await verifyRecoveryCode(db, user.id, newRecoveryCode),
      true,
      "the NEW recovery code shown during recovery verifies against the account",
    );
  } finally {
    await db.close();
  }
});

test("recovery: the newly registered passkey authenticates the person (the new second factor is real)", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock);
    const auth = createAuthenticator();
    const { user, recoveryCode: oldCode } = await seedAccount(db, "passkey-recoverer");

    const { recoveryId } = await throughRegisterPasskey(handler, auth, user.email, oldCode);
    const finishRes = await handler.finish(recoverRequest({ recoveryId }));
    assert.ok(finishRes.status >= 300 && finishRes.status < 400, "finishing recovery redirects");

    // Drive a real WebAuthn authentication with the SAME authenticator that registered
    // during recovery: the new credential was persisted for the account and verifies.
    const options = await beginPasskeyAuthentication(db, { userId: user.id }, { rpId: RP_ID });
    const assertion = await auth.authenticate(options);
    const result = await finishPasskeyAuthentication(
      db,
      { userId: user.id, response: assertion },
      { rpId: RP_ID },
    );
    assert.equal(result.ok, true, "the passkey registered during recovery authenticates the person");
  } finally {
    await db.close();
  }
});

test("recovery: finishing without registering a new passkey mints no session (the new second factor is required)", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock);
    const { user, recoveryCode: oldCode } = await seedAccount(db, "no-passkey-recoverer");

    // Verify the recovery code (so the options are issued) but DO NOT register a passkey.
    const { recoveryId } = await throughVerifyCode(handler, user.email, oldCode);

    const res = await handler.finish(recoverRequest({ recoveryId }));
    assert.ok(
      res.status >= 400 && res.status < 500,
      `finishing with no new passkey is refused with a 4xx, got ${res.status}`,
    );
    assert.equal(await countFor(db, "sessions", user.id), 0, "no session is minted without a new passkey");
    assert.equal(await countFor(db, "passkeys", user.id), 0, "no passkey was registered");
    assert.equal(
      await verifyRecoveryCode(db, user.id, oldCode),
      true,
      "the old recovery code still works — recovery did not complete, so nothing was replaced",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — a wrong recovery code is a 4xx: no session, no new passkey, the old code lives.
// =====================================================================================

test("recovery: a wrong recovery code is a 4xx — no session, no new passkey, and the old code still works", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock);
    const { user, recoveryCode: oldCode } = await seedAccount(db, "wrong-code");

    const recoveryId = await throughVerifyEmail(handler, user.email);

    // A well-formed but wrong code, over a valid Origin, so the ONLY reason to reject is
    // the code itself.
    const res = await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode: wrongCode(oldCode) }));
    assert.ok(res.status >= 400 && res.status < 500, `a wrong recovery code is a 4xx, got ${res.status}`);

    assert.equal(await countFor(db, "sessions", user.id), 0, "a wrong code mints no session");
    assert.equal(await countFor(db, "passkeys", user.id), 0, "a wrong code registers no passkey");
    assert.equal(
      await verifyRecoveryCode(db, user.id, oldCode),
      true,
      "a wrong guess does not replace the account's current recovery code",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — every step verifies Origin (missing or foreign → 403, changes nothing).
// =====================================================================================

test("recovery: identify and verify-code refuse a missing or foreign Origin (403) and change nothing", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock);
    const { user, recoveryCode: oldCode } = await seedAccount(db, "origin-early");

    // identify: a foreign Origin and a missing Origin are both forbidden.
    assert.equal(
      (await handler.identify(recoverRequest({ email: user.email }, FOREIGN_ORIGIN))).status,
      403,
      "identify from a foreign Origin is forbidden",
    );
    assert.equal(
      (await handler.identify(recoverRequest({ email: user.email }, null))).status,
      403,
      "identify with no Origin is forbidden",
    );

    // Start a real recovery over the good origin (its email code verified) so verify-code
    // has a handle to target.
    const recoveryId = await throughVerifyEmail(handler, user.email);

    // verify-code: the SAME valid code, so the ONLY reason to reject is the Origin.
    assert.equal(
      (await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode: oldCode }, FOREIGN_ORIGIN))).status,
      403,
      "verify-code from a foreign Origin is forbidden",
    );
    assert.equal(
      (await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode: oldCode }, null))).status,
      403,
      "verify-code with no Origin is forbidden",
    );

    // Nothing changed: no session, no passkey, the old code still works.
    assert.equal(await countFor(db, "sessions", user.id), 0, "a cross-site attempt mints no session");
    assert.equal(await countFor(db, "passkeys", user.id), 0, "a cross-site attempt registers no passkey");
    assert.equal(
      await verifyRecoveryCode(db, user.id, oldCode),
      true,
      "a cross-site attempt does not touch the recovery code",
    );

    // The good-origin verify-code still works — the only blocker above was the Origin.
    const ok = await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode: oldCode }));
    assert.equal(ok.status, 200, "the same code over the good Origin is accepted");
  } finally {
    await db.close();
  }
});

test("recovery: register-passkey and finish refuse a missing or foreign Origin (403) and change nothing", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock);
    const auth = createAuthenticator();
    const { user, recoveryCode: oldCode } = await seedAccount(db, "origin-late");

    // Reach a code-verified recovery over the good origin and produce a valid attestation.
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, user.email, oldCode);
    const registrationResponse = await auth.register(registrationOptions);

    // register-passkey: the SAME valid attestation, so the ONLY reason to reject is Origin.
    assert.equal(
      (await handler.registerPasskey(recoverRequest({ recoveryId, registrationResponse }, FOREIGN_ORIGIN))).status,
      403,
      "register-passkey from a foreign Origin is forbidden",
    );
    assert.equal(
      (await handler.registerPasskey(recoverRequest({ recoveryId, registrationResponse }, null))).status,
      403,
      "register-passkey with no Origin is forbidden",
    );
    // Nothing changed: no passkey stored, the old recovery code is untouched (no new one issued).
    assert.equal(await countFor(db, "passkeys", user.id), 0, "a cross-site register stores no passkey");
    assert.equal(
      await verifyRecoveryCode(db, user.id, oldCode),
      true,
      "a cross-site register does not issue a replacement recovery code",
    );

    // The good-origin register-passkey still works — the only blocker above was Origin.
    const registered = await handler.registerPasskey(recoverRequest({ recoveryId, registrationResponse }));
    assert.equal(registered.status, 200, "the same attestation over the good Origin registers the passkey");

    // finish: a foreign or missing Origin mints no session.
    assert.equal(
      (await handler.finish(recoverRequest({ recoveryId }, FOREIGN_ORIGIN))).status,
      403,
      "finish from a foreign Origin is forbidden",
    );
    assert.equal(
      (await handler.finish(recoverRequest({ recoveryId }, null))).status,
      403,
      "finish with no Origin is forbidden",
    );
    assert.equal(await countFor(db, "sessions", user.id), 0, "a cross-site finish mints no session");

    // The good-origin finish still redirects — the only blocker above was the Origin.
    const finished = await handler.finish(recoverRequest({ recoveryId }));
    assert.ok(
      finished.status >= 300 && finished.status < 400,
      `the good-Origin finish must redirect, got ${finished.status}`,
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — validate-and-parameterize: 4xx on bad input, and a SQL-injection probe is bound.
// =====================================================================================

test("recovery: identify and verify-code reject malformed or mis-shaped input with a 4xx (never a 500)", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);

    // All carry a valid Origin, so the ONLY reason to reject is the input itself.
    const badIdentify: unknown[] = ["{ not valid json at all", {}, { email: 123 }];
    for (const body of badIdentify) {
      const res = await handler.identify(recoverRequest(body));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad identify input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }

    const badVerify: unknown[] = ["{ not valid json", {}, { recoveryId: 5, recoveryCode: [] }];
    for (const body of badVerify) {
      const res = await handler.verifyCode(recoverRequest(body));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad verify-code input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("recovery: an oversized body is rejected with a 4xx before any work", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);

    // A schema-valid shape padded past any reasonable body cap (~2 MiB). The size guard
    // must reject it with a 4xx rather than process it.
    const huge = { email: "huge@warthog.com.au", pad: "x".repeat(2 * 1024 * 1024) };
    const res = await handler.identify(recoverRequest(huge));
    assert.ok(res.status >= 400 && res.status < 500, `an oversized body must be a 4xx, got ${res.status}`);
  } finally {
    await db.close();
  }
});

test("recovery: a SQL-injection probe in the email field is bound as data and cannot alter a query", async () => {
  const clock = fixedClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock);

    // A real account with a recovery code exists; if the probe below were concatenated
    // into SQL rather than bound, the trailing statement would drop the users table and
    // take this row with it.
    const { user: survivor, recoveryCode: survivorCode } = await seedAccount(db, "survivor");

    // Fire the classic injection probe through the email field with a valid Origin. It is
    // handled (never an uncontrolled 500): whether rejected at the validation boundary or
    // reaching the query bound as a parameter, it never runs as SQL.
    const probe = "robert'); DROP TABLE users; --@warthog.com.au";
    const res = await handler.identify(recoverRequest({ email: probe }));
    assert.ok(res.status < 500, `the probe must be handled, not crash the server (got ${res.status})`);

    // The injection did NOT execute: the users table still exists and still holds the
    // baseline account, its recovery code still verifies, and the recovery_codes table is
    // intact.
    assert.equal(
      (await getUserByEmail(db, survivor.email))?.id,
      survivor.id,
      "the baseline account survived — the probe was data, not SQL",
    );
    assert.equal(
      await verifyRecoveryCode(db, survivor.id, survivorCode),
      true,
      "the baseline account's recovery code still verifies — its row survived",
    );
    await db.query("SELECT 1 FROM recovery_codes LIMIT 1");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B5 — a pending recovery expires, so an abandoned one is forgotten.
// =====================================================================================

test("recovery: a pending recovery expires after thirty minutes and its handle stops working", async () => {
  let now = T0.getTime();
  const clock: Clock = { now: () => new Date(now) };
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock);
    const { user, recoveryCode } = await seedAccount(db, "expired-recovery");
    const recoveryId = await throughVerifyEmail(handler, user.email);

    now += 31 * 60 * 1000;
    const res = await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode }));
    assert.equal(res.status, 400, "an expired pending recovery is unknown");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B2 — recovery is "email code plus recovery code" (brief): the recovery code
// alone no longer takes over an account, each step requires the one before it, and the
// owner is told when their account is recovered.
// =====================================================================================

test("recovery: identify emails a code to an existing account only, and answers both cases identically", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const { user } = await seedAccount(db, "known-recoverer");
    const unknownEmail = "nobody-here@warthog.com.au";

    const known = await handler.identify(recoverRequest({ email: user.email }));
    const unknown = await handler.identify(recoverRequest({ email: unknownEmail }));
    assert.equal(known.status, unknown.status, "the same status whether or not the account exists");
    assert.deepEqual(
      Object.keys((await known.json()) as object),
      Object.keys((await unknown.json()) as object),
      "the same body shape whether or not the account exists",
    );
    assert.equal(emailsTo(handler.outbox, user.email).length, 1, "the account holder is emailed one code");
    assert.equal(emailsTo(handler.outbox, unknownEmail).length, 0, "no email goes to an address with no account");
  } finally {
    await db.close();
  }
});

test("recovery: the correct recovery code without the email code is refused — no options, no session, old code intact", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const { user, recoveryCode } = await seedAccount(db, "no-email-code");
    const recoveryId = await startIdentify(handler, user.email);

    const res = await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode }));
    assert.ok(res.status >= 400 && res.status < 500, `verify-code before the email code is a 4xx, got ${res.status}`);
    const body = (await res.json()) as { registrationOptions?: unknown };
    assert.equal(body.registrationOptions, undefined, "no passkey registration is offered");

    const finished = await handler.finish(recoverRequest({ recoveryId }));
    assert.ok(finished.status >= 400 && finished.status < 500, "finish mints nothing");
    assert.equal(finished.headers.get("set-cookie"), null, "no session cookie");
    assert.equal(await countFor(db, "sessions", user.id), 0, "no session exists");
    assert.equal(await verifyRecoveryCode(db, user.id, recoveryCode), true, "the old recovery code still works");
  } finally {
    await db.close();
  }
});

test("recovery: a wrong email code is refused and leaves the recovery code step locked", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const { user, recoveryCode } = await seedAccount(db, "wrong-email-code");
    const recoveryId = await startIdentify(handler, user.email);
    const code = emailedCode(handler.outbox, user.email);

    const wrong = await handler.verifyEmail(recoverRequest({ recoveryId, code: wrongEmailCode(code) }));
    assert.equal(wrong.status, 400, "a wrong email code is a 400");
    const locked = await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode }));
    assert.ok(locked.status >= 400 && locked.status < 500, "the recovery code is still not accepted");
  } finally {
    await db.close();
  }
});

test("recovery: register-passkey is refused on a recovery whose recovery code never verified", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const auth = createAuthenticator();
    const { user } = await seedAccount(db, "skipped-recovery-code");
    const recoveryId = await throughVerifyEmail(handler, user.email);

    // A registration challenge for the account exists (as one left by any earlier
    // ceremony would), but this recovery never proved the recovery code.
    const options = await beginPasskeyRegistration(
      db,
      { userId: user.id, userName: user.email },
      { rpId: RP_ID, origin: GOOD_ORIGIN },
    );
    const registrationResponse = await auth.register(options);
    const res = await handler.registerPasskey(recoverRequest({ recoveryId, registrationResponse }));
    assert.ok(res.status >= 400 && res.status < 500, `register-passkey is a 4xx, got ${res.status}`);
    assert.equal(await countFor(db, "passkeys", user.id), 0, "no passkey was added");
  } finally {
    await db.close();
  }
});

// Sign-in audit (founder decision 13 November 2026): the alert goes out when the new
// passkey is saved, so an abandoned recovery is still reported; finish sends nothing.
test("recovery: saving the new passkey emails the account holder an alert that carries no code", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const auth = createAuthenticator();
    const { user, recoveryCode } = await seedAccount(db, "alerted-recoverer");
    const { recoveryId: verifiedId, registrationOptions } = await throughVerifyCode(handler, user.email, recoveryCode);
    const before = emailsTo(handler.outbox, user.email).length;

    const registered = await handler.registerPasskey(
      recoverRequest({ recoveryId: verifiedId, registrationResponse: await auth.register(registrationOptions) }),
    );
    assert.equal(registered.status, 200);
    const { recoveryCode: newRecoveryCode } = (await registered.json()) as { recoveryCode: string };

    const after = emailsTo(handler.outbox, user.email);
    assert.equal(after.length, before + 1, "exactly one alert is sent to the account holder");
    const res = await handler.finish(recoverRequest({ recoveryId: verifiedId }));
    assert.equal(res.status, 303);
    assert.equal(emailsTo(handler.outbox, user.email).length, before + 1, "finishing sends nothing more");
    const alert = after.at(-1)!.body;
    assert.match(alert, /recover/i, "the alert says the account was recovered");
    assert.ok(!alert.includes(newRecoveryCode) && !alert.includes(recoveryCode), "the alert carries no recovery code");
    assert.ok(!/(?<!\d)\d{6}(?!\d)/.test(alert), "the alert carries no one-time code");
  } finally {
    await db.close();
  }
});

test("recovery: an alert that cannot be delivered does not undo a completed recovery", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    let failSends = false;
    const flaky = Object.assign(Object.create(outbox) as Outbox, {
      async sendEmail(message: { recipient: string; body: string }) {
        if (failSends) throw new Error("email provider down");
        return outbox.sendEmail(message);
      },
    });
    const handler = Object.assign(
      createRecoverHandler({
        db,
        clock: fixedClock(T0),
        random: systemRandom,
        hmacKey: HMAC_KEY,
        emailSender: flaky,
        keyWrapper: KEY_WRAPPER,
        rpId: RP_ID,
        publicOrigin: GOOD_ORIGIN,
      }),
      { outbox },
    );
    const auth = createAuthenticator();
    const { user, recoveryCode } = await seedAccount(db, "flaky-alert");
    const { recoveryId, registrationOptions } = await throughVerifyCode(handler, user.email, recoveryCode);

    failSends = true;
    const registered = await handler.registerPasskey(
      recoverRequest({ recoveryId, registrationResponse: await auth.register(registrationOptions) }),
    );
    assert.equal(registered.status, 200, "the passkey step still succeeds when the alert can't be sent");
    assert.equal(await countFor(db, "passkeys", user.id), 1, "and the new passkey is kept");
    const res = await handler.finish(recoverRequest({ recoveryId }));
    assert.equal(res.status, 303, "the recovery still completes");
    assert.ok(res.headers.get("set-cookie"), "and the session is still issued");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B3 — the recovery code has an attempt limit per recovery.
// =====================================================================================

test("recovery: after five wrong recovery codes the recovery is closed, even to the correct code", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const { user, recoveryCode } = await seedAccount(db, "guesser");
    const recoveryId = await throughVerifyEmail(handler, user.email);

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode: wrongCode(recoveryCode) }));
      statuses.push(res.status);
    }
    assert.equal(statuses.at(-1), 429, "the fifth wrong code closes the recovery (429)");

    const sixth = await handler.verifyCode(recoverRequest({ recoveryId, recoveryCode }));
    assert.ok(sixth.status >= 400 && sixth.status < 500, `the correct code is now refused, got ${sixth.status}`);
    const body = (await sixth.json()) as { registrationOptions?: unknown };
    assert.equal(body.registrationOptions, undefined, "no registration is offered");
  } finally {
    await db.close();
  }
});

// Review fix B7 — the browser a person recovers on is marked as recognised.
test("recovery: finishing marks the browser as one the person signs in on", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const { user, recoveryCode } = await seedAccount(db, "marked-recovery");
    const { recoveryId } = await throughRegisterPasskey(handler, createAuthenticator(), user.email, recoveryCode);
    const res = await handler.finish(recoverRequest({ recoveryId }));
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies[0]?.startsWith("__Host-wh_session="), "the session cookie comes first");
    assert.ok(cookies.some((c) => c.startsWith("__Host-wh_device=")), "the browser is marked");
  } finally {
    await db.close();
  }
});
