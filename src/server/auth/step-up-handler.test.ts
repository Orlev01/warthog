// E04-S36 — Confirm-it's-you (step-up) endpoints: the injectable step-up handler
// (`src/server/auth/step-up-handler.ts`).
//
// RED-first: `./step-up-handler` does not exist yet, so importing it throws and every
// test here fails until the builder adds it. That absence IS the point of test-first —
// do NOT implement anything to make these pass.
//
// A person already signed in must be able to re-confirm with their passkey before a
// sensitive change, without signing out and back in (brief: "Step-up check — a fresh
// passkey or authenticator confirmation (within the last 5 minutes)"; design §5). This
// task builds the PASSKEY step-up: a two-step round trip whose identity comes ONLY from
// the session cookie.
//
// These tests pin BEHAVIOUR (the HTTP outcome of begin/finish, and what ends up stored
// on the session — observed through the REAL session seam `verifySession`/`requireStepUp`),
// never the source text of the module — a later behaviour-preserving rename must not
// redden them. There is no browser, no Azure and no network: the person's account,
// passkeys and session are driven through the REAL seams (`createUser`, the passkey
// register/authenticate round trip via the software authenticator helper, `createSession`)
// against an isolated in-memory PGlite (src/test/db); the only non-test code the happy
// path trusts for the assertion is the production `@simplewebauthn/server` verifier.
//
// ─── The contract this task defines (the builder implements exactly this) ────────────
//
//   createStepUpHandler(deps): StepUpHandler            // { begin, finish }
//
//   deps (StepUpHandlerDeps):
//     { db: Db; clock: Clock; rpId: string; publicOrigin: string }
//       db          — the shared database (every query parameter-bound, INV-102)
//       clock       — judges session freshness and stamps the recorded step-up
//       rpId        — the configured WebAuthn RP ID (never hard-coded)
//       publicOrigin— the origin every request's Origin header is checked against, and
//                     the origin the assertion is verified at
//
//   begin(request): issues WebAuthn authentication options for the SIGNED-IN person
//     (identity resolved from the `__Host-wh_session` cookie). No/invalid session → 4xx.
//   finish(request): verifies the posted assertion ({ authenticationResponse }) against
//     that person's OWN passkeys and, on success, records a step-up on their CURRENT
//     session. An assertion that is not their own, or a request with no session, records
//     nothing and is a 4xx.
//
//   Every step checks Origin FIRST: a missing or foreign Origin is 403 and changes
//   nothing. The identity is NEVER read from the request body/query/path — only the
//   session cookie (constitution: member-scoped reads take userId from the session).
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 finish with a valid assertion from the signed-in person's own passkey records a
//       step-up on their current session; an assertion from another person's passkey, or
//       a request with no session, records nothing and is a 4xx.
//   AC2 every step checks Origin (a missing or foreign Origin is 403 and changes nothing).
//   AC3 the identity comes only from the session cookie.
//   AC4 [obligation:validate-and-parameterize-input] a handler rejects malformed or
//       oversized input with a 4xx, and a SQL-injection probe in an input field cannot
//       alter a query (parameter binding is used).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb(). Emails are tagged so accounts never collide on users.email.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createStepUpHandler } from "./step-up-handler";
import type { StepUpHandler, StepUpHandlerDeps } from "./step-up-handler";

import { createSession, verifySession, COOKIE_NAME } from "./session";
import { requireStepUp } from "./step-up";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyRegistration,
} from "./passkey";
import { createUser, type User } from "../db/users";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { createAuthenticator, type SoftwareAuthenticator } from "../../test/authenticator";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

// The WebAuthn site identity (from config in production) passed through deps, never a
// hard-coded constant in the module. GOOD_ORIGIN is chosen to equal `https://<RP_ID>`,
// so the default software authenticator's origin matches the verification origin.
const RP_ID = "warthog.com.au";
const GOOD_ORIGIN = "https://warthog.com.au";
const FOREIGN_ORIGIN = "https://evil.example";

