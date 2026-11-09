// E04-S22 — Sign-up SENDS the email code, and the passkey attestation shape is
// validated at the boundary.
//
// RED-first: the headline deliverable — a `sendCode(request)` step on the sign-up
// handler — does NOT exist yet, so every `handler.sendCode(...)` call below throws
// (the property is `undefined`) and `tsc` rejects the member access. That absence
// IS the point of test-first; do NOT implement anything to make these pass.
//
// Two things ship under this task (both proven here through BEHAVIOUR — the HTTP
// outcome and what ends up stored/sent — never the source text of the module, so a
// later rename that preserves behaviour must not redden it):
//
//   1. sendCode(request) — the step that actually delivers the first factor. Until
//      now `verifyEmail` checked a code that nothing ever sent. sendCode does the
//      Origin check, validates the body { email } at the boundary, then issues the
//      one-time code for that address (the real issueEmailCode → the email sender).
//      It answers the SAME 200 for any well-formed email, whether or not an account
//      already exists (no account-existence leak), and a missing/foreign Origin is
//      403 that sends nothing.
//
//   2. registerPasskey's registrationResponse is validated to the RegistrationResponseJSON
//      shape at the boundary (id/rawId strings, type "public-key", response.clientDataJSON
//      and response.attestationObject strings, EXTRA keys passed through to the verifier)
//      rather than the z.unknown() escape hatch — the same hatch that let a null assertion
//      crash sign-in (E04-S11). A null / non-object / mis-shaped attestation is a 4xx,
//      never a 500, and registers nothing; a well-formed one (even carrying extra keys)
//      still registers.
//
// The seam under test is the sibling `handler.ts` factory (`createSignupHandler`) —
// a Next "use server"/page entry file cannot carry an injectable factory without
// breaking `next build`, so the testable seam is this plain sibling; the thin
// actions/route verbs wrap it. There is no browser, no Azure and no network: the
// email code and the passkey round trip are driven through the REAL sibling seams
// against an isolated in-memory PGlite (src/test/db), and the WebAuthn attestation is
// produced by the software authenticator (src/test/authenticator), whose only
// non-test collaborator is the real @simplewebauthn/server verifier.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 sendCode with a valid Origin and a well-formed email returns 200 and the email
//       sender receives one message to that address containing the code; verifyEmail
//       with that code then succeeds.
//   AC2 sendCode returns the same status and body whether or not an account already
//       exists for the email, and a missing or foreign Origin is 403 and sends nothing.
//   AC3 registerPasskey with a null, non-object or mis-shaped registrationResponse
//       returns a 4xx, never a 500, and registers nothing (and a well-formed attestation
//       carrying extra keys still registers — the extra keys pass through).
//   AC4 a handler rejects malformed or oversized input with a 4xx, and a SQL-injection
//       probe in an input field cannot alter a query (parameter binding is used).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb() and createOutbox(). Emails, codes and signupIds are drawn from
// the REAL random seam so nothing collides across tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { createSignupHandler } from "./handler";

import { issueEmailCode } from "../../../server/auth/email-code";
import { createUser, getUserByEmail } from "../../../server/db/users";
import { localAesKeyWrapper } from "../../../server/crypto/key-wrapper";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { freshDb } from "../../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

// A frozen instant: the code is issued and verified at the same clock, comfortably
// inside its 10-minute window with no wall-clock dependence.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The configured WebAuthn RP ID — passed through deps (never a module constant).
const RP_ID = "warthog.com.au";

// The configured public origin the handler checks the request `Origin` against, and a
// foreign origin a cross-site request would carry.
const GOOD_ORIGIN = "https://warthog.com.au";
const FOREIGN_ORIGIN = "https://evil.example";

// One keyed HMAC for the email-code first factor: sendCode issues the code and
// verifyEmail verifies it under the SAME key, so the emailed code verifies.
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-signup-hmac-key-0123456789abcd", "utf8"));

// A local 256-bit KEK for the dev/test key wrapper. Its exact value is irrelevant here.
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

// The email messages the outbox recorded for `recipient` (scoped narrowly to one
// address so another test's / another address's mail never counts here).
function emailsTo(outbox: Outbox, recipient: string) {
  return outbox.list().filter((m) => m.channel === "email" && m.recipient === recipient);
}

// Seed a real account for `email` directly through the person data-access seam (a
// wrapped-DEK reference is opaque here), so the "account already exists" branch of
// sendCode can be exercised without driving the whole sign-up flow.
async function seedAccount(db: Db, email: string): Promise<void> {
  await createUser(db, { email, wrappedDek: "wrapped-dek-reference" });
}

