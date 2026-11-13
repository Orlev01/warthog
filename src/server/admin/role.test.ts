// Operator role reconciliation (src/server/admin/role.ts): promotes the configured
// operator's live account by normalised email, is idempotent, never demotes, skips tombstones.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { createAccount } from "./test-fixtures";
import { reconcileOperatorRole } from "./role";

async function roleOf(db: Awaited<ReturnType<typeof freshDb>>, userId: string): Promise<string> {
  return (await db.query("SELECT role FROM users WHERE id = $1", [userId])).rows[0]!.role as string;
}

test("promotes the operator's live account once, by normalised email, and leaves everyone else alone", async () => {
  const db = await freshDb();
  try {
    const operator = await createAccount(db, { email: "operator@example.test" });
    const other = await createAccount(db, { email: "other@example.test" });
    const existingAdmin = await createAccount(db, { email: "second@example.test", role: "admin" });
    const ghost = await createAccount(db, { email: "ghost@example.test", tombstone: true });

    assert.equal(await reconcileOperatorRole(db, "  Operator@Example.TEST "), 1);
    assert.equal(await roleOf(db, operator.userId), "admin");
    assert.equal(await reconcileOperatorRole(db, "operator@example.test"), 0, "idempotent");
    assert.equal(await roleOf(db, other.userId), "member");
    assert.equal(await roleOf(db, existingAdmin.userId), "admin", "never demotes another admin");

    assert.equal(await reconcileOperatorRole(db, "ghost@example.test"), 0, "a tombstone is never promoted");
    assert.equal(await roleOf(db, ghost.userId), "member");
    assert.equal(await reconcileOperatorRole(db, undefined), 0);
    assert.equal(await reconcileOperatorRole(db, "nobody@example.test"), 0);
  } finally {
    await db.close();
  }
});
