// Review fix W3.3 — the account-reset HTTP steps (the injectable seam the thin
// `/api/auth/reset/[step]` route wraps). The reset state machine (request → 7-day wait →
// cancel / complete, `src/server/auth/account-reset.ts`) had no way in. When every passkey
// AND the recovery code are lost, the brief's only way back is a reset by email after a
// 7-day wait, during which every channel is alerted and any signed-in device can cancel.
//
// Three steps, each its own request:
//   1. sendCode — { email }: email the account holder a one-time code (the first factor).
//                 The SAME 200 answers an address with no account, and one whose code
//                 could not be issued just now (the per-address limit), so the step
//                 reveals nothing about which addresses have accounts.
//   2. request  — { email, code }: start the reset (requestAccountReset verifies the code,
//                 records the pending reset, schedules completion and alerts every
//                 channel). A wrong code, or an address with no account, is the same 400.
//                 The answer says when the reset completes.
//   3. cancel   — a signed-in device cancels the person's own pending reset. Identity is
//                 the session cookie ALONE, never a body value (design §5).
//
// Review fix W5 — "Reset finished? Set up a new passkey". A completed reset leaves the
// person with no passkey they can use and no recovery code, so three more steps let them
// back in (the recover and sign-up handlers' patterns, reusing the same seams):
//   4. setupSendCode — { email }: email a code only when the address has a finished reset;
//                      the SAME 200 answers every address, so nothing is revealed.
//   5. setupVerify   — { email, code }: verify the code (throttled; only the newest code
//                      verifies), then — only when the account's reset status is 'done' —
//                      begin a passkey registration (a purpose-bound, single-use challenge)
//                      and hand back { setupId, registrationOptions }.
//   6. setupFinish   — { setupId, registrationResponse }: re-enrol in ONE transaction
//                      (reenrolAfterReset: register the passkey, claim 'done' → 'reenrolled',
//                      remove the lost passkeys, authenticator app and sessions, issue a new
//                      recovery code), then answer with the new code (shown once, never
//                      cached) and the session and device cookies exactly as sign-in sets
//                      them, and email the person (best effort). The set-up handle is
//                      single use, and a second, replayed or racing finish gets nothing.
// The verified account between steps 5 and 6 lives in the bounded, expiring pending store
// under a full-entropy handle (the recover handler's pattern).
//
// Sign-in audit (founder decision 13 November 2026) — a completed reset can be re-enrolled
// for 7 days, and the signed-in owner can close that ("This wasn't me"):
//   7. close — a signed-in device closes re-enrolment on the person's own completed reset.
//              Identity is the session cookie alone, and a fresh step-up is required; the
//              status-guarded 'done' → 'closed' update makes a close racing a re-enrolment
//              safe. After a close, set-up verify and finish refuse with 409 reset_closed.
//
// Security (each a reviewer veto): every step checks the request `Origin` against the
// configured `publicOrigin` first — a missing or foreign Origin is 403 and changes nothing
// (design §5). Every body is validated at the boundary through the shared `parseBody`
// (malformed / oversized / mis-shaped → a 4xx, never a 500; INV-102), and every query runs
// through the `Db` seam with bound parameters. The one-time code reaches only the email
// it is sent in, and no response carries it.

import { z } from "zod";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { parseBody, HttpError } from "../../../server/http/validate";
import { issueEmailCode, verifyEmailCode } from "../../../server/auth/email-code";
import {
  requestAccountReset,
  cancelAccountReset,
  closeAccountReset,
  hasCompletedReset,
  isResetClosed,
  reenrolAfterReset,
  RESET_WAIT_MS,
} from "../../../server/auth/account-reset";
import { requireStepUp } from "../../../server/auth/step-up";
import { discardPendingSignIns } from "../../../server/auth/recover-session";
import { beginPasskeyRegistration } from "../../../server/auth/passkey";
import { alertAccountReenrolled, deliverAlert } from "../../../server/auth/alerts";
import { deviceCookieFor } from "../../../server/auth/device-recognition";
import { pendingStore } from "../../../server/auth/pending-store";
import { verifySession } from "../../../server/auth/session";
import { getUserByEmail } from "../../../server/db/users";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { Senders } from "../../../server/notify/senders";
import type { Db } from "../../../server/db/index";

// The dependency bundle. `senders` carries the code email and the reset alerts (push,
// email, SMS); `hmacKey` is the key email codes are stored under; `rpId` is the WebAuthn
// RP ID the new passkey registers under (from config); `publicOrigin` is the origin every
// step checks the request against.
export interface ResetHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly senders: Senders;
  readonly rpId: string;
  readonly publicOrigin: string;
}

