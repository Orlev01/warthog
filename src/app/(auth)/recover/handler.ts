// E04-S29 — Account-recovery server actions (the injectable seam the thin
// `actions.ts` / route verbs wrap). Recovery is the front door for a person who has
// lost every device, and like sign-up it must NOT finish without a confirmed second
// factor (constitution INV-22; design §4.2, §5).
//
// The brief's recovery is "email code plus recovery code ... then the person creates a
// new passkey and receives a new recovery code that replaces the old one". The flow is
// five steps, each its own request, and each REQUIRES the one before it (recorded on the
// pending recovery, never inferred from database state):
//   1. identify        — resolve the account by email, start a pending recovery and, for
//                        an existing account, email a one-time code (the FIRST factor).
//   2. verifyEmail     — verify that emailed code (throttled per address by email-code).
//   3. verifyCode      — only after the email code: verify the recovery code (at most
//                        five wrong tries per recovery, then the recovery is closed), and
//                        hand back WebAuthn registration options for a new passkey.
//   4. registerPasskey — only after the recovery code: register the new passkey (the new
//                        SECOND factor) and issue a new recovery code that REPLACES the old
//                        one, shown ONCE here.
//   5. finish          — only after a new passkey is registered: mint a session → /home,
//                        and email the account holder that their account was recovered.
//
// Across the separate requests a pending recovery (the resolved account and how far it
// has progressed) lives in PROCESS MEMORY keyed by a
// random `recoveryId`, the release-store / new-device pattern sign-up uses for its
// `signupId` — a bounded, expiring process-wide store (pending-store) with full-entropy
// handles so pending recoveries never collide.
//
// Unlike sign-up there is an existing `users` row from the first step, so the real
// issuing functions run against the injected production `Db` and persist for real:
// `beginPasskeyRegistration` stores the challenge, `finishPasskeyRegistration` stores
// the new credential, and `issueRecoveryCode` (ON CONFLICT DO UPDATE) overwrites the
// account's current recovery code — so the old code stops verifying the moment the new
// one is issued. These modules are reused verbatim (the WebAuthn policy and the
// recovery-code hashing stay single-sourced), rather than re-derived here.
//
// Security (each a reviewer veto): every step checks the request `Origin` against the
// configured `publicOrigin` first — a missing or foreign Origin is 403 and changes
// nothing (design §5). Every body is validated at the boundary through the shared
// `parseBody` (malformed / oversized / mis-shaped → a 4xx, never a 500; INV-102). Every
// query runs through the `Db` seam bound as parameters, so a SQL-shaped value is stored
// as data and cannot alter a statement (INV-102). The new recovery code is handed to the
// person only in the registerPasskey response and reaches no notification channel.

import { z } from "zod";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { parseBody, HttpError } from "../../../server/http/validate";
import { verifyRecoveryCode, issueRecoveryCode } from "../../../server/auth/recovery";
import { issueEmailCode, verifyEmailCode } from "../../../server/auth/email-code";
import { alertAccountRecovered, deliverAlert } from "../../../server/auth/alerts";
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
} from "../../../server/auth/passkey";
import { createSession } from "../../../server/auth/session";
import { getUserByEmail } from "../../../server/db/users";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { EmailSender } from "../../../server/notify/senders";
import type { Db } from "../../../server/db/index";
import { pendingStore } from "../../../server/auth/pending-store";

// The dependency bundle. Each step reads the subset it needs; the superset is
// structurally assignable to each. `rpId` is the WebAuthn RP ID (from config, never
// hard-coded); `publicOrigin` is the origin every step checks the request against.
// `hmacKey` and `emailSender` carry the email one-time code (and the recovery alert).
export interface RecoverHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly emailSender: EmailSender;
  readonly rpId: string;
  readonly publicOrigin: string;
}

// The steps the thin `actions.ts` / route verbs call.
export interface RecoverHandler {
  identify(request: Request): Promise<Response>;
  verifyEmail(request: Request): Promise<Response>;
  verifyCode(request: Request): Promise<Response>;
  registerPasskey(request: Request): Promise<Response>;
  finish(request: Request): Promise<Response>;
}

// A pending recovery, held in process memory between the requests. `userId` is null
// for an email with no account (identify reveals nothing — the same handle is handed
// back either way, so an unknown email is indistinguishable from a registered one);
// `email` is the address the one-time code went to and seeds the passkey registration
// options. Each later step requires the flag the step before it sets: `emailVerified`
// (the email code), `recoveryVerified` (the recovery code), `passkeyRegistered` (the new
// second factor). `recoveryFailures` counts wrong recovery codes on this recovery.
interface PendingRecovery {
  readonly userId: string | null;
  readonly email: string;
  emailVerified: boolean;
  recoveryVerified: boolean;
  passkeyRegistered: boolean;
  recoveryFailures: number;
}

