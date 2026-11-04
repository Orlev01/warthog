// E03-S08 — Approvals state machine (brief "Agents wait safely"; design §6).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// "Agents wait safely": a request that needs approval is HELD by Warthog, not
// executed; when approved Warthog itself carries out the held request exactly as
// it was approved. So the transitions and the request-preservation invariant are
// deterministic code and live here, pure, built BEFORE the approval-creation and
// inbox tasks consume them. Time enters ONLY as an injected `now: Date` — a plain
// instant — so the module never reaches across the domain boundary into the
// server's Clock seam; the caller passes `clock.now()` in.
//
// Vocabulary is exactly the brief's / CLAUDE.md's: an approval has status
// `pending | approved | denied | expired | more_detail`; a reply links to the
// approval it answers by `in_reply_to` (the MCP wire name — the TS field is the
// camelCase `inReplyTo`). Expiry defaults to 15 minutes, bounded 2 minutes to 24
// hours; an expired request "is denied" and the waiting agent receives a denial.

/** The lifecycle status of an approval. */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "more_detail";

/**
 * A held request awaiting the person's decision. `request` is the held call
 * carried verbatim and never inspected (design §6: the call's "encrypted args"),
 * preserved unchanged across the whole lifecycle so that what is executed on
 * approval is exactly what the person saw — never something the agent swapped in.
 */
export interface Approval {
  id: string;
  agentId: string;
  status: ApprovalStatus;
  request: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
  decidedAt?: Date;
  question?: string;
  answer?: string;
  inReplyTo?: string;
}

/** What is needed to hold a fresh request. */
export interface CreateApprovalInput {
  id: string;
  agentId: string;
  request: Record<string, unknown>;
  expiryMinutes?: number;
}

export const DEFAULT_EXPIRY_MINUTES = 15;
export const MIN_EXPIRY_MINUTES = 2;
export const MAX_EXPIRY_MINUTES = 1440; // 24 hours

const MINUTE_MS = 60_000;

/**
 * The moment of an instant as epoch-ms. Takes a Date per the contract but
 * tolerates an epoch-ms or ISO-string representation too, so a reasonable
 * representation choice never reddens a test for the wrong reason.
 */
function ms(value: Date | number | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * The configured expiry, bounded to [MIN, MAX]; an omitted value falls back to
 * DEFAULT. A below-floor value is raised to the floor, an above-ceiling value is
 * lowered to the ceiling.
 */
export function clampExpiryMinutes(minutes?: number): number {
  if (minutes === undefined) return DEFAULT_EXPIRY_MINUTES;
  return Math.min(MAX_EXPIRY_MINUTES, Math.max(MIN_EXPIRY_MINUTES, minutes));
}

/**
 * Hold a fresh request as a PENDING approval. `createdAt` is the injected now;
 * `expiresAt` is now plus the clamped expiry window. Pure — the injected instant
 * is left untouched.
 */
export function createApproval(input: CreateApprovalInput, now: Date): Approval {
  const windowMs = clampExpiryMinutes(input.expiryMinutes) * MINUTE_MS;
  return {
    id: input.id,
    agentId: input.agentId,
    status: "pending",
    request: input.request,
    createdAt: new Date(ms(now)),
    expiresAt: new Date(ms(now) + windowMs),
  };
}

/** Guard: only a pending approval may be decided or asked about. */
function requirePending(approval: Approval, action: string): void {
  if (approval.status !== "pending") {
    throw new Error(
      `Cannot ${action} an approval in status "${approval.status}"; only a pending approval can be.`,
    );
  }
}

/**
 * A pending approval → approved, stamping the decision time. Illegal from any
 * non-pending status (throws — never fails silently). Returns a new object and
 * does not mutate the input.
 */
export function approve(approval: Approval, now: Date): Approval {
  requirePending(approval, "approve");
  return { ...approval, status: "approved", decidedAt: new Date(ms(now)) };
}

/**
 * A pending approval → denied, stamping the decision time. Illegal from any
 * non-pending status (throws). Returns a new object and does not mutate the input.
 */
export function deny(approval: Approval, now: Date): Approval {
  requirePending(approval, "deny");
  return { ...approval, status: "denied", decidedAt: new Date(ms(now)) };
}

/**
 * A pending approval → more_detail, recording the question on the SAME approval
 * (same id). Illegal from any non-pending status (throws); an empty or blank
 * question is rejected ("records a question" needs one). The held request is
 * preserved while detail is sought.
 */
export function askForMoreDetail(
  approval: Approval,
  question: string,
  _now: Date,
): Approval {
  requirePending(approval, "ask for more detail");
  if (question.trim() === "") {
    throw new Error("A question is required to ask for more detail.");
  }
  return { ...approval, status: "more_detail", question };
}

/**
 * The agent answers a more_detail approval, creating a NEW linked PENDING
 * approval (`input.id`) with `inReplyTo` pointing at the answered approval and the
 * agent's answer. It CARRIES THE ORIGINAL HELD REQUEST FORWARD unchanged — the
 * reply takes no request of its own, so the agent cannot swap what gets executed.
 * A fresh expiry window opens from `now`, inheriting the answered approval's
 * configured duration. Illegal unless the answered approval is in more_detail.
 */
export function reply(
  approval: Approval,
  input: { id: string; answer?: string },
  now: Date,
): Approval {
  if (approval.status !== "more_detail") {
    throw new Error(
      `Cannot reply to an approval in status "${approval.status}"; only one waiting on more detail can be answered.`,
    );
  }
  const windowMs = ms(approval.expiresAt) - ms(approval.createdAt);
  return {
    id: input.id,
    agentId: approval.agentId,
    status: "pending",
    request: approval.request,
    createdAt: new Date(ms(now)),
    expiresAt: new Date(ms(now) + windowMs),
    answer: input.answer,
    inReplyTo: approval.id,
  };
}

/**
 * A PENDING approval whose expiry time has been reached (now >= expiresAt) →
 * expired, stamping the decision time. Anything else — not pending, or not yet
 * due — is returned UNCHANGED, so the check is idempotent and never expires a
 * decision out from under itself.
 */
export function expireIfDue(approval: Approval, now: Date): Approval {
  if (approval.status !== "pending") return approval;
  if (ms(now) < ms(approval.expiresAt)) return approval;
  return { ...approval, status: "expired", decidedAt: new Date(ms(now)) };
}

/**
 * What the waiting agent is handed. An expired request collapses to "denied" (the
 * AC's "treats it as denied"); pending / approved / denied / more_detail map to
 * themselves.
 */
export function agentDecision(
  approval: Approval,
): "pending" | "approved" | "denied" | "more_detail" {
  switch (approval.status) {
    case "expired":
      return "denied";
    case "pending":
      return "pending";
    case "approved":
      return "approved";
    case "denied":
      return "denied";
    case "more_detail":
      return "more_detail";
  }
}