// A frozen instant: the session is created, resolved and stepped up at the same clock,
// so it sits well inside its idle/absolute windows with no wall-clock dependence, and a
// recorded step-up reads as fresh at the same instant.
const T0 = new Date("2026-06-01T00:00:00.000Z");

// A placeholder wrapped-DEK reference; createUser stores it verbatim. Its value is
// irrelevant — we only need a genuine `users` row so passkeys and sessions hang off a
// real userId (the account id every member-scoped row filters by).
const WRAPPED_DEK = "wrapped-dek-placeholder";

// A random tag so accounts never collide on the users.email UNIQUE within a test.
function tag(): string {
  return Math.random().toString(36).slice(2);
}

// Build the handler under test. Each test uses its own db, so nothing leaks across tests.
function makeHandler(db: Db, publicOrigin: string = GOOD_ORIGIN): StepUpHandler {
  const deps: StepUpHandlerDeps = { db, clock: fixedClock(T0), rpId: RP_ID, publicOrigin };
  return createStepUpHandler(deps);
}

// A POST begin request. `token` (when given) is placed in a `__Host-wh_session` cookie
// BETWEEN two decoys, so the handler must pick the right value out of a real Cookie
// header. `origin: null` sends no Origin header; omitting `token` sends no cookie.
function beginRequest(
  { token, origin = GOOD_ORIGIN }: { token?: string | null; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  if (token != null) headers.cookie = `ab=decoy1; ${COOKIE_NAME}=${token}; cd=decoy2`;
  return new Request("https://warthog.com.au/api/auth/step-up/begin", { method: "POST", headers });
}

// A POST finish request carrying the assertion in its JSON body. A raw string body is
// sent verbatim (for malformed JSON); anything else is JSON-encoded.
function finishRequest(
  {
    token,
    origin = GOOD_ORIGIN,
    body,
  }: { token?: string | null; origin?: string | null; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  if (token != null) headers.cookie = `ab=decoy1; ${COOKIE_NAME}=${token}; cd=decoy2`;
  return new Request("https://warthog.com.au/api/auth/step-up/finish", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
}

// Create a genuine person row. Distinct labels + a tag give distinct (unique) emails.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}-${tag()}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// Register a passkey for `user` through the real begin → authenticator → finish path, so
// a credential the authenticator holds is one `user` genuinely owns. Origin/RP ID match
// the handler's (GOOD_ORIGIN === https://RP_ID), so the later step-up assertion verifies.
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
  if (!result.ok) assert.fail(`setup passkey registration must verify: ${JSON.stringify(result)}`);
}

// Drive the handler's begin for the session `token` and hand the issued options to
// `auth`, returning the assertion it produces. Asserts begin issued real options.
async function beginAndAuthenticate(handler: StepUpHandler, auth: SoftwareAuthenticator, token: string) {
  const res = await handler.begin(beginRequest({ token }));
  assert.equal(res.status, 200, "begin issues options for the signed-in person");
  const body = (await res.json()) as { options?: PublicKeyCredentialRequestOptionsJSON };
  assert.ok(body.options, "begin returns WebAuthn authentication options");
  return auth.authenticate(body.options);
}

// Read the step-up time currently stored on the session the `token` identifies, or null
// when the session is gone. Uses the SAME frozen clock, so it reads inside the window.
async function steppedUpAt(db: Db, token: string): Promise<Date | null> {
  const session = await verifySession(db, token, { clock: fixedClock(T0) });
  assert.ok(session, "the session under test still verifies");
  return session.steppedUpAt;
}

// =====================================================================================
// begin — issues authentication options for the signed-in person.
// =====================================================================================

test("begin issues WebAuthn authentication options for the signed-in person", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const person = await freshUser(db, "stepup-begin");
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    const res = await handler.begin(beginRequest({ token: created.token }));

    assert.equal(res.status, 200, "begin returns 200 for a signed-in person");
    const body = (await res.json()) as { options?: PublicKeyCredentialRequestOptionsJSON };
    assert.ok(body.options, "begin returns WebAuthn authentication options");
    assert.equal(body.options.rpId, RP_ID, "the options carry the configured RP ID (not hard-coded)");
  } finally {
    await db.close();
  }
});

