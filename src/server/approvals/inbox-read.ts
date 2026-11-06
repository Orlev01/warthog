// E12-S11 — the approval inbox read (design §6, brief "Approval inbox" /
// "Agents wait safely"). The inbox page needs ONE owner-scoped read of the person's
// PENDING requests plus a HISTORY of past decisions. It is distinct from the
// agent-facing `check_approval` (which tells the waiting agent its outcome): this read
// is for the OWNER and NEVER returns another person's approvals.
//
// It composes the already-built, tested storage primitives rather than re-running SQL
// or re-implementing decryption: `listPendingForUser` / `listDecidedForUser` hand back
// the DEK-decrypted `detail` (the plain-language `sentence`, the exact recipient /
// amount / field, the stated `reason` and the triggering `rule` — all opaque to this
// read), and `listAgentsForUser` resolves each requesting agent's display name. All
// three are member-scoped by the `userId` the caller passes (the session's id, never a
// client value) and bind that id as a parameter (INV-102) — so no person can read
// another's approvals and a value shaped like SQL travels as data, not statement text.
//
// The time left on a pending request is derived from the INJECTED clock (never SQL
// now()), floored at zero once the window has passed. This module reads no
// `process.env` and holds no key (INV-103): the `detail` decrypts only under the
// injected DEK, so a different DEK cannot read it back.

import { listDecidedForUser, listPendingForUser, type StoredApproval } from "../db/approvals";
import { listAgentsForUser } from "../db/agents";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

// The requesting agent, resolved for display from the agents aggregate.
export interface ApprovalAgentRef {
  readonly id: string;
  readonly displayName: string;
}

// A pending request awaiting the OWNER's decision.
export interface PendingApproval {
  readonly id: string;
  readonly agent: ApprovalAgentRef;
  readonly detail: Record<string, unknown>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly timeLeftMs: number;
  readonly status: "pending";
}

// A past decision: approved / denied / expired / more_detail.
export interface DecidedApproval {
  readonly id: string;
  readonly agent: ApprovalAgentRef;
  readonly detail: Record<string, unknown>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly decidedAt?: Date;
  readonly question?: string;
  readonly status: "approved" | "denied" | "expired" | "more_detail";
}

// The owner's inbox: PENDING requests newest-first, plus the decision HISTORY.
export interface Inbox {
  readonly pending: PendingApproval[];
  readonly history: DecidedApproval[];
}

// Read `userId`'s inbox: their PENDING approvals newest-created-first (each with its
// requesting agent, decrypted detail and the time left before expiry) plus a HISTORY of
// their decided approvals (approved / denied / expired / more_detail). Member-scoped by
// the passed `userId` alone — another person's approvals are never returned in either
// list. The detail decrypts under the injected `dek`; time left comes from `clock`.
export async function readInbox(
  db: Db,
  userId: string,
  dek: Uint8Array,
  clock: Clock,
): Promise<Inbox> {
  const [pendingRows, decidedRows, agents] = await Promise.all([
    listPendingForUser(db, userId, dek),
    listDecidedForUser(db, userId, dek),
    listAgentsForUser(db, userId),
  ]);

  // Resolve each approval's OWN requesting agent's display name from the person's own
  // agents (member-scoped); a value is carried for the id even if the agent row is gone.
  const nameById = new Map(agents.map((agent) => [agent.id, agent.displayName]));
  const agentRef = (agentId: string): ApprovalAgentRef => ({
    id: agentId,
    displayName: nameById.get(agentId) ?? "",
  });

  const now = clock.now().getTime();

  const pending: PendingApproval[] = pendingRows
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((row) => ({
      id: row.id,
      agent: agentRef(row.agentId),
      detail: row.detail,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      timeLeftMs: Math.max(0, row.expiresAt.getTime() - now),
      status: "pending",
    }));

  const history: DecidedApproval[] = decidedRows.map((row) => toDecided(row, agentRef));

  return { pending, history };
}

// Shape a decided stored approval for the history, carrying its decision outcome:
// `decidedAt` (set on approve / deny / expire) and `question` (set on more_detail).
function toDecided(
  row: StoredApproval,
  agentRef: (agentId: string) => ApprovalAgentRef,
): DecidedApproval {
  return {
    id: row.id,
    agent: agentRef(row.agentId),
    detail: row.detail,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    question: row.question,
    status: row.status as DecidedApproval["status"],
  };
}
