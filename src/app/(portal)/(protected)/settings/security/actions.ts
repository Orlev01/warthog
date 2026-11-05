// E04-S15 — Security settings loader + actions (the injectable seam the thin
// `page.tsx` loader + its server-action wrappers compose).
//
// The security screen lets a person manage their OWN second factors and sessions
// (brief: "People manage their own factors and sessions; sensitive changes need
// step-up"; design §5). This factory is the testable core: it reads this person's
// passkeys and sessions (each session row is also a recent sign-in, carrying its
// own created_at / last_seen_at) and mutates them — add / remove a passkey, sign
// out another session, regenerate the recovery code.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file
// may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The thin loader reads the
// session + database and renders the view; the testable logic lives here (the
// convention's `createXHandler({ db })` pattern, here `createSecurityActions`).
//
// Security (each a reviewer veto; design §5):
//   • Every method takes the person's VERIFIED Session and derives the acting user
//     id from `session.userId` — never a client-supplied value. The loader lists
//     only that person's rows; every mutation is scoped `WHERE … AND user_id = $N`,
//     so an id belonging to someone else matches nothing and changes nothing (a
//     safe no-op reported as { ok: false }, never a silent success).
//   • Adding, removing a passkey, signing out a session and regenerating recovery
//     are SENSITIVE CHANGES: each requires a fresh step-up (requireStepUp, 5-minute
//     window). Without one the change is refused and nothing changes.
//   • A malformed id (not a well-formed uuid) is rejected at the validation
//     boundary with a 4xx HttpError (OBS-049) — it never reaches `WHERE id = $1` as
//     a cast and never surfaces as a 500. The RP ID is `deps.rpId` (from config),
//     never hard-coded. Every statement is parameterized (INV-102).

import { z } from "zod";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { parseParams } from "../../../../../server/http/validate";
import { requireStepUp } from "../../../../../server/auth/step-up";
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
} from "../../../../../server/auth/passkey";
import { issueRecoveryCode } from "../../../../../server/auth/recovery";
import { getUserById } from "../../../../../server/db/users";
import type { Session } from "../../../../../server/auth/session";
import type { Clock } from "../../../../../server/seams/clock";
import type { Random } from "../../../../../server/seams/random";
import type { Db } from "../../../../../server/db/index";

// The dependency bundle: the database seam, the injected clock + randomness (so
// step-up freshness and recovery entropy are deterministic in tests) and the
// WebAuthn RP ID read from config (never hard-coded).
export interface SecurityActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly rpId: string;
  // The app's public origin a new passkey's attestation is verified against.
  readonly origin?: string;
}

// A passkey as the loader surfaces it: its id (the handle remove takes) and when it
// was registered.
export interface PasskeySummary {
  readonly id: string;
  readonly createdAt: Date;
}

// A session as the loader surfaces it: its id (the handle sign-out takes) and its
// own timestamps — the same row is this person's active session AND a recent
// sign-in (its created_at is when it started; last_seen_at its latest activity).
export interface SessionSummary {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

// What the loader returns: only this person's passkeys and sessions.
export interface SecurityView {
  readonly passkeys: PasskeySummary[];
  readonly sessions: SessionSummary[];
}

// A single-step mutation's result: success, or a refusal naming its reason (a
// missing step-up, or an id that is not this person's). Never a silent success.
export type ActionResult = { ok: true } | { ok: false; reason: string };

// Begin-add-passkey hands back the WebAuthn creation options the browser passes to
// the authenticator (carrying the configured RP ID), or a refusal.
export type BeginAddPasskeyResult =
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON }
  | { ok: false; reason: string };

// Regenerate-recovery hands the fresh plaintext code back once (the single place it
// is ever returned), or a refusal.
export type RegenerateRecoveryResult =
  | { ok: true; code: string }
  | { ok: false; reason: string };

// The security actions the loader + its server-action wrappers drive.
export interface SecurityActions {
  load(session: Session): Promise<SecurityView>;
  beginAddPasskey(session: Session): Promise<BeginAddPasskeyResult>;
  finishAddPasskey(session: Session, response: RegistrationResponseJSON): Promise<ActionResult>;
  removePasskey(session: Session, passkeyId: string): Promise<ActionResult>;
  signOutSession(session: Session, sessionId: string): Promise<ActionResult>;
  regenerateRecovery(session: Session): Promise<RegenerateRecoveryResult>;
}

