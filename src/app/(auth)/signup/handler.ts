// E04-S10 — Sign-up server actions (the injectable seam the thin `actions.ts` /
// route verbs wrap). Sign-up is the front door and must NOT finish without a
// confirmed second factor (constitution INV-22; design §5).
//
// The flow is three steps, each its own request:
//   1. verifyEmail    — prove the email with the one-time code (the FIRST factor),
//                       and hand back WebAuthn registration options.
//   2. registerPasskey — register the passkey (the SECOND factor) and issue the
//                       one-time recovery code, shown ONCE in this response.
//   3. confirmSignup  — only after an "I have saved it" confirmation AND a
//                       registered passkey: create the account + session → /home.
//
// Until confirmation there is NO `users` row: a pending sign-up (the email, the
// registration challenge, the verified credential and the recovery code's entropy)
// lives in PROCESS MEMORY keyed by a random `signupId`, the release-store /
// new-device pattern — a module-level Map so it survives across the three separate
// requests, with full-entropy handles so pending sign-ups never collide.
//
// Because there is no account yet at steps 1–2, the real issuing functions
// (`beginPasskeyRegistration`, `issueRecoveryCode`) — which both PERSIST against a
// `users` row — are run against a write-discarding `Db` to obtain their outputs
// (the registration options, the recovery code) WITHOUT writing anything; the real
// persistence happens at confirm once the account exists. This reuses those modules
// verbatim (the WebAuthn registration policy and the recovery-code hashing stay
// single-sourced), rather than re-deriving a parallel copy here. For the recovery
// code the entropy drawn at register is RECORDED and REPLAYED at confirm, so the
// code shown once is exactly the code persisted for the new account (it verifies).
//
// Security (each a reviewer veto): every step checks the request `Origin` against
// the configured `publicOrigin` first — a missing or foreign Origin is 403 and
// changes nothing (design §5). Every body is validated at the boundary through the
// shared `parseBody` (malformed / oversized / mis-shaped → a 4xx, never a 500;
// INV-102). Every query runs through the `Db` seam bound as parameters, so a
// SQL-shaped value is stored as data and cannot alter a statement (INV-102). The
// recovery code is handed to the person only in the register response and reaches
// no notification channel.

import { z } from "zod";
import {
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

import { parseBody, HttpError } from "../../../server/http/validate";
import { verifyEmailCode } from "../../../server/auth/email-code";
import { beginPasskeyRegistration } from "../../../server/auth/passkey";
import { issueRecoveryCode } from "../../../server/auth/recovery";
import { createSession } from "../../../server/auth/session";
import { createUser } from "../../../server/db/users";
import type { KeyWrapper } from "../../../server/crypto/key-wrapper";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { EmailSender } from "../../../server/notify/senders";
import type { Db } from "../../../server/db/index";

// The dependency bundle. Each step reads the subset it needs; the superset is
// structurally assignable to each. `rpId` is the WebAuthn RP ID (from config, never
// hard-coded); `publicOrigin` is the origin every step checks the request against.
export interface SignupHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly emailSender: EmailSender;
  readonly keyWrapper: KeyWrapper;
  readonly rpId: string;
  readonly publicOrigin: string;
}

// The three steps the thin `actions.ts` / route verbs call.
export interface SignupHandler {
  verifyEmail(request: Request): Promise<Response>;
  registerPasskey(request: Request): Promise<Response>;
  confirmSignup(request: Request): Promise<Response>;
}

// A pending sign-up, held in process memory between the three requests. `credential`
// and `recoveryDraws` are set once the passkey is registered; confirm refuses
// without them (the confirmed-second-factor gate).
interface PendingSignup {
  readonly email: string;
  readonly challenge: string;
  credential?: { id: string; publicKey: string; counter: number };
  recoveryDraws?: Uint8Array[];
}

// The process-wide pending-sign-up store (the new-device / release-store pattern):
// ESM caches this module, so every import shares one Map, and the three separate
// requests of one sign-up find their pending row by its random handle.
const pendingSignups = new Map<string, PendingSignup>();

// A write-discarding `Db`: at the register stage there is no `users` row to hang a
// challenge or recovery code off, so the real issuing functions are run against this
// to borrow their computed output (options / code) while their INSERT is swallowed.
// The real persistence happens at confirm, against the injected production `Db`.
const discardWrites: Db = {
  async query() {
    return { rows: [] };
  },
  async close() {},
};

// A grossly oversized body is rejected before any work; a real sign-up body (even a
// WebAuthn registration response) is far under this.
const MAX_BODY_BYTES = 64 * 1024;

// verifyEmail: the email + its one-time code.
const verifyEmailSchema = z.object({
  email: z.string().min(1).max(320),
  code: z.string().min(1).max(100),
});

// registerPasskey: the pending handle + the WebAuthn attestation. The attestation is
// kept as-is (z.unknown preserves the whole object, never stripping its fields) and
// handed to the real verifier, which rejects anything malformed.
const registerPasskeySchema = z.object({
  signupId: z.string().min(1).max(200),
  registrationResponse: z.unknown(),
});

// confirmSignup: the pending handle + the explicit "I have saved it" confirmation.
const confirmSignupSchema = z.object({
  signupId: z.string().min(1).max(200),
  savedConfirmed: z.boolean(),
});

