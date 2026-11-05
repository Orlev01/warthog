// E04-S29 — Account-recovery server actions (the injectable seam the thin
// `actions.ts` / route verbs wrap). Recovery is the front door for a person who has
// lost every device, and like sign-up it must NOT finish without a confirmed second
// factor (constitution INV-22; design §4.2, §5).
//
// The flow is four steps, each its own request:
//   1. identify        — resolve the account by email and start a pending recovery.
//   2. verifyCode      — verify the one-time recovery code, and hand back WebAuthn
//                        registration options so the person can register a new passkey.
//   3. registerPasskey — register the new passkey (the new SECOND factor) and issue a
//                        new recovery code that REPLACES the old one, shown ONCE here.
//   4. finish          — only after a new passkey is registered: mint a session → /home.
//
// Across the four separate requests a pending recovery (the resolved account and
// whether its new passkey has been registered) lives in PROCESS MEMORY keyed by a
// random `recoveryId`, the release-store / new-device pattern sign-up uses for its
// `signupId` — a module-level Map (held through processSingleton so every module graph
// Next builds shares one) with full-entropy handles so pending recoveries never collide.
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
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
} from "../../../server/auth/passkey";
import { createSession } from "../../../server/auth/session";
import { getUserByEmail } from "../../../server/db/users";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { Db } from "../../../server/db/index";
import { processSingleton } from "../../../server/seams/process-singleton";

// The dependency bundle. Each step reads the subset it needs; the superset is
// structurally assignable to each. `rpId` is the WebAuthn RP ID (from config, never
// hard-coded); `publicOrigin` is the origin every step checks the request against.
export interface RecoverHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly rpId: string;
  readonly publicOrigin: string;
}

// The steps the thin `actions.ts` / route verbs call.
export interface RecoverHandler {
  identify(request: Request): Promise<Response>;
  verifyCode(request: Request): Promise<Response>;
  registerPasskey(request: Request): Promise<Response>;
  finish(request: Request): Promise<Response>;
}

// A pending recovery, held in process memory between the four requests. `userId` is
// null for an email with no account (identify reveals nothing — the same handle is
// handed back either way, so an unknown email is indistinguishable from a registered
// one); `userName` seeds the passkey registration options. `passkeyRegistered` is set
// once the new credential is stored; finish refuses without it (the second-factor gate).
interface PendingRecovery {
  readonly userId: string | null;
  readonly userName: string;
  passkeyRegistered?: boolean;
}

// The process-wide pending-recovery store (the new-device / release-store pattern):
// ESM caches this module, so every import shares one Map, and the four separate
// requests of one recovery find their pending row by its random handle. Held through
// processSingleton (globalThis) so every module graph Next builds shares it.
const pendingRecoveries = processSingleton(
  "auth.pendingRecoveries",
  () => new Map<string, PendingRecovery>(),
);

// A grossly oversized body is rejected before any work; a real recovery body (even a
// WebAuthn registration response) is far under this.
const MAX_BODY_BYTES = 64 * 1024;

// identify: the email the account is resolved by.
const identifySchema = z.object({
  email: z.string().min(1).max(320),
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
  const { db, clock, random, rpId, publicOrigin } = deps;

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

  // Step 1 — resolve the account by email and start a pending recovery. The Origin gate
  // runs first (a missing or foreign Origin is 403 and starts nothing). The body
  // { email } is validated at the boundary, then the account is looked up (bound as a
  // parameter, INV-102). The SAME 200 { recoveryId } is returned whether or not an
  // account exists — no existence leak — and no session is created.
  async function identify(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email } = await parseBody(identifySchema, request, { maxBytes: MAX_BODY_BYTES });

      const user = await getUserByEmail(db, email);

      // A full-entropy handle for the pending recovery.
      const recoveryId = Buffer.from(random.randomBytes(32)).toString("hex");
      pendingRecoveries.set(recoveryId, { userId: user?.id ?? null, userName: email });

      return json(200, { recoveryId });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 2 — verify the presented recovery code against the pending recovery's account
  // (the real verifier). A wrong code / unknown handle → 4xx and nothing changes (the
  // old code still works). A valid code hands back the registration options carrying the
  // configured RP ID, and persists the registration challenge the new passkey verifies
  // against at step 3.
  async function verifyCode(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { recoveryId, recoveryCode } = await parseBody(verifyCodeSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const pending = pendingRecoveries.get(recoveryId);
      if (!pending || !pending.userId) return json(400, { error: "invalid_code" });

      const ok = await verifyRecoveryCode(db, pending.userId, recoveryCode);
      if (!ok) return json(400, { error: "invalid_code" });

      const registrationOptions = await beginPasskeyRegistration(
        db,
        { userId: pending.userId, userName: pending.userName },
        { rpId, origin: publicOrigin },
      );

      return json(200, { registrationOptions });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 3 — verify the WebAuthn attestation against the challenge step 2 issued (the
  // real verifier) and store the new passkey for the account, then issue the NEW recovery
  // code, which REPLACES the old one (issueRecoveryCode overwrites the current row). The
  // new code is handed to the person only in this response (shown once). A bad attestation
  // / unknown handle / a handle that never verified a code (no challenge) → 4xx, and no
  // replacement code is issued.
  async function registerPasskey(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { recoveryId, registrationResponse } = await parseBody(
        registerPasskeySchema,
        request,
        { maxBytes: MAX_BODY_BYTES },
      );

      const pending = pendingRecoveries.get(recoveryId);
      if (!pending || !pending.userId) return json(400, { error: "unknown_recovery" });

      const result = await finishPasskeyRegistration(
        db,
        { userId: pending.userId, response: registrationResponse as RegistrationResponseJSON },
        { rpId, origin: publicOrigin },
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

  // Step 4 — the front door closes here. Refuse (4xx, nothing minted) unless a new
  // passkey was registered for this pending recovery (the new second factor). Only then
  // mint a session, host-locked in the `__Host-wh_session` cookie, and redirect to /home.
  async function finish(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { recoveryId } = await parseBody(finishSchema, request, { maxBytes: MAX_BODY_BYTES });

      const pending = pendingRecoveries.get(recoveryId);
      if (!pending || !pending.userId) return json(400, { error: "unknown_recovery" });
      if (!pending.passkeyRegistered) return json(400, { error: "no_second_factor" });

      const created = await createSession(db, pending.userId, { clock, random });

      pendingRecoveries.delete(recoveryId);
      return new Response(null, {
        status: 303,
        headers: { location: "/home", "set-cookie": created.cookie },
      });
    } catch (error) {
      return handleError(error);
    }
  }

  return { identify, verifyCode, registerPasskey, finish };
}
