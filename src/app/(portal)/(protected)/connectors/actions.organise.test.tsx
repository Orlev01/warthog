// Connectors loader organisation (`./actions` load): a `category` is validated against
// the catalogue's own categories before it narrows the browse; every category is offered
// with its count of matches for the current search; catalogue entries the person already
// connected are marked; and connected services that need attention come first.
//
// Drives the real factory over a real catalogue index (the project's loader on fixture
// files) and an isolated PGlite with the real migrations, as `actions.test.tsx` does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConnectorsActions } from "./actions";
import { createConnection, updateConnectionStatus, type ConnectionStatus } from "@/server/db/connections";
import { createUser } from "@/server/db/users";
import { loadCatalogue, type CatalogueIndex } from "@/server/connectors/catalogue";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-06-01T00:00:00.000Z");

const apiKey = (id: string, name: string, category: string, aliases: string[] = []) => ({
  id,
  name,
  aliases,
  category,
  auth_kind: "api_key",
  base_url: `https://api.${id}.example`,
  auth: { header: "Authorization: Bearer {api_key}" },
});

const ENTRIES = [
  apiKey("acme-mail", "Acme Mail", "email", ["acme"]),
  apiKey("bolt-mail", "Bolt Mail", "email"),
  apiKey("grid-db", "Grid DB", "database"),
  apiKey("home-hub", "Home Hub", "smart-home", ["acme-home"]),
];

function catalogue(): CatalogueIndex {
  const dir = mkdtempSync(join(tmpdir(), "warthog-connectors-organise-"));
  try {
    for (const entry of ENTRIES) writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry));
    return loadCatalogue({ dir, isOAuthClientConfigured: () => false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const deks = new Map<string, Uint8Array>();
const dekFor = async (userId: string) => deks.get(userId)!;

function actionsFor(db: Db) {
  return createConnectorsActions({
    db,
    clock: fixedClock(NOW),
    catalogue: catalogue(),
    dekFor,
    fetch: (async () => {
      throw new Error("no fetch in these tests");
    }) as unknown as typeof fetch,
    email: { async sendEmail() {} },
    operatorEmail: "operator@warthog.com.au",
    googleEarlyAccess: [],
    oauthClientConfigFor: () => ({ clientId: "c", clientSecret: "s", redirectUri: "https://warthog.com.au/cb" }),
    providerMcpConfig: { clientMetadataUrl: "https://warthog.com.au/oauth/client-metadata.json" },
    listProviderTools: async () => [],
    revokeProviderAccess: async () => {},
  });
}

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-${who}`).toString("base64"),
  });
  deks.set(user.id, randomBytes(32));
  return user.id;
}

async function connect(
  db: Db,
  userId: string,
  connectorId: string,
  accountLabel: string,
  status: ConnectionStatus = "connected",
  at = NOW,
): Promise<void> {
  const created = await createConnection(
    db,
    { userId, connectorId, accountLabel, credentials: { token: accountLabel } },
    await dekFor(userId),
    fixedClock(at),
  );
  if (status !== "connected") await updateConnectionStatus(db, { userId, id: created.id, status });
}

function sessionFor(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

test("every category is offered with its count, alphabetically, and the catalogue groups follow that order", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "categories");
    const data = await actionsFor(db).load(sessionFor(userId));
    assert.deepEqual(data.categories, [
      { key: "database", count: 1 },
      { key: "email", count: 2 },
      { key: "smart-home", count: 1 },
    ]);
    assert.deepEqual(
      data.groups.map((g) => g.category),
      ["database", "email", "smart-home"],
    );
    assert.equal(data.category, null);
  } finally {
    await db.close();
  }
});

test("a known category narrows the catalogue; the counts still cover every category", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "narrow");
    const data = await actionsFor(db).load(sessionFor(userId), { category: "email" });
    assert.equal(data.category, "email");
    assert.deepEqual(data.groups.map((g) => g.category), ["email"]);
    assert.deepEqual(data.groups[0]!.items.map((i) => i.name), ["Acme Mail", "Bolt Mail"]);
    assert.equal(data.categories!.length, 3, "the other categories remain one click away");
  } finally {
    await db.close();
  }
});

test("an unknown category is ignored, never trusted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "unknown");
    const data = await actionsFor(db).load(sessionFor(userId), { category: "<script>" });
    assert.equal(data.category, null);
    assert.equal(data.groups.length, 3, "the whole catalogue shows");
  } finally {
    await db.close();
  }
});

test("with a search, the counts are the matches in each category, and a match elsewhere is not a miss", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "search");
    const all = await actionsFor(db).load(sessionFor(userId), { query: "acme" });
    assert.deepEqual(all.categories, [
      { key: "email", count: 1 },
      { key: "smart-home", count: 1 },
    ], "categories with no match are left out");

    // Searching inside a category that has no match: nothing to show here, but the term
    // matched elsewhere in the catalogue, so this is not an "ask us to add it" miss.
    const inDatabase = await actionsFor(db).load(sessionFor(userId), { query: "acme", category: "database" });
    assert.equal(inDatabase.groups.length, 0);
    assert.equal(inDatabase.canRequest, false);
    assert.equal(inDatabase.category, "database", "the chosen category is kept so the person can see where they are");
    assert.ok(inDatabase.categories!.some((c) => c.key === "database" && c.count === 0), "the chosen category stays listed");

    const miss = await actionsFor(db).load(sessionFor(userId), { query: "zzqq" });
    assert.equal(miss.canRequest, true, "a term found nowhere still offers Request a connector");
  } finally {
    await db.close();
  }
});

test("catalogue entries the person has connected are marked; another person's connections are not", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "marked");
    const other = await makeUser(db, "other");
    await connect(db, userId, "acme-mail", "mine");
    await connect(db, other, "grid-db", "theirs");
    const data = await actionsFor(db).load(sessionFor(userId));
    const items = data.groups.flatMap((g) => g.items);
    assert.equal(items.find((i) => i.id === "acme-mail")!.connected, true);
    assert.ok(!items.find((i) => i.id === "grid-db")!.connected, "another person's connection never marks this person's catalogue");
    assert.ok(!items.find((i) => i.id === "bolt-mail")!.connected);
  } finally {
    await db.close();
  }
});

test("connected services that need reconnecting come first, then the rest by name", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "order");
    await connect(db, userId, "grid-db", "db", "connected", new Date("2026-05-01T00:00:00.000Z"));
    await connect(db, userId, "acme-mail", "mail", "connected", new Date("2026-05-02T00:00:00.000Z"));
    await connect(db, userId, "home-hub", "hub", "needs_reconnect", new Date("2026-05-03T00:00:00.000Z"));
    await connect(db, userId, "bolt-mail", "bolt", "error", new Date("2026-05-04T00:00:00.000Z"));
    const data = await actionsFor(db).load(sessionFor(userId));
    assert.deepEqual(
      data.connections.map((c) => [c.name, c.status]),
      [
        ["Home Hub", "needs-reconnect"],
        ["Bolt Mail", "error"],
        ["Acme Mail", "connected"],
        ["Grid DB", "connected"],
      ],
    );
  } finally {
    await db.close();
  }
});
