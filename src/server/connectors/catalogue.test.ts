// E09-S01 — Catalogue loader and availability (design §7 "Connector engine";
// brief "Connector catalogue — searchable and browsable by category … at least 100
// connectable services at launch"). The loader reads the operator's data files
// `catalogue/connectors/*.json`, validates each against the catalogue schema
// (`src/domain/catalogue/schema.ts`, built E03-S11), builds an in-memory index by
// category and alias, and computes connectability.
//
// RED-first: `./catalogue` does not exist yet, so importing `loadCatalogue` throws
// and every test here fails until the builder writes the module. That absence IS the
// point of test-first; do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what the index returns), never source text. The pinned
// contract this file (and its sibling `catalogue.obligations.test.ts`) depends on:
//
//   // A SYNCHRONOUS boot loader. It reads `*.json` files from `dir`, validates each
//   // against the catalogue schema, and throws a CLEAR error (naming the offending
//   // file + field) on the first malformed/oversized file — bad entries are rejected
//   // at boot, never half-loaded. `isOAuthClientConfigured(id)` is the injected
//   // config seam that decides whether an oauth2 connector's client id/secret are
//   // configured; api_key / basic / provider_mcp ignore it (always connectable).
//   function loadCatalogue(options: {
//     dir: string;
//     isOAuthClientConfigured: (connectorId: string) => boolean;
//   }): CatalogueIndex;
//
//   interface CatalogueIndex {
//     all(): readonly CatalogueEntry[];               // every loaded entry
//     get(id: string): CatalogueEntry | undefined;    // by id
//     byCategory(category: string): readonly CatalogueEntry[];
//     byAlias(alias: string): CatalogueEntry | undefined;   // case-insensitive
//     categories(): readonly string[];                // the distinct categories present
//     isConnectable(id: string): boolean;
//     connectable(): readonly CatalogueEntry[];       // only the connectable entries
//   }
//
// Fixtures are written to a throwaway temp directory per test (never a committed data
// file — the seed catalogue is E09-S02…S04) and removed in `finally`. Tests touch no
// network and no database (the loader is file + config only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalogue } from "./catalogue";

// --- fixtures ---------------------------------------------------------------

// A minimal VALID catalogue entry (every required field of the schema), with
// overrides merged on top. Keys are snake_case to mirror the data files.
function validEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme",
    name: "Acme Mail",
    aliases: ["acme-corp"],
    category: "email",
    auth_kind: "api_key",
    base_url: "https://api.acme.example",
    auth: { header: "Authorization: Bearer {key}" },
    ...over,
  };
}

// Write a throwaway catalogue directory from a filename → file-content map.
function makeCatalogueDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "warthog-catalogue-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

// Turn a list of entry objects into a `<id>.json` file map.
function entryFiles(entries: Array<Record<string, unknown>>): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of entries) {
    files[`${String(entry.id)}.json`] = JSON.stringify(entry);
  }
  return files;
}

const noOAuth = (): boolean => false;

// ===========================================================================
// AC — valid entries load into an index searchable by category and alias.
// ===========================================================================

