// E04-S19 — Passkey sign-in start must not reveal whether an account exists
// (`src/app/(auth)/signin/`).
//
// RED-first: these tests describe a behaviour the handler does NOT have yet. Today
// `beginPasskey` answers an UNKNOWN email with `401 { error: "unknown_account" }`
// and a REGISTERED email with `200 { options }` — the two outcomes are
// distinguishable, so an attacker can probe an email and learn from the status/body
// alone whether a Warthog account exists (the E04-S11 reviewer note: an
// account-enumeration oracle). The first test below asserts the FIXED behaviour
// (an unknown email gets the same 200 + same-shaped options a registered one does)
// and therefore fails against the current handler. Do NOT implement anything here to
// make it pass — the builder closes the oracle in `handler.ts` (and, if needed, the
// `auth` passkey seam) test-first.
//
// These tests pin BEHAVIOUR (the HTTP status, the body SHAPE an attacker can observe,
// and whether a session is minted), never the source text of the module — a later
// rename that preserves behaviour must not redden them. There is no browser, no Azure
// and no network: a person's account and their registered passkey are driven through
// the REAL sibling seams against an isolated in-memory PGlite (src/test/db), and a
// genuine WebAuthn assertion is produced by the software authenticator
// (src/test/authenticator), whose only non-test collaborator is the real
// @simplewebauthn/server verifier.
//
// Why a sibling `handler.ts` (not `actions.ts` or `page.tsx`): a Next "use server"
// actions file may export only async server actions, and a `page.tsx` entry file only
// its framework fields — neither can carry an injectable, unit-testable factory
// without breaking `next build`. So the testable seam lives in the plain sibling
// module (`handler.ts`, the convention's `createXHandler({ db })` pattern); these
// tests drive that seam directly with fakes.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 beginPasskey for an UNKNOWN email returns 200 with options whose keys and
//       types match the options returned for a REGISTERED email (so begin is an
//       indistinguishable oracle: an attacker cannot tell the two apart).
//   AC2 finishPasskey for an UNKNOWN email returns the SAME 401 body as a failed
//       assertion for a REGISTERED email, and creates no session.

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

import { createSigninHandler } from "./handler";

import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
} from "../../../server/auth/passkey";
import { createUser, getUserByEmail, type User } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

// A frozen instant: nothing here depends on wall-clock, but the handler needs a clock
// seam and sessions (if any were minted) would be stamped from it.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The configured WebAuthn RP ID — passed through deps (never a module constant), so
// the decoy options a non-existent account gets must still carry the configured RP ID.
const RP_ID = "warthog.com.au";

// The configured public origin the handler checks the request `Origin` against.
const GOOD_ORIGIN = "https://warthog.com.au";

// A placeholder wrapped-DEK reference; createUser stores it verbatim. We only need a
// genuine `users` row so a passkey can hang off a real userId.
const WRAPPED_DEK = "wrapped-dek-placeholder";

// The injected TOTP-secret store shape the handler declares in its deps. These tests
// never use TOTP, so the fake is always empty; it exists only to satisfy the bundle.
interface TotpSecretStore {
  get(userId: string): Promise<string | null>;
}

function emptyTotpSecrets(): TotpSecretStore {
  return {
    async get(): Promise<string | null> {
      return null;
    },
  };
}

// Build the handler under test with the real seams and the test fakes.
function makeHandler(db: Db, clock: Clock = fixedClock(T0)) {
  return createSigninHandler({
    db,
    clock,
    random: systemRandom,
    rpId: RP_ID,
    publicOrigin: GOOD_ORIGIN,
    totpSecrets: emptyTotpSecrets(),
  });
}

// A JSON POST request carrying the configured `Origin` (so the Origin check is never
// the reason a request is refused here — the behaviour under test is the account path).
function signinRequest(body: unknown): Request {
  return new Request("https://warthog.com.au/api/signin", {
    method: "POST",
    headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
    body: JSON.stringify(body),
  });
}

// Count the sessions currently stored. Each test uses its own freshly-migrated,
// isolated database, so a total count is the right "nobody is signed in" probe.
async function sessionCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM sessions");
  return Number(result.rows[0]?.n ?? -1);
}

// Create a genuine person row and return it. Distinct labels give distinct (unique)
// emails within a test.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// Register a passkey for `user` through the real begin → authenticator → finish path,
// so a credential exists and the account is a genuine, fully-registered one.
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

// A structural fingerprint of a value: its KEYS and the TYPE of each leaf, with every
// concrete value (challenges, timeouts, RP IDs, credential bytes) erased to its kind.
// Two values with the same fingerprint are indistinguishable in shape — exactly the
// "keys and types match" the acceptance criterion names — while differing in content.
// Object keys are sorted so key ORDER never affects the comparison.
type Shape = string | Shape[] | { [key: string]: Shape };

function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === "object") {
    const out: { [key: string]: Shape } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}

// =====================================================================================
// AC1 — beginPasskey is an indistinguishable oracle: an UNKNOWN email gets the same
// 200 + same-shaped authentication options a REGISTERED email gets. (Fails today: the
// current handler answers an unknown email with 401 { error: "unknown_account" }.)
// =====================================================================================

