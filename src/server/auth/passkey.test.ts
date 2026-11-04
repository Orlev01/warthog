// E04-S04 — Passkey registration and authentication (`src/server/auth/passkey.ts`,
// `db/migrations/0006_passkeys.sql`).
//
// RED-first: neither the passkey module nor the migration exists yet, so importing
// `./passkey` throws and `freshDb()` has no passkeys schema — every test here fails
// until the builder adds them. That absence IS the point of test-first; do NOT
// implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what begin/finish DO: the options they produce, what
// the REAL `@simplewebauthn/server` verifiers accept, and what is stored/rejected),
// never the source text of the module or the SQL file — a later rename that preserves
// behaviour must not redden them. The only non-test code the happy paths touch is the
// production `@simplewebauthn/server` library doing the verifying, driven end to end
// by the software authenticator helper (src/test/authenticator.ts) — no browser, no
// Azure, no network.
//
// The contract this task defines (design §5 "Passkeys via SimpleWebAuthn, RP ID
// warthog.com.au (from config), residentKey: required, userVerification: required,
// PRF requested on create and get"; §4.2; the builder implements exactly this):
//
//   PasskeyDeps = { readonly rpId: string }   // the configured WebAuthn RP ID
//     (from config.webauthnRpId). The verification origin is derived as
//     `https://<rpId>`. Passing a *different* rpId must flow through both begin and
//     finish — the RP ID is configuration, never a hard-coded constant.
//
//   PasskeyResult (a discriminated union on `ok`, like email-code's VerifyResult):
//       | { ok: true; credentialId: string }   // verified; the stored credential's id
//       | { ok: false; reason: string }        // any verification/ownership/replay failure
//     finish NEVER throws for an expected rejection — it returns { ok: false } (the
//     same discipline verifyEmailCode / verifySession follow).
//
//   beginPasskeyRegistration(db, { userId, userName }, deps)
//       : Promise<PublicKeyCredentialCreationOptionsJSON>
//     • options.rp.id === deps.rpId
//     • options.authenticatorSelection.residentKey === "required"
//     • options.authenticatorSelection.userVerification === "required"
//     • options.extensions.prf is present (PRF requested on create)
//     • persists the registration challenge server-side for userId, so finish can
//       verify the attestation against the challenge it issued.
//
//   finishPasskeyRegistration(db, { userId, response }, deps): Promise<PasskeyResult>
//     • verifies the attestation with expectedRPID = deps.rpId and
//       expectedOrigin = `https://<deps.rpId>`.
//     • on success STORES the credential (id, public key, counter) for userId and
//       returns { ok: true, credentialId }; on any failure returns { ok: false }.
//
//   beginPasskeyAuthentication(db, { userId }, deps)
//       : Promise<PublicKeyCredentialRequestOptionsJSON>
//     • options.rpId === deps.rpId
//     • options.userVerification === "required"
//     • options.extensions.prf is present (PRF requested on get)
//     • persists the authentication challenge server-side for userId.
//
//   finishPasskeyAuthentication(db, { userId, response }, deps): Promise<PasskeyResult>
//     • verifies the assertion against the credential stored for userId; on success
//       updates the stored signature counter and returns { ok: true, credentialId }.
//     • REJECTS (ok:false) a credential that does not belong to userId (an other-user
//       or unknown credential), a tampered assertion (bad signature), and a replayed
//       assertion (a signature counter that does not advance).
//
// Acceptance criteria → tests:
//   AC1 "Registration verifies attestation with the configured RP ID, residentKey and
//        userVerification required and PRF requested, and stores the credential."
//        — begin produces options carrying exactly those settings; the RP ID is taken
//        from config (a different configured RP ID flows through end to end); a genuine
//        attestation verifies and the credential is stored (proven because it then
//        authenticates); an attestation made for a DIFFERENT RP ID is rejected (the
//        configured RP ID is enforced at verification, not ignored).
//   AC2 "Authentication verifies an assertion and rejects a wrong or other-user
//        credential; a replayed signature counter is rejected." — begin produces
//        options with the configured RP ID, userVerification required and PRF
//        requested; a genuine assertion for the user's own credential verifies; a
//        credential belonging to ANOTHER user is rejected; a tampered (bad-signature)
//        assertion is rejected; a replayed assertion (counter does not advance) is
//        rejected; two legitimate, counter-advancing authentications both verify (a
//        real advance is not mistaken for a replay).
//   Migration: 0006_passkeys applies and a second run of every migration changes
//        nothing (idempotent).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and its own authenticator, so tests share no state. Tests never touch
// the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  beginPasskeyAuthentication,
  finishPasskeyAuthentication,
} from "./passkey";
import { freshDb } from "../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../test/authenticator";
import { createUser, type User } from "../db/users";
import { loadMigrations, runMigrations, type Db } from "../db/index";

