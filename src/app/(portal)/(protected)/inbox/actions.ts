// E12-S10 — Approval decision actions (the injectable seam the thin inbox
// `page.tsx` loader + its server-action wrappers compose).
//
// The inbox lets a person decide the approvals agents are waiting on (brief
// "Approval inbox" / "Agents wait safely"; design §6). This factory is the
// testable core behind the inbox controls: approve, deny, or ask the agent for
// more detail — each a server-verified decision, never trusted from the client.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry
// file may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The thin loader renders the
// inbox; the testable decision logic lives here (the convention's
// `createXActions(deps)` pattern, the same shape as `createSecurityActions`).
//
// Security (each a reviewer veto; CLAUDE.md member scope + design §5/§6):
//   • Every method takes the person's VERIFIED Session and derives the acting
//     user id from `session.userId` — never a client-supplied value. Every read
//     and write is member-scoped by that id, so a signed-in person can never
//     decide (or even mark opened) another person's approval by its id: it
//     resolves to no row for them and is refused ({ ok: false }), never a silent
//     success and never a throw.
//   • approveApproval moves the approval to `approved`; for a held NON-release
//     call it then triggers that call's single execution via the pipeline's
//     `executeApprovedHold` (single-shot, so the held tool runs exactly once).
//     denyApproval moves it to `denied`; askForMoreDetail moves it to
//     `more_detail`, recording the person's question. Each decision also marks
//     the approval opened (the inbox view write).
//   • Approving a HIGH-TIER or CARD release is a sensitive hand-over: it requires
//     a fresh step-up (requireStepUp, 5-minute window). Without one the approval
//     is NOT approved and nothing is handed over — refused with a plain reason. A
//     release is NEVER run through the pipeline (the agent collects it via
//     `collect_release`); only a held non-release call is executed on approval.
//   • A mis-shaped approval id (not a well-formed uuid) and an empty/oversized
//     question are rejected at the validation boundary with a 4xx HttpError
//     (parseParams, OBS-049/INV-102) — never cast at `WHERE id = $1`, never a
//     500. Every statement the actions issue is parameterized, so a SQL-shaped
//     value travels as a BOUND value and cannot alter a query.
//   • The actions run purely from their injected seams (db, clock, keyWrapper,
//     executeApprovedHold): they read no `process.env` and hold no secret
//     (INV-103), so no ambient env value can leak into a result or stored content.

import { z } from "zod";

import { parseParams } from "../../../../server/http/validate";
import { requireStepUp } from "../../../../server/auth/step-up";
import { decide, getApproval } from "../../../../server/db/approvals";
import { markOpened } from "../../../../server/approvals/opened";
import { getUserById } from "../../../../server/db/users";
import type { Session } from "../../../../server/auth/session";
import type { Clock } from "../../../../server/seams/clock";
import type { KeyWrapper } from "../../../../server/crypto/key-wrapper";
import type { Db } from "../../../../server/db/index";
import type { ApprovedHoldResult } from "../../../../server/mcp/pipeline";

// The injected seams — no process.env (INV-103). `executeApprovedHold` is the
// pipeline's own single-shot runner for an approved held call (taken as a seam so
// the actions never re-implement it and a test can observe it running exactly once).
export interface InboxActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
  readonly executeApprovedHold: (userId: string, approvalId: string) => Promise<ApprovedHoldResult>;
}

// A decision's result: success, or a refusal naming its reason (an id/approval
// that is not this person's, or a release awaiting a fresh step-up). Never a
// silent success. The page maps the reason code to plain copy.
export type ActionResult = { ok: true } | { ok: false; reason: string };

// The inbox decision actions the loader + its server-action wrappers drive.
export interface InboxActions {
  approveApproval(session: Session, approvalId: string): Promise<ActionResult>;
  denyApproval(session: Session, approvalId: string): Promise<ActionResult>;
  askForMoreDetail(session: Session, approvalId: string, question: string): Promise<ActionResult>;
}

// The refusal reason codes (mapped to copy by the page). Short, stable strings —
// the same vocabulary the sibling security actions use.
const NOT_FOUND = "not_found";
const STEP_UP_REQUIRED = "step_up_required";

