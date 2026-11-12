// Keyset page cursors (src/server/db/pagination.ts). A stale, edited or truncated "Older"
// link used to throw HttpError(400) out of the page loader, so /memory?cursor=zzz and the
// agent Memory/Skills sections fell to the generic "Something went wrong" screen. An
// invalid cursor now reads the first page (and says it did), unless the caller asks for
// the strict refusal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { isPageCursor, pageCursor, pageOptions, parsePageCursor } from "./pagination";
import { createMemory, pageMemories } from "./memories";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { HttpError } from "../http/validate";

const valid = pageCursor({ id: randomUUID(), createdAt: "2026-11-01T09:00:00.000000Z" });

test("a cursor Warthog issued round-trips to its keyset position", () => {
  const options = pageOptions({ cursor: valid, limit: 10 });
  assert.equal(options.limit, 10);
  assert.equal(options.cursorReset, false);
  assert.deepEqual(options.cursor, parsePageCursor(valid));
  assert.equal(isPageCursor(valid), true);
});

test("no cursor is the first page and not a reset", () => {
  assert.deepEqual(pageOptions({}), { limit: 50, cursor: null, cursorReset: false });
});

test("a stale, edited or oversized cursor falls back to the first page instead of throwing", () => {
  const edited = valid.slice(0, -3) + "zzz";
  const wrongShape = Buffer.from(JSON.stringify({ at: "yesterday", id: "1" })).toString("base64url");
  for (const cursor of ["zzz", edited, wrongShape, "a".repeat(300), "%%%"]) {
    assert.deepEqual(pageOptions({ cursor }), { limit: 50, cursor: null, cursorReset: true }, cursor);
    assert.equal(isPageCursor(cursor), false, cursor);
  }
});

test("a caller can still ask for the strict refusal", () => {
  assert.throws(() => pageOptions({ cursor: "zzz" }, { invalidCursor: "reject" }), (error) => error instanceof HttpError && error.status === 400);
  assert.doesNotThrow(() => pageOptions({ cursor: valid }, { invalidCursor: "reject" }));
});

test("a page read with a bad cursor returns the newest page, not an error", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: `cursor-${randomUUID()}@warthog.com.au`, wrappedDek: Buffer.from("wrapped").toString("base64") });
    const dek = randomBytes(32);
    for (const minute of [1, 2, 3]) {
      await createMemory(db, { userId: user.id, content: `memory ${minute}`, sourceAgentId: null, scope: "shared" }, dek, fixedClock(new Date(Date.UTC(2026, 10, 1, 9, minute))));
    }
    const fresh = await pageMemories(db, user.id, dek, { limit: 2 });
    const stale = await pageMemories(db, user.id, dek, { limit: 2, cursor: "zzz" });
    assert.deepEqual(stale.items.map((m) => m.content), fresh.items.map((m) => m.content));
    assert.deepEqual(stale.items.map((m) => m.content), ["memory 3", "memory 2"]);
    assert.ok(stale.nextCursor, "the first page still links on to the next");
  } finally {
    await db.close();
  }
});
