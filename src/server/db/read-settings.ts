// The "what agents see" level's data access (docs/adr/read-side-protection.md, amendment 24
// November 2026; `db/migrations/0124_read_settings.sql`).
//
// One person's level lives in exactly one place: the pipeline reads it before the result guard
// checks what an agent reads, and Settings › Agent defaults shows and saves it. It is PLAINTEXT
// METADATA (one of three words), so it is not DEK-encrypted and this module holds no key and
// reads no `process.env`. Every statement is parameterized through the `Db` seam and
// member-scoped by the `userId` the caller passes — the session's (or the connection owner's)
// id, never a client value — so one person can never read or change another's level.

import { DEFAULT_READ_LEVEL, isReadLevel, type ReadLevel } from "../../domain/content/read-levels";
import type { Clock } from "../seams/clock";
import type { Db } from "./index";

export interface SetReadLevelInput {
  readonly userId: string;
  readonly level: ReadLevel;
  // Stamped as updated_at (time comes from the caller's clock, never SQL now()).
  readonly clock: Clock;
}

// The saved level, or a refusal when it isn't one of the three — in which case nothing was
// written.
export type SetReadLevelResult =
  | { ok: true; level: ReadLevel }
  | { ok: false; reason: "invalid_level" };

// The person's level, or standard when they have chosen none (no row).
export async function getReadLevel(db: Db, userId: string): Promise<ReadLevel> {
  const result = await db.query("SELECT level FROM read_settings WHERE user_id = $1", [userId]);
  const level = result.rows[0]?.level;
  return isReadLevel(level) ? level : DEFAULT_READ_LEVEL;
}

// Save the person's ONE row, inserting it or overwriting it in place. An unknown level is
// refused BEFORE any query, so a refusal writes nothing and a saved level is left as it was.
export async function setReadLevel(db: Db, input: SetReadLevelInput): Promise<SetReadLevelResult> {
  if (!isReadLevel(input.level)) return { ok: false, reason: "invalid_level" };
  await db.query(
    `INSERT INTO read_settings (user_id, level, updated_at)
     VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (user_id) DO UPDATE
       SET level = EXCLUDED.level, updated_at = EXCLUDED.updated_at`,
    [input.userId, input.level, input.clock.now().toISOString()],
  );
  return { ok: true, level: input.level };
}