// A well-formed uuid: the only shape an approval id may take. A malformed value is
// rejected at the validation boundary (parseParams throws a 4xx HttpError) before
// it can reach `WHERE id = $1` as a cast (OBS-049).
const uuidSchema = z.uuid();

// The longest a more-detail question may be: a few sentences, not a payload. An
// empty/blank or over-long question is rejected at the boundary with a 4xx rather
// than escaping as a 500 from the state machine (which also forbids a blank one).
const MAX_QUESTION_CHARS = 2000;
const questionSchema = z
  .string()
  .min(1)
  .max(MAX_QUESTION_CHARS)
  .refine((value) => value.trim().length > 0);

export function createInboxActions(deps: InboxActionsDeps): InboxActions {
  const { db, clock, keyWrapper, executeApprovedHold } = deps;

  // Resolve the acting person's unwrapped DEK (to decrypt the approval detail and
  // the held args). Read the wrapped DEK member-scoped by `userId` (the session's,
  // never a client value) and unwrap it through the KeyWrapper seam. Throws when
  // the person has no row — never fails silently.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("inbox actions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Load the one approval with `id` OWNED BY the session's user, with its detail
  // decrypted under the person's DEK. Null when none is theirs — so another
  // person's id resolves to nothing and the caller refuses. `id` is assumed
  // already validated at the boundary.
  async function loadOwn(session: Session, id: string) {
    const dek = await dataKeyFor(session.userId);
    const approval = await getApproval(db, session.userId, id, dek);
    return approval ? { dek, approval } : null;
  }

  // Approve an approval. Validate the id shape at the boundary; load the one that
  // is this person's (refuse otherwise); gate a high-tier/card RELEASE on a fresh
  // step-up (refuse without one, approving nothing); then mark it opened, move it
  // to `approved`, and — for a held NON-release call only — trigger its single
  // execution through the pipeline (a release is collected separately, never run).
  async function approveApproval(session: Session, approvalId: string): Promise<ActionResult> {
    const id = parseParams(uuidSchema, approvalId);
    const own = await loadOwn(session, id);
    if (!own) return { ok: false, reason: NOT_FOUND };

    const request = own.approval.detail.request;
    const isRelease = request === "card" || request === "high_tier";
    if (isRelease && !requireStepUp(session, { clock })) {
      return { ok: false, reason: STEP_UP_REQUIRED };
    }

    await markOpened(db, { id, userId: session.userId }, clock);
    await decide(db, { userId: session.userId, id, decision: { status: "approved" } }, own.dek, clock);

    if (!isRelease) {
      await executeApprovedHold(session.userId, id);
    }
    return { ok: true };
  }

  // Deny an approval: validate, load the person's own (refuse otherwise), mark it
  // opened and move it to `denied`. Nothing is executed — the held call is left
  // waiting and can never run.
  async function denyApproval(session: Session, approvalId: string): Promise<ActionResult> {
    const id = parseParams(uuidSchema, approvalId);
    const own = await loadOwn(session, id);
    if (!own) return { ok: false, reason: NOT_FOUND };

    await markOpened(db, { id, userId: session.userId }, clock);
    await decide(db, { userId: session.userId, id, decision: { status: "denied" } }, own.dek, clock);
    return { ok: true };
  }

  // Ask the agent for more detail: validate the id AND the question at the boundary
  // (both throw a 4xx before any db access), load the person's own approval (refuse
  // otherwise), mark it opened and move it to `more_detail`, recording the question.
  // Nothing is executed.
  async function askForMoreDetail(
    session: Session,
    approvalId: string,
    question: string,
  ): Promise<ActionResult> {
    const id = parseParams(uuidSchema, approvalId);
    const q = parseParams(questionSchema, question);
    const own = await loadOwn(session, id);
    if (!own) return { ok: false, reason: NOT_FOUND };

    await markOpened(db, { id, userId: session.userId }, clock);
    await decide(
      db,
      { userId: session.userId, id, decision: { status: "more_detail", question: q } },
      own.dek,
      clock,
    );
    return { ok: true };
  }

  return { approveApproval, denyApproval, askForMoreDetail };
}
