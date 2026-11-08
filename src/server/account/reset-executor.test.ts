// E04-S40 — Account-reset executor (`src/server/account/reset-executor.ts`).
//
// RED-first: `./reset-executor` does NOT exist yet, so importing it throws — every
// test here fails at import until the builder writes the module. That absence IS the
// point of test-first; do NOT implement anything to make these pass.
//
// Background. A completed 7-day account reset ERASES the person's VK-wrapped vault
// data and REVOKES every agent and service connection, while KEEPING everything else
// (the `users` row, the wrapped DEK, low-tier identity, activity history) — a reset is
// NOT an account deletion (design §5; `../auth/account-reset`). The cross-aggregate
// work is delegated through the already-defined `ResetExecutor` seam
// (`../auth/account-reset`), which `completeAccountReset` calls once a still-pending
// reset is claimed. This task provides the PRODUCTION executor over the db; today the
// composition root wires a throwing "not configured" stub, so a reset can never finish.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Db } from "../db/index";
//   import type { ResetExecutor } from "../auth/account-reset";
//
//   // Build the production ResetExecutor over the db.
//   function createResetExecutor(db: Db): ResetExecutor;
//
//   // ResetExecutor (already defined in ../auth/account-reset):
//   //   eraseVaultData(userId): Promise<void>
//   //     — deletes the person's VK-wrapped data: saved cards, high-tier fields and
//   //       vault unlock methods. Low-tier identity fields and activity are untouched.
//   //   revokeAgentsAndConnections(userId): Promise<void>
//   //     — revokes every OAuth token and access key of the person's agents, marks
//   //       their agents disconnected and removes their connections.
//   //
//   // Every operation is member-scoped by the passed userId alone: it only ever
//   // touches rows of that user id (another person's rows are left wholly intact).
// ---------------------------------------------------------------------------
//
// These tests pin BEHAVIOUR (what is stored / what verifies after the reset), never
// the source text of any module. A credential is proven revoked by presenting the raw
// bearer to the already-built verification seam (`../oauth/verify-bearer`) — the real
// "verifies" path — and showing it resolves BEFORE and is rejected AFTER. Vault and
// identity state are read back through each aggregate's own list function, and activity
// survival through a direct row read. AC1/AC2 drive the whole thing through the real
// `completeAccountReset` with the production executor (the AC's own framing); AC3 calls
// the executor methods directly to pin the member-scope boundary.
//
// Every db handle is closed in a `finally`; each db-backed test uses its own isolated
// `freshDb()` (in-memory PGlite with the real migrations), so tests share no state and
// never touch the network or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createResetExecutor } from "./reset-executor";
import { completeAccountReset } from "../auth/account-reset";

import { createUser } from "../db/users";
import { addCard, listCards } from "../db/cards";
import { saveHighTierField, listHighTierFields } from "../db/high-tier-fields";
import {
  saveWrappedKey,
  listMethods,
  getWrappedKey,
  getOrCreatePrfSalt,
  saveRecoveryAuth,
  verifyRecoveryAuth,
} from "../db/vault-unlock-methods";
import { saveIdentityField, listIdentityFields } from "../db/identity-fields";
import { createConnection, listConnectionsForUser } from "../db/connections";
import { createAgent, listAgentsForUser } from "../db/agents";
import { createToken } from "../oauth/store";
import { issueAccessKey } from "../oauth/access-key";
import { verifyBearer } from "../oauth/verify-bearer";
import { createDbRecorder } from "../activity/writer";

import { loadConfig } from "../config";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import type { Db } from "../db/index";

// A frozen instant: token expiry and connected/occurred-at times are measured against
// it deterministically.
const NOW = new Date("2026-06-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLOCK = fixedClock(NOW);

// One data key reused for every store that encrypts (connections' credentials,
// low-tier identity values, activity payloads). Its exact bytes never matter here —
// nothing is decrypted back except identity fields, which use this same key.
const DEK = new Uint8Array(randomBytes(32));

// SHA-256 hex — how a token is addressed in storage (design §6.1), so a seeded token
// lands under the hash verification resolves it by.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// A real Config via the one env seam (a minimal DEVELOPMENT env — pglite is allowed in
// dev), so bearer verification has what it needs without a production environment. The
// base64 secrets are well-formed test-only values (HMAC >= 32 bytes; dev KEK exactly 32).
function configFor(publicBaseUrl = "https://warthog.example") {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: publicBaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  } as NodeJS.ProcessEnv);
}

