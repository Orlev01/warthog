// E17-S10 — Dev fake agent console: the provisioning seam the thin `page.tsx` loader
// composes (`src/app/dev/agent-console/actions.ts`, design §12 dev tools;
// INV-102 validate-and-parameterize-input, INV-103 secrets-from-env; constitution 16
// per-agent access keys, constitution 21 public address from config).
//
// RED-first: the sibling factory `./actions` (`createAgentConsoleActions`) does not
// exist yet, so importing it throws and EVERY test here fails until the builder writes
// the module. That absence IS the point of test-first — as the TESTER I must NOT create
// or edit any implementation/source file to make these pass; the builder writes
// `actions.ts` (and the thin `page.tsx` that composes it) afterwards, to this contract.
//
// WHY the sibling `actions.ts` (not `page.tsx`): a Next App-Router `page.tsx` entry may
// export ONLY its framework fields, so an injectable, unit-testable seam cannot live on
// the entry without breaking `next build` (OBS-025). The thin loader reads the
// process-wide database (`getServerDb()`) + config at request time and renders the
// view; the testable logic — "mint or read a dev access key through the REAL per-agent
// access-key mechanism, and name the /mcp endpoint" — lives in this plain
// `createAgentConsoleActions({ db, clock, random, config })` factory (the convention's
// `createXActions(deps)` pattern, exactly as the sibling home / security pages use).
// These tests drive that factory directly against an isolated in-memory PGlite with the
// REAL migrations (`src/test/db`), so nothing touches the network or Azure.
//
// These tests pin BEHAVIOUR (the key that actually VERIFIES through the real credential
// store; the endpoint string; what two independent mints produce), never the source
// text of any module — a later rename that preserves behaviour must not redden them.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface AgentConsoleActionsDeps {   // every seam a real injected value, so the
//     db:     Db;                         // loader can build it from getServerDb()/config
//     clock:  Clock;
//     random: Random;
//     config: Config;
//   }
//
//   createAgentConsoleActions(deps): {
//     load(): Promise<{ accessKey: string; endpoint: string }>
//   }
//
//     load() — "mint or read a dev access key":
//       1. Self-contained: against a fresh database with NO preconditions (no user, no
//          connection, no session) it provisions whatever it needs and succeeds. The
//          console is a gated dev affordance; it does not require a signed-in session.
//       2. Reuses the REAL per-agent access-key mechanism (constitution 16): the returned
//          `accessKey` is a genuine `wh_ak_` bearer stored in the real `oauth_access_keys`
//          table and VERIFIES through the already-built `verifyAccessKey` / `verifyBearer`
//          to the one connection it binds to — NOT a parallel credential path.
//       3. `endpoint` names the /mcp agent endpoint the console POSTs to.
//       4. The raw key is a runtime-minted secret (from the injected `random` seam), never
//          a literal baked into source (INV-103): two independent mints differ.
//
// `config` flows in through the injected seam, which production builds from `loadConfig`
// (the ONE env reader; INV-103) — so the public address the endpoint is built from comes
// from configuration, never a code literal (constitution 21). Per the conventions these
// tests assert behaviour, not the source text of the module.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgentConsoleActions } from "./actions";

import { loadConfig, type Config } from "../../../server/config";
import { verifyAccessKey } from "../../../server/oauth/access-key";
import { verifyBearer } from "../../../server/oauth/verify-bearer";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { fixedRandom, systemRandom, type Random } from "../../../server/seams/random";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";

// A frozen instant the provisioning happens at (the dev agent's connected-at, if the
// factory records one). Deterministic, so nothing depends on the wall clock.
const T0 = new Date("2026-05-01T00:00:00.000Z");
const clock: Clock = fixedClock(T0);

// The access-key shape design §6.1 mandates: `wh_ak_` + 32 base62 characters. The
// provisioned dev key must look like a real per-agent access key.
const ACCESS_KEY_SHAPE = /^wh_ak_[0-9A-Za-z]{32}$/;

// The configured public base URL the endpoint is built from. A complete, valid
// DEVELOPMENT environment so `loadConfig` succeeds; the secret values are the repo's
// test-only base64 values (HMAC ≥ 32 bytes, dev KEK exactly 32).
const PUBLIC_BASE_URL = "https://warthog.example";

function devEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PUBLIC_BASE_URL,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
    WARTHOG_DEV_TOOLS: "1",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function devConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(devEnv(overrides));
}

// Build the provisioning seam under test with the pinned deps — a real db seam, a fixed
// clock + the given randomness source, and an explicit config.
function makeActions(db: Db, random: Random, config: Config = devConfig()) {
  return createAgentConsoleActions({ db, clock, random, config });
}

// How many access keys the REAL credential table holds — a probe that the provisioning
// wrote into `oauth_access_keys` (the real mechanism), not some parallel dev store.
async function accessKeyCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM oauth_access_keys");
  return Number(result.rows[0]?.n ?? -1);
}