// The one reason string the step-up gate refuses with.
const STEP_UP_REQUIRED = "step_up_required";

// A well-formed uuid: the only shape an id handle may take. A malformed value is
// rejected at the validation boundary (parseParams throws a 4xx HttpError) before
// it can reach `WHERE id = $1` as a cast (OBS-049).
const uuidSchema = z.uuid();

export function createSecurityActions(deps: SecurityActionsDeps): SecurityActions {
  const { db, clock, random, rpId, origin } = deps;

  // List only the acting person's passkeys and sessions, scoped by the session's
  // own user id (never a client value). Sessions double as recent sign-ins, so
  // their timestamps come back too; newest activity first.
  async function load(session: Session): Promise<SecurityView> {
    const passkeyRows = await db.query(
      `SELECT id, created_at FROM passkeys WHERE user_id = $1 ORDER BY created_at`,
      [session.userId],
    );
    const sessionRows = await db.query(
      `SELECT id, created_at, last_seen_at FROM sessions WHERE user_id = $1 ORDER BY last_seen_at DESC`,
      [session.userId],
    );
    return {
      passkeys: passkeyRows.rows.map((row) => ({
        id: row.id as string,
        createdAt: new Date(row.created_at as string | number | Date),
      })),
      sessions: sessionRows.rows.map((row) => ({
        id: row.id as string,
        createdAt: new Date(row.created_at as string | number | Date),
        lastSeenAt: new Date(row.last_seen_at as string | number | Date),
      })),
    };
  }

  // Begin adding a passkey (a sensitive change): refuse without a fresh step-up,
  // else issue registration options carrying the configured RP ID for this person.
  async function beginAddPasskey(session: Session): Promise<BeginAddPasskeyResult> {
    if (!requireStepUp(session, { clock })) return { ok: false, reason: STEP_UP_REQUIRED };
    const user = await getUserById(db, session.userId);
    const options = await beginPasskeyRegistration(
      db,
      { userId: session.userId, userName: user?.email ?? session.userId },
      { rpId },
    );
    return { ok: true, options };
  }

  // Finish adding a passkey (a sensitive change): refuse without a fresh step-up,
  // else verify the attestation through the real passkey seam and store the
  // credential for this person.
  async function finishAddPasskey(
    session: Session,
    response: RegistrationResponseJSON,
  ): Promise<ActionResult> {
    if (!requireStepUp(session, { clock })) return { ok: false, reason: STEP_UP_REQUIRED };
    const result = await finishPasskeyRegistration(db, { userId: session.userId, response }, { rpId, origin });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  // Remove one of this person's passkeys. Validate the id shape at the boundary
  // first (a malformed id throws a 4xx), then require a fresh step-up, then delete
  // scoped to this person — an id that is not theirs deletes nothing ({ ok: false }).
  async function removePasskey(session: Session, passkeyId: string): Promise<ActionResult> {
    const id = parseParams(uuidSchema, passkeyId);
    if (!requireStepUp(session, { clock })) return { ok: false, reason: STEP_UP_REQUIRED };
    const result = await db.query(
      `DELETE FROM passkeys WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, session.userId],
    );
    return result.rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Sign out another of this person's sessions. Same discipline: validate the id
  // shape, require a fresh step-up, then delete scoped to this person — so the
  // signed-out session no longer verifies and drops out of the loader, while an id
  // that is not theirs ends nothing ({ ok: false }).
  async function signOutSession(session: Session, sessionId: string): Promise<ActionResult> {
    const id = parseParams(uuidSchema, sessionId);
    if (!requireStepUp(session, { clock })) return { ok: false, reason: STEP_UP_REQUIRED };
    const result = await db.query(
      `DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, session.userId],
    );
    return result.rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Regenerate this person's recovery code (a sensitive change): refuse without a
  // fresh step-up, else issue a fresh code — issueRecoveryCode replaces the prior
  // row, so exactly one code is current and the old one stops verifying.
  async function regenerateRecovery(session: Session): Promise<RegenerateRecoveryResult> {
    if (!requireStepUp(session, { clock })) return { ok: false, reason: STEP_UP_REQUIRED };
    const { code } = await issueRecoveryCode(db, session.userId, { random });
    return { ok: true, code };
  }

  return {
    load,
    beginAddPasskey,
    finishAddPasskey,
    removePasskey,
    signOutSession,
    regenerateRecovery,
  };
}
