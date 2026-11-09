import type { Db } from "../db/index";

// The caller must hold a transaction. Issue/rotate/revoke all take this lock
// before mutating credentials. No users/agents row lock is acquired here, so
// account reset/deletion may already hold its own account row lock safely.
export async function lockOAuthConnection(tx: Db, connectionId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`oauth-connection:${connectionId}`]);
}

// Consistent order for multi-connection account operations prevents lock cycles.
export async function lockUserOAuthConnections(tx: Db, userId: string): Promise<void> {
  const agents = await tx.query("SELECT connection_id FROM agents WHERE user_id = $1 ORDER BY connection_id", [userId]);
  for (const agent of agents.rows) await lockOAuthConnection(tx, agent.connection_id as string);
}
