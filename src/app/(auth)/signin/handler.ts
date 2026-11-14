import { checkPasskeyAttempt } from "../../../server/auth/passkey-attempts";
// Public sign-in: WebAuthn, or mailbox verification followed by an authenticator
// code. Email is a first factor, not merely an account identifier. The TOTP path
// issues a purpose-bound email code, exchanges it for a bounded ten-minute handle,
// then consumes that account-bound handle after the rate-limited TOTP check.
// Remembered-device cookies only deduplicate security alerts; they grant no bypass.
// See docs/adr/audit-totp-signin.md for the tightened public contract.
//
// Keep the injectable handler separate from Next's thin routes/server actions so
// tests exercise the same authentication boundary without framework machinery.
//
// Security (each a reviewer veto): every method checks the request `Origin` against
// the configured `publicOrigin` first — a missing or foreign Origin is 403 and
// changes nothing, so a cross-site request mints no session (design §5). Every body
// is validated at the boundary through the shared `parseBody` (malformed /
// oversized / mis-shaped → a 4xx, never a 500; INV-102). Every query runs through
// the `Db` seam bound as parameters, so a SQL-shaped value is looked up as data and
// cannot alter a statement (INV-102). The RP ID is `deps.rpId` (from config), never
// hard-coded.

import { z } from "zod";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import { parseBody, HttpError } from "../../../server/http/validate";
import {
  beginPasskeyAuthentication,
  decoyPasskeyAuthenticationOptions,
  finishPasskeyAuthentication,
} from "../../../server/auth/passkey";
import { checkTotpSignIn } from "../../../server/auth/totp-attempts";
import { tryRecord, type MetricSeam } from "../../../server/metrics/seam";
import { FACTORS, SIGNIN_ATTEMPT, SIGNIN_CATEGORIES, SIGNIN_OUTCOMES } from "../../../server/metrics/names";
import { issueEmailCode, verifyEmailCode } from "../../../server/auth/email-code";
import { pendingStore } from "../../../server/auth/pending-store";
import { createSessionWhileProofHolds, type SignInProof } from "../../../server/auth/sign-in-guard";
import { alertNewDeviceSignIn, deliverAlert } from "../../../server/auth/alerts";
import {
  describeDevice,
  deviceCookieFor,
  isRecognisedDevice,
} from "../../../server/auth/device-recognition";
import { getUserByEmail } from "../../../server/db/users";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { EmailSender } from "../../../server/notify/senders";
import type { Db } from "../../../server/db/index";

// The injected store the handler reads a person's base32 TOTP secret through: a
// userId with no enrolled secret returns null. Production decrypts the enrolled
// secret through the vault unlock-method store; tests supply an isolated fake.
export interface TotpSecretStore {
  get(userId: string): Promise<string | null>;
}

// The dependency bundle. Each method reads the subset it needs; the superset is
// structurally assignable to each. `rpId` is the WebAuthn RP ID (from config, never
// hard-coded); `publicOrigin` is the origin every method checks the request against.
// `hmacKey` binds email proofs and device cookies; `emailSender` delivers codes and alerts.
export interface SigninHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly emailSender: EmailSender;
  readonly rpId: string;
  readonly publicOrigin: string;
  readonly totpSecrets: TotpSecretStore;
  // The optional, best-effort sign-in outcome metrics (docs/design/admin-portal.md §4):
  // one `signin.attempt` per completed, failed or throttled attempt with only the outcome,
  // the factor and the failing step's category — never an address, code or user id.
  readonly recordMetric?: MetricSeam;
}

// The three methods the thin `actions.ts` / route verbs call.
export interface SigninHandler {
  beginPasskey(request: Request): Promise<Response>;
  finishPasskey(request: Request): Promise<Response>;
  sendTotpEmailCode(request: Request): Promise<Response>;
  verifyTotpEmail(request: Request): Promise<Response>;
  signInWithTotp(request: Request): Promise<Response>;
}

const pendingTotpSignins = pendingStore<{ userId: string | null }>("auth.pendingTotpSignins", {
  ttlMs: 10 * 60_000, maxEntries: 1000,
});
const totpEmailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320) });
const verifyTotpEmailSchema = totpEmailSchema.extend({ code: z.string().regex(/^\d{6}$/) });

// A grossly oversized body is rejected before any work; a real sign-in body (even a
// WebAuthn assertion) is far under this.
const MAX_BODY_BYTES = 64 * 1024;

// beginPasskey: the email naming the account to issue a challenge for.
const beginPasskeySchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320), // normalised (users.normaliseEmail)
});

