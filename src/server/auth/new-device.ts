// New-device sign-in approval (design §5: "New-device sign-in: email code +
// (synced passkey | hybrid QR | approval from a signed-in device via push +
// step-up | recovery code)").
//
// On a new phone or computer the person types their email one-time code (the
// FIRST factor) and then proves themselves a SECOND way; the second factor
// completes the sign-in and a brand-new session is minted for the REQUESTING
// device only. Every method here gates on the email code first — a wrong code
// blocks all of them — then runs its second factor against the REAL sibling
// modules (email-code, passkey, recovery, session, step-up); none of these
// functions throws for an expected failure, they return { ok: false, reason }.
//
// Four second factors:
//   • synced passkey / hybrid QR — a WebAuthn assertion the new device presents.
//     Both transports are server-identical (one assertion verify covers both).
//   • recovery code — the last-resort secret.
//   • approval from a signed-in device — a two-party handshake: the new device
//     requests approval (one push is sent naming it), an existing signed-in
//     device of the SAME person approves after a fresh step-up, then the new
//     device collects its session. Approving hands the approver NO session; the
//     session appears only when the requesting device collects, exactly once.
//
// The one piece of new state this task owns — the pending approval request —
// lives in process memory (the release-store pattern): a Map keyed by a random
// bearer handle, with a single collection. It touches only this module and adds
// no migration, so nothing about a pending request is written to the database.
// Every member-scoped decision takes its userId from the session (the approver's
// own `approvingSession.userId`), never from a client-supplied value.

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import { verifyEmailCode } from "./email-code";
import { verifyRecoveryCode } from "./recovery";
import { finishPasskeyAuthentication } from "./passkey";
import { pendingStore } from "./pending-store";
import { createSession, type Session } from "./session";
import { requireStepUp } from "./step-up";
import { getUserByEmail, type User } from "../db/users";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { EmailSender, PushSender } from "../notify/senders";
import type { Db } from "../db/index";

// The successful result of every sign-in method: the stored session plus the raw
// token and Set-Cookie value the new device holds. An expected failure names its
// reason and never throws.
export type NewDeviceResult =
  | { ok: true; session: Session; token: string; cookie: string }
  | { ok: false; reason: string };

// Each function reads only the subset of the deps bundle it needs; the caller's
// superset bundle is structurally assignable to each of these.

// Verifying the email-code first factor: the clock bounds the code window, the
// HMAC key matches the issuer's, and the sender carries the throttle alert.
interface FirstFactorDeps {
  readonly clock: Clock;
  readonly hmacKey: Uint8Array;
  readonly emailSender: EmailSender;
}

// A self-service passkey sign-in: first factor + the assertion verify (rpId) +
// session minting (clock, random).
export interface PasskeySignInDeps extends FirstFactorDeps {
  readonly random: Random;
  readonly rpId: string;
  // The app's public origin the assertion is verified against (see PasskeyDeps).
  readonly origin?: string;
}

// A self-service recovery-code sign-in: first factor + session minting.
export interface RecoverySignInDeps extends FirstFactorDeps {
  readonly random: Random;
}

// Starting an approval request: first factor + a random bearer handle + the push.
export interface RequestApprovalDeps extends FirstFactorDeps {
  readonly random: Random;
  readonly pushSender: PushSender;
}

// Approving reads only the clock, to judge the approver's step-up freshness.
export interface ApproveDeps {
  readonly clock: Clock;
}

// Collecting mints the new device's session (clock, random).
export interface CollectDeps {
  readonly clock: Clock;
  readonly random: Random;
}

// A pending approval request, held in process memory. `userId` is the account the
// new device is signing in to (resolved from the email at request time, never
// from the client); `approved` flips true only when the owner approves.
interface PendingRequest {
  readonly userId: string;
  approved: boolean;
}

// The process-wide pending-request store (the release-store pattern). Keys are
// full-entropy random handles, so requests never collide across callers. It is bounded
// and expiring (pending-store): a request must be approved and collected within ten
// minutes, so a stale approved request can never be collected days later.
const pendingRequests = pendingStore<PendingRequest>("auth.newDeviceRequests", {
  ttlMs: 10 * 60 * 1000,
  maxEntries: 10_000,
});

// Verify the email one-time code (the first factor) and resolve the person it is
// for. Returns the person on success; null when the code is wrong/expired/
// throttled OR no account exists for the email — the single gate every method
// runs before its second factor. The code is consumed by a successful verify.
async function completeFirstFactor(
  db: Db,
  email: string,
  code: string,
  deps: FirstFactorDeps,
): Promise<User | null> {
  const codeResult = await verifyEmailCode(db, email, code, {
    clock: deps.clock,
    hmacKey: deps.hmacKey,
    emailSender: deps.emailSender,
  });
  if (!codeResult.ok) return null;
  return getUserByEmail(db, email);
}

