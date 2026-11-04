// Passkeys: registration and authentication through SimpleWebAuthn (design §5, §4.2).
//
// A passkey is the preferred second factor and vault-unlock method. Each flow is two
// server round trips: `begin*` produces the options the browser hands the
// authenticator (and persists the challenge the server issued), and `finish*` verifies
// the authenticator's response against that challenge with the REAL
// `@simplewebauthn/server` verifiers — never a rubber stamp.
//
// The RP ID (warthog.com.au) is configuration, taken from `deps.rpId` (config's
// `webauthnRpId`) and never hard-coded, so the whole site identity moves with
// configuration. The verification origin is derived from it as `https://<rpId>`.
// residentKey and userVerification are required and the PRF extension is requested on
// both create and get (PRF is the vault-unlock seed).
//
// `finish*` never throws for an expected rejection: a failed attestation/assertion, a
// credential that is not the person's own, a tampered signature or a replayed
// (non-advancing) signature counter all return { ok: false, reason } — the same
// discipline verifyEmailCode / verifySession follow. Every member-scoped statement
// takes `userId` from the caller (the session's user id) and is parameterized
// (INV-102): the credential-id ownership check is `WHERE user_id = $1`, never an id
// read from the response.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";

import type { Db } from "../db/index";

// The configured WebAuthn RP ID (warthog.com.au in production). The verification
// origin is derived from it; a different configured value flows through begin and
// finish together.
export interface PasskeyDeps {
  readonly rpId: string;
}

// What finish reports back — a discriminated union on `ok`, like email-code's
// VerifyResult. A verified response names the stored credential; every rejection names
// its reason and never throws.
export type PasskeyResult =
  | { ok: true; credentialId: string }
  | { ok: false; reason: string };

// The friendly, user-visible relying-party name (the RP ID is the domain; this is the
// label shown in the authenticator prompt).
const RP_NAME = "Warthog";

// One outstanding challenge per person per purpose (see 0006_passkeys).
const PURPOSE_REGISTRATION = "registration";
const PURPOSE_AUTHENTICATION = "authentication";

// The verification origin is always `https://<rpId>` (passkeys are HTTPS-only).
function originFor(rpId: string): string {
  return `https://${rpId}`;
}

// Persist (and overwrite) the single outstanding challenge the server issued for this
// person and purpose, so finish can verify the response against the challenge WE sent.
async function storeChallenge(
  db: Db,
  userId: string,
  purpose: string,
  challenge: string,
): Promise<void> {
  await db.query(
    `INSERT INTO passkey_challenges (user_id, purpose, challenge)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, purpose)
     DO UPDATE SET challenge = EXCLUDED.challenge, created_at = now()`,
    [userId, purpose, challenge],
  );
}

// Read back the challenge the server issued for this person and purpose, or null when
// none is outstanding.
async function readChallenge(db: Db, userId: string, purpose: string): Promise<string | null> {
  const found = await db.query(
    `SELECT challenge FROM passkey_challenges WHERE user_id = $1 AND purpose = $2`,
    [userId, purpose],
  );
  const row = found.rows[0];
  return row ? (row.challenge as string) : null;
}

// Begin registration: build the creation options carrying the configured RP ID,
// residentKey + userVerification required and the PRF extension, and persist the
// registration challenge for `userId`.
export async function beginPasskeyRegistration(
  db: Db,
  params: { userId: string; userName: string },
  deps: PasskeyDeps,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: deps.rpId,
    userName: params.userName,
    userID: isoUint8Array.fromUTF8String(params.userId),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    // PRF requested on create (the vault-unlock seed, design §4.2).
    extensions: { prf: {} },
  });
  await storeChallenge(db, params.userId, PURPOSE_REGISTRATION, options.challenge);
  return options;
}