// finishPasskey: the email + the WebAuthn assertion. The assertion's minimal shape
// (AuthenticationResponseJSON: ids, type and the three signed response fields) is
// validated HERE, so the later cast narrows rather than bypasses validation — a
// null or mis-shaped assertion is a 4xx at the boundary, never a dereference crash
// inside the verifier. Unknown extra keys pass through (looseObject) untouched for
// the real verifier, which still rejects anything that does not verify.
const authenticationResponseSchema = z.looseObject({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().optional(),
  }),
  clientExtensionResults: z.looseObject({}).optional(),
});

const finishPasskeySchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320), // normalised (users.normaliseEmail)
  authenticationResponse: authenticationResponseSchema,
});

// signInWithTotp: a verified-email handle + authenticator code. The TOTP check itself
// rejects anything that is not exactly six digits.
const totpSchema = z.object({
  signinId: z.string().regex(/^[a-f0-9]{64}$/),
  totp: z.string().min(1).max(100),
});

// A JSON response with a status.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createSigninHandler(deps: SigninHandlerDeps): SigninHandler {
  const { db, clock, random, hmacKey, emailSender, rpId, publicOrigin, totpSecrets, recordMetric } = deps;

  // One sign-in outcome as a metric carrying only its labels.
  const recordAttempt = (outcome: string, labels: { platform?: string; errorCategory?: string }): Promise<void> =>
    tryRecord(recordMetric, { name: SIGNIN_ATTEMPT, value: 1, dimensions: { outcome, ...labels } });
  const recordFailure = (category: string, throttled = false): Promise<void> =>
    recordAttempt(throttled ? SIGNIN_OUTCOMES.throttled : SIGNIN_OUTCOMES.failed, { errorCategory: category });

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

  // Mint a session for the signed-in person and redirect to /home carrying the
  // host-locked `__Host-wh_session` cookie (the signed-in home). A sign-in IS a
  // passkey/TOTP check, so record a step-up on the new session (design §5): the
  // next sensitive change is allowed for the following five minutes.
  //
  // A sign-in from a browser this person has not signed in on before emails them the
  // brief's new-device alert (best effort: a failed send never fails the sign-in) and
  // marks the browser with a device cookie, so later sign-ins from it stay quiet.
  //
  // The session is minted only while the passkey or authenticator that proved the sign-in
  // is still on the account, re-checked under the account lock (sign-in-guard.ts): null
  // when a recovery or removal took it away in the meantime, and the caller refuses.
  async function mintSession(userId: string, request: Request, factor: string, proof: SignInProof): Promise<Response | null> {
    const created = await createSessionWhileProofHolds(db, userId, proof, { clock, random }, { stepUp: true });
    if (!created) return null;
    await recordAttempt(SIGNIN_OUTCOMES.ok, { platform: factor });
    const headers = new Headers({ location: "/home" });
    headers.append("set-cookie", created.cookie);
    if (!isRecognisedDevice(request, userId, hmacKey)) {
      const deviceLabel = describeDevice(request.headers.get("user-agent"));
      await deliverAlert("new-device-sign-in", () =>
        alertNewDeviceSignIn(db, { userId, deviceLabel }, { emailSender }),
      );
      headers.append("set-cookie", deviceCookieFor(userId, { hmacKey, random }));
    }
    return new Response(null, { status: 303, headers });
  }

  // Passkey step 1 — issue a WebAuthn authentication challenge (carrying the configured
  // RP ID). A registered account gets a real challenge, persisted so finish can verify
  // against it; an email with no account gets indistinguishable DECOY options (same
  // shape, same RP ID, a fresh string challenge) with nothing persisted — so begin
  // reveals nothing about whether the account exists (E04-S19). No session either way.
  async function beginPasskey(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email } = await parseBody(beginPasskeySchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const user = await getUserByEmail(db, email);
      const options = user
        ? await beginPasskeyAuthentication(db, { userId: user.id, purpose: "signin" }, { rpId, clock })
        : await decoyPasskeyAuthenticationOptions({ rpId });
      return json(200, { options });
    } catch (error) {
      return handleError(error);
    }
  }

  // Passkey step 2 — verify the assertion against the claimed person's registered
  // passkey and the challenge begin issued (the real verifier). An assertion that is
  // not that person's own (or otherwise fails to verify) → 4xx and NO session. On
  // success: mint a session and redirect to /home.
  async function finishPasskey(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, authenticationResponse } = await parseBody(finishPasskeySchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const user = await getUserByEmail(db, email);
      if (!user) {
        await recordFailure(SIGNIN_CATEGORIES.passkey);
        return json(401, { error: "invalid_assertion" });
      }

      let credentialId: string | null = null;
      const result = await checkPasskeyAttempt(db, user.id, async () => {
        const verified = await finishPasskeyAuthentication(
          db,
          {
            userId: user.id,
            response: authenticationResponse as AuthenticationResponseJSON,
            purpose: "signin",
          },
          { rpId, origin: publicOrigin, clock },
        );
        if (verified.ok) credentialId = verified.credentialId;
        return verified.ok;
      }, { clock, emailSender });
      if (result.reason === "throttled") {
        await recordFailure(SIGNIN_CATEGORIES.passkey, true);
        return new Response(JSON.stringify({ error: "throttled" }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(Math.ceil((result.retryAfterMs ?? 1000) / 1000)) } });
      }
      const signedIn = result.ok && credentialId !== null
        ? await mintSession(user.id, request, FACTORS.passkey, { kind: "passkey", credentialId })
        : null;
      if (!signedIn) {
        await recordFailure(SIGNIN_CATEGORIES.passkey);
        return json(401, { error: "invalid_assertion" });
      }
      return signedIn;
    } catch (error) {
      return handleError(error);
    }
  }

  async function sendTotpEmailCode(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email } = await parseBody(totpEmailSchema, request, { maxBytes: MAX_BODY_BYTES });
      // Same response/delivery path for existing and unknown accounts. Mailbox
      // verification alone never grants access or discloses account enrollment.
      const issued = await issueEmailCode(db, email, { purpose: "signin_totp", clock, random, hmacKey, emailSender });
      if (!issued.ok) {
        await recordFailure(SIGNIN_CATEGORIES.emailCode, true);
        return new Response(JSON.stringify({ error: "throttled" }), { status: 429,
          headers: { "content-type": "application/json", "retry-after": String(Math.ceil(issued.retryAfterMs / 1000)) } });
      }
      return json(200, { ok: true });
    } catch (error) { return handleError(error); }
  }

  async function verifyTotpEmail(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, code } = await parseBody(verifyTotpEmailSchema, request, { maxBytes: MAX_BODY_BYTES });
      const checked = await verifyEmailCode(db, email, code, { purpose: "signin_totp", clock, hmacKey, emailSender });
      if (!checked.ok) {
        await recordFailure(SIGNIN_CATEGORIES.emailCode, checked.reason === "throttled");
        return json(checked.reason === "throttled" ? 429 : 401, { error: "invalid_code" });
      }
      const user = await getUserByEmail(db, email);
      const signinId = Buffer.from(random.randomBytes(32)).toString("hex");
      pendingTotpSignins.set(signinId, { userId: user?.id ?? null }, clock.now());
      return json(200, { signinId });
    } catch (error) { return handleError(error); }
  }

  // Verified email + authenticator code — resolve the account from its proof, read its TOTP secret (the
  // injected seam) and verify the code for the current 30-second step (±1). A wrong /
  // out-of-window code, or no enrolled secret → 4xx and NO session. On success: mint
  // a session and redirect to /home.
  async function signInWithTotp(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { signinId, totp } = await parseBody(totpSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const pending = pendingTotpSignins.get(signinId, clock.now());
      if (!pending?.userId) {
        await recordFailure(SIGNIN_CATEGORIES.totp);
        return json(401, { error: "invalid_code" });
      }

      const secret = await totpSecrets.get(pending.userId);
      if (!secret) {
        await recordFailure(SIGNIN_CATEGORIES.totp);
        return json(401, { error: "invalid_code" });
      }
      // Limited and single use (review fix W3.5): 5 failures in 15 minutes slow further
      // attempts, and a code (or one from an earlier step) is accepted only once.
      const checked = await checkTotpSignIn(db, { userId: pending.userId, secret, code: totp }, { clock });
      if (!checked.ok) {
        await recordFailure(SIGNIN_CATEGORIES.totp, checked.reason === "throttled");
        if (checked.reason === "throttled") {
          return new Response(JSON.stringify({ error: "throttled" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(Math.max(1, Math.ceil(checked.retryAfterMs / 1000))),
            },
          });
        }
        return json(401, { error: "invalid_code" });
      }

      // Consume synchronously before the next await. Even concurrent valid codes
      // cannot exchange the same email proof for two sessions.
      if (pendingTotpSignins.get(signinId, clock.now()) !== pending) {
        await recordFailure(SIGNIN_CATEGORIES.totp);
        return json(401, { error: "invalid_code" });
      }
      pendingTotpSignins.delete(signinId);
      const signedIn = await mintSession(pending.userId, request, FACTORS.totp, { kind: "authenticator", step: checked.step });
      if (!signedIn) {
        await recordFailure(SIGNIN_CATEGORIES.totp);
        return json(401, { error: "invalid_code" });
      }
      return signedIn;
    } catch (error) {
      return handleError(error);
    }
  }

  return { beginPasskey, finishPasskey, sendTotpEmailCode, verifyTotpEmail, signInWithTotp };
}