// Reach a pending, email-verified sign-up (steps 1's output) WITHOUT sendCode: the
// code is issued through the real issuer directly, so these attestation-shape tests
// stand on their own even while sendCode is absent. Returns the pending handle and the
// registration options the authenticator needs to produce a real attestation.
async function startSignup(
  handler: ReturnType<typeof makeHandler>,
  db: Db,
  outbox: Outbox,
  email: string,
  clock: Clock,
): Promise<{ signupId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  await issueEmailCode(db, email, { purpose: "signup",
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    emailSender: outbox,
  });
  const delivered = emailsTo(outbox, email).at(-1);
  assert.ok(delivered, `issuing a code must deliver an email to ${email}`);
  const code = extractCode(delivered.body);

  const res = await handler.verifyEmail(signupRequest({ email, code }));
  assert.equal(res.status, 200, "a valid email code starts the sign-up");
  const started = (await res.json()) as {
    signupId: string;
    registrationOptions: PublicKeyCredentialCreationOptionsJSON;
  };
  return { signupId: started.signupId, options: started.registrationOptions };
}

// =====================================================================================
// AC1 — sendCode sends the first-factor code, and verifyEmail accepts exactly it.
// =====================================================================================

test("sendCode delivers one code email to the address, and verifyEmail accepts that code", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "newcomer@warthog.com.au";

    const res = await handler.sendCode(signupRequest({ email }));
    assert.equal(res.status, 200, "sendCode with a valid Origin and well-formed email returns 200");

    // Exactly one message, on the email channel, to that address.
    const mails = emailsTo(outbox, email);
    assert.equal(mails.length, 1, "the email sender receives exactly one message to that address");

    // The code that email carries is the one verifyEmail then accepts — i.e. sendCode
    // sent the very code the next step checks (previously nothing sent it).
    const code = extractCode(mails[0]!.body);
    const verifyRes = await handler.verifyEmail(signupRequest({ email, code }));
    assert.equal(verifyRes.status, 200, "verifyEmail succeeds with the code sendCode delivered");
    const started = (await verifyRes.json()) as { signupId?: unknown };
    assert.equal(typeof started.signupId, "string", "a verified code starts a sign-up");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — sendCode does not leak account existence (same status AND body either way), and
// the Origin gate refuses a cross-site / originless request without sending anything.
// =====================================================================================

test("sendCode answers identically whether or not an account already exists for the email", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const newEmail = "fresh-signup@warthog.com.au";
    const existingEmail = "already-a-member@warthog.com.au";
    await seedAccount(db, existingEmail);
    assert.ok(await getUserByEmail(db, existingEmail), "the existing-account branch really has an account");
    assert.equal(await getUserByEmail(db, newEmail), null, "the other address has no account");

    const resNew = await handler.sendCode(signupRequest({ email: newEmail }));
    const resExisting = await handler.sendCode(signupRequest({ email: existingEmail }));

    // Same status, same body — nothing in the response betrays whether the account exists.
    assert.equal(resNew.status, 200, "a well-formed email always answers 200");
    assert.equal(resExisting.status, resNew.status, "the status is the same whether or not an account exists");
    assert.equal(
      await resExisting.text(),
      await resNew.text(),
      "the body is the same whether or not an account exists (no account-existence leak)",
    );

    // The code is issued for the address in BOTH cases (the step is issueEmailCode for
    // that address, unconditionally).
    assert.equal(emailsTo(outbox, newEmail).length, 1, "a code is sent for the new address");
    assert.equal(emailsTo(outbox, existingEmail).length, 1, "a code is sent for the existing address too");
  } finally {
    await db.close();
  }
});

