// Several accounts of one service (docs/adr/google-published-and-accounts.md):
//   - findConnectionByAccount finds the person's own connection for one provider account,
//     ignoring case, so connecting the same Google or Microsoft account again renews it;
//   - renameConnection names one of the person's own accounts, never another person's;
//   - pinAgentsToSoleAccount keeps every agent on the account it uses today, just before
//     another account of that service is added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createConnection, findConnectionByAccount, renameConnection } from "./connections";
import { getConnectionPermissions, pinAgentsToSoleAccount, upsertPermissions } from "./agent-permissions";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import type { Db } from "./index";

const clock = { now: () => new Date("2026-11-17T00:00:00Z") };
const AGENT_A = "33333333-3333-3333-3333-333333333333";
const AGENT_B = "44444444-4444-4444-4444-444444444444";
const AGENT_C = "55555555-5555-5555-5555-555555555555";

async function person(db: Db, who: string): Promise<string> {
  return (await createUser(db, { email: `${who}@example.test`, wrappedDek: "wrapped" })).id;
}

async function connect(db: Db, userId: string, connectorId: string, accountLabel: string): Promise<string> {
  const connection = await createConnection(db, { userId, connectorId, accountLabel, credentials: { access_token: "a" } }, randomBytes(32), clock);
  return connection.id;
}

async function grant(db: Db, userId: string, agent: string, grantedConnectors: string[], connectorAccounts: Record<string, string> = {}): Promise<void> {
  await upsertPermissions(db, {
    userId, connectionId: agent, grantedConnectors, connectorAccounts, readTools: true, changeTools: "ask_first",
    identityAccess: false, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [],
    memoryRead: false, sharing: false, rulesScope: [], rateLimit: 60,
  });
}

test("findConnectionByAccount finds the person's own account of that service, ignoring case", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const other = await person(db, "other");
    const gmail = await connect(db, me, "google-gmail", "Sam@Gmail.test");
    await connect(db, me, "google-calendar", "sam@gmail.test");
    await connect(db, other, "google-gmail", "sam@gmail.test");

    assert.equal((await findConnectionByAccount(db, me, "google-gmail", "sam@gmail.test"))?.id, gmail);
    assert.equal(await findConnectionByAccount(db, me, "google-gmail", "someone@gmail.test"), null);
    assert.equal(await findConnectionByAccount(db, me, "google-drive", "sam@gmail.test"), null, "another service is another connection");
    const theirs = await findConnectionByAccount(db, other, "google-gmail", "sam@gmail.test");
    assert.notEqual(theirs?.id, gmail, "never another person's connection");
  } finally {
    await db.close();
  }
});

test("renameConnection names the person's own account and refuses another person's", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const other = await person(db, "other");
    const notion = await connect(db, me, "notion", "Notion");
    const renamed = await renameConnection(db, { userId: me, id: notion, accountLabel: "Family workspace" });
    assert.equal(renamed.accountLabel, "Family workspace");
    await assert.rejects(renameConnection(db, { userId: other, id: notion, accountLabel: "Taken" }), /no connection/);
    assert.equal((await findConnectionByAccount(db, me, "notion", "family workspace"))?.id, notion);
  } finally {
    await db.close();
  }
});

test("pinAgentsToSoleAccount keeps each agent on the one account it uses, and only then", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const other = await person(db, "other");
    const first = await connect(db, me, "google-gmail", "first@gmail.test");
    await grant(db, me, AGENT_A, ["google-gmail", "notion"]);
    await grant(db, me, AGENT_B, ["google-gmail"], { "google-gmail": "66666666-6666-6666-6666-666666666666" });
    await grant(db, me, AGENT_C, ["notion"]);
    await grant(db, other, AGENT_A, ["google-gmail"]);

    await pinAgentsToSoleAccount(db, me, "google-gmail");

    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_A))?.connectorAccounts, { "google-gmail": first }, "an unpinned agent stays on the account it used");
    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_B))?.connectorAccounts, { "google-gmail": "66666666-6666-6666-6666-666666666666" }, "a chosen account is never changed");
    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_C))?.connectorAccounts, {}, "an agent without the service is untouched");
    assert.deepEqual((await getConnectionPermissions(db, other, AGENT_A))?.connectorAccounts, {}, "another person's agents are untouched");

    // With two accounts already, there is no one account to keep an agent on.
    await connect(db, me, "google-gmail", "second@gmail.test");
    await grant(db, me, AGENT_C, ["google-gmail"]);
    await pinAgentsToSoleAccount(db, me, "google-gmail");
    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_C))?.connectorAccounts, {});

    // With none, there is nothing to keep.
    await grant(db, me, AGENT_C, ["microsoft-outlook-mail"]);
    await pinAgentsToSoleAccount(db, me, "microsoft-outlook-mail");
    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_C))?.connectorAccounts, {});
  } finally {
    await db.close();
  }
});