// Finish registration: verify the attestation against the configured RP ID / origin
// and the challenge the server issued, then store the credential (id, public key,
// counter) for `userId`. Returns { ok: true, credentialId } on success; any failure —
// an unexpected RP ID, a challenge we never issued, a bad attestation — returns
// { ok: false }.
export async function finishPasskeyRegistration(
  db: Db,
  params: { userId: string; response: RegistrationResponseJSON },
  deps: PasskeyDeps,
): Promise<PasskeyResult> {
  const expectedChallenge = await readChallenge(db, params.userId, PURPOSE_REGISTRATION);
  if (!expectedChallenge) return { ok: false, reason: "no_challenge" };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge,
      expectedOrigin: originFor(deps.rpId),
      expectedRPID: deps.rpId,
    });
  } catch {
    return { ok: false, reason: "verification_failed" };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: "not_verified" };
  }

  const { credential } = verification.registrationInfo;
  await db.query(
    `INSERT INTO passkeys (user_id, credential_id, public_key, counter)
     VALUES ($1, $2, $3, $4)`,
    [
      params.userId,
      credential.id,
      isoBase64URL.fromBuffer(credential.publicKey),
      credential.counter,
    ],
  );
  return { ok: true, credentialId: credential.id };
}

// Build the authentication request options carrying the configured RP ID,
// userVerification required and the PRF extension. The credentials are discoverable
// (resident), so no allowCredentials list is named — the presented credential is bound
// to the person in finish. Pure option generation with NO persistence: the single
// source of the options' shape, shared by a real begin (which also stores the
// challenge) and the decoy issued for an email with no account.
async function authenticationOptions(
  deps: PasskeyDeps,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: deps.rpId,
    userVerification: "required",
    // PRF requested on get (design §4.2, §5).
    extensions: { prf: {} },
  });
}

// Begin authentication: build the request options and persist the authentication
// challenge for `userId`, so finish can verify the response against the challenge WE
// sent.
export async function beginPasskeyAuthentication(
  db: Db,
  params: { userId: string },
  deps: PasskeyDeps,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await authenticationOptions(deps);
  await storeChallenge(db, params.userId, PURPOSE_AUTHENTICATION, options.challenge);
  return options;
}

// Decoy authentication options for an email with NO account: exactly the options a real
// begin issues (same keys and types, the configured RP ID, a fresh string challenge),
// but with NO challenge persisted — there is no account to bind one to. Handing these
// back instead of a 401 closes the account-enumeration oracle at begin (E04-S19): an
// unknown email is indistinguishable from a registered one. Because no challenge is
// stored for the email, a later finish against it still fails exactly like a failed
// assertion (no challenge / no account), re-closing the oracle at the finish step.
export async function decoyPasskeyAuthenticationOptions(
  deps: PasskeyDeps,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return authenticationOptions(deps);
}

// Finish authentication: verify the assertion against the credential stored for
// `userId` and the challenge the server issued. Rejects (ok:false) a credential that
// is not one of this person's (the ownership lookup finds nothing), a tampered
// assertion (the real verifier returns not-verified / throws) and a replayed assertion
// (its signature counter does not advance). On success the stored counter is updated
// to the new value so a later replay is caught.
export async function finishPasskeyAuthentication(
  db: Db,
  params: { userId: string; response: AuthenticationResponseJSON },
  deps: PasskeyDeps,
): Promise<PasskeyResult> {
  const expectedChallenge = await readChallenge(db, params.userId, PURPOSE_AUTHENTICATION);
  if (!expectedChallenge) return { ok: false, reason: "no_challenge" };

  // Ownership check: the presented credential must be one THIS person registered.
  // Filtering by the session's userId (not an id from the response) rejects an
  // other-user or unknown credential before any crypto is trusted.
  const found = await db.query(
    `SELECT id, credential_id, public_key, counter
     FROM passkeys
     WHERE user_id = $1 AND credential_id = $2`,
    [params.userId, params.response.id],
  );
  const row = found.rows[0];
  if (!row) return { ok: false, reason: "unknown_credential" };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge,
      expectedOrigin: originFor(deps.rpId),
      expectedRPID: deps.rpId,
      credential: {
        id: row.credential_id as string,
        publicKey: isoBase64URL.toBuffer(row.public_key as string),
        counter: Number(row.counter),
      },
    });
  } catch {
    // A tampered signature or a non-advancing (replayed) counter makes the real
    // verifier throw — an expected rejection, not an error to surface.
    return { ok: false, reason: "verification_failed" };
  }
  if (!verification.verified) return { ok: false, reason: "not_verified" };

  // Advance the stored counter so the next, genuinely later assertion is accepted and
  // a replay of this one (same counter) is refused.
  await db.query(
    `UPDATE passkeys SET counter = $2 WHERE id = $1`,
    [row.id, verification.authenticationInfo.newCounter],
  );
  return { ok: true, credentialId: verification.authenticationInfo.credentialID };
}
