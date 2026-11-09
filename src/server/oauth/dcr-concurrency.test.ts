import assert from "node:assert/strict";
import { test } from "node:test";
import { createClientWithinCap } from "./store";
import type { Db, Row } from "../db/index";

// Models READ COMMITTED's statement snapshot: two unlocked INSERT/COUNT calls
// can observe the same committed count. Transactions are independent; only an
// explicit advisory lock serializes them. This is an offline interleaving probe,
// not a substitute for the separately required two-connection PostgreSQL check.
function concurrentDatabase(): { db: Db; committed: Row[] } {
  const committed: Row[] = [];
  let lockTail = Promise.resolve();
  function handle(inTransaction: boolean): Db {
    let release: (() => void) | undefined;
    return {
      async query(text, values = []) {
        if (/pg_advisory_xact_lock/.test(text)) {
          const prior = lockTail;
          lockTail = new Promise<void>((resolve) => { release = resolve; });
          await prior;
          if (!inTransaction) release?.();
          return { rows: [] };
        }
        if (/INSERT INTO oauth_clients/.test(text)) {
          const countAtStatementStart = committed.length;
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (countAtStatementStart >= Number(values[5])) return { rows: [] };
          const row = { client_id: values[0], registration: values[1], redirect_uris: JSON.parse(String(values[2])) };
          committed.push(row);
          return { rows: [row] };
        }
        throw new Error("Unexpected statement in concurrent registration probe");
      },
      async close() {},
      async transaction<T>(fn: (tx: Db) => Promise<T>) {
        const tx = handle(true);
        try { return await fn(tx); } finally { await tx.close(); }
      },
      ...(inTransaction ? { async close() { release?.(); } } : {}),
    };
  }
  return { db: handle(false), committed };
}

test("independent registration transactions cannot both consume the last available slot", async () => {
  const { db, committed } = concurrentDatabase();
  const cap = { since: new Date("2026-11-08"), createdAt: new Date("2026-11-09"), max: 1 };
  const results = await Promise.all(["one", "two"].map((clientId) => createClientWithinCap(db,
    { clientId, registration: "dcr", redirectUris: ["https://client.example/callback"] }, cap)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(committed.length, 1);
});