export interface ResetHandler {
  sendCode(request: Request): Promise<Response>;
  request(request: Request): Promise<Response>;
  cancel(request: Request): Promise<Response>;
  setupSendCode(request: Request): Promise<Response>;
  setupVerify(request: Request): Promise<Response>;
  setupFinish(request: Request): Promise<Response>;
  close(request: Request): Promise<Response>;
}

// A verified set-up between setupVerify and setupFinish: the account whose email code
// verified and whose reset is finished. Bounded and expiring (pending-store): a set-up
// must finish within ten minutes (the registration challenge itself lapses in five).
interface PendingSetup {
  readonly userId: string;
}

const pendingSetups = pendingStore<PendingSetup>("auth.pendingResetSetups", {
  ttlMs: 10 * 60 * 1000,
  maxEntries: 10_000,
});

// The host-locked session cookie set by the session module.
const SESSION_COOKIE = "__Host-wh_session";

// A reset body is a few short fields; anything larger is refused before any work.
const MAX_BODY_BYTES = 4 * 1024;

const emailSchema = z.string().trim().toLowerCase().min(1).max(320); // users.normaliseEmail
const sendCodeSchema = z.object({ email: emailSchema });
const requestSchema = z.object({ email: emailSchema, code: z.string().trim().min(1).max(100) });

// A set-up finish carries a WebAuthn attestation, far larger than the other bodies.
const MAX_SETUP_BODY_BYTES = 64 * 1024;

// The attestation's minimal shape (RegistrationResponseJSON), validated here so the later
// cast narrows rather than bypasses validation; extra keys pass through to the verifier,
// which still rejects anything that does not verify (the recover handler's schema).
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

