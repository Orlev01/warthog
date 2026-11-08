// E04-S40 — the production account-reset executor (design §5; `../auth/account-reset`).
//
// A completed 7-day account reset is NOT an account deletion: it ERASES the person's
// VK-wrapped vault data and REVOKES every agent and service connection, while KEEPING
// everything else — the `users` row, the wrapped DEK, the low-tier identity fields and
// the whole activity history all survive (design §5). `completeAccountReset` owns the
// state machine (pending → done) and delegates this cross-aggregate work through the
// `ResetExecutor` seam; this module is the real implementation over the `Db`, wired in
// at the job-runtime composition root (`../jobs/compose`) in place of the throwing
// "not configured" stub.
//
// Every operation is member-scoped by the passed `userId` ALONE — the id the reset
// state machine resolved, never a client value (INV-102): each statement binds it as a
// parameter (never concatenated into the SQL text, so a value shaped like SQL is handled
// as data), and each `WHERE user_id = $1` touches only that person's rows, so another
// person's vault, agents and connections are left wholly intact. Each method runs its
// writes in ONE transaction (`withTransaction`, the one place a transaction is opened),
// so they commit together or roll back together — never a half-erased vault or a
// half-revoked set of agents (constitution: roll back on failure). When the caller
// passes its own transaction (`tx` — completeAccountReset does, so the work commits with
// the reset's status change), the statements run on it instead of a new one. This module
// holds no key and reads no `process.env` (INV-103): the `Db` is its only dependency.

import { withTransaction } from "../db/index";
import type { Db } from "../db/index";
import type { ResetExecutor } from "../auth/account-reset";

// Build the production ResetExecutor over the db.
export function createResetExecutor(db: Db): ResetExecutor {
  // Run `fn` on the caller's transaction when given one, otherwise in a new one.
  function inTransaction(tx: Db | undefined, fn: (tx: Db) => Promise<void>): Promise<void> {
    return tx ? fn(tx) : withTransaction(db, fn);
  }
  return {
    // Erase the person's VK-wrapped vault data: their saved cards, high-tier identity
    // fields and vault unlock methods — the three device-held stores whose values the
    // server only ever held as opaque ciphertext (never decryptable without the lost
    // vault key). The low-tier identity fields (server DEK-encrypted) and the activity
    // history are in other tables and are deliberately untouched.
    async eraseVaultData(userId: string, outer?: Db): Promise<void> {
      await inTransaction(outer, async (tx) => {
        await tx.query("DELETE FROM cards WHERE user_id = $1", [userId]);
        await tx.query("DELETE FROM high_tier_fields WHERE user_id = $1", [userId]);
        await tx.query("DELETE FROM vault_unlock_methods WHERE user_id = $1", [userId]);
      });
    },

    // Revoke every agent and service connection of the person: delete every OAuth token
    // and per-agent access key bound to any of their agents (so the agents' next request
    // carrying either credential no longer verifies), mark every agent disconnected (the
    // rows survive — only the status changes) and remove the service connections. A
    // credential's `connection_id` is the OAuth connection the AGENT is born from — the
    // uuid in `agents.connection_id` (design §6.1; the same id `disconnectAgent` revokes
    // by), NOT a row in the `connections` (service) table — so the token and access-key
    // deletes are scoped through the person's own AGENTS, and run while those rows still
    // carry their connection ids (before the agents are even touched). The agent-status
    // UPDATE and the service-connection DELETE are each member-scoped by `user_id`.
    async revokeAgentsAndConnections(userId: string, outer?: Db): Promise<void> {
      await inTransaction(outer, async (tx) => {
        await tx.query(
          "DELETE FROM oauth_tokens WHERE connection_id IN (SELECT connection_id FROM agents WHERE user_id = $1)",
          [userId],
        );
        await tx.query(
          "DELETE FROM oauth_access_keys WHERE connection_id IN (SELECT connection_id FROM agents WHERE user_id = $1)",
          [userId],
        );
        await tx.query("UPDATE agents SET status = 'disconnected' WHERE user_id = $1", [userId]);
        await tx.query("DELETE FROM connections WHERE user_id = $1", [userId]);
      });
    },
  };
}