test("sendCode refuses a foreign or missing Origin with 403 and sends nothing", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const foreignEmail = "cross-site@warthog.com.au";
    const originlessEmail = "no-origin@warthog.com.au";

    // A well-formed body, so the ONLY reason to reject is the Origin.
    const foreign = await handler.sendCode(signupRequest({ email: foreignEmail }, FOREIGN_ORIGIN));
    assert.equal(foreign.status, 403, "a foreign Origin is forbidden");
    assert.equal(emailsTo(outbox, foreignEmail).length, 0, "a cross-site request sends no code");

    const originless = await handler.sendCode(signupRequest({ email: originlessEmail }, null));
    assert.equal(originless.status, 403, "a request with no Origin is forbidden");
    assert.equal(emailsTo(outbox, originlessEmail).length, 0, "an originless request sends no code");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 (sendCode) — validate-and-parameterize: 4xx on bad input, probe bound as data.
// =====================================================================================

test("sendCode rejects malformed and mis-shaped input with a 4xx (never a 500)", async () => {
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox);

    // Malformed JSON, and mis-shaped bodies — all carry a valid Origin, so the ONLY
    // reason to reject is the input itself.
    const badBodies: unknown[] = [
      "{ not valid json at all",
      {},
      { email: 123 },
      { email: [] },
      { email: null },
    ];
    for (const body of badBodies) {
      const res = await handler.sendCode(signupRequest(body));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("sendCode rejects an oversized body with a 4xx before doing any work", async () => {
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox);

    // A schema-valid shape padded past any reasonable body cap (~2 MiB).
    const huge = { email: "huge@warthog.com.au", pad: "x".repeat(2 * 1024 * 1024) };
    const res = await handler.sendCode(signupRequest(huge));
    assert.ok(res.status >= 400 && res.status < 500, `an oversized body must be a 4xx, got ${res.status}`);
    assert.equal(emailsTo(outbox, "huge@warthog.com.au").length, 0, "an oversized body sends nothing");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in sendCode's email field is bound as data and cannot alter a query", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);

    // A baseline code exists; if the probe below were concatenated into SQL rather than
    // bound, the trailing statement would drop the table and take this row with it.
    const safeEmail = "survivor@warthog.com.au";
    const baseline = await handler.sendCode(signupRequest({ email: safeEmail }));
    assert.equal(baseline.status, 200, "a baseline code is issued before the probe");
    const beforeCount = await emailCodeCount(db, safeEmail);
    assert.ok(beforeCount >= 1, "the baseline code row exists");

    // Fire the classic injection probe through the email field with a valid Origin.
    // Whether it is rejected at the validation boundary or bound as a query parameter,
    // it never runs as SQL and never crashes the server.
    const probe = "robert'); DROP TABLE email_codes; --@warthog.com.au";
    const res = await handler.sendCode(signupRequest({ email: probe }));
    assert.ok(res.status < 500, `the probe must be handled, not crash the server (got ${res.status})`);

    // The injection did NOT execute: the email_codes table still exists and still holds
    // the baseline row.
    await db.query("SELECT 1 FROM email_codes LIMIT 1");
    assert.ok(
      (await emailCodeCount(db, safeEmail)) >= beforeCount,
      "the baseline code survived — the probe was data, not SQL",
    );
  } finally {
    await db.close();
  }
});

// Count the email_codes rows for one address (bound as a parameter).
async function emailCodeCount(db: Db, email: string): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM email_codes WHERE email = $1", [email]);
  return Number(result.rows[0]?.n ?? -1);
}

// =====================================================================================
// AC3 — registerPasskey validates the attestation SHAPE at the boundary: a null /
// non-object / mis-shaped registrationResponse is a 4xx (never a 500) and registers
// nothing; a well-formed attestation carrying extra keys still registers.
// =====================================================================================

test("registerPasskey rejects a null / non-object / mis-shaped attestation with a 4xx (never a 500)", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const { signupId } = await startSignup(handler, db, outbox, "shape@warthog.com.au", clock);

    // Each is a registrationResponse that is NOT a well-formed RegistrationResponseJSON:
    // null, non-objects, and objects missing/mis-typing the required id/rawId/type and
    // response.clientDataJSON / response.attestationObject string fields.
    const badShapes: unknown[] = [
      null,
      123,
      "not-an-object",
      [],
      true,
      {},
      { id: "x", rawId: "x", type: "public-key", response: {} },
      { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "a" } },
      { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: 1, attestationObject: "b" } },
      { id: 1, rawId: "x", type: "public-key", response: { clientDataJSON: "a", attestationObject: "b" } },
      { id: "x", rawId: "x", type: "not-public-key", response: { clientDataJSON: "a", attestationObject: "b" } },
    ];

    for (const registrationResponse of badShapes) {
      const res = await handler.registerPasskey(signupRequest({ signupId, registrationResponse }));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `a mis-shaped attestation ${JSON.stringify(registrationResponse)} must be a 4xx, got ${res.status}`,
      );
      const body = (await res.json().catch(() => ({}))) as { recoveryCode?: unknown };
      assert.equal(body.recoveryCode, undefined, "a rejected attestation issues no recovery code");
    }

    // The registrationResponse key missing entirely is rejected the same way.
    const missing = await handler.registerPasskey(signupRequest({ signupId }));
    assert.ok(
      missing.status >= 400 && missing.status < 500,
      `a missing registrationResponse must be a 4xx, got ${missing.status}`,
    );
  } finally {
    await db.close();
  }
});

