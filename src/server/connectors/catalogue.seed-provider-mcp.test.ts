// E09-S02 — Seed catalogue: provider_mcp entries.
//
// The brief requires "at least 30 provider-hosted connectors that allow automatic
// registration" (design §7 "Launch target: ≥ 30 provider_mcp … entries"). These are
// DATA FILES the operator deploys under `catalogue/connectors/<id>.json` — "Adding an
// entry = a PR + deploy; no code change" — validated at boot by the catalogue loader
// (E09-S01, `./catalogue`) against the catalogue schema (E03-S11,
// `src/domain/catalogue/schema.ts`). A provider_mcp connector self-registers via CIMD,
// so it carries no auth secrets and is always connectable.
//
// RED-first: the seed data files do NOT exist yet, so reading the real
// `catalogue/connectors/` directory throws (ENOENT) and every test here fails until the
// builder adds the ≥ 30 data files. That absence IS the point of test-first. As the
// TESTER I must NOT create or edit any data/source file to make these pass — including
// the catalogue entries themselves, which are this task's deliverable for the builder.
//
// These tests pin the BEHAVIOUR of the real seed DATA (what validates, what loads, what
// is connectable) — never the source text of any file. They are scoped to the entries
// this task owns: every `*.json` file in the real catalogue directory that declares
// `auth_kind: "provider_mcp"`. Sibling seed tasks (api_key / oauth2 — E09-S03/S04) add
// OTHER files to the same directory; those are out of scope here and are deliberately
// skipped, so this file's result depends only on the provider_mcp seed. The provider_mcp
// files are copied into a throwaway directory before the boot loader runs, so a defect
// in a sibling seed file can never redden this task's suite. No network, no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalogue } from "./catalogue";
import { validateCatalogueEntry } from "../../domain/catalogue/schema";

// The real, committed seed catalogue directory. Resolved from the repo root: `npm test`
// runs with cwd at the repo root, the same rooting server code uses for repo-relative
// dirs (CLAUDE.md: "Root such paths at process.cwd()").
const CATALOGUE_DIR = join(process.cwd(), "catalogue", "connectors");

// The brief / design launch target for provider-hosted (self-registering) connectors.
const REQUIRED_PROVIDER_MCP_COUNT = 30;

interface SeedFile {
  fileName: string;
  raw: string;
  parsed: Record<string, unknown>;
}

// Read every `*.json` file in the real catalogue directory that declares
// `auth_kind: "provider_mcp"`. Files that are not a JSON object, or whose auth_kind is
// something else (the api_key / oauth2 seed owned by other tasks), are skipped — this
// task owns only the provider_mcp entries. Throws (ENOENT) while the directory is absent
// → the intended RED.
function readProviderMcpFiles(dir: string): SeedFile[] {
  const out: SeedFile[] = [];
  const fileNames = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const fileName of fileNames) {
    const raw = readFileSync(join(dir, fileName), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not valid JSON — cannot classify; it belongs to the loader's own tests, not here.
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).auth_kind === "provider_mcp"
    ) {
      out.push({ fileName, raw, parsed: parsed as Record<string, unknown> });
    }
  }
  return out;
}

// ===========================================================================
// AC — at least 30 provider_mcp entries load and validate against the schema.
// ===========================================================================

test("the seed catalogue has at least 30 provider_mcp entries, each validating against the schema", () => {
  const files = readProviderMcpFiles(CATALOGUE_DIR);

  assert.ok(
    files.length >= REQUIRED_PROVIDER_MCP_COUNT,
    `at least ${REQUIRED_PROVIDER_MCP_COUNT} provider_mcp catalogue entries are present (got ${files.length})`,
  );

  for (const { fileName, parsed } of files) {
    const result = validateCatalogueEntry(parsed);
    if (!result.ok) {
      assert.fail(
        `${fileName} must validate against the catalogue schema — ` +
          result.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      );
    }
    assert.equal(result.entry.auth_kind, "provider_mcp", `${fileName} is a provider_mcp entry`);
  }
});

// ===========================================================================
// AC — each entry declares id, name, aliases, category and a provider MCP base URL.
// ===========================================================================

