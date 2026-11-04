// E04-S03 — Software passkey authenticator test helper (`src/test/authenticator.ts`).
//
// RED-first: `src/test/authenticator.ts` does not exist yet, so importing
// `createAuthenticator` fails and every test here fails until the helper is built.
// That absence is the point of test-first — do NOT add the helper to make these pass;
// the builder does that.
//
// These tests pin BEHAVIOUR — what the software authenticator PRODUCES and whether the
// REAL `@simplewebauthn/server` verifiers accept it — never the helper's source text.
// The whole value of the helper (design §5, §4.2 and the "runnable artifact" notes) is
// that a passkey registration AND authentication, PRF included, can be driven end to end
// in a test with no browser, no Azure and no network: the only non-helper code these
// tests touch is the production `@simplewebauthn/server` library doing the verifying.
//
// Contract under test (the seam the builder implements):
//   createAuthenticator(): a stateful software authenticator standing in for a browser +
//   platform authenticator. It exposes two intent-named operations:
//     register(options)     — given the JSON from generateRegistrationOptions(), produce
//                             a real RegistrationResponseJSON (attestation).
//     authenticate(options) — given the JSON from generateAuthenticationOptions() for a
//                             credential it holds, produce a real AuthenticationResponseJSON
//                             (assertion).
//   The authenticator remembers each credential it registers (keypair, PRF secret, counter,
//   user handle), so a credential registered through register() is the one authenticate()
//   signs with — that persistence is what "exercise registration AND authentication" means.
//
// Design-anchored assumptions these tests rely on (technical-design §5, §4.2):
//   - RP ID is `warthog.com.au`; the site is served over https from that host, so the
//     authenticator's client-data origin is `https://warthog.com.au` (derived from the RP ID
//     in the options — the test passes no separate origin). The contract is: whatever the
//     options' rp.id / rpId is, the produced response verifies against `https://<that id>`.
//   - residentKey + userVerification are "required", so the authenticator sets the UP and UV
//     flags (the verifiers default to requireUserPresence/requireUserVerification = true) and
//     a resident (discoverable) credential returns its user handle on assertion.
//   - PRF: the request asks for `extensions.prf.eval.first = <32-byte salt>`; the produced
//     response surfaces the PRF output at `clientExtensionResults.prf.results.first`, exactly
//     where WebAuthn L3 / the design put it. PRF "counts as present only when results.first
//     actually comes back", and it is obtained on the get() (authenticate) call.
//
// Acceptance criteria exercised:
//   AC1: register() produces a real attestation object that SimpleWebAuthn verifies.
//   AC2: authenticate() produces a real assertion object that SimpleWebAuthn verifies, and it
//        carries a PRF result (results.first) usable as a wrapping-key seed.
//   AC3: a passkey registration and authentication run entirely in-test, end to end.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";

import { createAuthenticator } from "./authenticator";

// --- The minimal structural contract these tests depend on -------------------------
// Kept narrow on purpose: only `createAuthenticator`, `register` and `authenticate`.
interface SoftwareAuthenticator {
  register(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  authenticate(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
}

const RP_ID = "warthog.com.au";
const RP_NAME = "Warthog";
const ORIGIN = `https://${RP_ID}`;

// A 32-byte PRF salt (design: `salt_v1` is a fixed per-person 32-byte salt). Distinct
// `fill` bytes give distinct salts without any randomness, so PRF determinism is testable.
function salt(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

// A known, non-random user id so the assertion's user handle can be checked back.
function userId(label: string): Uint8Array {
  return new TextEncoder().encode(`warthog-person-${label}`);
}

// Coerce whatever encoding the PRF result arrives in (raw bytes, an ArrayBuffer view, or a
// base64url string — all faithful transports for `results.first`) to bytes, or null if the
// PRF result is absent. Narrowly scoped to the one field under test.
function prfFirstBytes(
  response: RegistrationResponseJSON | AuthenticationResponseJSON,
): Uint8Array | null {
  const first: unknown = response.clientExtensionResults?.prf?.results?.first;
  if (first == null) return null;
  if (first instanceof Uint8Array) return first;
  if (first instanceof ArrayBuffer) return new Uint8Array(first);
  if (ArrayBuffer.isView(first)) {
    return new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  }
  if (typeof first === "string") return isoBase64URL.toBuffer(first);
  throw new Error("PRF results.first was not bytes, an ArrayBuffer view or a base64url string");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Register a passkey through the REAL server options + verify path, returning the stored
// credential (as the server would keep it) alongside the raw response.
async function registerPasskey(
  auth: SoftwareAuthenticator,
  opts: { user: Uint8Array; prfSalt: Uint8Array },
): Promise<{ response: RegistrationResponseJSON; credential: WebAuthnCredential; options: PublicKeyCredentialCreationOptionsJSON }> {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: "person@warthog.com.au",
    userID: opts.user,
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    extensions: { prf: { eval: { first: opts.prfSalt } } },
  });

  const response = await auth.register(options);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });

