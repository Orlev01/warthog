// "On for new agents" (docs/adr/default-services.md): a person marks an account, and every agent
// connected afterwards starts with that account ticked.
//   - setDefaultForAgents marks or unmarks one of the person's own accounts, never another
//     person's. An agent can use several accounts of a service
//     (docs/adr/several-accounts-per-agent.md), so each account's mark is its own;
//   - defaultAccountsForAgents reads the marks, as account ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createConnection, defaultAccountsForAgents, setDefaultForAgents } from "./connections";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import type { Db } from "./index";

const clock = { now: () => new Date("2026-11-23T00:00:00Z") };

async function person(db: Db, who: string): Promise<string> {
  return (await createUser(db, { email: `${who}@example.test`, wrappedDek: "wrapped" })).id;
}

async function connect(db: Db, userId: string, connectorId: string, accountLabel: string): Promise<string> {
  const connection = await createConnection(db, { userId, connectorId, accountLabel, credentials: { access_token: "a" } }, randomBytes(32), clock);
  return connection.id;
}

const sorted = (ids: readonly string[]) => [...ids].sort();

test("no account is on for new agents until the person turns one on", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    await connect(db, me, "google-gmail", "home@gmail.test");
    assert.deepEqual(await defaultAccountsForAgents(db, me), []);
  } finally {
    await db.close();
  }
});

test("turning an account on and off for new agents", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const gmail = await connect(db, me, "google-gmail", "home@gmail.test");
    const notion = await connect(db, me, "notion", "Notion");

    assert.equal(await setDefaultForAgents(db, { userId: me, id: gmail, on: true }), true);
    assert.equal(await setDefaultForAgents(db, { userId: me, id: notion, on: true }), true);
    assert.deepEqual(sorted(await defaultAccountsForAgents(db, me)), sorted([gmail, notion]));

    assert.equal(await setDefaultForAgents(db, { userId: me, id: gmail, on: false }), true);
    assert.deepEqual(await defaultAccountsForAgents(db, me), [notion]);
  } finally {
    await db.close();
  }
});

test("two accounts of a service can both be on for new agents, each on its own", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const home = await connect(db, me, "google-gmail", "home@gmail.test");
    const work = await connect(db, me, "google-gmail", "work@gmail.test");
    const billing = await connect(db, me, "google-gmail", "billing@gmail.test");

    await setDefaultForAgents(db, { userId: me, id: home, on: true });
    await setDefaultForAgents(db, { userId: me, id: work, on: true });
    assert.deepEqual(sorted(await defaultAccountsForAgents(db, me)), sorted([home, work]), "turning one on leaves the other on");

    // Turning one off leaves the others as they are.
    await setDefaultForAgents(db, { userId: me, id: home, on: false });
    assert.deepEqual(await defaultAccountsForAgents(db, me), [work]);
    assert.ok(!(await defaultAccountsForAgents(db, me)).includes(billing), "an account never turned on stays off");
  } finally {
    await db.close();
  }
});

test("another person's account is never turned on or off", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const other = await person(db, "other");
    const theirs = await connect(db, other, "google-gmail", "them@gmail.test");
    await setDefaultForAgents(db, { userId: other, id: theirs, on: true });

    assert.equal(await setDefaultForAgents(db, { userId: me, id: theirs, on: false }), false);
    assert.deepEqual(await defaultAccountsForAgents(db, other), [theirs]);
    assert.deepEqual(await defaultAccountsForAgents(db, me), []);
  } finally {
    await db.close();
  }
});

test("a disconnected account stops being a default", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const gmail = await connect(db, me, "google-gmail", "home@gmail.test");
    await setDefaultForAgents(db, { userId: me, id: gmail, on: true });
    await db.query("DELETE FROM connections WHERE id = $1 AND user_id = $2", [gmail, me]);
    assert.deepEqual(await defaultAccountsForAgents(db, me), []);
  } finally {
    await db.close();
  }
});
