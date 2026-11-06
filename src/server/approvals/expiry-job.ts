// E12-S09 — the approval expiry job (design §6 "Ask … Denied / expired → refusal";
// brief NFR: "an unanswered approval expires, is treated as denied, and returns a
// denial to the waiting agent"). This is the TIMER that enforces it.
//
// `runApprovalExpiry` is what the background worker runs when the expiry job it
// claimed (scheduled at the approval's `expires_at`) comes due. At that moment, for
// the one approval the job carries, it marks a still-PENDING approval whose window has
// passed as `expired` — so the waiting agent's next `check_approval` comes back a
// refusal (an expired request "is denied"). The lifecycle rules are NOT re-implemented
// here: the transition is applied through the already-built, tested approvals store
// `decide({status:"expired"})`, which delegates to the pure state machine's
// `expireIfDue`, so the rules live in ONE place. That delegation makes every case fall
// out for free:
//   • pending AND due (clock.now() >= expires_at) → expired, decided_at stamped;
//   • pending but NOT yet due → left pending (the timer only expires what is due);
//   • already decided (approved / denied / expired / more_detail) → left unchanged,
//     its status and decided_at untouched — so the timer never overwrites a decision;
//   • idempotent — a second run over an already-expired approval (even at a later
//     clock) changes nothing, because `expireIfDue` is a no-op once not pending.
//
// A SERVER module built purely from its INJECTED seams (db, clock, keyWrapper) plus its
// input: it reads no `process.env` and holds no secret (INV-103) — the KEK rides in the
// injected keyWrapper (used to recover the owner's DEK so the status transition persists
// through the store), and time comes from the injected Clock (never SQL now()). The one
// untrusted-shaped field (the approval id) is validated AND shape-guarded at the
// boundary (a UUID → a 4xx `HttpError` before any query runs, OBS-049/INV-102), so an
// injection-shaped id never reaches `WHERE id = $1` and cannot alter a query; every real
// value is bound as a parameter, never concatenated.

import { z } from "zod";

import { decide } from "../db/approvals";
import { getUserById } from "../db/users";
import { parseParams } from "../http/validate";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { KeyWrapper } from "../crypto/key-wrapper";

// The injected seams — no process.env (INV-103). `keyWrapper` unwraps the owner's
// wrapped DEK so the status transition can be persisted through the store's `decide`.
export interface ApprovalExpiryDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
}

export interface ApprovalExpiryInput {
  // The approval the due job carries (its `payload.approvalId`).
  readonly approvalId: string;
}

// Every approval id is a UUID (created with `randomUUID` / `gen_random_uuid`), and the
// `approvals.id` column is uuid-typed. A malformed, oversized or otherwise non-UUID id
// — e.g. a SQL-injection probe — can match no approval, so we refuse it at the boundary
// with a 4xx rather than feed it to a query where the uuid cast would fail (OBS-049).
const approvalIdSchema = z.uuid();

// Resolve the approval's OWNER (user id) in one parameterized read: the approval id is
// BOUND as a parameter (INV-102), never woven into the SQL text. The member scope is
// taken from the approval's own row, never from a client value. Returns null when no
// such approval exists.
async function ownerOf(db: Db, approvalId: string): Promise<string | null> {
  const result = await db.query(`SELECT user_id FROM approvals WHERE id = $1`, [approvalId]);
  const row = result.rows[0];
  return row ? (row.user_id as string) : null;
}

export async function runApprovalExpiry(
  deps: ApprovalExpiryDeps,
  input: ApprovalExpiryInput,
): Promise<void> {
  const { db, clock, keyWrapper } = deps;

  // VALIDATE + shape-guard at the boundary: a malformed / oversized / non-UUID id
  // throws a 4xx `HttpError` BEFORE any query runs, so nothing is touched and an
  // injection-shaped id never reaches a query (OBS-049).
  const approvalId = parseParams(approvalIdSchema, input.approvalId);

  // The approval's owner; no row ⇒ nothing to expire.
  const userId = await ownerOf(db, approvalId);
  if (userId === null) return;

  // Recover the owner's DEK (their wrapped DEK, unwrapped through the KeyWrapper seam)
  // so the store can read the detail and persist the transition. No row ⇒ nothing to do.
  const user = await getUserById(db, userId);
  if (!user) return;
  const dek = await keyWrapper.unwrap(user.wrappedDek);

  // Apply the expiry through the store, which delegates to the pure state machine's
  // `expireIfDue`: it expires ONLY a pending, due approval and leaves anything else
  // (not due, or already decided) unchanged — so this run is a no-op unless the window
  // has passed, and a second run over an already-expired approval changes nothing.
  await decide(db, { userId, id: approvalId, decision: { status: "expired" } }, dek, clock);
}
