// One agent, several accounts of a service (docs/adr/several-accounts-per-agent.md):
//   - migration 0122 carries every agent's access over exactly, account by account;
//   - an agent's granted accounts are stored per account, replaced whole when stated and kept
//     when left out, and only ever the person's own accounts;
//   - disconnecting an account removes it from every agent and leaves the others;
//   - the old service columns keep a copy an earlier release reads, which never widens access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

import { createConnection } from "./connections";
import { agentsUsingAccount, getConnectionPermissions, refreshServiceCopy, upsertPermissions, type AccountGrantInput } from "./agent-permissions";
import { createUser } from "./users";
import { loadMigrations, pgliteDb, runMigrations, type Db } from "./index";
import { freshDb } from "../../test/db";

const clock = { now: () => new Date("2026-11-24T00:00:00Z") };
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const AGENT_B = "44444444-4444-4444-8444-444444444444";

async function person(db: Db, who: string): Promise<string> {
  return (await createUser(db, { email: `${who}@example.test`, wrappedDek: "wrapped" })).id;
}

async function connect(db: Db, userId: string, connectorId: string, accountLabel: string, status?: "needs_reconnect"): Promise<string> {
  return (await createConnection(db, { userId, connectorId, accountLabel, credentials: { access_token: "a" }, ...(status ? { status } : {}) }, randomBytes(32), clock)).id;
}

const BASE = {
  readTools: true, changeTools: "ask_first" as const, identityAccess: false, highTierAccess: false, cardAccess: false,
  cardBudget: null, skillsScope: [], memoryRead: false, sharing: false, rulesScope: [], rateLimit: 60,
};

async function grant(db: Db, userId: string, agent: string, accounts?: AccountGrantInput[]) {
  return upsertPermissions(db, { userId, connectionId: agent, ...BASE, ...(accounts ? { accounts } : {}) });
}

// A database migrated up to (not including) 0122, holding grants in the old service shape.
async function beforeAccounts(): Promise<{ db: Db; all: Awaited<ReturnType<typeof loadMigrations>> }> {
  const pglite = new PGlite("memory://");
  await pglite.waitReady;
  const db = pgliteDb(pglite);
  const all = await loadMigrations();
  await runMigrations(db, all.filter((m) => m.name < "0122"));
  return { db, all };
}

async function legacyGrant(db: Db, userId: string, agent: string, services: string[], chosen: Record<string, string> = {}, policies: Record<string, unknown> = {}) {
  await db.query(
    `INSERT INTO agent_permissions (user_id, connection_id, granted_connectors, read_tools, change_tools, identity_access, high_tier_access,
       card_access, card_budget, skills_scope, memory_read, sharing, rules_scope, rate_limit, connector_accounts, connector_policies)
     VALUES ($1, $2, $3::jsonb, true, 'ask_first', false, false, false, NULL, '[]', false, false, '[]', 60, $4::jsonb, $5::jsonb)`,
    [userId, agent, JSON.stringify(services), JSON.stringify(chosen), JSON.stringify(policies)],
  );
}

test("0122 gives each agent exactly the accounts it could use before, with their settings", async () => {
  const { db, all } = await beforeAccounts();
  try {
    const me = await person(db, "me");
    const other = await person(db, "other");
    const home = await connect(db, me, "google-gmail", "home@gmail.com");
    const work = await connect(db, me, "google-gmail", "work@gmail.com");
    const calendar = await connect(db, me, "google-calendar", "home@gmail.com", "needs_reconnect");
    const notion = await connect(db, me, "notion", "Notion");
    const theirs = await connect(db, other, "google-drive", "them@gmail.com");
    // A: Gmail chosen (work) with its own settings; Calendar's only account (needs reconnect);
    //    Notion's only account; Drive pinned to another person's account; Slack never connected.
    await legacyGrant(db, me, AGENT_A, ["google-gmail", "google-calendar", "notion", "google-drive", "slack"],
      { "google-gmail": work, "google-drive": theirs },
      { "google-gmail": { readTools: false, changeTools: "off", allowedTools: ["google-gmail__search"] }, notion: { changeTools: "nonsense", allowedTools: null } });
    // B: Gmail with two accounts and none chosen (no access before), and a choice of a missing account.
    await legacyGrant(db, me, AGENT_B, ["google-gmail", "notion"], { notion: "66666666-6666-4666-8666-666666666666" });

    await runMigrations(db, all);

    const a = await getConnectionPermissions(db, me, AGENT_A);
    assert.deepEqual(a?.accounts, [
      { accountId: calendar, connectorId: "google-calendar" },
      { accountId: work, connectorId: "google-gmail", readTools: false, changeTools: "off", allowedTools: ["google-gmail__search"] },
      { accountId: notion, connectorId: "notion" },
    ]);
    assert.deepEqual(a?.grantedConnectors, ["google-calendar", "google-gmail", "notion"]);
    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_B))?.accounts, [], "ambiguous and missing choices gave no access, and still give none");
    assert.ok(!a?.accounts.some((g) => g.accountId === home));

    // Running the backfill again changes nothing.
    await runMigrations(db, all);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM agent_account_grants")).rows[0]!.n, 3);
  } finally {
    await db.close();
  }
});