// A request carrying a Bearer credential (or none).
function mcpRequest(bearer?: string): Request {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers["authorization"] = `Bearer ${bearer}`;
  return new Request("https://warthog.example/mcp", { method: "POST", headers });
}

// Does this raw bearer still verify against the protected resource? (The real
// verification seam — tokens AND access keys both resolve through it.)
async function verifies(db: Db, bearer: string): Promise<boolean> {
  const result = await verifyBearer(mcpRequest(bearer), { db, config: configFor(), clock: CLOCK });
  return result.ok;
}

// A person whose member-scoped stores we seed. The wrapped-DEK column is opaque here
// (nothing the executor touches reads it), so a placeholder suffices.
async function makeUser(db: Db): Promise<string> {
  const user = await createUser(db, {
    email: `reset-${randomUUID()}@warthog.com.au`,
    wrappedDek: "wrapped-dek-placeholder",
  });
  return user.id;
}

// Seed the three VK-wrapped vault stores for a person: a saved card, a high-tier field
// and a vault unlock method.
async function seedVault(db: Db, userId: string): Promise<void> {
  await addCard(db, {
    userId,
    brand: "visa",
    lastFour: "4242",
    expiryMonth: 12,
    expiryYear: 2030,
    nickname: "everyday",
    billingAddressId: randomUUID(),
    numberCiphertext: "vk-ct-card",
  });
  await saveHighTierField(db, {
    userId,
    type: "passport",
    label: "Passport",
    ciphertext: "vk-ct-passport",
  });
  await saveWrappedKey(db, {
    userId,
    method: "passphrase",
    wrappedKey: "wrapped-vk",
    params: { iterations: 100000 },
  });
}

// Seed one low-tier identity field (DEK-encrypted by the store) — this must SURVIVE a
// reset.
async function seedIdentity(db: Db, userId: string): Promise<void> {
  await saveIdentityField(db, { userId, kind: "name", value: "Robin Example" }, DEK);
}

// Seed one activity entry through the real DB recorder — this must SURVIVE a reset.
async function seedActivity(db: Db, userId: string): Promise<void> {
  const recorder = createDbRecorder({ db, clock: CLOCK, dekFor: async () => DEK });
  await recorder.record({
    userId,
    kind: "tool_call",
    source: "warthog",
    payload: { note: "kept across the reset" },
  });
}

