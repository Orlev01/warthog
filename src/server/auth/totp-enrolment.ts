// Authenticator set-up after sign-up, from Settings › Security (follow-up S1; see
// docs/adr/security-followups-2026-11.md). Sign-up was the only place an authenticator app
// could be added (docs/adr/authenticator-signup.md), so a member who chose a passkey had no
// second kind of sign-in method to fall back on. This is the signed-in enrolment, under the
// sign-up rules plus the step-up gate every Security change carries:
//
//   begin(session)        — fresh step-up required. Refused when the account already has an
//                           authenticator (this never replaces one). Otherwise issues — or
//                           returns the existing — pending secret and its QR. Asking again
//                           returns the SAME secret and QR: it neither resets the attempt
//                           counter nor extends the time-to-live.
//   verify(session, code) — fresh step-up required. A six-digit code is checked against the
//                           pending secret; five wrong codes use up the attempts. Only one
//                           verification runs at a time. A match stores the secret
//                           DEK-encrypted with its accepted time step (totp-store `enrol`), so
//                           the code cannot be replayed to sign in or confirm, discards the
//                           pending secret and emails the new-sign-in-method alert.
//
// The pending secret lives only in process memory (pending-store: bounded and expiring),
// keyed by the account the SESSION belongs to — never an id from the client — so two tabs
// share one enrolment and one attempt counter. It is returned only by begin, for display
// during set-up, and never reaches a log, a notice or an alert.

import { enrollTotp, matchTotpStep } from "./totp";
import { pendingStore } from "./pending-store";
import { requireStepUp } from "./step-up";
import { stillSignedIn } from "./sign-in-guard";
import { alertNewAuthenticator, deliverAlert, type AlertDeps } from "./alerts";
import type { Session } from "./session";
import type { TotpSecretStore } from "./totp-store";
import { getUserById } from "../db/users";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Db } from "../db/index";

// How long a pending set-up lasts from when it was first issued.
export const TOTP_ENROLMENT_TTL_MS = 10 * 60 * 1000;
// Wrong codes allowed per pending set-up (the sign-up enrolment limit).
export const TOTP_ENROLMENT_MAX_ATTEMPTS = 5;

export interface TotpEnrolmentDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly totpSecrets: Pick<TotpSecretStore, "enrol">;
  // Where the new-sign-in-method alert goes. Optional so a bundle without a sender still
  // works; the Security page always wires it.
  readonly alerts?: AlertDeps;
}

export type BeginTotpEnrolmentResult =
  | { ok: true; secret: string; qr: string }
  | { ok: false; reason: "step_up_required" | "already_enrolled" | "in_progress" };

export type VerifyTotpEnrolmentResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "step_up_required"
        | "already_enrolled"
        | "no_enrolment"
        | "in_progress"
        | "invalid_code"
        | "too_many_attempts"
        | "signed_out";
    };

export interface TotpEnrolment {
  begin(session: Session): Promise<BeginTotpEnrolmentResult>;
  verify(session: Session, code: string): Promise<VerifyTotpEnrolmentResult>;
}

interface PendingEnrolment {
  readonly secret: string;
  readonly qr: string;
  attempts: number;
  processing: boolean;
}

// One pending set-up per account. Only signed-in, stepped-up members create entries, but the
// store is still bounded and expiring like every other pending auth state.
const pendingEnrolments = pendingStore<PendingEnrolment>("auth.settingsTotpEnrolments", {
  ttlMs: TOTP_ENROLMENT_TTL_MS,
  maxEntries: 10_000,
});

const SIX_DIGITS = /^[0-9]{6}$/;

// Recovery and reset re-enrolment evict the lost devices (recover-session). A set-up begun
// before that belongs to them, so it goes too: otherwise the owner adding an authenticator
// within its lifetime would be handed a secret the other device already holds.
export function discardTotpEnrolment(userId: string): void {
  pendingEnrolments.delete(userId);
}

export function createTotpEnrolment(deps: TotpEnrolmentDeps): TotpEnrolment {
  const { db, clock, random, totpSecrets, alerts } = deps;

  // Enrolment metadata only: whether a secret row exists, never the secret itself.
  async function alreadyEnrolled(userId: string): Promise<boolean> {
    const result = await db.query(
      "SELECT EXISTS (SELECT 1 FROM totp_secrets WHERE user_id = $1) AS enrolled",
      [userId],
    );
    return result.rows[0]?.enrolled === true;
  }

  async function begin(session: Session): Promise<BeginTotpEnrolmentResult> {
    if (!requireStepUp(session, { clock })) return { ok: false, reason: "step_up_required" };
    const userId = session.userId;
    if (await alreadyEnrolled(userId)) {
      pendingEnrolments.delete(userId);
      return { ok: false, reason: "already_enrolled" };
    }

    let pending = pendingEnrolments.get(userId, clock.now());
    if (!pending) {
      const user = await getUserById(db, userId);
      const issued = await enrollTotp({ account: user?.email ?? "Warthog account", issuer: "Warthog" }, { random });
      // Another begin may have issued one while this one awaited: keep the first, so every
      // tab shows the same secret and the attempt counter is never replaced.
      pending = pendingEnrolments.get(userId, clock.now());
      if (!pending) {
        pending = { secret: issued.secret, qr: issued.qr, attempts: 0, processing: false };
        pendingEnrolments.set(userId, pending, clock.now());
      }
    }
    if (pending.processing) return { ok: false, reason: "in_progress" };
    return { ok: true, secret: pending.secret, qr: pending.qr };
  }

  async function verify(session: Session, code: string): Promise<VerifyTotpEnrolmentResult> {
    if (!requireStepUp(session, { clock })) return { ok: false, reason: "step_up_required" };
    // A malformed value is refused before it is counted, as sign-up's boundary does.
    if (!SIX_DIGITS.test(code)) return { ok: false, reason: "invalid_code" };
    const userId = session.userId;
    const pending = pendingEnrolments.get(userId, clock.now());
    if (!pending) {
      return (await alreadyEnrolled(userId))
        ? { ok: false, reason: "already_enrolled" }
        : { ok: false, reason: "no_enrolment" };
    }
    // Everything up to the claim below is synchronous, so a second verification started in
    // parallel always sees the claim (single-flight) and is never counted.
    if (pending.processing) return { ok: false, reason: "in_progress" };
    if (pending.attempts >= TOTP_ENROLMENT_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
    pending.attempts += 1;
    const step = matchTotpStep(pending.secret, code, { clock });
    if (step === null) return { ok: false, reason: "invalid_code" };

    pending.processing = true;
    try {
      // Stored only while this session still exists, under the account lock: a recovery that
      // signed it out first leaves nothing to add to (sign-in-guard.ts).
      const stored = await totpSecrets.enrol(userId, pending.secret, step, (tx) => stillSignedIn(tx, session));
      pendingEnrolments.delete(userId);
      if (stored === null) return { ok: false, reason: "signed_out" };
      if (!stored) return { ok: false, reason: "already_enrolled" };
    } finally {
      pending.processing = false;
    }
    // Tell the person (best effort: a send failure never undoes the new sign-in method).
    if (alerts) await deliverAlert("new-authenticator", () => alertNewAuthenticator(db, { userId }, alerts));
    return { ok: true };
  }

  return { begin, verify };
}
