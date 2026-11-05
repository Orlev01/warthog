// E09-S01 — Catalogue loader, the obligation acceptance criteria
// (INV-102 validate-and-parameterize-input; INV-103 secrets-from-env).
//
// RED-first: `./catalogue` does not exist yet, so importing `loadCatalogue` throws and
// every test here fails until the builder writes the module. That absence IS the point
// of test-first; do NOT implement anything to make these pass.
//
// The pinned loader contract is documented in the sibling `catalogue.test.ts`; this
// file depends on the same `loadCatalogue({ dir, isOAuthClientConfigured })` surface
// and the `CatalogueIndex` it returns, and pins only BEHAVIOUR.
//
//   AC [obligation:validate-and-parameterize-input] (INV-102) —
//     • the loader VALIDATES every entry at the boundary and rejects a malformed or
//       OVERSIZED file at load, throwing rather than returning a half-built index; and
//     • the catalogue is file-backed and held purely IN MEMORY — it never reaches a SQL
//       query, so there is no query for a probe to alter. Every field value is inert
//       DATA: a SQL-injection probe placed in a field is loaded VERBATIM, is only ever
//       compared/returned as a literal key, and disturbs no other entry. (The
//       parameter-binding half of INV-102 lives on the db seam, which this task has
//       none of; connections and connector-requests are later tasks, E09-S05 / S14.)
//   AC [obligation:secrets-from-env] (INV-103) — the loader reads no `process.env`:
//     connectability comes ONLY from the injected `isOAuthClientConfigured` seam, and no
//     ambient env value is folded into the index. Secrets flow in through the seam
//     (config reads them from env), never baked into this module or its output.
//
// Fixtures are written to a throwaway temp directory per test and removed in `finally`.
// Tests touch no network and no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalogue } from "./catalogue";

// --- fixtures (self-contained; mirror catalogue.test.ts) --------------------

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

function makeCatalogueDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "warthog-catalogue-obl-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function entryFiles(entries: Array<Record<string, unknown>>): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of entries) {
    files[`${String(entry.id)}.json`] = JSON.stringify(entry);
  }
  return files;
}

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

// ===========================================================================
// AC [validate-and-parameterize-input] — a malformed entry is rejected at the
// boundary; the loader throws rather than returning a partially-built index.
// ===========================================================================

