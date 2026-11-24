// Several accounts of one service (docs/adr/google-published-and-accounts.md):
//   - findConnectionByAccount finds the person's own connection for one provider account,
//     ignoring case, so connecting the same Google or Microsoft account again renews it;
//   - renameConnection names one of the person's own accounts, never another person's;
//   - connecting another account of a service grants it to no agent: each agent keeps exactly
//     the accounts it was given (docs/adr/several-accounts-per-agent.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createConnection, findConnectionByAccount, renameConnection } from "./connections";
import { agentsUsingAccount, getConnectionPermissions, upsertPermissions } from "./agent-permissions";
import { saveApiKeyConnection } from "../connectors/api-key";
import { createUser } from "./users";
import type { CatalogueEntry } from "../../domain/catalogue/schema";
import { freshDb } from "../../test/db";
import type { Db } from "./index";

const clock = { now: () => new Date("2026-11-17T00:00:00Z") };
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const AGENT_B = "44444444-4444-4444-8444-444444444444";

async function person(db: Db, who: string): Promise<string> {
  return (await createUser(db, { email: `${who}@example.test`, wrappedDek: "wrapped" })).id;
}

async function connect(db: Db, userId: string, connectorId: string, accountLabel: string): Promise<string> {
  const connection = await createConnection(db, { userId, connectorId, accountLabel, credentials: { access_token: "a" } }, randomBytes(32), clock);
  return connection.id;
}

async function grant(db: Db, userId: string, agent: string, accountIds: string[]): Promise<void> {
  await upsertPermissions(db, {
    userId, connectionId: agent, accounts: accountIds.map((accountId) => ({ accountId })), readTools: true, changeTools: "ask_first",
    identityAccess: false, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [],
    memoryRead: false, sharing: false, rulesScope: [], rateLimit: 60,
  });
}

// A key service connected without a check request, so saving a key makes no outbound call.
const KEY_SERVICE: CatalogueEntry = {
  id: "plainkey",
  name: "Plain Key Service",
  aliases: ["plainkey"],
  category: "developer-tools",
  auth_kind: "api_key",
  base_url: "https://api.plain.example",
  auth: { header: "X-API-Key: {api_key}" },
  instructions: "Create a key. See https://docs.plain.example/keys.",
};

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

test("connecting another account of a service grants it to no agent", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const first = await connect(db, me, KEY_SERVICE.id, "First workspace");
    await grant(db, me, AGENT_A, [first]);
    await grant(db, me, AGENT_B, []);

    const { connection: second } = await saveApiKeyConnection(
      { entry: KEY_SERVICE, userId: me, accountLabel: "Second workspace", apiKey: "key-2", dek: randomBytes(32) },
      { db, clock, fetch: (async () => { throw new Error("no outbound call"); }) as unknown as typeof fetch },
    );

    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_A))?.accounts, [{ accountId: first, connectorId: KEY_SERVICE.id }],
      "an agent using the service keeps only the account it was given");
    assert.deepEqual((await getConnectionPermissions(db, me, AGENT_B))?.accounts, [], "an agent without the service still has none");
    assert.equal((await agentsUsingAccount(db, me)).get(second.id), undefined, "no agent uses the new account");
  } finally {
    await db.close();
  }
});