async function countActivity(db: Db, userId: string): Promise<number> {
  const result = await db.query(
    "SELECT count(*)::int AS n FROM activity_entries WHERE user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// Seed one connection + its agent + an OAuth access token AND a per-agent access key,
// all bound to the same connection. Returns the raw credentials a client would present.
async function seedAgent(
  db: Db,
  userId: string,
): Promise<{ connectionId: string; agentId: string; rawToken: string; rawKey: string }> {
  const connection = await createConnection(
    db,
    { userId, connectorId: "google", accountLabel: "me@example.test", credentials: { access: "x" } },
    DEK,
    CLOCK,
  );
  const agent = await createAgent(
    db,
    { userId, connectionId: connection.id, displayName: "Claude", platform: "claude.ai" },
    CLOCK,
  );
  const rawToken = `access-${randomUUID()}`;
  await createToken(db, {
    tokenHash: sha256Hex(rawToken),
    connectionId: connection.id,
    kind: "access",
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });
  const { key: rawKey } = await issueAccessKey(db, { connectionId: connection.id }, { random: systemRandom });
  return { connectionId: connection.id, agentId: agent.id, rawToken, rawKey };
}

// Record a still-pending reset for the person, so `completeAccountReset` claims it and
// runs the executor (its guard moves pending → done).
async function insertPendingReset(db: Db, userId: string): Promise<void> {
  await db.query(
    "INSERT INTO account_resets (user_id, status, requested_at) VALUES ($1, 'pending', $2::timestamptz)",
    [userId, NOW.toISOString()],
  );
}

// ===========================================================================
// AC1 — after completeAccountReset with the real executor, the vault is erased while
// low-tier identity and activity remain.
// ===========================================================================

test("completeAccountReset with the real executor erases the vault but keeps low-tier identity and activity", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db);
    await seedVault(db, userId);
    await seedIdentity(db, userId);
    await seedActivity(db, userId);
    await insertPendingReset(db, userId);

    // Precondition: the vault, identity and activity are all present.
    assert.equal((await listCards(db, userId)).length, 1, "precondition: a saved card exists");
    assert.equal((await listHighTierFields(db, userId)).length, 1, "precondition: a high-tier field exists");
    assert.deepEqual(await listMethods(db, userId), ["passphrase"], "precondition: a vault unlock method exists");
    assert.equal((await listIdentityFields(db, userId, DEK)).length, 1, "precondition: a low-tier field exists");
    assert.ok((await countActivity(db, userId)) >= 1, "precondition: an activity entry exists");

    const outcome = await completeAccountReset(db, { userId }, { executor: createResetExecutor(db) });
    assert.deepEqual(outcome, { ok: true }, "a due reset completes with the real executor");

    // The VK-wrapped vault data is gone.
    assert.deepEqual(await listCards(db, userId), [], "saved cards are erased");
    assert.deepEqual(await listHighTierFields(db, userId), [], "high-tier fields are erased");
    assert.deepEqual(await listMethods(db, userId), [], "vault unlock methods are erased");

    // Low-tier identity and activity history remain.
    const identity = await listIdentityFields(db, userId, DEK);
    assert.equal(identity.length, 1, "low-tier identity fields remain");
    assert.equal(identity[0]?.value, "Robin Example", "the low-tier value is still readable");
    assert.ok((await countActivity(db, userId)) >= 1, "activity history remains");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — after the reset, a bearer token / access key no longer verifies and the agents
// show as disconnected.
// ===========================================================================

test("after the reset, a previously-issued bearer token and access key no longer verify, and the agents are disconnected", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db);
    const a = await seedAgent(db, userId);
    const b = await seedAgent(db, userId); // a SECOND agent — "every" token/key must be revoked
    await insertPendingReset(db, userId);

    // Precondition: both credentials verify and both agents are connected.
    assert.ok(await verifies(db, a.rawToken), "precondition: agent A's token verifies");
    assert.ok(await verifies(db, b.rawKey), "precondition: agent B's access key verifies");
    const before = await listAgentsForUser(db, userId);
    assert.equal(before.length, 2, "precondition: both agents exist");
    assert.ok(before.every((agent) => agent.status === "connected"), "precondition: both agents are connected");

    await completeAccountReset(db, { userId }, { executor: createResetExecutor(db) });

    // Neither credential verifies any more.
    assert.equal(await verifies(db, a.rawToken), false, "agent A's token no longer verifies");
    assert.equal(await verifies(db, a.rawKey), false, "agent A's access key no longer verifies");
    assert.equal(await verifies(db, b.rawToken), false, "agent B's token no longer verifies");
    assert.equal(await verifies(db, b.rawKey), false, "agent B's access key no longer verifies");

    // Every agent shows as disconnected (the rows survive — the status changes).
    const after = await listAgentsForUser(db, userId);
    assert.equal(after.length, 2, "the agent rows survive the reset");
    assert.ok(after.every((agent) => agent.status === "disconnected"), "every agent shows as disconnected");
  } finally {
    await db.close();
  }
});