test("each provider_mcp entry declares id, name, aliases, category and a provider MCP base URL", () => {
  const files = readProviderMcpFiles(CATALOGUE_DIR);
  assert.ok(
    files.length >= REQUIRED_PROVIDER_MCP_COUNT,
    `at least ${REQUIRED_PROVIDER_MCP_COUNT} provider_mcp entries (got ${files.length})`,
  );

  const ids: string[] = [];
  const aliasKeys: string[] = [];

  for (const { fileName, parsed } of files) {
    const result = validateCatalogueEntry(parsed);
    if (!result.ok) {
      assert.fail(`${fileName} must validate against the catalogue schema`);
    }
    const entry = result.entry;

    // id — a non-empty string.
    assert.equal(typeof entry.id, "string", `${fileName} declares a string id`);
    assert.ok(entry.id.length > 0, `${fileName} declares a non-empty id`);
    ids.push(entry.id);

    // name — a non-empty string.
    assert.equal(typeof entry.name, "string", `${fileName} declares a string name`);
    assert.ok(entry.name.length > 0, `${fileName} declares a non-empty name`);

    // aliases — present as an array, with at least one non-empty string alias (the
    // catalogue is searchable by alias and connector requests are matched on aliases).
    assert.ok(Array.isArray(entry.aliases), `${fileName} declares an aliases array`);
    assert.ok(entry.aliases.length >= 1, `${fileName} declares at least one alias`);
    for (const alias of entry.aliases) {
      assert.ok(
        typeof alias === "string" && alias.length > 0,
        `${fileName} aliases are non-empty strings`,
      );
      aliasKeys.push(alias.toLowerCase());
    }

    // category — a non-empty string (the browsable catalogue categories are open-ended
    // per the brief, so the value is not constrained to a fixed set here).
    assert.equal(typeof entry.category, "string", `${fileName} declares a string category`);
    assert.ok(entry.category.length > 0, `${fileName} declares a non-empty category`);

    // provider MCP base URL — a valid https URL. Provider MCP servers are reached only
    // over https through the SSRF guard (CLAUDE.md security rules), so an http or
    // malformed base URL is not acceptable.
    assert.equal(typeof entry.base_url, "string", `${fileName} declares a string base_url`);
    assert.ok(entry.base_url.length > 0, `${fileName} declares a non-empty base_url`);
    const url = new URL(entry.base_url); // validated as a URL by the schema already
    assert.equal(url.protocol, "https:", `${fileName} provider MCP base URL is https`);
  }

  // Ids are unique across the provider_mcp seed: the loader indexes by id, so a
  // collision would silently shadow an entry.
  assert.equal(new Set(ids).size, ids.length, "provider_mcp entry ids are unique");

  // Aliases are unique (case-insensitively) across the provider_mcp seed: the loader's
  // alias index folds case, so a collision would make one entry unreachable by its alias.
  assert.equal(
    new Set(aliasKeys).size,
    aliasKeys.length,
    "provider_mcp entry aliases are unique (case-insensitively)",
  );
});

// ===========================================================================
// AC (via the real boot loader) — the provider_mcp seed loads through the actual
// catalogue loader into a searchable index, and (design §7) every provider_mcp entry is
// connectable WITHOUT any operator client configuration. Copying only the provider_mcp
// files into a throwaway directory keeps this check dependent on THIS task's data alone.
// ===========================================================================

test("the provider_mcp seed loads through the boot loader: every entry is connectable and findable", () => {
  const files = readProviderMcpFiles(CATALOGUE_DIR);
  assert.ok(
    files.length >= REQUIRED_PROVIDER_MCP_COUNT,
    `at least ${REQUIRED_PROVIDER_MCP_COUNT} provider_mcp entries (got ${files.length})`,
  );

  const dir = mkdtempSync(join(tmpdir(), "warthog-provider-mcp-seed-"));
  try {
    for (const { fileName, raw } of files) {
      writeFileSync(join(dir, fileName), raw);
    }

    // `isOAuthClientConfigured` returns false for everything — a provider_mcp entry must
    // be connectable regardless, because it ignores that seam (design §7).
    const index = loadCatalogue({ dir, isOAuthClientConfigured: () => false });

    const loaded = index.all();
    assert.equal(loaded.length, files.length, "every provider_mcp file loaded into the index");
    assert.ok(
      loaded.length >= REQUIRED_PROVIDER_MCP_COUNT,
      `at least ${REQUIRED_PROVIDER_MCP_COUNT} entries in the index (got ${loaded.length})`,
    );

    for (const entry of loaded) {
      assert.equal(entry.auth_kind, "provider_mcp", "only provider_mcp entries were loaded");

      // Connectable with no operator client configured.
      assert.equal(index.isConnectable(entry.id), true, `${entry.id} is connectable`);
      assert.ok(
        index.connectable().some((e) => e.id === entry.id),
        `${entry.id} is in connectable()`,
      );

      // Findable by id, by category, and (case-insensitively) by its first alias.
      assert.equal(index.get(entry.id)?.id, entry.id, `${entry.id} is found by id`);
      assert.ok(
        index.byCategory(entry.category).some((e) => e.id === entry.id),
        `${entry.id} is found under its category`,
      );
      const firstAlias = entry.aliases[0];
      assert.ok(
        typeof firstAlias === "string" && firstAlias.length > 0,
        `${entry.id} declares at least one alias`,
      );
      assert.equal(
        index.byAlias(firstAlias.toUpperCase())?.id,
        entry.id,
        `${entry.id} is found case-insensitively by its alias`,
      );
    }

    // Every loaded provider_mcp entry is connectable, so the connectable set is the whole
    // set.
    assert.equal(index.connectable().length, loaded.length, "every provider_mcp entry is connectable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
