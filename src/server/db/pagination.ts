import { z } from "zod";
import { HttpError } from "../http/validate";
const cursorShape = z.object({ at: z.iso.datetime(), id: z.uuid() });
type PageCursor = z.infer<typeof cursorShape>;

/** The decoded keyset position, or null when the value is not a cursor Warthog issued. */
export function parsePageCursor(value: string): PageCursor | null {
  try {
    if (value.length > 256) return null;
    return cursorShape.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** True for a well-formed cursor; a boundary schema (e.g. an MCP tool) can refuse anything else. */
export function isPageCursor(value: string): boolean {
  return parsePageCursor(value) !== null;
}

// A stale, edited or truncated "Older" link must not crash a page: an invalid cursor reads
// the first page instead, and `cursorReset` lets the caller say so ("showing the newest").
// Pass `invalidCursor: "reject"` where a client must be told its cursor was wrong.
export function pageOptions(
  input: { cursor?: string; limit?: number },
  options: { invalidCursor?: "first-page" | "reject" } = {},
) {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(input.limit ?? 50);
  if (!input.cursor) return { limit, cursor: null, cursorReset: false };
  const cursor = parsePageCursor(input.cursor);
  if (cursor) return { limit, cursor, cursorReset: false };
  if (options.invalidCursor === "reject") throw new HttpError(400, "Invalid page cursor. Start from the first page.");
  return { limit, cursor: null, cursorReset: true };
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
