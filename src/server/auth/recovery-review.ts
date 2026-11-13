// Reviewing agents after an account recovery (sign-in audit, founder decision 13 November
// 2026). Recovery removes the lost passkeys and authenticator app and signs every device
// out, but it KEEPS agents, their access keys and their OAuth connections: those are not
// sign-in methods, and cutting them off would break whatever the person relies on. Whoever
// had the lost devices may have connected an agent of their own, though, so after a
// recovery Home shows a contained notice naming every agent that was connected at the time,
// with a link to each agent's settings (Replace key) and to Agents (Disconnect).
//
// The mechanism needs no schema change. The recovery's passkey step records one
// "account_recovered" activity entry (the person's own record of the event, on the
// Activity page). The notice is derived from that entry: it shows for
// RECOVERY_REVIEW_WINDOW_MS after the newest one, and a person who has reviewed the agents
// can dismiss it on that browser, which sets a cookie naming that entry, so a later
// recovery shows a fresh notice. Only the entry's plaintext metadata (kind, time, entry
// hash) is read, never its payload. Every read is member-scoped by the session's user id.

import { listAgentsForUser } from "../db/agents";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

const DAY_MS = 24 * 60 * 60 * 1000;

// The activity kind the recovery's passkey step records.
export const ACCOUNT_RECOVERED_KIND = "account_recovered";

// The entry's one-line summary (fixed copy; no code, token or credential).
export const ACCOUNT_RECOVERED_SUMMARY =
  "Recovered with the recovery code. A new passkey and recovery code were set up, the old " +
  "passkeys and authenticator app were removed, and every device was signed out.";

// How long after a recovery Home keeps asking the person to review their agents.
export const RECOVERY_REVIEW_WINDOW_MS = 14 * DAY_MS;

// The cookie a dismissal sets: the entry hash of the recovery whose notice was dismissed.
// HttpOnly and host-locked; it only hides a notice on this browser, so it grants nothing.
export const RECOVERY_REVIEW_COOKIE = "__Host-wh_recovery_review";

export interface RecoveryReviewAgent {
  readonly id: string;
  readonly name: string;
}

export interface RecoveryReview {
  // The recovery's activity entry hash: what a dismissal records.
  readonly id: string;
  readonly recoveredAt: Date;
  readonly agents: readonly RecoveryReviewAgent[];
}

// The display names of the account's connected agents, for the recovery alert.
export async function connectedAgentNames(db: Db, userId: string): Promise<string[]> {
  return (await listAgentsForUser(db, userId))
    .filter((agent) => agent.status === "connected")
    .map((agent) => agent.displayName);
}

// The newest recovery within the window, unless this browser dismissed it, with the agents
// that were connected when it happened and still are. Null when there is nothing to review.
export async function getRecoveryReview(
  db: Db,
  { userId }: { userId: string },
  deps: { readonly clock: Clock; readonly dismissed?: string | null },
): Promise<RecoveryReview | null> {
  const since = new Date(deps.clock.now().getTime() - RECOVERY_REVIEW_WINDOW_MS);
  const found = await db.query(
    `SELECT entry_hash, occurred_at FROM activity_entries
      WHERE user_id = $1 AND kind = $2 AND occurred_at > $3::timestamptz
      ORDER BY seq DESC LIMIT 1`,
    [userId, ACCOUNT_RECOVERED_KIND, since.toISOString()],
  );
  const row = found.rows[0];
  if (!row) return null;
  const id = row.entry_hash as string;
  if (deps.dismissed && deps.dismissed === id) return null;
  const recoveredAt = new Date(row.occurred_at as string | Date);
  const agents = (await listAgentsForUser(db, userId))
    .filter((agent) => agent.status === "connected" && new Date(agent.connectedAt).getTime() <= recoveredAt.getTime())
    .map((agent) => ({ id: agent.id, name: agent.displayName }));
  if (agents.length === 0) return null;
  return { id, recoveredAt, agents };
}
