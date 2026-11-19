// Connectors loader organisation (`./actions` load): the catalogue's data categories are
// offered as plain display groups (everyday first); a `category` is validated against those
// groups (or a data category inside one) before it narrows the browse; every group is
// offered with its count of matches for the current search; only services a person can
// connect or ask to join are offered; the popular services lead the full catalogue;
// catalogue entries the person already connected are marked; and connected services that
// need attention come first.
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

function catalogue(entries: ReadonlyArray<{ id: string }> = ENTRIES): CatalogueIndex {
  const dir = mkdtempSync(join(tmpdir(), "warthog-connectors-organise-"));
  try {
    for (const entry of entries) writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry));
    return loadCatalogue({ dir, isOAuthClientConfigured: () => false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const deks = new Map<string, Uint8Array>();
const dekFor = async (userId: string) => deks.get(userId)!;

function actionsFor(db: Db, entries: ReadonlyArray<{ id: string }> = ENTRIES) {
  return createConnectorsActions({
    db,
    clock: fixedClock(NOW),
    catalogue: catalogue(entries),
    dekFor,
    fetch: (async () => {
      throw new Error("no fetch in these tests");
    }) as unknown as typeof fetch,
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

test("every display group is offered with its count, everyday groups first, and the catalogue groups follow that order", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "categories");
    const data = await actionsFor(db).load(sessionFor(userId));
    // "database" folds into "Data and analytics", which sorts after the everyday groups.
    assert.deepEqual(data.categories, [
      { key: "email", count: 2 },
      { key: "smart-home", count: 1 },
      { key: "data", count: 1 },
    ]);
    assert.deepEqual(
      data.groups.map((g) => g.category),
      ["email", "smart-home", "data"],
    );
    assert.deepEqual(data.groups[0]!.items.map((i) => i.category), ["email", "email"], "each entry names its display group");
    assert.equal(data.category, null);
  } finally {
    await db.close();
  }
});

test("near-duplicate data categories share one group, and an old category link still lands on it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "merge");
    const entries = [
      apiKey("box-ish", "Boxish", "storage"),
      apiKey("bucket", "Bucket", "file-storage"),
      apiKey("fly-me", "Fly Me", "flight"),
      apiKey("trip", "Trip", "travel"),
    ];
    const data = await actionsFor(db, entries).load(sessionFor(userId));
    assert.deepEqual(data.categories, [
      { key: "files", count: 2 },
      { key: "travel", count: 2 },
    ]);
    const old = await actionsFor(db, entries).load(sessionFor(userId), { category: "file-storage" });
    assert.equal(old.category, "files", "a data category resolves to the group that holds it");
    assert.deepEqual(old.groups.flatMap((g) => g.items.map((i) => i.name)), ["Boxish", "Bucket"]);
  } finally {
    await db.close();
  }
});

test("a service that can't be connected yet is left out; a Google early-access entry stays with its ask-to-join", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "offered");
    const oauth = (id: string, name: string, category: string, extra: Record<string, unknown> = {}) => ({
      id,
      name,
      aliases: [],
      category,
      auth_kind: "oauth2",
      base_url: `https://api.${id}.example`,
      auth: { authorize_url: `https://${id}.example/a`, token_url: `https://${id}.example/t`, scopes: ["s"] },
      ...extra,
    });
    const entries = [
      apiKey("acme-mail", "Acme Mail", "email"),
      // No provider sign-in client is configured in this catalogue, so neither oauth2 entry
      // is connectable; only the early-access one is offered (as ask-to-join).
      oauth("outlookish", "Outlookish", "email"),
      oauth("google-calendar", "Google Calendar", "calendar", { google_early_access: true }),
    ];
    const data = await actionsFor(db, entries).load(sessionFor(userId));
    const items = data.groups.flatMap((g) => g.items);
    assert.deepEqual(items.map((i) => i.name).sort(), ["Acme Mail", "Google Calendar"]);
    assert.equal(items.find((i) => i.id === "google-calendar")!.gate, "ask_to_join");
    assert.deepEqual(data.categories, [
      { key: "email", count: 1 },
      { key: "calendar", count: 1 },
    ], "the hidden service isn't counted");
    assert.deepEqual(data.featured!.map((i) => i.id), ["google-calendar"], "a popular service leads the full catalogue");

    const searched = await actionsFor(db, entries).load(sessionFor(userId), { query: "outlookish" });
    assert.equal(searched.groups.length, 0);
    assert.equal(searched.canRequest, true, "a term that only matched a service that can't be connected is a request for it");
    assert.deepEqual(searched.featured, [], "no popular row while a search narrows the catalogue");
    const narrowed = await actionsFor(db, entries).load(sessionFor(userId), { category: "calendar" });
    assert.deepEqual(narrowed.featured, [], "no popular row inside a category");
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
    assert.equal(inDatabase.category, "data", "the chosen category is kept (as its group) so the person can see where they are");
    assert.ok(inDatabase.categories!.some((c) => c.key === "data" && c.count === 0), "the chosen category stays listed");

    const miss = await actionsFor(db).load(sessionFor(userId), { query: "zzqq" });
    assert.equal(miss.canRequest, true, "a term found nowhere still offers Request a service");
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
