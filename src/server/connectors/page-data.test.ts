// E09-S15 — Connectors read for the page (catalogue browse + connections list-all)
// (`src/server/connectors/page-data.ts`, brief "Connector catalogue — searchable and
// browsable by category" + "Request a connector", design §7).
//
// RED-first: `./page-data` does not exist yet, so importing `browseCatalogue` /
// `listConnectionsForPage` throws and every test here fails until the builder writes the
// module. That absence IS the point of test-first; do NOT implement anything to make
// these pass — the builder writes the module afterwards (the minimum to go green).
//
// These tests pin BEHAVIOUR (what the reads RETURN for a given catalogue index and a
// given person's stored connections), never the source text of the module. A later
// rename that preserves behaviour must not redden them. The per-tool reads/makes-changes
// marking is checked against the project's OWN exported curated declarations
// (`GOOGLE_CURATED_TOOLS`) rather than a copy, so the two can never drift (one source of
// truth) and a rename of their internals does not break this file.
//
// WHY this exists (task E09-S15; CLAUDE.md vocabulary: a *connector* is a catalogue
// entry; a *connection* is a person's connected service): the Connectors page needs two
// reads the earlier tasks did not provide —
//   • a CATALOGUE BROWSE read: the catalogue entries grouped BY CATEGORY, each carrying a
//     `connectable` flag (an oauth2 connector is connectable only when its client is
//     configured; api_key/basic/provider_mcp always), plus a "Request a connector"
//     affordance surfaced when a browse/search comes up empty (a MISS), so the person can
//     ask for a service that is not in the catalogue yet; and
//   • a CONNECTIONS LIST-ALL read: ALL of the SESSION person's connections regardless of
//     status, each with its status, account label, connected date and the TOOLS it offers
//     — each tool marked a read or makes-changes — distinct from any agent-facing filter.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // ---- catalogue browse (pure read over the already-loaded in-memory index) ----
//   interface BrowseInput { category?: string; query?: string }
//   interface CatalogueBrowseEntry {
//     id: string; name: string; category: string;
//     connectable: boolean;           // === index.isConnectable(id)
//   }
//   interface CatalogueBrowseGroup { category: string; entries: CatalogueBrowseEntry[] }
//   interface CatalogueBrowse {
//     groups: CatalogueBrowseGroup[]; // the matching entries grouped by category
//     canRequest: boolean;            // the "Request a connector" affordance — true on a MISS
//     query: string | null;           // the search term echoed back (for the request form); else null
//   }
//   browseCatalogue(index: CatalogueIndex, input: BrowseInput): CatalogueBrowse
//     • no filter ⇒ every catalogue entry, grouped under its own category, each with its
//       connectable flag; canRequest false (there are entries).
//     • { category } ⇒ only that category's entries.
//     • { query } that matches an entry ⇒ a hit: the entry is present, canRequest false.
//     • a MISS (nothing matches) ⇒ groups empty, canRequest TRUE, query echoed back.
//
//   // ---- connections list-all (member-scoped read, enriched with per-tool marking) ----
//   interface PageTool { name: string; makesChange: boolean }  // false = read, true = makes change
//   interface ConnectionForPage {
//     id: string; connectorId: string; accountLabel: string;
//     status: ConnectionStatus; connectedAt: Date | string;
//     tools: PageTool[];              // the tools this connection offers, each marked
//   }
//   listConnectionsForPage(db, userId, index): Promise<ConnectionForPage[]>
//     • ALL of `userId`'s connections REGARDLESS OF STATUS (member-scoped — the session's
//       id, never a client value); never another person's; never with credentials.
//     • each connection's `tools` carry the reads/makes-changes marking for its connector
//       (for a curated connector this is the project's curated declaration for that slug).
//
// Acceptance criteria → tests:
//   AC1 "Catalogue browse returns entries by category with connectable flags and a
//        Request-a-connector affordance for misses."
//   AC2 "The connections read lists all of the session user's connections with status and
//        per-tool reads/makes-changes marking."
//   AC3 "A user never receives another user's connections."
//   AC4/AC5 (the obligation ACs) live in the sibling `page-data.obligations.test.ts`.
//
// Database tests use `freshDb()` (an isolated in-memory PGlite with the real migrations);
// each closes its handle in a `finally`. The catalogue index is built by the REAL loader
// over throwaway fixture files written to a temp dir and removed immediately (the index is
// held in memory). Tests touch no network and no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browseCatalogue, listConnectionsForPage } from "./page-data";
import { loadCatalogue, type CatalogueIndex } from "./catalogue";
import { GOOGLE_CURATED_TOOLS } from "./curated/google";
import { createConnection, type ConnectionStatus } from "../db/connections";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";