test("a rejected attestation registers nothing: the sign-up cannot then be completed", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const email = "nothing-registered@warthog.com.au";
    const { signupId } = await startSignup(handler, db, outbox, email, clock);

    const rejected = await handler.registerPasskey(
      signupRequest({ signupId, registrationResponse: null }),
    );
    assert.ok(rejected.status >= 400 && rejected.status < 500, "the mis-shaped attestation is refused");

    // Nothing was registered: confirm is refused (no second factor) and no account is
    // created — the bad attestation left no credential behind.
    const confirm = await handler.confirmSignup(signupRequest({ signupId, savedConfirmed: true }));
    assert.ok(
      confirm.status >= 400 && confirm.status < 500,
      `the sign-up cannot be completed after a rejected attestation, got ${confirm.status}`,
    );
    assert.equal(await getUserByEmail(db, email), null, "a rejected attestation creates no account");
  } finally {
    await db.close();
  }
});

test("a well-formed attestation carrying extra keys still registers (extra keys pass through)", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth: SoftwareAuthenticator = createAuthenticator();
    const { signupId, options } = await startSignup(handler, db, outbox, "extras@warthog.com.au", clock);

    // A genuine attestation, then decorated with extra keys the verifier does not know
    // about (top-level and nested in `response`). A boundary schema that strips or
    // rejects unknown keys would break this; the shape check must let them pass through.
    const genuine: RegistrationResponseJSON = await auth.register(options);
    const withExtras = {
      ...genuine,
      unexpectedTopLevel: "ignored-by-the-verifier",
      response: { ...genuine.response, unexpectedNested: "also-ignored" },
    };

    const res = await handler.registerPasskey(
      signupRequest({ signupId, registrationResponse: withExtras }),
    );
    assert.equal(res.status, 200, "a valid attestation with extra keys still registers");
    const issued = (await res.json()) as { recoveryCode?: unknown };
    assert.equal(typeof issued.recoveryCode, "string", "the recovery code is issued on success");
    assert.ok((issued.recoveryCode as string).length > 0, "the recovery code is non-empty");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B1 — send-code is throttled per address, so it cannot be used to flood an
// inbox or to keep many codes live at once.
// =====================================================================================

test("a second send-code for one address inside a minute is refused with 429 and sends nothing", async () => {
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, fixedClock(T0));
    const email = "flooded@warthog.com.au";

    const first = await handler.sendCode(signupRequest({ email }));
    assert.equal(first.status, 200);
    const second = await handler.sendCode(signupRequest({ email }));
    assert.equal(second.status, 429, "a repeat send inside the minute is throttled");
    assert.ok(Number(second.headers.get("retry-after")) > 0, "the refusal carries Retry-After");
    assert.equal(emailsTo(outbox, email).length, 1, "only the first code was emailed");

    // The first code is still the live one and verifies.
    const code = extractCode(emailsTo(outbox, email)[0]!.body);
    const verified = await handler.verifyEmail(signupRequest({ email, code }));
    assert.equal(verified.status, 200, "the code from the first send still verifies");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B5 — a pending sign-up expires, so an abandoned one is forgotten.
// =====================================================================================

test("a pending sign-up expires after thirty minutes: registering on it afterwards is refused", async () => {
  let now = T0.getTime();
  const clock: Clock = { now: () => new Date(now) };
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, clock);
    const auth = createAuthenticator();
    const { signupId, options } = await startSignup(handler, db, outbox, "slowcoach@warthog.com.au", clock);

    now += 31 * 60 * 1000;
    const registrationResponse = await auth.register(options);
    const res = await handler.registerPasskey(signupRequest({ signupId, registrationResponse }));
    assert.equal(res.status, 400, "an expired pending sign-up is unknown");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B8 — sign-up treats an address the same whatever its case or spacing.
// =====================================================================================

test("an address typed in another case is the same address: its code verifies and the account is stored lower-case", async () => {
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, outbox, fixedClock(T0));
    const sent = await handler.sendCode(signupRequest({ email: " Mixed.Case@Warthog.com.au " }));
    assert.equal(sent.status, 200);
    const code = extractCode(emailsTo(outbox, "mixed.case@warthog.com.au")[0]!.body);

    const verified = await handler.verifyEmail(signupRequest({ email: "MIXED.CASE@warthog.com.au", code }));
    assert.equal(verified.status, 200, "the code verifies under another spelling of the address");

    // An existing account under one spelling is found under another.
    await seedAccount(db, "Taken@Warthog.com.au");
    assert.ok(await getUserByEmail(db, "taken@warthog.com.au"), "stored and found lower-case");
  } finally {
    await db.close();
  }
});