// Design §5 / constraint own-domain: the WebAuthn site identity is warthog.com.au,
// set from config. These tests pass it through `deps` (never a hard-coded constant in
// the module) so the "from config" part of the AC is exercised, not assumed.
const RP_ID = "warthog.com.au";
const deps = { rpId: RP_ID };

// A placeholder wrapped-DEK reference: `createUser` stores it verbatim (opaque to the
// app). Its value is irrelevant here — we only need a real `users` row so a passkey
// can hang off a genuine userId (the account id every member-scoped row references).
const WRAPPED_DEK = "wrapped-dek-placeholder";

// Create a genuine person row and return it, so a passkey is registered against a real
// userId. Distinct labels give distinct (unique) emails within a test.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// Register a passkey for `user` through the module's own begin → authenticator →
// finish path, asserting the round trip verified, and return the stored credential id.
// This is the shared setup for the authentication tests: a credential registered here
// is the one authentication later signs with.
async function registerPasskey(
  db: Db,
  auth: SoftwareAuthenticator,
  user: User,
): Promise<string> {
  const options = await beginPasskeyRegistration(
    db,
    { userId: user.id, userName: user.email },
    deps,
  );
  const response = await auth.register(options);
  const result = await finishPasskeyRegistration(db, { userId: user.id, response }, deps);
  if (!result.ok) {
    assert.fail(`setup registration must verify: ${JSON.stringify(result)}`);
  }
  return result.credentialId;
}

// Drive one authentication for `user` end to end (begin → authenticator → finish),
// optionally overriding the options handed to the authenticator (used to point the
// authenticator at a DIFFERENT credential while keeping the user's own stored
// challenge — the only way to isolate the other-user ownership check).
async function authenticateOnce(
  db: Db,
  auth: SoftwareAuthenticator,
  user: User,
  override?: (options: PublicKeyCredentialRequestOptionsJSON) => PublicKeyCredentialRequestOptionsJSON,
): Promise<{ response: AuthenticationResponseJSON; result: Awaited<ReturnType<typeof finishPasskeyAuthentication>> }> {
  const options = await beginPasskeyAuthentication(db, { userId: user.id }, deps);
  const response = await auth.authenticate(override ? override(options) : options);
  const result = await finishPasskeyAuthentication(db, { userId: user.id, response }, deps);
  return { response, result };
}

// Corrupt an assertion's signature while leaving its DER structure well-formed:
// decode the signature, flip the low bit of its last byte, re-encode. The result is a
// structurally valid but WRONG ECDSA signature, so a genuine verifier returns
// verified:false — proving the module checks real crypto, not a rubber stamp.
function tamperSignature(response: AuthenticationResponseJSON): AuthenticationResponseJSON {
  const bytes = new Uint8Array(isoBase64URL.toBuffer(response.response.signature));
  bytes[bytes.length - 1] ^= 0x01;
  return {
    ...response,
    response: { ...response.response, signature: isoBase64URL.fromBuffer(bytes) },
  };
}

// =====================================================================================
// AC1 — registration: configured RP ID + residentKey/UV required + PRF requested,
// and the credential is stored.
// =====================================================================================

test("beginPasskeyRegistration requests residentKey + userVerification required, PRF, and the configured RP ID", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "reg-options");
    const options: PublicKeyCredentialCreationOptionsJSON = await beginPasskeyRegistration(
      db,
      { userId: user.id, userName: user.email },
      deps,
    );

    assert.equal(options.rp.id, RP_ID, "the registration options carry the configured RP ID");
    assert.equal(
      options.authenticatorSelection?.residentKey,
      "required",
      "registration requires a resident (discoverable) key",
    );
    assert.equal(
      options.authenticatorSelection?.userVerification,
      "required",
      "registration requires user verification",
    );
    assert.ok(
      options.extensions?.prf != null,
      "registration must request the PRF extension (vault-unlock seed, design §4.2)",
    );
  } finally {
    await db.close();
  }
});