test("[validate-and-parameterize-input] a malformed entry is rejected at the boundary; no index is returned", () => {
  const dir = makeCatalogueDir({
    "ok.json": JSON.stringify(validEntry({ id: "ok" })),
    "bad.json": JSON.stringify({
      id: "bad",
      name: "Bad",
      aliases: [],
      category: "email",
      auth_kind: "nope", // not one of the four allowed kinds
      base_url: "https://api.bad.example",
      auth: {},
    }),
  });
  try {
    let index: unknown;
    assert.throws(() => {
      index = loadCatalogue({ dir, isOAuthClientConfigured: () => false });
    }, "a malformed entry is rejected at load");
    assert.equal(index, undefined, "the loader throws rather than returning a half-built index");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC [validate-and-parameterize-input] — an OVERSIZED catalogue file is refused at
// load. A single connector entry is tiny; a multi-megabyte file is a boot-safety
// hazard and must be rejected rather than parsed and indexed.
// ===========================================================================

test("[validate-and-parameterize-input] an oversized catalogue file is rejected at load", () => {
  // An otherwise-valid entry padded to ~5 MiB: the ONLY reason to reject it is its size.
  const huge = validEntry({ id: "huge", instructions: "a".repeat(5 * 1024 * 1024) });
  const dir = makeCatalogueDir({ "huge.json": JSON.stringify(huge) });
  try {
    assert.throws(
      () => loadCatalogue({ dir, isOAuthClientConfigured: () => false }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "an oversized file is rejected at load");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC [validate-and-parameterize-input] — field values are inert DATA. The catalogue is
// held in memory and never reaches a SQL query, so a SQL-injection probe in a field
// cannot alter a query: it round-trips verbatim and disturbs no other entry.
// ===========================================================================

test("[validate-and-parameterize-input] a SQL-injection probe in a field is inert data and alters nothing", () => {
  const dropProbe = "'); DROP TABLE connectors; --";
  const orProbe = "x' OR '1'='1";
  const probeCategory = "email'; DROP TABLE connectors; --";

  const probeEntry = validEntry({
    id: "probe-co",
    name: dropProbe,
    category: probeCategory,
    aliases: [orProbe],
    instructions: dropProbe,
    auth_kind: "api_key",
    base_url: "https://api.probe.example",
    auth: { header: "Authorization: Bearer {key}" },
  });
  // A sentinel that must remain intact and findable after the probe entry is loaded.
  const sentinel = validEntry({
    id: "sentinel",
    name: "Sentinel",
    category: "files",
    aliases: ["sentinel-alias"],
    base_url: "https://api.sentinel.example",
  });

  const dir = makeCatalogueDir(entryFiles([probeEntry, sentinel]));
  try {
    const index = loadCatalogue({ dir, isOAuthClientConfigured: () => false });

    // The probe round-trips VERBATIM — nothing in it was interpreted or executed.
    const loaded = index.get("probe-co");
    assert.equal(loaded?.name, dropProbe, "the probe survives verbatim in the entry name");
    assert.deepEqual(loaded?.aliases, [orProbe], "the probe survives verbatim in the aliases");

    // It is only ever used as a LITERAL key: findable by its (probe-containing)
    // category and alias, matching nothing else.
    assert.deepEqual(
      index.byCategory(probeCategory).map((e) => e.id),
      ["probe-co"],
      "the probe category is a literal lookup key, not an interpreted fragment",
    );
    assert.equal(index.byAlias(orProbe)?.id, "probe-co", "the probe alias is a literal lookup key");

    // The sentinel and the rest of the index are intact — the probe altered nothing.
    assert.equal(index.get("sentinel")?.name, "Sentinel", "the sentinel entry is intact");
    assert.equal(index.byAlias("sentinel-alias")?.id, "sentinel", "the sentinel is still findable by alias");
    assert.equal(index.all().length, 2, "exactly the two entries loaded; the probe created/destroyed nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC [secrets-from-env] — connectability comes ONLY from the injected config seam.
// Even with CONNECTOR_* secrets sitting in the environment, the loader ignores ambient
// env and uses the injected predicate, and folds no env value into its output.
// ===========================================================================

test("[secrets-from-env] connectability uses the injected seam, not ambient env, and leaks no env value", () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const DECOY_ID = "decoy-client-id-must-never-appear";
  const prevSecret = process.env.CONNECTOR_ACME_CLIENT_SECRET;
  const prevId = process.env.CONNECTOR_ACME_CLIENT_ID;
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  process.env.CONNECTOR_ACME_CLIENT_SECRET = DECOY;
  process.env.CONNECTOR_ACME_CLIENT_ID = DECOY_ID;
  process.env.WARTHOG_DECOY_SECRET = DECOY;

  const oauthEntry = validEntry({
    id: "acme",
    name: "Acme",
    category: "calendar",
    aliases: ["acme-cal"],
    auth_kind: "oauth2",
    base_url: "https://api.acme.example",
    auth: { authorize_url: "https://acme.example/a", token_url: "https://acme.example/t", scopes: ["read"] },
  });
  const dir = makeCatalogueDir(entryFiles([oauthEntry]));
  try {
    // Despite a CONNECTOR_ACME_CLIENT_* pair in the environment, the loader uses ONLY
    // the injected predicate: `false` → the oauth2 entry is not connectable.
    const off = loadCatalogue({ dir, isOAuthClientConfigured: () => false });
    assert.equal(off.isConnectable("acme"), false, "ambient env is ignored; the injected seam (off) decides");

    // And flips purely with the injected seam.
    const on = loadCatalogue({ dir, isOAuthClientConfigured: () => true });
    assert.equal(on.isConnectable("acme"), true, "the injected seam (on) makes it connectable");

    // No ambient env value is folded into any index output.
    const dump = JSON.stringify({ all: on.all(), connectable: on.connectable(), one: on.get("acme") });
    assert.ok(!dump.includes(DECOY), "no ambient env secret appears in the index output");
    assert.ok(!dump.includes(DECOY_ID), "no ambient env client id appears in the index output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreEnv("CONNECTOR_ACME_CLIENT_SECRET", prevSecret);
    restoreEnv("CONNECTOR_ACME_CLIENT_ID", prevId);
    restoreEnv("WARTHOG_DECOY_SECRET", prevDecoy);
  }
});