// --- catalogue fixtures -----------------------------------------------------------
//
// A small, self-contained catalogue spanning three categories and all four auth kinds,
// with a deliberate mix of connectability:
//   • google-gmail  (oauth2)       — connectable ONLY when its client is configured (seam)
//   • acme-mail     (api_key)      — always connectable
//   • slack-oauth   (oauth2)       — oauth2 whose client is NOT configured ⇒ not connectable
//   • airtable      (provider_mcp) — always connectable
// "google-gmail" is a curated connector, so its tools carry the reads/makes-changes
// marking declared in `./curated/google` (the catalogue data file carries no such flag).

const FIXTURE_ENTRIES: Array<Record<string, unknown>> = [
  {
    id: "google-gmail",
    name: "Gmail",
    aliases: ["google mail", "gmail inbox"],
    category: "email",
    auth_kind: "oauth2",
    base_url: "https://gmail.googleapis.com",
    auth: {
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    },
  },
  {
    id: "acme-mail",
    name: "Acme Mail",
    aliases: ["acme"],
    category: "email",
    auth_kind: "api_key",
    base_url: "https://api.acme.example",
    auth: { header: "Authorization: Bearer {key}" },
  },
  {
    id: "slack-oauth",
    name: "Slacker",
    aliases: ["slacker chat"],
    category: "messaging",
    auth_kind: "oauth2",
    base_url: "https://slacker.example",
    auth: {
      authorize_url: "https://slacker.example/a",
      token_url: "https://slacker.example/t",
      scopes: ["chat:write"],
    },
  },
  {
    id: "airtable",
    name: "Airtable",
    aliases: ["airtable bases"],
    category: "database",
    auth_kind: "provider_mcp",
    base_url: "https://mcp.airtable.com/mcp",
    auth: {},
    curated_tools: [{ name: "list_records" }, { name: "create_record" }],
  },
];

function makeCatalogueDir(entries: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "warthog-page-data-"));
  for (const entry of entries) {
    writeFileSync(join(dir, `${String(entry.id)}.json`), JSON.stringify(entry));
  }
  return dir;
}

