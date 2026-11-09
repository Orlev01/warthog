import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireOwnership, type OwnershipClient } from "./ownership";

function server() {
  let held = false;
  return { client() {
    let mine = false, disconnected = false;
    const handlers = new Map<string, () => void>();
    const client: OwnershipClient = {
      connect: async () => {}, on: (event, fn) => { handlers.set(event, fn); },
      query: async (sql) => {
        if (disconnected) throw new Error("private connection details");
        if (sql.includes("pg_try_advisory_lock")) { mine = !held; held = true; return { rows: [{ acquired: mine }] }; }
        return { rows: [] };
      },
      end: async () => { if (mine) held = false; handlers.get("end")?.(); },
    };
    return { client, disconnect() { disconnected = true; if (mine) held = false; handlers.get("error")?.(); } };
  } };
}

test("only one server obtains ownership; a stopped owner permits its replacement", async () => {
  const db = server();
  let lost = 0;
  const first = await acquireOwnership({ client: db.client().client, onLost: () => { lost++; }, schedule: () => () => {} });
  await assert.rejects(acquireOwnership({ client: db.client().client, onLost: () => { lost++; }, schedule: () => () => {} }), /already owned/);
  assert.equal(lost, 0);
  await first.close();
  const replacement = await acquireOwnership({ client: db.client().client, onLost: () => { lost++; }, schedule: () => () => {} });
  assert.equal(lost, 0, "intentional shutdown does not report lost ownership");
  await replacement.close();
});

test("connection loss immediately fails closed once and cancels monitoring", async () => {
  const connection = server().client();
  let lost = 0, cancelled = 0;
  const owner = await acquireOwnership({ client: connection.client, onLost: () => { lost++; }, schedule: () => () => { cancelled++; } });
  connection.disconnect(); connection.disconnect();
  assert.equal(lost, 1);
  assert.equal(cancelled, 1);
  await owner.close();
});

test("a failed heartbeat fails closed even without a transport close event", async () => {
  const connection = server().client();
  let poll: () => Promise<void> = async () => {};
  let lost = 0;
  const owner = await acquireOwnership({ client: connection.client, onLost: () => { lost++; }, schedule: (task) => { poll = task; return () => {}; } });
  connection.client.query = async () => { throw new Error("private connection details"); };
  await poll();
  assert.equal(lost, 1);
  await owner.close();
});