// Wrong recovery codes allowed on one recovery before it is closed. Starting another
// recovery needs a fresh email code, which is itself rate-limited per address.
const MAX_RECOVERY_CODE_FAILURES = 5;

// The process-wide pending-recovery store (the new-device / release-store pattern):
// the separate requests of one recovery find their pending row by its random handle.
// identify is unauthenticated, so the store is bounded and expiring (pending-store): a
// recovery must finish within thirty minutes, and a flood cannot grow memory unbounded.
const pendingRecoveries = pendingStore<PendingRecovery>("auth.pendingRecoveries", {
  ttlMs: 30 * 60 * 1000,
  maxEntries: 10_000,
});

// A grossly oversized body is rejected before any work; a real recovery body (even a
// WebAuthn registration response) is far under this.
const MAX_BODY_BYTES = 64 * 1024;

// identify: the email the account is resolved by.
const identifySchema = z.object({
  email: z.string().min(1).max(320),
});

// verifyEmail: the pending handle + the six-digit code emailed at identify.
const verifyEmailSchema = z.object({
  recoveryId: z.string().min(1).max(200),
  code: z.string().min(1).max(100),
});

// verifyCode: the pending handle + the one-time recovery code.
const verifyCodeSchema = z.object({
  recoveryId: z.string().min(1).max(200),
  recoveryCode: z.string().min(1).max(100),
});

// registerPasskey: the pending handle + the WebAuthn attestation. The attestation's
// minimal shape (RegistrationResponseJSON: ids, type and the two attestation response
// fields) is validated HERE, so the later cast narrows rather than bypasses validation —
// a null or mis-shaped attestation is a 4xx at the boundary, never a dereference crash
// inside the verifier. Unknown extra keys pass through (looseObject) untouched for the
// real verifier, which still rejects anything that does not verify.
const registrationResponseSchema = z.looseObject({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
  }),
  clientExtensionResults: z.looseObject({}).optional(),
});

const registerPasskeySchema = z.object({
  recoveryId: z.string().min(1).max(200),
  registrationResponse: registrationResponseSchema,
});

// finish: the pending handle alone.
const finishSchema = z.object({
  recoveryId: z.string().min(1).max(200),
});