test("the RP ID is taken from configuration — a different configured RP ID flows through end to end", async () => {
  const db = await freshDb();
  try {
    // A deliberately different RP ID: if the module hard-coded warthog.com.au this
    // round trip would not line up (begin's options and finish's expectedRPID must be
    // the SAME configured value for the attestation to verify).
    const otherDeps = { rpId: "example.test" };
    const auth = createAuthenticator();
    const user = await freshUser(db, "configurable-rp");

    const options = await beginPasskeyRegistration(
      db,
      { userId: user.id, userName: user.email },
      otherDeps,
    );
    assert.equal(options.rp.id, "example.test", "the options reflect the injected RP ID");

    const response = await auth.register(options);
    const result = await finishPasskeyRegistration(db, { userId: user.id, response }, otherDeps);
    assert.equal(
      result.ok,
      true,
      "a registration under a different configured RP ID still verifies (RP ID is configurable, not hard-coded)",
    );
  } finally {
    await db.close();
  }
});

test("finishPasskeyRegistration verifies a genuine attestation and stores a usable credential", async () => {
  const db = await freshDb();
  try {
    const auth = createAuthenticator();
    const user = await freshUser(db, "reg-store");

    const regOptions = await beginPasskeyRegistration(
      db,
      { userId: user.id, userName: user.email },
      deps,
    );
    const regResponse = await auth.register(regOptions);
    const reg = await finishPasskeyRegistration(db, { userId: user.id, response: regResponse }, deps);

    if (!reg.ok) assert.fail(`registration must verify a genuine attestation: ${JSON.stringify(reg)}`);
    assert.equal(reg.credentialId, regResponse.id, "the stored credential id is the one just registered");

    // "stores the credential" proven behaviourally: the stored credential (its public
    // key + counter) is what authentication reads back — a subsequent assertion for it
    // verifies. If nothing had been stored, this authentication could not succeed.
    const authOptions = await beginPasskeyAuthentication(db, { userId: user.id }, deps);
    const authResponse = await auth.authenticate(authOptions);
    const authResult = await finishPasskeyAuthentication(db, { userId: user.id, response: authResponse }, deps);

    if (!authResult.ok) assert.fail(`the stored credential must authenticate: ${JSON.stringify(authResult)}`);
    assert.equal(
      authResult.credentialId,
      regResponse.id,
      "authentication identifies the credential that registration stored",
    );
  } finally {
    await db.close();
  }
});

