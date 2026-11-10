import { HttpError } from "../http/validate";
import type { Db } from "./index";

// Limits apply to stored encrypted bytes, including envelope overhead. All writers
// lock the same owner row, so simultaneous imports and agent writes cannot race.
export const COLLECTION_LIMITS = {
  memories: { rows: 5000, bytes: 20_000_000, columns: ["content"] },
  skills: {
    rows: 1000,
    bytes: 30_000_000,
    columns: ["title", "use_this_when", "full_text"],
  },
  skill_packages: {
    rows: 100,
    bytes: 30_000_000,
    columns: ["content_ct", "summary_ct"],
  },
} as const;
export async function assertCollectionCapacity(
  db: Db,
  userId: string,
  kind: keyof typeof COLLECTION_LIMITS,
  incomingBytes: number,
  replaceId?: string,
  limits: { rows: number; bytes: number } = COLLECTION_LIMITS[kind],
): Promise<void> {
  if (!db.inTransaction)
    throw new Error(
      "Storage capacity must be checked inside the write transaction",
    );
  await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const bytes = COLLECTION_LIMITS[kind].columns
    .map((c) => `octet_length(${c})`)
    .join(" + ");
  // Identifiers come only from the fixed definitions above; no client SQL fragments.
  const row = (
    await db.query(
      `SELECT count(*) AS n, COALESCE(sum(${bytes}),0) AS total, COALESCE(max(CASE WHEN id = $2::uuid THEN ${bytes} ELSE 0 END),0) AS previous FROM ${kind} WHERE user_id = $1`,
      [userId, replaceId ?? null],
    )
  ).rows[0];
  const previous = Number(row?.previous ?? 0),
    total = Number(row?.total ?? 0);
  if (
    (!replaceId && Number(row?.n ?? 0) >= limits.rows) ||
    (total - previous + incomingBytes > limits.bytes &&
      incomingBytes >= previous)
  ) {
    throw new HttpError(
      409,
      "This collection has reached its storage limit. Remove unused items or reduce their size before saving.",
    );
  }
}