const setupFinishSchema = z.object({
  setupId: z.string().min(1).max(200),
  registrationResponse: registrationResponseSchema,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// One cookie's value from the request's Cookie header, or null when absent.
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createResetHandler(deps: ResetHandlerDeps): ResetHandler {
  const { db, clock, random, hmacKey, senders, rpId, publicOrigin } = deps;

  // Same-origin only when the request carries exactly the configured Origin; a missing
  // header or a foreign one cannot be proven same-origin, so it is refused.
  function sameOrigin(request: Request): boolean {
    return request.headers.get("origin") === publicOrigin;
  }

  // The validation boundary's 4xx becomes a Response; anything else is a genuine fault.
  function handleError(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    throw error;
  }

  // Step 1 — email the account holder a one-time code. Only an existing account is
  // emailed; the answer is the same either way, and also when the address's code limit
  // refused a new code (the person can use the code they already have).
  async function sendCode(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email } = await parseBody(sendCodeSchema, request, { maxBytes: MAX_BODY_BYTES });
      const user = await getUserByEmail(db, email);
      if (user) {
        await issueEmailCode(db, user.email, { purpose: "reset", clock, random, hmacKey, emailSender: senders.email });
      }
      return json(200, { ok: true });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 2 — start the reset with the emailed code. A wrong or lapsed code and an address
  // with no account are the same 400; a reset whose alerts reached no channel at all is
  // withdrawn by the state machine and reported as 503 (try again later).
  async function requestReset(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, code } = await parseBody(requestSchema, request, { maxBytes: MAX_BODY_BYTES });
      const result = await requestAccountReset(db, { email, code }, { clock, hmacKey, senders });
      if (!result.ok) {
        if (result.reason === "alert_failed") return json(503, { error: "alert_failed" });
        return json(400, { error: "invalid_code" });
      }
      const completesAt = new Date(clock.now().getTime() + RESET_WAIT_MS);
      return json(200, { ok: true, completesAt: completesAt.toISOString() });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 3 — the signed-in person cancels their own pending reset. The person is the
  // session cookie's; a body (if any) is never read, so no client value picks whose reset
  // is cancelled. No session is 401; nothing pending is 404.
  async function cancel(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    const token = readCookie(request, SESSION_COOKIE);
    const session = token ? await verifySession(db, token, { clock }) : null;
    if (!session) return json(401, { error: "unauthenticated" });
    const result = await cancelAccountReset(db, { userId: session.userId }, {});
    if (!result.ok) return json(404, { error: "no_pending_reset" });
    return json(200, { ok: true });
  }

  // Step 7 — the signed-in person closes re-enrolment on their own completed reset ("This
  // wasn't me"). The person is the session cookie's; a body is never read. No session is
  // 401; no fresh confirmation is 403 step_up_required (nothing changes, and the banner asks
  // the person to confirm it's them); nothing to close is 404.
  async function close(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    const token = readCookie(request, SESSION_COOKIE);
    const session = token ? await verifySession(db, token, { clock }) : null;
    if (!session) return json(401, { error: "unauthenticated" });
    if (!requireStepUp(session, { clock })) return json(403, { error: "step_up_required" });
    const result = await closeAccountReset(db, { userId: session.userId }, { clock });
    if (!result.ok) return json(404, { error: "no_completed_reset" });
    return json(200, { ok: true });
  }

  // Step 4 — email a code to an address whose reset has finished. Only such an account is
  // emailed; every address (a pending or cancelled reset, no reset, no account, or a code
  // limit reached) gets the same 200, so the step reveals nothing.
  async function setupSendCode(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email } = await parseBody(sendCodeSchema, request, { maxBytes: MAX_BODY_BYTES });
      const user = await getUserByEmail(db, email);
      if (user && (await hasCompletedReset(db, { userId: user.id }, { clock }))) {
        await issueEmailCode(db, user.email, { purpose: "reset", clock, random, hmacKey, emailSender: senders.email });
      }
      return json(200, { ok: true });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 5 — verify the emailed code, then begin the new passkey's registration, but only
  // for a finished reset. A wrong or lapsed code (or no account) is 400 and a throttled
  // address 429; a proven address whose reset is not finished (pending, cancelled, already
  // used or never asked for) is 409 and begins nothing.
  async function setupVerify(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, code } = await parseBody(requestSchema, request, { maxBytes: MAX_BODY_BYTES });
      const result = await verifyEmailCode(db, email, code, { purpose: "reset", clock, hmacKey, emailSender: senders.email });
      if (!result.ok) {
        if (result.reason === "throttled") {
          return new Response(JSON.stringify({ error: "throttled" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
            },
          });
        }
        return json(400, { error: "invalid_code" });
      }

      const user = await getUserByEmail(db, email);
      if (!user) return json(400, { error: "invalid_code" });
      if (!(await hasCompletedReset(db, { userId: user.id }, { clock }))) {
        // The address is proven, so say plainly when its reset was closed from a signed-in
        // device rather than that there is none.
        const closed = await isResetClosed(db, { userId: user.id });
        return json(409, { error: closed ? "reset_closed" : "no_completed_reset" });
      }

      const registrationOptions = await beginPasskeyRegistration(
        db,
        { userId: user.id, userName: user.email },
        { rpId, origin: publicOrigin, clock },
      );
      const setupId = Buffer.from(random.randomBytes(32)).toString("hex");
      pendingSetups.set(setupId, { userId: user.id }, clock.now());
      return json(200, { setupId, registrationOptions });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 6 — register the new passkey and re-enrol. The set-up handle is taken (single
  // use) before anything else, so a replay finds nothing; reenrolAfterReset's guarded
  // claim means only one re-enrolment per finished reset ever succeeds, however many
  // verified set-ups race. Any failure is 400 with no cookie and no code.
  async function setupFinish(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { setupId, registrationResponse } = await parseBody(setupFinishSchema, request, {
        maxBytes: MAX_SETUP_BODY_BYTES,
      });
      const pending = pendingSetups.get(setupId, clock.now());
      pendingSetups.delete(setupId);
      if (!pending) return json(400, { error: "unknown_setup" });

      const userId = pending.userId;
      const result = await reenrolAfterReset(
        db,
        { userId, response: registrationResponse as RegistrationResponseJSON },
        { rpId, origin: publicOrigin, clock, random },
      );
      if (!result.ok) return json(result.reason === "reset_closed" ? 409 : 400, { error: result.reason });
      discardPendingSignIns(userId, { clock });

      await deliverAlert("account-reenrolled", () =>
        alertAccountReenrolled(db, { userId }, { emailSender: senders.email }),
      );
      // The new recovery code, shown once (never cached), with the session cookie and the
      // device cookie marking this browser as one the person signs in on — as sign-in.
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      headers.append("set-cookie", result.session.cookie);
      headers.append("set-cookie", deviceCookieFor(userId, { hmacKey, random }));
      return new Response(JSON.stringify({ recoveryCode: result.recoveryCode }), { status: 200, headers });
    } catch (error) {
      return handleError(error);
    }
  }

  return { sendCode, request: requestReset, cancel, setupSendCode, setupVerify, setupFinish, close };
}
