import { z } from "zod";
import { withTransaction, type Db } from "./index";
import { addNote, type TaskStatus } from "./tasks";

export const TASK_CLAIM_MS = 10 * 60_000;

export async function validTaskAssignee(
  db: Db,
  userId: string,
  assignee: string,
): Promise<boolean> {
  if (assignee === "any") return true;
  if (!z.uuid().safeParse(assignee).success) return false;
  return (
    (
      await db.query(
        "SELECT id FROM agents WHERE user_id = $1 AND id = $2 AND status = 'connected'",
        [userId, assignee],
      )
    ).rows.length > 0
  );
}

// The scope check, lease and note/status changes share a row lock. In particular,
// reassignment by the owner cannot race an earlier agent-side visibility check.
export async function changeTaskAsAgent(
  db: Db,
  input: {
    userId: string;
    agentId: string;
    id: string;
    status?: TaskStatus;
    note?: string;
  },
  dek: Uint8Array,
  now: Date,
): Promise<{ claimExpiresAt: string | null } | null> {
  if (!z.uuid().safeParse(input.id).success) return null;
  return withTransaction(db, async (tx) => {
    const row = (
      await tx.query(
        "SELECT assignee, status, claimed_by, claim_expires_at FROM tasks WHERE user_id = $1 AND id = $2 FOR UPDATE",
        [input.userId, input.id],
      )
    ).rows[0];
    if (!row || (row.assignee !== "any" && row.assignee !== input.agentId))
      return null;
    if (
      row.claimed_by &&
      row.claimed_by !== input.agentId &&
      new Date(row.claim_expires_at as string).getTime() > now.getTime()
    )
      return null;
    if (row.status === "done" && input.status !== "open") return null;
    const release = input.status === "open" || input.status === "done";
    const expiry =
      row.assignee === "any" && !release
        ? new Date(now.getTime() + TASK_CLAIM_MS).toISOString()
        : null;
    await tx.query(
      "UPDATE tasks SET status = COALESCE($3, status), claimed_by = $4, claim_expires_at = $5 WHERE user_id = $1 AND id = $2",
      [
        input.userId,
        input.id,
        input.status ?? null,
        expiry ? input.agentId : null,
        expiry,
      ],
    );
    if (input.note !== undefined)
      await addNote(
        tx,
        {
          userId: input.userId,
          id: input.id,
          author: { kind: "agent", agentId: input.agentId },
          text: input.note,
        },
        dek,
      );
    return { claimExpiresAt: expiry };
  });
}