// Build a real CatalogueIndex over the fixtures through the project's own loader. The
// `connectableOAuth` set decides which oauth2 connectors have a configured client (the
// injected `isOAuthClientConfigured` seam); default: only "google-gmail".
function fixtureIndex(connectableOAuth: Set<string> = new Set(["google-gmail"])): CatalogueIndex {
  const dir = makeCatalogueDir(FIXTURE_ENTRIES);
  try {
    return loadCatalogue({ dir, isOAuthClientConfigured: (id) => connectableOAuth.has(id) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- connection fixtures ----------------------------------------------------------

const DEK_BYTES = 32;
const T0 = new Date("2026-04-01T09:00:00.000Z");

function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// Compare the moment, not the representation (connectedAt may be a Date or an ISO string).
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

// Provider credentials carrying a UNIQUE token, so an appearance of it in a page read is an
// unambiguous plaintext leak — credentials must never reach the client-facing shape.
function credsWith(token: string): Record<string, unknown> {
  return { accessToken: `atok_${token}`, refreshToken: `rtok_${token}` };
}

// Seed one connection for `userId` and return its id.
async function seedConnection(
  db: Db,
  dek: Uint8Array,
  userId: string,
  connectorId: string,
  accountLabel: string,
  token: string,
  status?: ConnectionStatus,
): Promise<string> {
  const created = await createConnection(
    db,
    { userId, connectorId, accountLabel, credentials: credsWith(token), status },
    dek,
    fixedClock(T0),
  );
  return created.id;
}

// ===========================================================================
// AC1 — catalogue browse: entries grouped BY CATEGORY, each with a connectable flag.
// ===========================================================================

test("browseCatalogue with no filter returns every entry grouped under its own category", () => {
  const index = fixtureIndex();
  const browse = browseCatalogue(index, {});

  // Every category in the index is represented, exactly once.
  const groupCategories = browse.groups.map((g) => g.category).sort();
  assert.deepEqual(
    groupCategories,
    [...index.categories()].sort(),
    "the groups cover exactly the catalogue's categories",
  );
  assert.equal(
    new Set(groupCategories).size,
    groupCategories.length,
    "each category appears as a single group",
  );

  // The union of all grouped entries is exactly the whole catalogue, each filed under its
  // own category.
  const flatIds = browse.groups.flatMap((g) => g.entries.map((e) => e.id)).sort();
  assert.deepEqual(
    flatIds,
    index.all().map((e) => e.id).sort(),
    "every catalogue entry appears in the browse",
  );
  for (const group of browse.groups) {
    for (const entry of group.entries) {
      assert.equal(entry.category, group.category, "an entry is filed under its own category");
    }
  }
});

test("browseCatalogue marks each entry's connectable flag from the index", () => {
  const index = fixtureIndex(); // only google-gmail's oauth2 client is configured
  const browse = browseCatalogue(index, {});

  const connectable = new Map<string, boolean>();
  for (const group of browse.groups) {
    for (const entry of group.entries) connectable.set(entry.id, entry.connectable);
  }

  // Each browse entry's flag agrees with the index's own connectability truth.
  for (const entry of index.all()) {
    assert.equal(
      connectable.get(entry.id),
      index.isConnectable(entry.id),
      `${entry.id} connectable flag matches the index`,
    );
  }

  // Spelled out for the fixture: the configured oauth2 + the always-on kinds are
  // connectable; the unconfigured oauth2 is not.
  assert.equal(connectable.get("google-gmail"), true, "a configured oauth2 connector is connectable");
  assert.equal(connectable.get("acme-mail"), true, "an api_key connector is always connectable");
  assert.equal(connectable.get("airtable"), true, "a provider_mcp connector is always connectable");
  assert.equal(connectable.get("slack-oauth"), false, "an unconfigured oauth2 connector is not connectable");
});

test("browseCatalogue filtered by category returns only that category's entries", () => {
  const index = fixtureIndex();
  const browse = browseCatalogue(index, { category: "email" });

  const ids = browse.groups.flatMap((g) => g.entries.map((e) => e.id)).sort();
  assert.deepEqual(ids, ["acme-mail", "google-gmail"], "only the email category's entries are returned");
  for (const group of browse.groups) {
    assert.equal(group.category, "email", "no other category leaks into a category-filtered browse");
  }
  assert.equal(browse.canRequest, false, "a category that has entries is not a miss");
});

// ===========================================================================
// AC1 — the "Request a connector" affordance surfaces for a MISS (and not for a hit).
// ===========================================================================

test("browseCatalogue surfaces the Request-a-connector affordance for a search miss", () => {
  const index = fixtureIndex();
  const browse = browseCatalogue(index, { query: "Hyperdrive Logistics 9000" });

  assert.equal(
    browse.groups.flatMap((g) => g.entries).length,
    0,
    "a search that matches nothing returns no entries",
  );
  assert.equal(browse.canRequest, true, "a miss offers the Request-a-connector affordance");
  assert.equal(
    browse.query,
    "Hyperdrive Logistics 9000",
    "the searched term is echoed back so the page can prefill the request",
  );
});

test("browseCatalogue does NOT offer the request affordance when a search hits", () => {
  const index = fixtureIndex();
  const browse = browseCatalogue(index, { query: "Gmail" });

  const hitIds = browse.groups.flatMap((g) => g.entries.map((e) => e.id));
  assert.ok(hitIds.includes("google-gmail"), "an exact-name search finds the entry");
  assert.equal(browse.canRequest, false, "a hit is not a miss — the request affordance is not surfaced");
});

// ===========================================================================
// AC2 — connections list-all: every connection, every status, with status / account /
// connected date, and the per-tool reads-vs-makes-changes marking.
// ===========================================================================

test("listConnectionsForPage returns ALL the person's connections regardless of status", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const index = fixtureIndex();
    const user = await makeUser(db, "ac2-all");

    const gmailId = await seedConnection(db, dek, user, "google-gmail", "oren@gmail.com", "G1", "connected");
    const acmeId = await seedConnection(db, dek, user, "acme-mail", "oren@acme", "A1", "needs_reconnect");
    const airId = await seedConnection(db, dek, user, "airtable", "oren-base", "AIR1", "error");

    const list = await listConnectionsForPage(db, user, index);

    const byId = new Map(list.map((c) => [c.id, c]));
    assert.deepEqual(
      new Set(byId.keys()),
      new Set([gmailId, acmeId, airId]),
      "all three connections are listed, regardless of status",
    );

    // Status, account label and connected date come straight through for each.
    assert.equal(byId.get(gmailId)!.status, "connected", "a connected connection is listed as connected");
    assert.equal(byId.get(acmeId)!.status, "needs_reconnect", "a needs_reconnect connection is listed");
    assert.equal(byId.get(airId)!.status, "error", "an errored connection is listed");

    assert.equal(byId.get(gmailId)!.accountLabel, "oren@gmail.com", "the account label is carried through");
    assert.equal(byId.get(gmailId)!.connectorId, "google-gmail", "the connector slug is carried through");
    assert.equal(ms(byId.get(gmailId)!.connectedAt), ms(T0), "the connected date is carried through");
  } finally {
    await db.close();
  }
});

test("listConnectionsForPage marks each curated connection's tools as reads or makes-changes", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const index = fixtureIndex();
    const user = await makeUser(db, "ac2-tools");
    await seedConnection(db, dek, user, "google-gmail", "oren@gmail.com", "G1", "connected");

    const list = await listConnectionsForPage(db, user, index);
    const gmail = list.find((c) => c.connectorId === "google-gmail");
    assert.ok(gmail, "the gmail connection is present");

    // The marking is checked against the project's OWN curated declaration for this slug —
    // the single source of truth for Gmail's reads vs makes-changes (its catalogue data
    // file carries no such flag), so the page read and the engine can never disagree.
    const expected = new Map(
      GOOGLE_CURATED_TOOLS.filter((t) => t.connectorId === "google-gmail").map((t) => [t.name, t.makesChange]),
    );
    const got = new Map(gmail!.tools.map((t) => [t.name, t.makesChange]));

    assert.ok(expected.size > 0, "the fixture precondition: Gmail has curated tools to mark");
    assert.deepEqual(
      new Set(got.keys()),
      new Set(expected.keys()),
      "the gmail connection offers exactly the curated gmail tools",
    );
    for (const [name, makesChange] of expected) {
      assert.equal(got.get(name), makesChange, `${name} is marked ${makesChange ? "makes-changes" : "read"}`);
    }

    // The fixture deliberately has both kinds — the marking distinguishes them, it is not a
    // constant.
    const values = [...got.values()];
    assert.ok(values.includes(true), "at least one tool is marked makes-changes (e.g. send/draft)");
    assert.ok(values.includes(false), "at least one tool is marked a read (e.g. search/read)");
  } finally {
    await db.close();
  }
});

