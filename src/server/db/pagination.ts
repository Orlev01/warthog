import { z } from "zod";
import { HttpError } from "../http/validate";
const cursorShape = z.object({ at: z.iso.datetime(), id: z.uuid() });
export function pageOptions(input: { cursor?: string; limit?: number }) {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(input.limit ?? 50);
  if (!input.cursor) return { limit, cursor: null };
  try {
    if (input.cursor.length > 256) throw new Error();
    const cursor = cursorShape.parse(
      JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
    );
    return { limit, cursor };
  } catch {
    throw new HttpError(400, "Invalid page cursor. Start from the first page.");
  }
}
export function pageCursor(row: {
  id: string;
  createdAt: Date | string;
}): string {
  return Buffer.from(
    JSON.stringify({
      at:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : row.createdAt,
      id: row.id,
    }),
  ).toString("base64url");
}

// Keep PostgreSQL microseconds: Date conversion would skip rows within the last millisecond.
export function cursorTimestamp(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
}