test("loads valid entries into an index searchable by category and by alias", () => {
  const dir = makeCatalogueDir(
    entryFiles([
      validEntry({ id: "acme", name: "Acme Mail", category: "email", aliases: ["acme-corp"] }),
      validEntry({ id: "beemail", name: "Bee Mail", category: "email", aliases: ["bee"] }),
      validEntry({
        id: "clockcal",
        name: "Clock Calendar",
        category: "calendar",
        aliases: ["clock-cal"],
        auth_kind: "provider_mcp",
        auth: {},
      }),
    ]),
  );
  try {
    const index = loadCatalogue({ dir, isOAuthClientConfigured: noOAuth });

    // searchable by category
    assert.deepEqual(
      new Set(index.byCategory("email").map((e) => e.id)),
      new Set(["acme", "beemail"]),
      "both email connectors are found by category",
    );
    assert.deepEqual(
      index.byCategory("calendar").map((e) => e.id),
      ["clockcal"],
      "the calendar connector is found by category",
    );
    assert.deepEqual(index.byCategory("no-such-category"), [], "an unknown category yields no entries");

    // searchable by alias
    assert.equal(index.byAlias("acme-corp")?.id, "acme", "an entry is found by its alias");
    assert.equal(index.byAlias("clock-cal")?.id, "clockcal", "another entry is found by its alias");
    assert.equal(index.byAlias("missing-alias"), undefined, "an unknown alias yields nothing");

    // by id, and the distinct category list
    assert.equal(index.get("beemail")?.name, "Bee Mail", "an entry is found by id");
    assert.equal(index.get("nope"), undefined, "an unknown id yields nothing");
    assert.deepEqual(
      new Set(index.categories()),
      new Set(["email", "calendar"]),
      "categories() lists the distinct categories present",
    );

    assert.equal(index.all().length, 3, "every valid entry is loaded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alias search ignores case", () => {
  const dir = makeCatalogueDir(
    entryFiles([validEntry({ id: "clockcal", name: "Clock Calendar", category: "calendar", aliases: ["gcal"] })]),
  );
  try {
    const index = loadCatalogue({ dir, isOAuthClientConfigured: noOAuth });
    assert.equal(index.byAlias("GCAL")?.id, "clockcal", "an upper-cased alias still matches");
    assert.equal(index.byAlias("GcAl")?.id, "clockcal", "a mixed-case alias still matches");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC — at least 100 connectable entries are present (the loader's counting +
// connectability mechanism, exercised with 100+ synthetic always-connectable
// entries; the real seed catalogue is E09-S02…S04).
// ===========================================================================

test("at least 100 connectable entries load into the index", () => {
  const entries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 100; i++) {
    entries.push(
      validEntry({
        id: `svc-${i}`,
        name: `Service ${i}`,
        category: i % 2 === 0 ? "email" : "files",
        aliases: [`svc-${i}-alias`],
        auth_kind: "api_key",
        base_url: `https://api.svc${i}.example`,
        auth: { header: "Authorization: Bearer {key}" },
      }),
    );
  }
  // A provider_mcp entry (always connectable) and an oauth2 entry whose client is NOT
  // configured (present in the index, but not counted as connectable).
  entries.push(
    validEntry({ id: "mcp-a", name: "MCP A", category: "notes", aliases: ["mcpa"], auth_kind: "provider_mcp", auth: {} }),
  );
  entries.push(
    validEntry({
      id: "oauth-off",
      name: "OAuth Off",
      category: "calendar",
      aliases: ["oauthoff"],
      auth_kind: "oauth2",
      base_url: "https://api.oauthoff.example",
      auth: { authorize_url: "https://o.example/a", token_url: "https://o.example/t", scopes: ["read"] },
    }),
  );

  const dir = makeCatalogueDir(entryFiles(entries));
  try {
    const index = loadCatalogue({ dir, isOAuthClientConfigured: noOAuth });

    assert.ok(index.all().length >= 102, `every entry loaded (got ${index.all().length})`);
    assert.ok(
      index.connectable().length >= 100,
      `at least 100 connectable entries are present (got ${index.connectable().length})`,
    );

    // The unconfigured oauth2 entry is present but not connectable.
    assert.equal(index.isConnectable("oauth-off"), false, "an unconfigured oauth2 entry is not connectable");
    assert.ok(
      !index.connectable().some((e) => e.id === "oauth-off"),
      "the unconfigured oauth2 entry is excluded from connectable()",
    );
    // A provider_mcp entry is connectable.
    assert.equal(index.isConnectable("mcp-a"), true, "a provider_mcp entry is connectable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC — connectability: oauth2 only when its client id/secret are configured;
// api_key / basic / provider_mcp always.
// ===========================================================================

test("connectability: api_key/basic/provider_mcp always; oauth2 only with a configured client", () => {
  const entries = [
    validEntry({
      id: "k",
      auth_kind: "api_key",
      category: "email",
      aliases: ["k"],
      base_url: "https://api.k.example",
      auth: { header: "Authorization: Bearer {key}" },
    }),
    validEntry({
      id: "b",
      auth_kind: "basic",
      category: "files",
      aliases: ["b"],
      base_url: "https://api.b.example",
      auth: { header: "Authorization: Basic {key}" },
    }),
    validEntry({ id: "m", auth_kind: "provider_mcp", category: "notes", aliases: ["m"], base_url: "https://api.m.example", auth: {} }),
    validEntry({
      id: "o-on",
      auth_kind: "oauth2",
      category: "calendar",
      aliases: ["oon"],
      base_url: "https://api.oon.example",
      auth: { authorize_url: "https://o.example/a", token_url: "https://o.example/t", scopes: ["x"] },
    }),
    validEntry({
      id: "o-off",
      auth_kind: "oauth2",
      category: "calendar",
      aliases: ["ooff"],
      base_url: "https://api.ooff.example",
      auth: { authorize_url: "https://o.example/a", token_url: "https://o.example/t", scopes: ["x"] },
    }),
  ];
  const dir = makeCatalogueDir(entryFiles(entries));
  try {
    // Only the "o-on" oauth2 connector has its client configured.
    const index = loadCatalogue({ dir, isOAuthClientConfigured: (id) => id === "o-on" });

    assert.equal(index.isConnectable("k"), true, "api_key is always connectable");
    assert.equal(index.isConnectable("b"), true, "basic is always connectable");
    assert.equal(index.isConnectable("m"), true, "provider_mcp is always connectable");
    assert.equal(index.isConnectable("o-on"), true, "oauth2 with a configured client is connectable");
    assert.equal(index.isConnectable("o-off"), false, "oauth2 without a configured client is not connectable");

    assert.deepEqual(
      new Set(index.connectable().map((e) => e.id)),
      new Set(["k", "b", "m", "o-on"]),
      "connectable() is exactly the connectable entries",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC — a malformed entry is rejected at load with a CLEAR error (naming the
// offending file and field). Rejection happens even when a valid entry sits
// alongside, proving per-entry validation at the boundary.
// ===========================================================================

test("a malformed entry (missing required field) is rejected at load, naming the file and field", () => {
  // `category` is omitted; every other required field is present, so `category` is the
  // sole defect.
  const bad = {
    id: "broken",
    name: "Broken",
    aliases: [],
    auth_kind: "api_key",
    base_url: "https://api.broken.example",
    auth: {},
  };
  const dir = makeCatalogueDir({
    "acme.json": JSON.stringify(validEntry()),
    "broken-entry.json": JSON.stringify(bad),
  });
  try {
    assert.throws(
      () => loadCatalogue({ dir, isOAuthClientConfigured: noOAuth }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "load throws an Error for a malformed entry");
        const msg = err.message.toLowerCase();
        assert.ok(msg.includes("broken-entry"), `the error names the offending file: ${err.message}`);
        assert.ok(msg.includes("category"), `the error names the offending field: ${err.message}`);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed entry (bad auth kind) is rejected at load, naming the file and field", () => {
  const bad = validEntry({ id: "weirdauth", auth_kind: "magic" });
  const dir = makeCatalogueDir({ "weirdauth.json": JSON.stringify(bad) });
  try {
    assert.throws(
      () => loadCatalogue({ dir, isOAuthClientConfigured: noOAuth }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "load throws an Error for a bad auth kind");
        const msg = err.message.toLowerCase();
        assert.ok(msg.includes("weirdauth"), `the error names the offending file: ${err.message}`);
        assert.ok(msg.includes("auth_kind"), `the error names the offending field: ${err.message}`);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed entry (invalid base_url) is rejected at load", () => {
  const bad = validEntry({ id: "nourl", base_url: "not-a-valid-url" });
  const dir = makeCatalogueDir({ "nourl.json": JSON.stringify(bad) });
  try {
    assert.throws(
      () => loadCatalogue({ dir, isOAuthClientConfigured: noOAuth }),
      /nourl|base_url|url/i,
      "an invalid base_url is rejected at load",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file containing invalid JSON is rejected at load, naming the file", () => {
  const dir = makeCatalogueDir({ "garbage.json": "{ not valid json ," });
  try {
    assert.throws(
      () => loadCatalogue({ dir, isOAuthClientConfigured: noOAuth }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "load throws an Error for invalid JSON");
        assert.ok(
          err.message.toLowerCase().includes("garbage"),
          `the error names the offending file: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
