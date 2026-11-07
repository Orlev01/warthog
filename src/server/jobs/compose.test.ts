// E04-S40 — the job-runtime composition root wires the REAL account-reset executor
// (`src/server/jobs/compose.ts`).
//
// Today `composeJobSeams()` wires a throwing "not configured" stub as `resetExecutor`,
// so the `account_reset.complete` handler can never finish a reset. This task replaces
// that stub with the production executor (`../account/reset-executor`). These tests
// prove the SWAP end to end: the dispatch table built from the COMPOSED seams actually
// erases the vault and revokes the agents of a due reset — something the throwing stub
// could never do (it would reject, leaving the vault intact and the job un-done).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Config } from "../config";
//   import type { Db } from "../db/index";
//   import type { JobSeams } from "./registry";
//
//   // Build the real job seams from validated config, with the db from the getter —
//   // both injectable for tests, defaulting (in production) to loadConfig() /
//   // getServerDb(). This mirrors the auth composition root
//   // (`../auth/compose` getSignupDeps/getSigninDeps), so the root stays testable
//   // WITHOUT a real environment, the process-wide server database, or Azure.
//   function composeJobSeams(overrides?: {
//     config?: Config;
//     getDb?: () => Promise<Db>;
//   }): Promise<JobSeams>;
//
// `composeScheduler()` keeps calling `composeJobSeams()` with no arguments (both
// overrides are optional), so production wiring is unchanged.
// ---------------------------------------------------------------------------
//
// RED-first: the real `createResetExecutor` the root wires does not exist yet, and the
// root does not yet accept overrides, so these tests fail until the builder adds both.
// That absence IS the point of test-first; do NOT implement anything to make them pass.
//
// Behaviour only: real DB state (the seeded vault / agents, the jobs row's status) and
// the real verification seam prove the composed executor ran. No test asserts source
// text. Each db-backed test uses its own isolated `freshDb()`, closed in a `finally`,
// and nothing touches the network or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import { composeJobSeams } from "./compose";
import { buildDispatchTable } from "./registry";

import { enqueue, run } from "../db/jobs";
import { COMPLETE_JOB_TYPE } from "../auth/account-reset";

import { createUser } from "../db/users";
import { addCard, listCards } from "../db/cards";
import { createConnection, listConnectionsForUser } from "../db/connections";
import { createAgent, listAgentsForUser } from "../db/agents";
import { createToken } from "../oauth/store";
import { verifyBearer } from "../oauth/verify-bearer";

import { loadConfig, type Config } from "../config";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import type { Db } from "../db/index";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLOCK = fixedClock(NOW);

// A 32-byte data key for the one store (connections) that encrypts in this test.
const DEK = new Uint8Array(Buffer.alloc(32, 0x5c));

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// A fully valid DEVELOPMENT config via the one env seam (dev tools off; pglite allowed
// in dev). The composition root builds its KeyWrapper, senders and rate source from
// this — none of which the reset handler exercises, but all must construct cleanly.
function devConfig(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: Buffer.alloc(48, 0x2a).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 0x5c).toString("base64"),
  } as NodeJS.ProcessEnv);
}

function mcpRequest(bearer: string): Request {
  return new Request("https://warthog.example/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
  });
}

async function verifies(db: Db, bearer: string): Promise<boolean> {
  const result = await verifyBearer(mcpRequest(bearer), { db, config: devConfig(), clock: CLOCK });
  return result.ok;
}

async function jobStatus(db: Db, id: string): Promise<string | undefined> {
  const result = await db.query("SELECT status FROM jobs WHERE id = $1", [id]);
  return result.rows[0]?.status as string | undefined;
}

test("compose.ts wires the real executor: the composed account_reset.complete handler completes a due reset end to end", async () => {
  const db = await freshDb();
  try {
    // A person with a pending reset, a saved card (VK-wrapped vault data), and a
    // connected agent whose access token verifies.
    const user = await createUser(db, {
      email: `compose-${randomUUID()}@warthog.com.au`,
      wrappedDek: "wrapped-dek-placeholder",
    });
    await addCard(db, {
      userId: user.id,
      brand: "visa",
      lastFour: "4242",
      expiryMonth: 1,
      expiryYear: 2031,
      nickname: "card",
      billingAddressId: randomUUID(),
      numberCiphertext: "vk-ct",
    });
    const connection = await createConnection(
      db,
      { userId: user.id, connectorId: "google", accountLabel: "me@example.test", credentials: { a: 1 } },
      DEK,
      CLOCK,
    );
    await createAgent(
      db,
      { userId: user.id, connectionId: connection.id, displayName: "Claude", platform: "claude.ai" },
      CLOCK,
    );
    const rawToken = `access-${randomUUID()}`;
    await createToken(db, {
      tokenHash: sha256Hex(rawToken),
      connectionId: connection.id,
      kind: "access",
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });
    await db.query(
      "INSERT INTO account_resets (user_id, status, requested_at) VALUES ($1, 'pending', $2::timestamptz)",
      [user.id, NOW.toISOString()],
    );

    // Preconditions: the vault datum and agent exist, and the token verifies.
    assert.equal((await listCards(db, user.id)).length, 1, "precondition: a saved card exists");
    assert.ok(await verifies(db, rawToken), "precondition: the agent's token verifies");

    // The REAL queue row production enqueues for the 7-day timer: the completion type
    // with the person's id, due in the past.
    const row = await enqueue(db, {
      type: COMPLETE_JOB_TYPE,
      payload: { userId: user.id },
      runAt: new Date(NOW.getTime() - HOUR_MS),
    });

    // Build the dispatch table from the COMPOSED seams (db injected; config injected) —
    // this is the real `resetExecutor` the composition root wires, not a test fake.
    const seams = await composeJobSeams({ config: devConfig(), getDb: async () => db });
    assert.equal(seams.db, db, "the composed seams use the injected db getter");
    const dispatch = buildDispatchTable(seams);

    // Drive the due job through the real runner. If the not-configured stub were still
    // wired, the handler would throw ("account reset execution is not configured") and
    // `run` would reject — so a clean completion is itself proof the real executor ran.
    const processed = await run(db, CLOCK, dispatch);
    assert.equal(processed?.type, COMPLETE_JOB_TYPE, "the composed runtime ran the account_reset.complete row");
    assert.equal(await jobStatus(db, row.id), "done", "the reset job is marked done");

    // End-to-end effects of the REAL executor: the vault datum is erased, the agent is
    // disconnected and the token no longer verifies.
    assert.deepEqual(await listCards(db, user.id), [], "the composed executor erased the saved card");
    assert.deepEqual(await listConnectionsForUser(db, user.id), [], "the composed executor removed the connection");
    const agents = await listAgentsForUser(db, user.id);
    assert.ok(agents.length >= 1 && agents.every((a) => a.status === "disconnected"), "the agent is disconnected");
    assert.equal(await verifies(db, rawToken), false, "the agent's token no longer verifies");
  } finally {
    await db.close();
  }
});