// A JSON POST to /mcp carrying the given raw bearer — so a provisioned key can be run
// through the REAL `verifyBearer`, exactly as the /mcp route does.
function mcpRequest(bearer: string): Request {
  return new Request(`${PUBLIC_BASE_URL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } }),
  });
}

// =====================================================================================
// AC3 — the console reuses the REAL per-agent access-key mechanism: the provisioned key
// is a genuine `wh_ak_` bearer, stored in the real `oauth_access_keys` table, that
// resolves through the already-built `verifyAccessKey` to the connection it binds to.
// =====================================================================================

test("load() mints a real per-agent access key that verifies through the real credential store", async () => {
  const db = await freshDb();
  try {
    assert.equal(await accessKeyCount(db), 0, "precondition: no access keys before provisioning");

    const { accessKey } = await makeActions(db, systemRandom).load();

    assert.match(
      accessKey,
      ACCESS_KEY_SHAPE,
      `the provisioned dev key must be a real wh_ak_ access key, got: ${JSON.stringify(accessKey)}`,
    );

    // The REAL verification seam resolves it to a connection — proving it lives in the
    // real store under the same hash contract, not a parallel credential path (AC3).
    const resolved = await verifyAccessKey(db, accessKey);
    assert.ok(resolved, "the provisioned key must verify through the real verifyAccessKey");
    assert.ok(
      typeof resolved!.connectionId === "string" && resolved!.connectionId.length > 0,
      "the provisioned key must bind to a connection id",
    );

    // It was written into the REAL per-agent access-key table (not a dev-only table).
    assert.ok(await accessKeyCount(db) >= 1, "provisioning must store the key in oauth_access_keys");
  } finally {
    await db.close();
  }
});

test("the provisioned key is accepted by the real /mcp bearer verification (end-to-end credential reuse)", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { accessKey } = await makeActions(db, systemRandom, config).load();

    // Drive the SAME verifyBearer the /mcp route uses: the dev key must authenticate as
    // an agent, so the console genuinely "calls /mcp with a dev access key" (AC1).
    const verification = await verifyBearer(mcpRequest(accessKey), { db, config, clock });
    assert.equal(verification.ok, true, "the dev access key must verify as a bearer at /mcp");
    if (verification.ok) {
      assert.ok(verification.connectionId.length > 0, "verification resolves the console's connection");
    }

    // A bearer the console never minted must NOT verify — the key above passes on its own
    // merits, not because verification admits everything.
    const bogus = await verifyBearer(mcpRequest("wh_ak_not-a-real-key"), { db, config, clock });
    assert.equal(bogus.ok, false, "an unrelated bearer is still rejected");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — the console calls /mcp: load() names the /mcp agent endpoint the view POSTs to.
// =====================================================================================

test("load() returns the /mcp endpoint the console posts tool calls to", async () => {
  const db = await freshDb();
  try {
    const { endpoint } = await makeActions(db, systemRandom).load();
    assert.equal(typeof endpoint, "string", "the console must be told where to post tool calls");
    assert.ok(
      endpoint.length > 0 && /\/mcp\/?$/.test(endpoint),
      `the endpoint must address the /mcp agent endpoint, got: ${JSON.stringify(endpoint)}`,
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// "mints or reads" — self-contained and idempotent: against a fresh database with no
// preconditions it succeeds, and loading twice always yields a working key.
// =====================================================================================

test("load() is self-contained: it provisions with no pre-existing user, connection or session", async () => {
  const db = await freshDb(); // nothing seeded
  try {
    const first = await makeActions(db, systemRandom).load();
    assert.ok(await verifyAccessKey(db, first.accessKey), "the first load provisions a working key from nothing");

    // "mints OR reads" — a second load does not error and again yields a key that verifies
    // (whether it re-mints or reuses the connection is the builder's choice).
    const second = await makeActions(db, systemRandom).load();
    assert.ok(await verifyAccessKey(db, second.accessKey), "a second load still yields a working key");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [secrets-from-env] — the key is a runtime-minted secret from the injected random seam,
// never a literal baked into source: two independent mints produce different keys, and
// each verifies in its own store. A hard-coded key would make both identical.
// =====================================================================================

test("the access key is minted at runtime from the random seam, not a source literal [secrets-from-env]", async () => {
  const dbA = await freshDb();
  const dbB = await freshDb();
  try {
    // Two independent randomness sources → two distinct keys (a baked constant could not
    // differ). Each must still verify in ITS OWN store.
    const a = await makeActions(dbA, fixedRandom(0x11)).load();
    const b = await makeActions(dbB, fixedRandom(0x22)).load();

    assert.notEqual(
      a.accessKey,
      b.accessKey,
      "two independent mints must differ — the key is runtime entropy, not a hard-coded secret",
    );
    assert.ok(await verifyAccessKey(dbA, a.accessKey), "mint A verifies in store A");
    assert.ok(await verifyAccessKey(dbB, b.accessKey), "mint B verifies in store B");

    // And a key minted into store A does not verify in the unrelated store B (each key is
    // bound to the store it was issued in, not a shared literal).
    assert.equal(await verifyAccessKey(dbB, a.accessKey), null, "A's key is not valid in B's store");
  } finally {
    await dbA.close();
    await dbB.close();
  }
});