// A JSON response with a status.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createSignupHandler(deps: SignupHandlerDeps): SignupHandler {
  const { db, clock, random, hmacKey, emailSender, keyWrapper, rpId, publicOrigin } = deps;

  // The request is same-origin only when it carries exactly the configured Origin. A
  // missing header (`null`) or a foreign one cannot be proven same-origin → refused.
  function sameOrigin(request: Request): boolean {
    return request.headers.get("origin") === publicOrigin;
  }

  // Map the validation boundary's 4xx to a Response; let anything unexpected surface
  // (a genuine server fault is a 5xx, not a handled 4xx).
  function handleError(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    throw error;
  }

  // Step 1 — verify the email one-time code (the real verifier). A wrong / expired /
  // throttled code starts nothing (4xx, no handle). A valid code starts a pending
  // sign-up and hands back the registration options carrying the configured RP ID.
  async function verifyEmail(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, code } = await parseBody(verifyEmailSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const result = await verifyEmailCode(db, email, code, { clock, hmacKey, emailSender });
      if (!result.ok) return json(400, { error: "invalid_code" });

      // A full-entropy handle for the pending sign-up.
      const signupId = Buffer.from(random.randomBytes(32)).toString("hex");

      // Borrow the real registration-options policy (RP ID, resident key + user
      // verification required, PRF) — the challenge is persisted for real only at
      // confirm, so here the store write is discarded.
      const registrationOptions = await beginPasskeyRegistration(
        discardWrites,
        { userId: signupId, userName: email },
        { rpId },
      );

      pendingSignups.set(signupId, { email, challenge: registrationOptions.challenge });
      return json(200, { signupId, registrationOptions });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 2 — verify the WebAuthn attestation against the challenge this pending
  // sign-up issued (the real verifier), record the verified credential, and issue the
  // one-time recovery code (shown once here). A bad attestation / unknown handle →
  // 4xx. Still NO `users` row.
  async function registerPasskey(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { signupId, registrationResponse } = await parseBody(
        registerPasskeySchema,
        request,
        { maxBytes: MAX_BODY_BYTES },
      );

      const pending = pendingSignups.get(signupId);
      if (!pending) return json(400, { error: "unknown_signup" });

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: registrationResponse as RegistrationResponseJSON,
          expectedChallenge: pending.challenge,
          expectedOrigin: `https://${rpId}`,
          expectedRPID: rpId,
        });
      } catch {
        return json(400, { error: "bad_attestation" });
      }
      if (!verification.verified || !verification.registrationInfo) {
        return json(400, { error: "bad_attestation" });
      }

      // Hold the verified credential in the pending sign-up; it is persisted for the
      // new account (the same storage finishPasskeyRegistration writes) at confirm.
      const { credential } = verification.registrationInfo;
      pending.credential = {
        id: credential.id,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter,
      };

      // Issue the recovery code through the real issuer, recording the entropy it
      // draws so confirm can REPLAY it and persist the SAME code against the new
      // account. The store write is discarded here (no account yet); the code is
      // handed to the person only in this response.
      const recoveryDraws: Uint8Array[] = [];
      const recordingRandom: Random = {
        randomBytes(n) {
          const bytes = random.randomBytes(n);
          recoveryDraws.push(Uint8Array.from(bytes));
          return bytes;
        },
      };
      const { code } = await issueRecoveryCode(discardWrites, signupId, {
        random: recordingRandom,
      });
      pending.recoveryDraws = recoveryDraws;

      return json(200, { recoveryCode: code });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 3 — the front door closes here. Refuse (4xx, nothing created) unless the
  // person confirmed they saved the recovery code AND a passkey was registered (the
  // confirmed second factor). Only then: create the account with a wrapped DEK,
  // persist the passkey and the recovery code, mint a session, and redirect to /home.
  async function confirmSignup(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { signupId, savedConfirmed } = await parseBody(confirmSignupSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const pending = pendingSignups.get(signupId);
      if (!pending) return json(400, { error: "unknown_signup" });
      if (!savedConfirmed) return json(400, { error: "not_confirmed" });
      if (!pending.credential || !pending.recoveryDraws) {
        return json(400, { error: "no_second_factor" });
      }

      // The account: a fresh 256-bit DEK stored only WRAPPED (design §4.1).
      const wrappedDek = await keyWrapper.wrap(random.randomBytes(32));
      const user = await createUser(db, { email: pending.email, wrappedDek });

      // Persist the passkey registered at step 2 for the new account (mirrors the
      // passkeys storage in finishPasskeyRegistration; the credential was already
      // verified, so here it is only stored — bound as parameters, INV-102).
      await db.query(
        `INSERT INTO passkeys (user_id, credential_id, public_key, counter)
         VALUES ($1, $2, $3, $4)`,
        [user.id, pending.credential.id, pending.credential.publicKey, pending.credential.counter],
      );

      // Persist the SAME recovery code shown at step 2 by replaying its recorded
      // entropy through the real issuer, so it verifies against the new account.
      const draws = pending.recoveryDraws;
      let drawIndex = 0;
      const replayRandom: Random = {
        randomBytes(n) {
          const next = draws[drawIndex++];
          if (!next || next.length !== n) {
            throw new Error("recovery-code replay exhausted or size mismatch");
          }
          return next;
        },
      };
      await issueRecoveryCode(db, user.id, { random: replayRandom });

      // The signed-in session, host-locked in the `__Host-wh_session` cookie.
      const created = await createSession(db, user.id, { clock, random });

      pendingSignups.delete(signupId);
      return new Response(null, {
        status: 303,
        headers: { location: "/home", "set-cookie": created.cookie },
      });
    } catch (error) {
      return handleError(error);
    }
  }

  return { verifyEmail, registerPasskey, confirmSignup };
}
