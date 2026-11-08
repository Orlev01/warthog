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
// Challenges are single-use, short-lived and bound to their purpose (review fix B4).
// Synced passkeys (iCloud, Google) always report a signature counter of 0, so the
// counter cannot catch a replayed assertion; the challenge must. Every begin stores its
// own challenge row (keyed by the challenge, so a third party's begin for the same
// person cannot overwrite a ceremony in progress), stamped from the injected Clock.
// Every finish first DELETEs the exact challenge the browser's response carries, with
// RETURNING — so of any number of finishes of one assertion, racing or replayed, exactly
// one finds it — and only if it is under five minutes old. The challenge is consumed
// before the signature is checked, so even a failed attempt burns it. Sign-in and
// step-up are separate purposes, so a sign-in assertion never counts as a step-up.
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

import { systemClock, type Clock } from "../seams/clock";
import type { Db } from "../db/index";

// The configured WebAuthn RP ID (warthog.com.au in production) and the app's public
// origin — the origin the browser reports in clientDataJSON, which every finish step
// verifies. They differ in development (http://localhost:3000 with RP ID localhost) and
// whenever the app is served from a subdomain of the RP ID, so the origin comes from
// config (the origin of PUBLIC_BASE_URL). Without it, verification falls back to
// `https://<rpId>` (the app served at the RP ID itself over https).
export interface PasskeyDeps {
  readonly rpId: string;
  readonly origin?: string;
  // The clock challenges are stamped with and judged against (the system clock when
  // omitted).
  readonly clock?: Clock;
}

// What an authentication challenge is for. A challenge issued for one purpose cannot be
// finished as the other, so a sign-in assertion never passes a step-up check.
export type AuthenticationPurpose = "signin" | "step_up";

// What finish reports back — a discriminated union on `ok`, like email-code's
// VerifyResult. A verified response names the stored credential; every rejection names
// its reason and never throws.
export type PasskeyResult =
  | { ok: true; credentialId: string }
  | { ok: false; reason: string };

// The friendly, user-visible relying-party name (the RP ID is the domain; this is the
// label shown in the authenticator prompt).
const RP_NAME = "Warthog";

// The registration purpose; authentication challenges carry an AuthenticationPurpose.
const PURPOSE_REGISTRATION = "registration";

// A challenge lapses five minutes after begin issued it.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// At most this many challenges stay outstanding per person and purpose; begin drops
// the oldest beyond it, so repeated begins cannot grow the table without bound.
const MAX_OUTSTANDING_CHALLENGES = 10;

// The longest challenge accepted from a response (ours are 43 base64url characters).
const MAX_CHALLENGE_LENGTH = 512;

// The origin a finish step verifies: the configured public origin, else the RP ID itself.
function originFor(deps: PasskeyDeps): string {
  return deps.origin ?? `https://${deps.rpId}`;
}

function clockOf(deps: PasskeyDeps): Clock {
  return deps.clock ?? systemClock;
}

// Persist a challenge the server issued for this person and purpose, stamped with the
// clock, so finish can verify the response against a challenge WE sent. The person's
// lapsed challenges for the purpose are purged first and only the newest few are kept.
async function storeChallenge(
  db: Db,
  userId: string,
  purpose: string,
  challenge: string,
  now: Date,
): Promise<void> {
  await db.query(
    `DELETE FROM passkey_challenges
     WHERE user_id = $1 AND purpose = $2 AND created_at <= $3::timestamptz`,
    [userId, purpose, new Date(now.getTime() - CHALLENGE_TTL_MS).toISOString()],
  );
  await db.query(
    `INSERT INTO passkey_challenges (user_id, purpose, challenge, created_at)
     VALUES ($1, $2, $3, $4::timestamptz)
     ON CONFLICT DO NOTHING`,
    [userId, purpose, challenge, now.toISOString()],
  );
  await db.query(
    `DELETE FROM passkey_challenges
     WHERE user_id = $1 AND purpose = $2 AND challenge NOT IN (
       SELECT challenge FROM passkey_challenges
       WHERE user_id = $1 AND purpose = $2
       ORDER BY created_at DESC
       LIMIT $3
     )`,
    [userId, purpose, MAX_OUTSTANDING_CHALLENGES],
  );
}