  if (!verification.verified) {
    throw new Error("registration response did not verify");
  }
  return { response, credential: verification.registrationInfo.credential, options };
}

// Authenticate an existing credential through the REAL server options + verify path.
async function authenticatePasskey(
  auth: SoftwareAuthenticator,
  credential: WebAuthnCredential,
  opts: { prfSalt: Uint8Array },
): Promise<{
  response: AuthenticationResponseJSON;
  verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: [{ id: credential.id }],
    userVerification: "required",
    extensions: { prf: { eval: { first: opts.prfSalt } } },
  });

  const response = await auth.authenticate(options);

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential,
  });

  return { response, verification, options };
}

// A verification that returns false instead of throwing — used only to prove a tampered
// input is REJECTED (a bad signature returns verified:false; a mismatched challenge/origin
// throws). Either way the response must not be accepted.
async function verifiesOrFalse(
  options: Parameters<typeof verifyAuthenticationResponse>[0],
): Promise<boolean> {
  try {
    return (await verifyAuthenticationResponse(options)).verified;
  } catch {
    return false;
  }
}

// --- AC1: real attestation that SimpleWebAuthn verifies ----------------------------

test("register() produces an attestation object that @simplewebauthn/server verifies", async () => {
  const auth: SoftwareAuthenticator = createAuthenticator();
  const { response, credential } = await registerPasskey(auth, { user: userId("a"), prfSalt: salt(1) });

  // The response is a real RegistrationResponseJSON (not a stub): it has the webauthn.create
  // shape and verification handed back a usable, server-storable credential.
  assert.equal(response.type, "public-key");
  assert.ok(response.id.length > 0, "attestation must carry a credential id");
  assert.equal(credential.id, response.id, "verified credential id matches the response id");
  assert.ok(credential.publicKey instanceof Uint8Array, "verification yields a stored public key");
  assert.equal(typeof credential.counter, "number", "verification yields a signature counter");
});

test("register() acknowledges the requested PRF extension", async () => {
  const auth: SoftwareAuthenticator = createAuthenticator();
  const { response } = await registerPasskey(auth, { user: userId("prf-create"), prfSalt: salt(7) });

  const prf = response.clientExtensionResults?.prf;
  assert.ok(prf, "registration response must report the prf extension it was asked for");
  // Faithful to the design note "many authenticators only report `enabled` on create": either
  // an explicit enabled flag or an actual result counts as acknowledgement.
  const acknowledged = prf.enabled === true || prfFirstBytes(response) !== null;
  assert.ok(acknowledged, "registration must report PRF enabled (or return a PRF result)");
});

// --- AC2 + AC3: real assertion, PRF result, full end-to-end flow --------------------

test("a registered passkey authenticates: authenticate() produces an assertion @simplewebauthn/server verifies", async () => {
  const auth: SoftwareAuthenticator = createAuthenticator();

  // Register, then authenticate the SAME credential — the whole round trip in one test.
  const { credential } = await registerPasskey(auth, { user: userId("e2e"), prfSalt: salt(1) });
  const { response, verification } = await authenticatePasskey(auth, credential, { prfSalt: salt(1) });

  assert.equal(response.type, "public-key");
  assert.equal(response.id, credential.id, "assertion is for the credential that was registered");
  assert.equal(verification.verified, true, "the assertion must verify against the stored credential");
  assert.equal(
    verification.authenticationInfo.credentialID,
    credential.id,
    "verification identifies the registered credential",
  );
});

test("the assertion carries a PRF result usable as a wrapping-key seed", async () => {
  const auth: SoftwareAuthenticator = createAuthenticator();
  const { credential } = await registerPasskey(auth, { user: userId("prf"), prfSalt: salt(1) });
  const { response, verification } = await authenticatePasskey(auth, credential, { prfSalt: salt(1) });

  assert.equal(verification.verified, true, "a PRF assertion must still verify");
  const prf = prfFirstBytes(response);
  assert.ok(prf, "assertion must surface clientExtensionResults.prf.results.first");
  assert.ok(prf.length >= 32, "PRF output must be at least a 256-bit key seed");
});

