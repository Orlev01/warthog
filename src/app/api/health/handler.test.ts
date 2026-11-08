// Review fix F10 — the health endpoints (`/api/health` readiness, `/api/health/live` liveness).
//
// The container platform needs a probe that fails when this revision cannot serve: an invalid
// or incomplete configuration (which production refuses at load), an unreachable database, or a
// migration that did not apply (the shared database applies migrations on first use). Without
// one, a broken revision takes all traffic and every request 500s. Liveness is "the process
// answers" only, so a database outage never restarts healthy containers.
//
// The probes answer with fixed words, never an error message: a database error can carry a
// host or user, so it never reaches the response.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHealthHandler } from "./handler";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const SENTINEL = "SENTINEL_SECRET_db_pw_7f3a";

function workingDb(): Db {
  return {
    async query() {
      return { rows: [{ ok: 1 }] };
    },
    async close() {},
  };
}

async function body(response: Response): Promise<{ status: string; checks?: Record<string, string> }> {
  return (await response.json()) as { status: string; checks?: Record<string, string> };
}

test("ready: config loads and the database answers → 200 ok, never cached", async () => {
  const handler = createHealthHandler({ loadConfig: () => ({}), getDb: async () => workingDb() });
  const response = await handler.ready();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await body(response), { status: "ok", checks: { config: "ok", database: "ok" } });
});

test("ready: the real migrated database answers", async () => {
  const db = await freshDb();
  try {
    const handler = createHealthHandler({ loadConfig: () => ({}), getDb: async () => db });
    assert.equal((await handler.ready()).status, 200);
  } finally {
    await db.close();
  }
});

test("ready: an invalid configuration → 503, and the database is not touched", async () => {
  let opened = 0;
  const handler = createHealthHandler({
    loadConfig: () => {
      throw new Error(`Missing required configuration: KEY_VAULT_URL ${SENTINEL}`);
    },
    getDb: async () => {
      opened++;
      return workingDb();
    },
  });
  const response = await handler.ready();
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { status: "unavailable", checks: { config: "error", database: "skipped" } });
  assert.ok(!text.includes(SENTINEL), "no error detail reaches the response");
  assert.equal(opened, 0);
});

test("ready: the database (or its migrations) failing → 503 with no error detail", async () => {
  const handler = createHealthHandler({
    loadConfig: () => ({}),
    getDb: async () => {
      throw new Error(`connect ECONNREFUSED postgres://wh:${SENTINEL}@db`);
    },
  });
  const response = await handler.ready();
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { status: "unavailable", checks: { config: "ok", database: "error" } });
  assert.ok(!text.includes(SENTINEL));
});

test("ready: a database that never answers → 503 within the probe timeout", async () => {
  const handler = createHealthHandler({
    loadConfig: () => ({}),
    getDb: async () => ({
      query: () => new Promise(() => {}),
      close: async () => {},
    }),
    timeoutMs: 50,
  });
  const started = Date.now();
  const response = await handler.ready();
  assert.equal(response.status, 503);
  assert.ok(Date.now() - started < 2000, "the probe answered promptly");
  assert.equal((await body(response)).checks?.database, "error");
});

test("live: the process answers 200 without touching config or the database", async () => {
  const handler = createHealthHandler({
    loadConfig: () => {
      throw new Error("config is broken");
    },
    getDb: async () => {
      throw new Error("db is down");
    },
  });
  const response = handler.live();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await body(response), { status: "ok" });
});
