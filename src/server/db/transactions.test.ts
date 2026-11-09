import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb, withTransaction, type Db } from "./index";

test("concurrent PGlite transactions isolate a rollback from another transaction's commit", async () => {
  const db = await createDb("pglite:memory");
  try {
    await db.query("CREATE TABLE tx_probe (value text)");
    let reached!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const proceed = new Promise<void>((resolve) => { resume = resolve; });
    const failing = withTransaction(db, async (tx) => {
      assert.equal(tx.inTransaction, true, "native handles explicitly identify their transaction scope");
      await tx.query("INSERT INTO tx_probe VALUES ('rolled-back')");
      reached();
      await proceed;
      throw new Error("synthetic rollback");
    });
    void failing.catch(() => {});
    await paused;
    const successful = withTransaction(db, async (tx) => {
      await tx.query("INSERT INTO tx_probe VALUES ('committed')");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    resume();
    await assert.rejects(failing, /synthetic rollback/);
    await successful;
    assert.deepEqual((await db.query("SELECT value FROM tx_probe")).rows, [{ value: "committed" }]);
  } finally { await db.close(); }
});

test("raw-query transaction seams mark scoped handles and refuse nested boundaries", async () => {
  const queries: string[] = [];
  const db: Db = {
    async query(text) { queries.push(text); return { rows: [] }; },
    async close() {},
  };
  assert.equal(db.inTransaction, undefined);
  await withTransaction(db, async (tx) => {
    assert.equal(tx.inTransaction, true);
    assert.notEqual(tx, db);
    await tx.query("SELECT 'joined operation'");
    await assert.rejects(withTransaction(tx, async () => undefined), /nested transaction/i);
  });
  assert.deepEqual(queries, ["BEGIN", "SELECT 'joined operation'", "COMMIT"]);
  assert.equal(db.inTransaction, undefined, "the outer handle is never marked as a transaction");
});

test("nested transaction boundaries are rejected before committing their parent's writes", async () => {
  const db = await createDb("pglite:memory");
  try {
    await db.query("CREATE TABLE tx_probe (value text)");
    await assert.rejects(withTransaction(db, async (tx) => {
      await tx.query("INSERT INTO tx_probe VALUES ('outer')");
      await withTransaction(tx, async (nested) => {
        await nested.query("INSERT INTO tx_probe VALUES ('inner')");
      });
    }), /nested transaction/i);
    assert.deepEqual((await db.query("SELECT value FROM tx_probe")).rows, []);
  } finally { await db.close(); }
});