// The challenge a browser response signed over, read from its clientDataJSON (base64url
// JSON), or null when it is missing or malformed. The verifier re-checks it against the
// expected challenge; this only selects which stored challenge to consume.
function challengeIn(clientDataJSON: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(isoBase64URL.toBuffer(clientDataJSON)).toString("utf8"),
    );
    const challenge = (parsed as { challenge?: unknown } | null)?.challenge;
    if (typeof challenge !== "string") return null;
    if (challenge.length === 0 || challenge.length > MAX_CHALLENGE_LENGTH) return null;
    return challenge;
  } catch {
    return null;
  }
}

// Consume the challenge a response carries for this person and purpose: delete it and
// hand it back only if it was outstanding and under five minutes old. The single
// DELETE ... RETURNING makes the spend atomic — of any number of finishes presenting
// it, one gets the challenge and the rest get null.
async function consumeChallenge(
  db: Db,
  userId: string,
  purpose: string,
  clientDataJSON: string,
  now: Date,
): Promise<string | null> {
  const challenge = challengeIn(clientDataJSON);
  if (!challenge) return null;
  const consumed = await db.query(
    `DELETE FROM passkey_challenges
     WHERE user_id = $1 AND purpose = $2 AND challenge = $3 AND created_at > $4::timestamptz
     RETURNING challenge`,
    [userId, purpose, challenge, new Date(now.getTime() - CHALLENGE_TTL_MS).toISOString()],
  );
  return consumed.rows.length > 0 ? challenge : null;
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
  await storeChallenge(db, params.userId, PURPOSE_REGISTRATION, options.challenge, clockOf(deps).now());
  return options;
}

// Finish registration: consume the challenge the attestation carries (single use, at
// most five minutes old), verify the attestation against the configured RP ID / origin
// and that challenge, then store the credential (id, public key, counter) for `userId`.
// Returns { ok: true, credentialId } on success; any failure — an unexpected RP ID, a
// challenge we never issued (or already spent, or lapsed), a bad attestation — returns
// { ok: false }.
export async function finishPasskeyRegistration(
  db: Db,
  params: { userId: string; response: RegistrationResponseJSON },
  deps: PasskeyDeps,
): Promise<PasskeyResult> {
  const expectedChallenge = await consumeChallenge(
    db,
    params.userId,
    PURPOSE_REGISTRATION,
    params.response.response.clientDataJSON,
    clockOf(deps).now(),
  );
  if (!expectedChallenge) return { ok: false, reason: "no_challenge" };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge,
      expectedOrigin: originFor(deps),
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
// challenge for `userId` and its purpose (sign-in unless said otherwise), so finish can
// verify the response against the challenge WE sent, for the purpose it was sent for.
export async function beginPasskeyAuthentication(
  db: Db,
  params: { userId: string; purpose?: AuthenticationPurpose },
  deps: PasskeyDeps,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await authenticationOptions(deps);
  await storeChallenge(
    db,
    params.userId,
    params.purpose ?? "signin",
    options.challenge,
    clockOf(deps).now(),
  );
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

// Finish authentication: consume the challenge the assertion carries for `userId` and
// the purpose (sign-in unless said otherwise) — single use, at most five minutes old —
// then verify the assertion against the credential stored for `userId` and that
// challenge. Rejects (ok:false) a spent, lapsed or other-purpose challenge, a credential
// that is not one of this person's (the ownership lookup finds nothing), a tampered
// assertion (the real verifier returns not-verified / throws) and a replayed assertion.
// On success the stored counter is updated to the new value.
export async function finishPasskeyAuthentication(
  db: Db,
  params: { userId: string; response: AuthenticationResponseJSON; purpose?: AuthenticationPurpose },
  deps: PasskeyDeps,
): Promise<PasskeyResult> {
  const expectedChallenge = await consumeChallenge(
    db,
    params.userId,
    params.purpose ?? "signin",
    params.response.response.clientDataJSON,
    clockOf(deps).now(),
  );
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
      expectedOrigin: originFor(deps),
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