// A JSON response with a status.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createRecoverHandler(deps: RecoverHandlerDeps): RecoverHandler {
  const { db, clock, random, hmacKey, emailSender, rpId, publicOrigin } = deps;

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

  // Step 1 — resolve the account by email, start a pending recovery and email the
  // account holder a one-time code. The Origin gate runs first (a missing or foreign
  // Origin is 403 and starts nothing). The body { email } is validated at the boundary,
  // then the account is looked up (bound as a parameter, INV-102). The SAME 200
  // { recoveryId } is returned whether or not an account exists — and whether or not a
  // code could be issued just now (the per-address issue limit) — so nothing leaks about
  // existence. Only an existing account is emailed; no session is created.
  async function identify(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email } = await parseBody(identifySchema, request, { maxBytes: MAX_BODY_BYTES });

      const user = await getUserByEmail(db, email);
      if (user) {
        await issueEmailCode(db, user.email, { clock, random, hmacKey, emailSender });
      }

      // A full-entropy handle for the pending recovery.
      const recoveryId = Buffer.from(random.randomBytes(32)).toString("hex");
      pendingRecoveries.set(
        recoveryId,
        {
          userId: user?.id ?? null,
          email: user?.email ?? email,
          emailVerified: false,
          recoveryVerified: false,
          passkeyRegistered: false,
          recoveryFailures: 0,
        },
        clock.now(),
      );

      return json(200, { recoveryId });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 2 — verify the one-time code identify emailed (the real verifier, which
  // limits attempts per address and consumes the code). An unknown handle or a wrong /
  // expired code → 400; a throttled address → 429 with Retry-After. An address with no
  // account has no code to match, so it fails exactly like a wrong code. Success marks
  // the recovery's email as proven, which the recovery-code step requires.
  async function verifyEmail(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { recoveryId, code } = await parseBody(verifyEmailSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const pending = pendingRecoveries.get(recoveryId, clock.now());
      if (!pending) return json(400, { error: "invalid_code" });

      const result = await verifyEmailCode(db, pending.email, code, { clock, hmacKey, emailSender });
      if (!result.ok) {
        if (result.reason === "throttled") {
          return new Response(JSON.stringify({ error: "throttled" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
            },
          });
        }
        return json(400, { error: "invalid_code" });
      }

      pending.emailVerified = true;
      return json(200, { ok: true });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 3 — only for a recovery whose email code verified: check the presented recovery
  // code against the pending recovery's account (the real verifier). A wrong code / an
  // unknown handle / an unproven email → 4xx and nothing changes (the old code still
  // works); the fifth wrong code on one recovery closes it (429), so the code cannot be
  // guessed through one handle. A valid code hands back the registration options carrying
  // the configured RP ID, and persists the registration challenge the new passkey
  // verifies against at the next step.
  async function verifyCode(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { recoveryId, recoveryCode } = await parseBody(verifyCodeSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const pending = pendingRecoveries.get(recoveryId, clock.now());
      if (!pending) return json(400, { error: "invalid_code" });
      if (!pending.emailVerified) return json(400, { error: "email_not_verified" });

      // An address with no account still runs the (equal-cost) verifier, so the response
      // time does not reveal whether the account exists.
      const ok = await verifyRecoveryCode(db, pending.userId, recoveryCode);
      if (!ok || !pending.userId) {
        pending.recoveryFailures += 1;
        if (pending.recoveryFailures >= MAX_RECOVERY_CODE_FAILURES) {
          pendingRecoveries.delete(recoveryId);
          return json(429, { error: "too_many_attempts" });
        }
        return json(400, { error: "invalid_code" });
      }

      const registrationOptions = await beginPasskeyRegistration(
        db,
        { userId: pending.userId, userName: pending.email },
        { rpId, origin: publicOrigin, clock },
      );
      pending.recoveryVerified = true;

      return json(200, { registrationOptions });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 4 — verify the WebAuthn attestation against the challenge step 3 issued (the
  // real verifier) and store the new passkey for the account, then issue the NEW recovery
  // code, which REPLACES the old one (issueRecoveryCode overwrites the current row). The
  // new code is handed to the person only in this response (shown once). A bad attestation
  // / unknown handle / a handle whose recovery code never verified → 4xx, and no
  // replacement code is issued.
  async function registerPasskey(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { recoveryId, registrationResponse } = await parseBody(
        registerPasskeySchema,
        request,
        { maxBytes: MAX_BODY_BYTES },
      );

      const pending = pendingRecoveries.get(recoveryId, clock.now());
      if (!pending || !pending.userId) return json(400, { error: "unknown_recovery" });
      if (!pending.recoveryVerified) return json(400, { error: "not_verified" });

      const result = await finishPasskeyRegistration(
        db,
        { userId: pending.userId, response: registrationResponse as RegistrationResponseJSON },
        { rpId, origin: publicOrigin, clock },
      );
      if (!result.ok) return json(400, { error: "bad_attestation" });

      // The new passkey is the second factor: only now is a new recovery code issued,
      // replacing the old one. The code is returned once and stored only as its hash.
      const { code } = await issueRecoveryCode(db, pending.userId, { random });
      pending.passkeyRegistered = true;

      return json(200, { recoveryCode: code });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 5 — the front door closes here. Refuse (4xx, nothing minted) unless a new
  // passkey was registered for this pending recovery (the new second factor). Only then
  // mint a session, host-locked in the `__Host-wh_session` cookie, redirect to /home, and
  // tell the account holder their account was recovered (best effort: a failed alert
  // never undoes the recovery).
  async function finish(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { recoveryId } = await parseBody(finishSchema, request, { maxBytes: MAX_BODY_BYTES });

      const pending = pendingRecoveries.get(recoveryId, clock.now());
      if (!pending || !pending.userId) return json(400, { error: "unknown_recovery" });
      if (!pending.passkeyRegistered) return json(400, { error: "no_second_factor" });

      const created = await createSession(db, pending.userId, { clock, random });

      pendingRecoveries.delete(recoveryId);
      const userId = pending.userId;
      await deliverAlert("account-recovered", () =>
        alertAccountRecovered(db, { userId }, { emailSender }),
      );
      return new Response(null, {
        status: 303,
        headers: { location: "/home", "set-cookie": created.cookie },
      });
    } catch (error) {
      return handleError(error);
    }
  }

  return { identify, verifyEmail, verifyCode, registerPasskey, finish };
}