test("begin with no session is a 4xx (there is no identity to issue a challenge for)", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const res = await handler.begin(beginRequest({ token: null }));
    assert.ok(
      res.status >= 400 && res.status < 500,
      `begin with no session cookie is a 4xx, got ${res.status}`,
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — finish with the signed-in person's OWN passkey records a step-up on their
// CURRENT session.
// =====================================================================================

test("finish with the person's own passkey assertion records a step-up on their current session", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const auth = createAuthenticator(); // default origin https://warthog.com.au === GOOD_ORIGIN
    const person = await freshUser(db, "stepup-own");
    await registerPasskeyFor(db, auth, person);
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    assert.equal(await steppedUpAt(db, created.token), null, "precondition: the session has no step-up yet");

    const assertion = await beginAndAuthenticate(handler, auth, created.token);
    const res = await handler.finish(
      finishRequest({ token: created.token, body: { authenticationResponse: assertion } }),
    );

    assert.ok(res.status < 400, `a valid own-passkey finish succeeds (not a 4xx/5xx), got ${res.status}`);

    const session = await verifySession(db, created.token, { clock: fixedClock(T0) });
    assert.ok(session, "the current session still verifies");
    assert.ok(session.steppedUpAt != null, "finish recorded a step-up on the current session");
    assert.equal(
      requireStepUp(session, { clock: fixedClock(T0) }),
      true,
      "the recorded step-up is fresh — a sensitive change is now allowed",
    );
  } finally {
    await db.close();
  }
});

test("finish records a step-up on the CURRENT session only — the person's other sessions are untouched", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const auth = createAuthenticator();
    const person = await freshUser(db, "stepup-current");
    await registerPasskeyFor(db, auth, person);

    const sessionOne = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });
    const sessionTwo = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    const assertion = await beginAndAuthenticate(handler, auth, sessionOne.token);
    const res = await handler.finish(
      finishRequest({ token: sessionOne.token, body: { authenticationResponse: assertion } }),
    );
    assert.ok(res.status < 400, `the step-up succeeds, got ${res.status}`);

    assert.notEqual(await steppedUpAt(db, sessionOne.token), null, "the session used to confirm is stepped up");
    assert.equal(
      await steppedUpAt(db, sessionTwo.token),
      null,
      "the person's OTHER session is not stepped up — the step-up is scoped to the current session",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 + AC3 — an assertion from ANOTHER person's passkey records nothing and is a 4xx;
// the identity is the session's, never the assertion's.
// =====================================================================================

test("finish with another person's passkey assertion records nothing and is a 4xx (identity is the session's)", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);

    // Person A is the signed-in person; B is someone else, with their own passkey.
    const personA = await freshUser(db, "stepup-victim");
    const personB = await freshUser(db, "stepup-intruder");
    const authB = createAuthenticator();
    await registerPasskeyFor(db, authB, personB);

    const createdA = await createSession(db, personA.id, { clock: fixedClock(T0), random: systemRandom });

    // begin as A issues A's challenge; B signs it with B's OWN credential. The identity
    // the handler acts on is A's (from the cookie), so B's credential is not A's.
    const assertionB = await beginAndAuthenticate(handler, authB, createdA.token);

    const res = await handler.finish(
      finishRequest({ token: createdA.token, body: { authenticationResponse: assertionB } }),
    );

    assert.ok(
      res.status >= 400 && res.status < 500,
      `an assertion that is not the signed-in person's own is a 4xx, got ${res.status}`,
    );
    const session = await verifySession(db, createdA.token, { clock: fixedClock(T0) });
    assert.equal(session?.steppedUpAt ?? null, null, "no step-up was recorded on the signed-in person's session");
    assert.equal(requireStepUp(session!, { clock: fixedClock(T0) }), false, "the session is still not stepped up");
  } finally {
    await db.close();
  }
});