test("beginPasskey answers an unknown email exactly like a registered one (200, same option shape)", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const auth = createAuthenticator();

    // A genuine, fully-registered account.
    const known = await freshUser(db, "enum-known");
    await registerPasskeyFor(db, auth, known);

    // An email with no account at all.
    const unknownEmail = "enum-no-such-account@warthog.com.au";
    assert.equal(
      await getUserByEmail(db, unknownEmail),
      null,
      "precondition: the unknown email has no account",
    );

    const knownRes = await handler.beginPasskey(signinRequest({ email: known.email }));
    const unknownRes = await handler.beginPasskey(signinRequest({ email: unknownEmail }));

    // Same status: an unknown email must NOT be singled out with a different code.
    assert.equal(knownRes.status, 200, "a registered email begins with a 200");
    assert.equal(
      unknownRes.status,
      200,
      "an unknown email must ALSO begin with a 200 — no 401/unknown_account oracle",
    );

    const knownBody = (await knownRes.json()) as { options: PublicKeyCredentialRequestOptionsJSON };
    const unknownBody = (await unknownRes.json()) as {
      options: PublicKeyCredentialRequestOptionsJSON;
    };

    // Same top-level body keys (both `{ options }`) — no extra/missing field betrays
    // the account's existence.
    assert.deepEqual(
      Object.keys(unknownBody).sort(),
      Object.keys(knownBody).sort(),
      "the unknown-email response body has the same top-level keys",
    );
    assert.ok(unknownBody.options, "an unknown email still hands back authentication options");

    // Same option keys...
    assert.deepEqual(
      Object.keys(unknownBody.options).sort(),
      Object.keys(knownBody.options).sort(),
      "the authentication options have the same keys for an unknown and a registered email",
    );

    // ...and the same types throughout: a structural fingerprint that erases every
    // concrete value but preserves keys + kinds. Identical fingerprints mean the two
    // responses are indistinguishable in shape.
    assert.deepEqual(
      shapeOf(unknownBody.options),
      shapeOf(knownBody.options),
      "the option keys and value types match between an unknown and a registered email",
    );

    // The decoy options must still carry the CONFIGURED RP ID and a string challenge —
    // a differing/absent rpId would itself be an enumeration signal.
    assert.equal(unknownBody.options.rpId, RP_ID, "the decoy options carry the configured RP ID");
    assert.equal(
      typeof unknownBody.options.challenge,
      "string",
      "the decoy options carry a string challenge, like a registered email's",
    );

    // Begin never signs anyone in, for either email.
    assert.equal(await sessionCount(db), 0, "beginPasskey mints no session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — finishPasskey for an UNKNOWN email fails EXACTLY like a failed assertion for a
// REGISTERED email: the same 401 body, and no session. (A divergent body here would
// re-open the oracle at the finish step.)
// =====================================================================================

test("finishPasskey for an unknown email returns the same 401 body as a failed assertion, and no session", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const knownAuth = createAuthenticator();
    const otherAuth = createAuthenticator();

    // A registered account, plus a second account whose authenticator we use to sign a
    // genuine BUT wrong assertion (a credential the first account never registered).
    const known = await freshUser(db, "enum-finish-known");
    const other = await freshUser(db, "enum-finish-other");
    await registerPasskeyFor(db, knownAuth, known);
    await registerPasskeyFor(db, otherAuth, other);

    // Reach a real, shape-valid assertion that will FAIL to verify for `known`: begin
    // issues the challenge for `known`, but `otherAuth` signs it with a credential
    // `known` does not own.
    const beginRes = await handler.beginPasskey(signinRequest({ email: known.email }));
    assert.equal(beginRes.status, 200, "begin issues a challenge for the registered email");
    const { options } = (await beginRes.json()) as { options: PublicKeyCredentialRequestOptionsJSON };
    const assertionResponse: AuthenticationResponseJSON = await otherAuth.authenticate(options);

    // The baseline: a failed assertion for a REGISTERED email.
    const failedRes = await handler.finishPasskey(
      signinRequest({ email: known.email, authenticationResponse: assertionResponse }),
    );
    assert.equal(failedRes.status, 401, "a failed assertion for a registered email is a 401");
    const failedBody = await failedRes.json();

    // The case under test: the SAME shape-valid assertion against an email with no
    // account at all must look identical.
    const unknownEmail = "enum-finish-no-such-account@warthog.com.au";
    assert.equal(
      await getUserByEmail(db, unknownEmail),
      null,
      "precondition: the unknown email has no account",
    );
    const unknownRes = await handler.finishPasskey(
      signinRequest({ email: unknownEmail, authenticationResponse: assertionResponse }),
    );

    assert.equal(
      unknownRes.status,
      failedRes.status,
      "an unknown email finishes with the same status as a failed assertion (401)",
    );
    const unknownBody = await unknownRes.json();
    assert.deepEqual(
      unknownBody,
      failedBody,
      "an unknown email returns the SAME 401 body as a failed assertion — no distinguishable oracle",
    );

    assert.equal(await sessionCount(db), 0, "no finish here mints a session");
  } finally {
    await db.close();
  }
});
