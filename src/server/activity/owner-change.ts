import { withTransaction, type Db } from "../db/index";
import { getUserById } from "../db/users";
import { createRedactingRecorder } from "../mcp/recorder";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Clock } from "../seams/clock";
import type { ActivityRecorder } from "./recorder";

/** Account mutations and their audit append share a transaction. Resolve keys first. */
export async function auditedOwnerChange<T>(
  deps: { db: Db; clock: Clock; keyWrapper: KeyWrapper },
  userId: string,
  change: (tx: Db, record: (kind: string, changes: unknown, agentId?: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  const user = await getUserById(deps.db, userId);
  if (!user) throw new Error("Account unavailable");
  const dek = await deps.keyWrapper.unwrap(user.wrappedDek);
  return withTransaction(deps.db, async tx => {
    const recorder: ActivityRecorder = createRedactingRecorder({ db: tx, clock: deps.clock, dekFor: async () => dek });
    return change(tx, async (kind, changes, agentId) => {
      await recorder.record({ userId, agentId, kind, source: "warthog", outcome: "saved", payload: { actor: "account_owner", changes } });
    });
  });
}