// Mint a fresh session for `userId` and shape it as a successful NewDeviceResult.
async function issueSessionFor(
  db: Db,
  userId: string,
  deps: { clock: Clock; random: Random },
): Promise<NewDeviceResult> {
  const created = await createSession(db, userId, { clock: deps.clock, random: deps.random });
  return { ok: true, session: created.session, token: created.token, cookie: created.cookie };
}

// Synced passkey / hybrid QR: email code + a WebAuthn assertion against one of the
// person's registered passkeys. A failed code, no account, or an assertion that is
// not the claimed person's own → { ok: false }; otherwise a session for the new
// device.
export async function signInNewDeviceWithPasskey(
  db: Db,
  params: { email: string; code: string; response: AuthenticationResponseJSON },
  deps: PasskeySignInDeps,
): Promise<NewDeviceResult> {
  const person = await completeFirstFactor(db, params.email, params.code, deps);
  if (!person) return { ok: false, reason: "invalid_code" };

  const assertion = await finishPasskeyAuthentication(
    db,
    { userId: person.id, response: params.response },
    { rpId: deps.rpId, origin: deps.origin },
  );
  if (!assertion.ok) return { ok: false, reason: assertion.reason };

  return issueSessionFor(db, person.id, deps);
}

// Recovery code: email code + the person's current recovery code. A failed code,
// no account, or a wrong recovery code → { ok: false }; otherwise a session.
export async function signInNewDeviceWithRecoveryCode(
  db: Db,
  params: { email: string; code: string; recoveryCode: string },
  deps: RecoverySignInDeps,
): Promise<NewDeviceResult> {
  const person = await completeFirstFactor(db, params.email, params.code, deps);
  if (!person) return { ok: false, reason: "invalid_code" };

  const ok = await verifyRecoveryCode(db, person.id, params.recoveryCode);
  if (!ok) return { ok: false, reason: "recovery_rejected" };

  return issueSessionFor(db, person.id, deps);
}

// Start an approval-from-a-signed-in-device request. Gated on the email code: a
// failed code (or no account) starts nothing and sends no push. On success a
// pending request is recorded for the person and ONE push is sent naming the new
// device, and the random collection handle is returned to the requesting device
// ONLY — it never rides along in the push (approvals happen inside the signed-in
// app, and the handle is a bearer secret for the new device alone).
export async function requestNewDeviceApproval(
  db: Db,
  params: { email: string; code: string; deviceLabel: string },
  deps: RequestApprovalDeps,
): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }> {
  const person = await completeFirstFactor(db, params.email, params.code, deps);
  if (!person) return { ok: false, reason: "invalid_code" };

  const requestId = Buffer.from(deps.random.randomBytes(32)).toString("hex");
  pendingRequests.set(requestId, { userId: person.id, approved: false }, deps.clock.now());

  await deps.pushSender.sendPush({
    recipient: person.id,
    body: `Approve sign-in on ${params.deviceLabel}?`,
  });

  return { ok: true, requestId };
}

// Approve a pending request from an existing signed-in device. Accepted only when
// the approving session passes a FRESH step-up AND the request belongs to the
// approver's OWN account (the userId comes from the session, never the client).
// Marks the request approved and returns NO session — approving never hands the
// approver a session. Never throws for an unknown request, a stale step-up or a
// wrong owner.
export async function approveNewDeviceRequest(
  db: Db,
  params: { requestId: string; approvingSession: Session },
  deps: ApproveDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const request = pendingRequests.get(params.requestId, deps.clock.now());
  if (!request) return { ok: false, reason: "unknown_request" };

  if (!requireStepUp(params.approvingSession, { clock: deps.clock })) {
    return { ok: false, reason: "step_up_required" };
  }
  if (request.userId !== params.approvingSession.userId) {
    return { ok: false, reason: "not_owner" };
  }

  request.approved = true;
  return { ok: true };
}

// Collect the session for an approved request from the requesting device. Not-ok
// for an unknown handle, a request not yet approved, or one already collected.
// Once approved it issues a session exactly once: the handle is dropped on a
// successful collection (single use, like the release store), so a second collect
// yields nothing.
export async function collectNewDeviceApproval(
  db: Db,
  params: { requestId: string },
  deps: CollectDeps,
): Promise<NewDeviceResult> {
  const request = pendingRequests.get(params.requestId, deps.clock.now());
  if (!request) return { ok: false, reason: "unknown_request" };
  if (!request.approved) return { ok: false, reason: "not_approved" };

  pendingRequests.delete(params.requestId);
  return issueSessionFor(db, request.userId, deps);
}
