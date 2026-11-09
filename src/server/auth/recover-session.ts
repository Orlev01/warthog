import { withTransaction, type Db } from "../db/index";
import { createSession, lockActiveAccount } from "./session";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";

export function recoverSession(db: Db, userId: string, deps: { clock: Clock; random: Random }) {
  return withTransaction(db, async (tx) => {
    await lockActiveAccount(tx, userId);
    await tx.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    return createSession(tx, userId, deps);
  });
}
