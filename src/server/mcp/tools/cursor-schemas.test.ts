// The web pages restart a stale cursor at the first page (pagination.ts), but an agent following
// nextCursor/next.* must be told its cursor is wrong, or a corrupted value could loop it forever.
import { test } from "node:test";
import assert from "node:assert/strict";

import { searchMemorySchema } from "./memory";
import { getContextSchema } from "./get-context";
import { pageCursor } from "../../db/pagination";

const issued = pageCursor({ id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-11-12T01:30:00.000Z" });

test("search_memory and get_context refuse a cursor Warthog didn't issue", () => {
  assert.equal(searchMemorySchema.safeParse({ cursor: "invalid" }).success, false);
  assert.equal(getContextSchema.safeParse({ memory_cursor: "invalid" }).success, false);
  assert.equal(getContextSchema.safeParse({ skill_cursor: "invalid" }).success, false);
});

test("search_memory and get_context accept an issued cursor and no cursor", () => {
  assert.equal(searchMemorySchema.safeParse({}).success, true);
  assert.equal(searchMemorySchema.safeParse({ cursor: issued }).success, true);
  assert.equal(getContextSchema.safeParse({ memory_cursor: issued, skill_cursor: issued }).success, true);
});