test("the PRF result is deterministic for the same salt and credential", async () => {
  const auth: SoftwareAuthenticator = createAuthenticator();
  const { credential } = await registerPasskey(auth, { user: userId("det"), prfSalt: salt(1) });

  const first = prfFirstBytes((await authenticatePasskey(auth, credential, { prfSalt: salt(9) })).response);
  const again = prfFirstBytes((await authenticatePasskey(auth, credential, { prfSalt: salt(9) })).response);

  assert.ok(first && again, "both assertions must return a PRF result");
  assert.ok(
    bytesEqual(first, again),
    "same credential + same salt must yield the same PRF output (so the vault key is stable)",
  );
});

test("a different PRF salt yields a different PRF result for the same credential", async () => {
  const auth: SoftwareAuthenticator = createAuthenticator();
  const { credential } = await registerPasskey(auth, { user: userId("salts"), prfSalt: salt(1) });

  const withA = prfFirstBytes((await authenticatePasskey(auth, credential, { prfSalt: salt(1) })).response);
  const withB = prfFirstBytes((await authenticatePasskey(auth, credential, { prfSalt: salt(2) })).response);

  assert.ok(withA && withB, "both assertions must return a PRF result");
  assert.ok(!bytesEqual(withA, withB), "distinct salts must produce distinct PRF outputs");
});

test("a different passkey yields a different PRF result for the same salt", async () => {
  // PRF (hmac-secret) is per-credential, so two independently registered passkeys must not
  // share a PRF output — otherwise every account would wrap its vault with the same key.
  const authA: SoftwareAuthenticator = createAuthenticator();
  const authB: SoftwareAuthenticator = createAuthenticator();
  const { credential: credA } = await registerPasskey(authA, { user: userId("A"), prfSalt: salt(1) });
  const { credential: credB } = await registerPasskey(authB, { user: userId("B"), prfSalt: salt(1) });

  const prfA = prfFirstBytes((await authenticatePasskey(authA, credA, { prfSalt: salt(5) })).response);
  const prfB = prfFirstBytes((await authenticatePasskey(authB, credB, { prfSalt: salt(5) })).response);

  assert.ok(prfA && prfB, "both assertions must return a PRF result");
  assert.ok(!bytesEqual(prfA, prfB), "different credentials must produce different PRF outputs");
});

// --- The objects are real crypto, not rubber-stamps --------------------------------

test("the assertion is bound to its own credential's key — another credential's key rejects it", async () => {
  const authA: SoftwareAuthenticator = createAuthenticator();
  const authB: SoftwareAuthenticator = createAuthenticator();
  const { credential: credA } = await registerPasskey(authA, { user: userId("real-a"), prfSalt: salt(1) });
  const { credential: credB } = await registerPasskey(authB, { user: userId("real-b"), prfSalt: salt(1) });

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: [{ id: credA.id }],
    userVerification: "required",
  });
  const response = await authA.authenticate(options);

  // Correct key: must verify. Wrong key (credB's public key under credA's id): must NOT.
  assert.equal(
    await verifiesOrFalse({
      response,
      expectedChallenge: options.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: credA,
    }),
    true,
    "a genuine assertion verifies against its own credential key",
  );
  assert.equal(
    await verifiesOrFalse({
      response,
      expectedChallenge: options.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: { ...credA, publicKey: credB.publicKey },
    }),
    false,
    "the assertion must not verify under a different credential's public key (real signature)",
  );
});

test("the same credential authenticates repeatedly, counter carried forward each time", async () => {
  // Proves the flow is stateful and replay-safe: the server updates the stored counter from
  // one assertion and the next assertion still verifies (never trips the counter regression).
  const auth: SoftwareAuthenticator = createAuthenticator();
  let { credential } = await registerPasskey(auth, { user: userId("counter"), prfSalt: salt(1) });

  const first = await authenticatePasskey(auth, credential, { prfSalt: salt(1) });
  assert.equal(first.verification.verified, true, "first authentication verifies");
  credential = { ...credential, counter: first.verification.authenticationInfo.newCounter };

  const second = await authenticatePasskey(auth, credential, { prfSalt: salt(1) });
  assert.equal(second.verification.verified, true, "second authentication verifies with the carried counter");
  assert.ok(
    second.verification.authenticationInfo.newCounter >= credential.counter,
    "the reported counter never goes backwards",
  );
});

test("a resident-key assertion returns the registered user handle", async () => {
  const auth: SoftwareAuthenticator = createAuthenticator();
  const user = userId("handle");
  const { credential, options } = await registerPasskey(auth, { user, prfSalt: salt(1) });
  const { response } = await authenticatePasskey(auth, credential, { prfSalt: salt(1) });

  assert.ok(response.response.userHandle, "a discoverable (resident) credential must return a user handle");
  assert.equal(
    response.response.userHandle,
    options.user.id,
    "the user handle must round-trip the id the credential was registered with",
  );
});
