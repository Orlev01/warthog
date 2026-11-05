// E08-S07 — Activity page server actions (dispute, undo, check integrity).
//
// The Activity screen's controls must call server-verified actions — the acting
// person is the VERIFIED Session's user id, never a client-supplied value (design
// §5: every member-scoped query is filtered by the session's user id). This factory
// is the testable core the thin `page.tsx` loader composes: it reads the session +
// the process-wide database, builds the sub-services (the dispute repo E08-S03, the
// undo service E08-S04, the integrity check E08-S02) and renders the view; the
// logic that turns a verified session into a dispute / undo / integrity outcome
// lives here.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file
// may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The testable logic lives here,
// the convention's `createXActions(deps)` pattern — exactly as the sibling security
// page uses `createSecurityActions(deps)`.
//
// Security (each a reviewer veto; design §5, INV-102/103):
//   • Every action derives the acting user id from `session.userId` — never a
//     client-supplied value. There is no `userId` parameter on any method.
//   • disputeEntry / undoEntry validate `entrySeq` at the boundary and REJECT
//     anything that is not a POSITIVE INTEGER with a 4xx `HttpError` (OBS-049), so a
//     bad id never reaches a query as a raw cast. An over-long / mis-shaped note or
//     reason is likewise rejected with a 4xx before any query runs.
//   • A well-formed id that is simply not this person's (or declares no reversal)
//     returns { ok: false } with a plain-words reason and changes nothing — a
//     reported refusal, never a silent success and never another person's row.
//   • Every statement under these actions is parameterized through the injected
//     seams (INV-102). This module reads no `process.env` and holds no secret
//     (INV-103): the db and both sub-services are INJECTED.

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import {
  checkIntegrity as runIntegrityCheck,
  type IntegrityResult,
} from "@/server/activity/integrity";
import type { Session } from "@/server/auth/session";
import type { Db } from "@/server/db/index";

// The sub-services the actions drive, declared as the MINIMAL behaviour each action
// needs (not the concrete exported type names) so these actions couple to behaviour
// — the real `DisputeRepo` / `UndoService` and a recording test stand-in both
// satisfy them. disputeEntry only files; undoEntry only undoes.
interface DisputeFiler {
  fileDispute(input: { userId: string; entrySeq: number; note: string }): Promise<unknown>;
}
interface EntryUndoer {
  undo(input: { userId: string; entrySeq: number; reason?: string }): Promise<
    { ok: true; entry: { seq: number } } | { ok: false; reason: string }
  >;
}

// The dependency bundle: the parameterizing db seam (the integrity check reads it,
// member-scoped) plus the two composed sub-services.
export interface ActivityActionsDeps {
  readonly db: Db;
  readonly disputes: DisputeFiler;
  readonly undo: EntryUndoer;
}

// A dispute / undo outcome: success, or a refusal naming its reason in plain words
// (never a silent success, never a silent failure).
export type DisputeResult = { ok: true } | { ok: false; reason: string };
export type UndoResult =
  | { ok: true; entry: { seq: number } }
  | { ok: false; reason: string };

// The activity actions the loader + its server-action wrappers drive.
export interface ActivityActions {
  disputeEntry(session: Session, entrySeq: number, note: string): Promise<DisputeResult>;
  undoEntry(session: Session, entrySeq: number, reason?: string): Promise<UndoResult>;
  checkIntegrity(session: Session): Promise<IntegrityResult>;
}

// An entry seq is a position within a person's own chain: a POSITIVE INTEGER. A
// value that is not (negative, zero, fractional, NaN, Infinity) is rejected at the
// validation boundary before it can reach `WHERE … seq = $n` as a raw cast
// (OBS-049). A note must carry some text and stay within a sane bound; a reason is
// optional but likewise bounded.
const NOTE_MAX = 4000;
const disputeInputSchema = z.object({
  entrySeq: z.number().int().positive(),
  note: z.string().min(1).max(NOTE_MAX),
});
const undoInputSchema = z.object({
  entrySeq: z.number().int().positive(),
  reason: z.string().max(NOTE_MAX).optional(),
});

// The plain-words refusal shown when a well-formed dispute is for an entry that is
// not this person's (the dispute repo rejects an entry the caller does not own). A
// fixed string, so no internal detail or ambient value leaks into the result.
const DISPUTE_REFUSED = "That activity entry can't be disputed.";

export function createActivityActions(deps: ActivityActionsDeps): ActivityActions {
  const { db, disputes, undo } = deps;

  // Dispute one of the acting person's OWN entries. Validate the id + note shape at
  // the boundary first (a bad id or an empty/oversized note throws a 4xx and never
  // reaches the repo), then file scoped to the SESSION user id. The repo rejects an
  // entry the caller does not own by throwing; translate that into a reported
  // refusal so another person's entry is never disputed and nothing changes.
  async function disputeEntry(
    session: Session,
    entrySeq: number,
    note: string,
  ): Promise<DisputeResult> {
    const input = parseParams(disputeInputSchema, { entrySeq, note });
    try {
      await disputes.fileDispute({
        userId: session.userId,
        entrySeq: input.entrySeq,
        note: input.note,
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: DISPUTE_REFUSED };
    }
  }

  // Undo one of the acting person's OWN reversible entries. Validate the id +
  // reason shape at the boundary first (a bad id or an oversized reason throws a 4xx
  // and never reaches the service), then undo scoped to the SESSION user id. The
  // service already reports an entry the caller does not own — or one that declares
  // no reversal — as { ok: false }; pass that refusal through and map the recorded
  // reversal entry to its seq.
  async function undoEntry(
    session: Session,
    entrySeq: number,
    reason?: string,
  ): Promise<UndoResult> {
    const input = parseParams(undoInputSchema, { entrySeq, reason });
    const result = await undo.undo({
      userId: session.userId,
      entrySeq: input.entrySeq,
      reason: input.reason,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, entry: { seq: result.entry.seq } };
  }

  // Verify the acting person's OWN activity chain, scoped to the SESSION user id
  // (bound as a parameter). Returns the whole result: a sound chain of N → intact
  // with checked = N and no broken seq; a tampered chain → the first broken seq.
  async function checkIntegrity(session: Session): Promise<IntegrityResult> {
    return runIntegrityCheck(db, session.userId);
  }

  return { disputeEntry, undoEntry, checkIntegrity };
}
