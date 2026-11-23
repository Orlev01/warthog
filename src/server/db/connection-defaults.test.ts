// "On for new agents" (docs/adr/default-services.md): a person marks one account of a service,
// and every agent connected afterwards starts with that service, set to that account.
//   - setDefaultForAgents marks or unmarks one of the person's own accounts, never another
//     person's; marking a second account of a service moves the mark, because an agent uses
//     one account of each service;
//   - defaultAccountsForAgents reads the marks, one account id per service.
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

test("no account is on for new agents until the person turns one on", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    await connect(db, me, "google-gmail", "home@gmail.test");
    assert.deepEqual(await defaultAccountsForAgents(db, me), {});
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
    assert.deepEqual(await defaultAccountsForAgents(db, me), { "google-gmail": gmail, notion });

    assert.equal(await setDefaultForAgents(db, { userId: me, id: gmail, on: false }), true);
    assert.deepEqual(await defaultAccountsForAgents(db, me), { notion });
  } finally {
    await db.close();
  }
});

test("turning on a second account of a service moves the default to it", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const home = await connect(db, me, "google-gmail", "home@gmail.test");
    const work = await connect(db, me, "google-gmail", "work@gmail.test");

    await setDefaultForAgents(db, { userId: me, id: home, on: true });
    await setDefaultForAgents(db, { userId: me, id: work, on: true });
    assert.deepEqual(await defaultAccountsForAgents(db, me), { "google-gmail": work });

    // Turning off an account that isn't the default leaves the default alone.
    await setDefaultForAgents(db, { userId: me, id: home, on: false });
    assert.deepEqual(await defaultAccountsForAgents(db, me), { "google-gmail": work });
  } finally {
    await db.close();
  }
});

test("the database holds at most one default account per service", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "me");
    const home = await connect(db, me, "google-gmail", "home@gmail.test");
    const work = await connect(db, me, "google-gmail", "work@gmail.test");
    await setDefaultForAgents(db, { userId: me, id: home, on: true });
    await assert.rejects(db.query("UPDATE connections SET default_for_agents = true WHERE id = $1", [work]));
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
    assert.deepEqual(await defaultAccountsForAgents(db, other), { "google-gmail": theirs });
    assert.deepEqual(await defaultAccountsForAgents(db, me), {});
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
    assert.deepEqual(await defaultAccountsForAgents(db, me), {});
  } finally {
    await db.close();
  }
});