test("after the reset, the person's connections are removed", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db);
    await seedAgent(db, userId);
    await seedAgent(db, userId);
    await insertPendingReset(db, userId);

    assert.equal((await listConnectionsForUser(db, userId)).length, 2, "precondition: two connections exist");

    await completeAccountReset(db, { userId }, { executor: createResetExecutor(db) });

    assert.deepEqual(await listConnectionsForUser(db, userId), [], "the person's connections are removed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the executor only ever touches rows of the given user id.
// ===========================================================================

test("eraseVaultData erases only the given user's vault, leaving another person's vault, identity and activity intact", async () => {
  const db = await freshDb();
  try {
    const victim = await makeUser(db);
    const bystander = await makeUser(db);
    for (const userId of [victim, bystander]) {
      await seedVault(db, userId);
      await seedIdentity(db, userId);
      await seedActivity(db, userId);
    }

    await createResetExecutor(db).eraseVaultData(victim);

    // The victim's vault is erased; their identity and activity are untouched.
    assert.deepEqual(await listCards(db, victim), [], "the victim's cards are erased");
    assert.deepEqual(await listHighTierFields(db, victim), [], "the victim's high-tier fields are erased");
    assert.deepEqual(await listMethods(db, victim), [], "the victim's unlock methods are erased");
    assert.equal((await listIdentityFields(db, victim, DEK)).length, 1, "the victim's identity is kept");
    assert.ok((await countActivity(db, victim)) >= 1, "the victim's activity is kept");

    // The bystander is wholly untouched.
    assert.equal((await listCards(db, bystander)).length, 1, "the bystander's cards are untouched");
    assert.equal((await listHighTierFields(db, bystander)).length, 1, "the bystander's high-tier fields are untouched");
    assert.deepEqual(await listMethods(db, bystander), ["passphrase"], "the bystander's unlock methods are untouched");
    assert.equal((await listIdentityFields(db, bystander, DEK)).length, 1, "the bystander's identity is untouched");
    assert.ok((await countActivity(db, bystander)) >= 1, "the bystander's activity is untouched");
  } finally {
    await db.close();
  }
});

test("revokeAgentsAndConnections touches only the given user's agents, connections and credentials", async () => {
  const db = await freshDb();
  try {
    const victim = await makeUser(db);
    const bystander = await makeUser(db);
    const victimAgent = await seedAgent(db, victim);
    const bystanderAgent = await seedAgent(db, bystander);

    await createResetExecutor(db).revokeAgentsAndConnections(victim);

    // The victim is revoked.
    assert.equal(await verifies(db, victimAgent.rawToken), false, "the victim's token no longer verifies");
    assert.equal(await verifies(db, victimAgent.rawKey), false, "the victim's access key no longer verifies");
    const victimAgents = await listAgentsForUser(db, victim);
    assert.ok(victimAgents.every((agent) => agent.status === "disconnected"), "the victim's agent is disconnected");
    assert.deepEqual(await listConnectionsForUser(db, victim), [], "the victim's connection is removed");

    // The bystander is wholly untouched: credentials still verify, agent still
    // connected, connection still present.
    assert.ok(await verifies(db, bystanderAgent.rawToken), "the bystander's token still verifies");
    assert.ok(await verifies(db, bystanderAgent.rawKey), "the bystander's access key still verifies");
    const bystanderAgents = await listAgentsForUser(db, bystander);
    assert.equal(bystanderAgents.length, 1, "the bystander's agent survives");
    assert.equal(bystanderAgents[0]?.status, "connected", "the bystander's agent stays connected");
    assert.equal((await listConnectionsForUser(db, bystander)).length, 1, "the bystander's connection survives");
  } finally {
    await db.close();
  }
});

// Review fix W5 — a reset must leave no stale vault material behind, so the person's
// first protected save after it sets up a FRESH vault: no wrapped key for any method, a
// new passkey-PRF salt (the old one salted the lost passkeys) and no recovery verifier
// for the lost code. Member-scoped like the rest of the erase.
test("eraseVaultData also clears the PRF salt and the recovery verifier, so the next set-up starts fresh", async () => {
  const db = await freshDb();
  try {
    const victim = await makeUser(db);
    const bystander = await makeUser(db);
    const salts = new Map<string, string>();
    for (const userId of [victim, bystander]) {
      await seedVault(db, userId);
      await saveWrappedKey(db, { userId, method: "recovery", wrappedKey: "wrapped-vk-recovery" });
      salts.set(userId, await getOrCreatePrfSalt(db, userId, { random: systemRandom }));
      await saveRecoveryAuth(db, userId, "OLD-RECOVERY-CODE", { random: systemRandom });
    }

    await createResetExecutor(db).eraseVaultData(victim);

    assert.deepEqual(await listMethods(db, victim), [], "no unlock method survives");
    assert.equal(await getWrappedKey(db, victim, "passkey_prf"), null, "no passkey envelope: the next unlock sets up a new vault key");
    assert.equal(await getWrappedKey(db, victim, "recovery"), null, "no recovery envelope: a new recovery phrase is asked for");
    assert.equal(await verifyRecoveryAuth(db, victim, "OLD-RECOVERY-CODE"), false, "the old recovery verifier is gone");
    const fresh = await getOrCreatePrfSalt(db, victim, { random: systemRandom });
    assert.notEqual(fresh, salts.get(victim), "the next set-up draws a new PRF salt");

    // The bystander keeps every piece.
    assert.deepEqual((await listMethods(db, bystander)).sort(), ["passphrase", "recovery"]);
    assert.equal(await getOrCreatePrfSalt(db, bystander, { random: systemRandom }), salts.get(bystander));
    assert.equal(await verifyRecoveryAuth(db, bystander, "OLD-RECOVERY-CODE"), true);
  } finally {
    await db.close();
  }
});