test("listConnectionsForPage never folds a connection's credentials into the page shape", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const index = fixtureIndex();
    const user = await makeUser(db, "ac2-nocreds");
    await seedConnection(db, dek, user, "google-gmail", "oren@gmail.com", "SECRET1", "connected");

    const list = await listConnectionsForPage(db, user, index);
    const serialized = JSON.stringify(list);

    assert.ok(!serialized.includes("atok_SECRET1"), "no access token appears in the page read");
    assert.ok(!serialized.includes("rtok_SECRET1"), "no refresh token appears in the page read");
    for (const connection of list) {
      assert.ok(!("credentials" in connection), "a page connection carries no credentials field");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a person never receives another person's connections (member-scoped).
// ===========================================================================

test("listConnectionsForPage returns only the session person's connections", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const index = fixtureIndex();
    const alice = await makeUser(db, "ac3-alice");
    const bob = await makeUser(db, "ac3-bob");

    const aliceGmail = await seedConnection(db, dek, alice, "google-gmail", "alice@gmail.com", "AL1", "connected");
    const bobSlack = await seedConnection(db, dek, bob, "slack-oauth", "bob@slack", "BO1", "connected");

    const aliceList = await listConnectionsForPage(db, alice, index);
    const bobList = await listConnectionsForPage(db, bob, index);

    assert.deepEqual(aliceList.map((c) => c.id), [aliceGmail], "Alice sees only her own connection");
    assert.deepEqual(bobList.map((c) => c.id), [bobSlack], "Bob sees only his own connection");

    assert.ok(!aliceList.some((c) => c.id === bobSlack), "Alice never receives Bob's connection");
    assert.ok(!bobList.some((c) => c.id === aliceGmail), "Bob never receives Alice's connection");
  } finally {
    await db.close();
  }
});

test("listConnectionsForPage returns an empty list for a person with no connections", async () => {
  const db = await freshDb();
  try {
    const index = fixtureIndex();
    const loner = await makeUser(db, "ac3-loner");

    const list = await listConnectionsForPage(db, loner, index);
    assert.deepEqual(list, [], "a person with no connections receives an empty list, not an error");
  } finally {
    await db.close();
  }
});