test("an agent's accounts are replaced whole when stated and kept when left out", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const home = await connect(db, me, "google-gmail", "home@gmail.com");
    const work = await connect(db, me, "google-gmail", "work@gmail.com");
    const notion = await connect(db, me, "notion", "Notion");

    const first = await grant(db, me, AGENT_A, [{ accountId: home }, { accountId: work, changeTools: "off" }]);
    assert.deepEqual(first.accounts, [
      { accountId: home, connectorId: "google-gmail" },
      { accountId: work, connectorId: "google-gmail", changeTools: "off" },
    ].sort((x, y) => x.accountId.localeCompare(y.accountId)));
    assert.deepEqual(first.grantedConnectors, ["google-gmail"]);

    const kept = await grant(db, me, AGENT_A);
    assert.deepEqual(kept.accounts, first.accounts, "left out, the accounts stay");

    const replaced = await grant(db, me, AGENT_A, [{ accountId: notion, allowedTools: [] }, { accountId: work, readTools: false }]);
    assert.deepEqual(replaced.accounts, [
      { accountId: work, connectorId: "google-gmail", readTools: false },
      { accountId: notion, connectorId: "notion", allowedTools: [] },
    ]);
    assert.deepEqual((await grant(db, me, AGENT_A, [])).accounts, [], "an empty list removes every account");
  } finally {
    await db.close();
  }
});

test("only the person's own accounts are ever granted", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const other = await person(db, "other");
    const mine = await connect(db, me, "google-gmail", "me@gmail.com");
    const theirs = await connect(db, other, "google-gmail", "them@gmail.com");
    const stored = await grant(db, me, AGENT_A, [{ accountId: theirs }, { accountId: mine }, { accountId: "not-a-uuid" }, { accountId: "77777777-7777-4777-8777-777777777777" }]);
    assert.deepEqual(stored.accounts.map((g) => g.accountId), [mine]);
    // Another person's agent with the same id is a different agent.
    await grant(db, other, AGENT_A, [{ accountId: theirs }]);
    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_A))?.accounts.map((g) => g.accountId), [mine]);
  } finally {
    await db.close();
  }
});

test("disconnecting an account removes it from every agent and leaves the others", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const home = await connect(db, me, "google-gmail", "home@gmail.com");
    const work = await connect(db, me, "google-gmail", "work@gmail.com");
    await grant(db, me, AGENT_A, [{ accountId: home }, { accountId: work }]);
    await grant(db, me, AGENT_B, [{ accountId: home }]);
    assert.deepEqual(Object.fromEntries(await agentsUsingAccount(db, me)), { [home]: [AGENT_A, AGENT_B], [work]: [AGENT_A] });

    await db.query("DELETE FROM connections WHERE user_id = $1 AND id = $2", [me, home]);

    const a = await getConnectionPermissions(db, me, AGENT_A);
    assert.deepEqual(a?.accounts.map((g) => g.accountId), [work]);
    assert.deepEqual(a?.grantedConnectors, ["google-gmail"], "Gmail stays granted through the other account");
    const b = await getConnectionPermissions(db, me, AGENT_B);
    assert.deepEqual(b?.accounts, []);
    assert.deepEqual(b?.grantedConnectors, []);
  } finally {
    await db.close();
  }
});

test("the old service columns hold a copy that an earlier release reads without widening access", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const home = await connect(db, me, "google-gmail", "home@gmail.com");
    const work = await connect(db, me, "google-gmail", "work@gmail.com");
    const notion = await connect(db, me, "notion", "Notion");
    await grant(db, me, AGENT_A, [{ accountId: home }, { accountId: work }, { accountId: notion, changeTools: "off" }]);
    const row = (await db.query("SELECT granted_connectors, connector_accounts, connector_policies FROM agent_permissions WHERE user_id = $1 AND connection_id = $2", [me, AGENT_A])).rows[0]!;
    assert.deepEqual(row.granted_connectors, ["google-gmail", "notion"]);
    // One Notion account: set to it. Two Gmail accounts: none set, which an earlier release refuses.
    assert.deepEqual(row.connector_accounts, { notion });
    assert.deepEqual(row.connector_policies, { notion: { changeTools: "off" } });
  } finally {
    await db.close();
  }
});

test("several accounts of a service can be on for new agents", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    await connect(db, me, "google-gmail", "home@gmail.com");
    await connect(db, me, "google-gmail", "work@gmail.com");
    await db.query("UPDATE connections SET default_for_agents = true WHERE user_id = $1", [me]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM connections WHERE user_id = $1 AND default_for_agents", [me])).rows[0]!.n, 2);
  } finally {
    await db.close();
  }
});

test("after a disconnect, the old columns' copy never lets an earlier release reach a remaining account", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const home = await connect(db, me, "google-gmail", "home@gmail.com");
    const work = await connect(db, me, "google-gmail", "work@gmail.com");
    await connect(db, me, "google-gmail", "spare@gmail.com");
    await grant(db, me, AGENT_A, [{ accountId: home }, { accountId: work }]);
    // Both granted accounts go; spare, never granted, is now the only Gmail account left.
    await db.query("DELETE FROM connections WHERE user_id = $1 AND id = ANY($2::uuid[])", [me, [home, work]]);
    await refreshServiceCopy(db, me);
    const row = (await db.query("SELECT granted_connectors, connector_accounts FROM agent_permissions WHERE user_id = $1 AND connection_id = $2", [me, AGENT_A])).rows[0]!;
    assert.deepEqual(row.granted_connectors, [], "Gmail is no longer listed, so the earlier release gives no Gmail at all");
    assert.deepEqual(row.connector_accounts, {});
  } finally {
    await db.close();
  }
});