test("finishPasskeyRegistration rejects an attestation made for a different RP ID", async () => {
  const db = await freshDb();
  try {
    const auth = createAuthenticator();
    const user = await freshUser(db, "reg-wrong-rp");

    // Begin under the configured RP ID (so the stored challenge is the one finish
    // expects), then make the authenticator attest to a DIFFERENT RP ID. The authData's
    // rpIdHash (and the client-data origin) then disagree with the configured RP ID, so
    // the production verifier must refuse — proving the configured RP ID is enforced.
    const options = await beginPasskeyRegistration(
      db,
      { userId: user.id, userName: user.email },
      deps,
    );
    const wrongRp = { ...options, rp: { ...options.rp, id: "evil.example" } };
    const response = await auth.register(wrongRp);

    const result = await finishPasskeyRegistration(db, { userId: user.id, response }, deps);
    assert.equal(
      result.ok,
      false,
      "an attestation whose RP ID is not the configured one must not verify",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — authentication: verify a genuine assertion; reject wrong / other-user / replay.
// =====================================================================================

test("beginPasskeyAuthentication requests userVerification required, PRF, and the configured RP ID", async () => {
  const db = await freshDb();
  try {
    const auth = createAuthenticator();
    const user = await freshUser(db, "auth-options");
    await registerPasskey(db, auth, user);

    const options: PublicKeyCredentialRequestOptionsJSON = await beginPasskeyAuthentication(
      db,
      { userId: user.id },
      deps,
    );

    assert.equal(options.rpId, RP_ID, "the authentication options carry the configured RP ID");
    assert.equal(
      options.userVerification,
      "required",
      "authentication requires user verification",
    );
    assert.ok(
      options.extensions?.prf != null,
      "authentication must request the PRF extension on get (design §4.2, §5)",
    );
  } finally {
    await db.close();
  }
});

test("a genuine assertion for the user's own credential verifies", async () => {
  const db = await freshDb();
  try {
    const auth = createAuthenticator();
    const user = await freshUser(db, "auth-ok");
    const credentialId = await registerPasskey(db, auth, user);

    const { result } = await authenticateOnce(db, auth, user);
    if (!result.ok) assert.fail(`a genuine assertion must verify: ${JSON.stringify(result)}`);
    assert.equal(result.credentialId, credentialId, "the verified assertion is for the registered credential");
  } finally {
    await db.close();
  }
});

test("authentication rejects a credential that belongs to another user", async () => {
  const db = await freshDb();
  try {
    const authOwner = createAuthenticator();
    const authIntruder = createAuthenticator();
    const owner = await freshUser(db, "owner");
    const intruder = await freshUser(db, "intruder");

    await registerPasskey(db, authOwner, owner);
    const intruderCredId = await registerPasskey(db, authIntruder, intruder);

    // Start an authentication for the OWNER (so the owner's own challenge is the one
    // stored), but point the authenticator at the intruder's credential so it signs the
    // owner's challenge with a key the owner does not own. finish must reject it: the
    // presented credential is not one of the owner's, even though the signature itself
    // is cryptographically valid over the owner's challenge.
    const { result } = await authenticateOnce(db, authIntruder, owner, (options) => ({
      ...options,
      allowCredentials: [{ id: intruderCredId }],
    }));

    assert.equal(
      result.ok,
      false,
      "a credential belonging to another user must not authenticate this user",
    );
  } finally {
    await db.close();
  }
});

test("authentication rejects a tampered assertion (a corrupted signature)", async () => {
  const db = await freshDb();
  try {
    const auth = createAuthenticator();
    const user = await freshUser(db, "auth-tampered");
    await registerPasskey(db, auth, user);

    const options = await beginPasskeyAuthentication(db, { userId: user.id }, deps);
    const response = await auth.authenticate(options);
    const tampered = tamperSignature(response);

    const result = await finishPasskeyAuthentication(db, { userId: user.id, response: tampered }, deps);
    assert.equal(
      result.ok,
      false,
      "an assertion with a corrupted signature must not verify (the module checks real crypto)",
    );
  } finally {
    await db.close();
  }
});

test("authentication rejects a replayed assertion (its signature counter does not advance)", async () => {
  const db = await freshDb();
  try {
    const auth = createAuthenticator();
    const user = await freshUser(db, "auth-replay");
    await registerPasskey(db, auth, user);

    const options = await beginPasskeyAuthentication(db, { userId: user.id }, deps);
    const response = await auth.authenticate(options);

    const first = await finishPasskeyAuthentication(db, { userId: user.id, response }, deps);
    if (!first.ok) assert.fail(`the first authentication must verify: ${JSON.stringify(first)}`);

    // Replaying the very same assertion carries the very same (non-advancing) signature
    // counter — a captured-and-replayed sign-in. The server must refuse it.
    const replay = await finishPasskeyAuthentication(db, { userId: user.id, response }, deps);
    assert.equal(
      replay.ok,
      false,
      "replaying the same assertion must be rejected (the signature counter did not advance)",
    );
  } finally {
    await db.close();
  }
});

test("two legitimate, counter-advancing authentications both verify (a real advance is not a replay)", async () => {
  const db = await freshDb();
  try {
    const auth = createAuthenticator();
    const user = await freshUser(db, "auth-advance");
    await registerPasskey(db, auth, user);

    const first = await authenticateOnce(db, auth, user);
    assert.equal(first.result.ok, true, "the first authentication verifies");

    // A second, later sign-in: the authenticator reports a higher counter and the server
    // must accept the advance — forward progress is not mistaken for a replay.
    const second = await authenticateOnce(db, auth, user);
    assert.equal(
      second.result.ok,
      true,
      "a second authentication with an advanced counter also verifies",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Migration — 0006_passkeys applies and a second run changes nothing.
// =====================================================================================

test("the passkeys migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // The project migration set includes the passkeys migration (its recorded name is
    // the task's named deliverable, stable once applied).
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0006_passkeys"),
      "db/migrations/0006_passkeys.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0006's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing (idempotent).
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