test("finish with no session records nothing and is a 4xx — a body cannot supply the identity", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);

    // A real, well-formed assertion produced by a genuine signed-in flow, so the ONLY
    // thing the finish request below is missing is the session cookie.
    const person = await freshUser(db, "stepup-nosession");
    const auth = createAuthenticator();
    await registerPasskeyFor(db, auth, person);
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });
    const assertion = await beginAndAuthenticate(handler, auth, created.token);

    // Present that valid assertion with NO session cookie at all.
    const res = await handler.finish(finishRequest({ token: null, body: { authenticationResponse: assertion } }));
    assert.ok(
      res.status >= 400 && res.status < 500,
      `a finish with no session is a 4xx, got ${res.status}`,
    );

    // The person's session was NOT stepped up: identity comes only from the cookie, so a
    // body-supplied assertion cannot step up anyone's session without their session cookie.
    assert.equal(
      await steppedUpAt(db, created.token),
      null,
      "no step-up was recorded — identity comes only from the session cookie",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — every step checks Origin: a missing or foreign Origin is 403 and changes nothing.
// =====================================================================================

test("begin and finish refuse a foreign or missing Origin with 403 and change nothing", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const person = await freshUser(db, "stepup-origin");
    const auth = createAuthenticator();
    await registerPasskeyFor(db, auth, person);
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    // A genuine assertion, so the ONLY reason the finishes below are refused is the Origin.
    const assertion = await beginAndAuthenticate(handler, auth, created.token);

    for (const origin of [FOREIGN_ORIGIN, null] as const) {
      const label = origin ?? "missing";
      const beginRes = await handler.begin(beginRequest({ token: created.token, origin }));
      assert.equal(beginRes.status, 403, `begin with a ${label} Origin is 403`);

      const finishRes = await handler.finish(
        finishRequest({ token: created.token, origin, body: { authenticationResponse: assertion } }),
      );
      assert.equal(finishRes.status, 403, `finish with a ${label} Origin is 403`);
    }

    assert.equal(
      await steppedUpAt(db, created.token),
      null,
      "a cross-site request recorded no step-up — it changed nothing",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 [obligation:validate-and-parameterize-input] — malformed/oversized input is a 4xx
// (never a 500), and an injection probe in an input field is bound as data.
// =====================================================================================

test("[obligation:validate-and-parameterize-input] finish rejects malformed or mis-shaped input with a 4xx", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const person = await freshUser(db, "stepup-malformed");
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    // A valid session + Origin, so the only reason to reject is the body itself.
    const badBodies: unknown[] = [
      "{ not valid json at all",
      {},
      { authenticationResponse: null },
      { authenticationResponse: "not-an-object" },
      { authenticationResponse: 123 },
      { authenticationResponse: {} },
    ];
    for (const body of badBodies) {
      const res = await handler.finish(finishRequest({ token: created.token, body }));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad input ${JSON.stringify(body)} must be a 4xx (never a 500), got ${res.status}`,
      );
    }
    assert.equal(await steppedUpAt(db, created.token), null, "malformed input records no step-up");
  } finally {
    await db.close();
  }
});

test("[obligation:validate-and-parameterize-input] an oversized finish body is a 4xx before any work", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const person = await freshUser(db, "stepup-oversize");
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    // A body padded past any reasonable cap (~2 MiB), carrying a valid session + Origin.
    const huge = { authenticationResponse: { pad: "x".repeat(2 * 1024 * 1024) } };
    const res = await handler.finish(finishRequest({ token: created.token, body: huge }));
    assert.ok(res.status >= 400 && res.status < 500, `an oversized body must be a 4xx, got ${res.status}`);
  } finally {
    await db.close();
  }
});

test("[obligation:validate-and-parameterize-input] a SQL-injection probe in the session cookie is bound as data and cannot alter a query", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);

    // A baseline signed-in person whose session must survive the probe.
    const person = await freshUser(db, "stepup-survivor");
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });
    assert.ok(await verifySession(db, created.token, { clock: fixedClock(T0) }), "baseline session exists before the probe");

    // The classic injection probe as the presented session token. Bound as data (hashed,
    // parameterized) it matches no session; it never runs as SQL and never crashes.
    const probe = "robert'); DROP TABLE sessions; --";
    const res = await handler.begin(beginRequest({ token: probe }));
    assert.ok(res.status < 500, `the probe must be handled, not crash the server (got ${res.status})`);
    assert.ok(res.status >= 400, `a probe token names no session, so begin is a 4xx (got ${res.status})`);

    // The injection did NOT execute: the table still exists and the baseline session survives.
    await db.query("SELECT 1 FROM sessions LIMIT 1");
    assert.ok(
      await verifySession(db, created.token, { clock: fixedClock(T0) }),
      "the baseline session survived — the token was data, not SQL",
    );
  } finally {
    await db.close();
  }
});

test("[obligation:validate-and-parameterize-input] a SQL-injection probe in the assertion's credential id is bound as data", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const person = await freshUser(db, "stepup-credprobe");
    const auth = createAuthenticator();
    await registerPasskeyFor(db, auth, person);
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    // A real assertion whose credential id is replaced with the injection probe. Bound as
    // a parameter in the ownership lookup (WHERE credential_id = $n), it matches no row.
    const real = await beginAndAuthenticate(handler, auth, created.token);
    const probe = "robert'); DROP TABLE passkeys; --";
    const tampered = { ...real, id: probe, rawId: probe };

    const res = await handler.finish(finishRequest({ token: created.token, body: { authenticationResponse: tampered } }));
    assert.ok(res.status < 500, `the probe must be handled, not crash the server (got ${res.status})`);
    assert.ok(res.status >= 400, `a credential id that is not the person's own is rejected (got ${res.status})`);

    // The injection did NOT execute and no step-up was recorded.
    await db.query("SELECT 1 FROM passkeys LIMIT 1");
    assert.equal(
      await steppedUpAt(db, created.token),
      null,
      "a rejected assertion records no step-up; the probe was data, not SQL",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B4 — a sign-in assertion never counts as a step-up, and a step-up
// assertion cannot be replayed to stamp a fresh step-up again.
// =====================================================================================

test("a sign-in assertion posted to step-up finish is refused and records nothing", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const auth = createAuthenticator();
    const person = await freshUser(db, "stepup-purpose");
    await registerPasskeyFor(db, auth, person);
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    // A sign-in ceremony for the same person (as the sign-in page runs it).
    const signinOptions = await beginPasskeyAuthentication(db, { userId: person.id }, { rpId: RP_ID });
    const signinAssertion = await auth.authenticate(signinOptions);
    await db.query(`UPDATE passkeys SET counter = 0 WHERE user_id = $1`, [person.id]);

    const res = await handler.finish(
      finishRequest({ token: created.token, body: { authenticationResponse: signinAssertion } }),
    );
    assert.equal(res.status, 401, "a sign-in assertion is not a step-up");
    assert.equal(await steppedUpAt(db, created.token), null, "no step-up was recorded");
  } finally {
    await db.close();
  }
});

test("a step-up assertion cannot be replayed", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const auth = createAuthenticator();
    const person = await freshUser(db, "stepup-replay");
    await registerPasskeyFor(db, auth, person);
    const created = await createSession(db, person.id, { clock: fixedClock(T0), random: systemRandom });

    const assertion = await beginAndAuthenticate(handler, auth, created.token);
    const first = await handler.finish(finishRequest({ token: created.token, body: { authenticationResponse: assertion } }));
    assert.equal(first.status, 200);
    await db.query(`UPDATE passkeys SET counter = 0 WHERE user_id = $1`, [person.id]);
    const replay = await handler.finish(finishRequest({ token: created.token, body: { authenticationResponse: assertion } }));
    assert.equal(replay.status, 401, "the consumed challenge refuses the replay");
  } finally {
    await db.close();
  }
});
