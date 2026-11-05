// E09-S03 — Seed catalogue: api_key (and basic) entries.
//
// The brief requires "at least 60 services connected with the person's own API key or
// personal token" (design §7 "Launch target: … ≥ 60 api_key entries"). These are DATA
// FILES the operator deploys under `catalogue/connectors/<id>.json` — "Adding an entry =
// a PR + deploy; no code change" — validated at boot by the catalogue loader (E09-S01,
// `./catalogue`) against the catalogue schema (E03-S11, `src/domain/catalogue/schema.ts`).
// An api_key / basic connector carries a header TEMPLATE (design §7: "header template
// like `Authorization: Bearer {key}`") plus plain key-entry instructions and a provider
// docs link; it needs no operator client, so it is always connectable.
//
// RED-first: the seed api_key/basic data files do NOT exist yet (today the directory holds
// only the E09-S02 provider_mcp seed), so these tests fail until the builder adds the ≥ 60
// data files. That absence IS the point of test-first. As the TESTER I must NOT create or
// edit any data/source file to make these pass — including the catalogue entries
// themselves, which are this task's deliverable for the builder.
//
// These tests pin the BEHAVIOUR of the real seed DATA (what validates, what loads, what is
// connectable, what each entry carries) — never the source text of any file. They are
// scoped to the entries this task owns: every `*.json` file in the real catalogue directory
// whose `auth_kind` is `api_key` or `basic`. Sibling seed tasks (provider_mcp — E09-S02;
// oauth2 — E09-S04) add OTHER files to the same directory; those are out of scope here and
// are deliberately skipped, so this file's result depends only on the api_key/basic seed.
// The api_key/basic files are copied into a throwaway directory before the boot loader runs,
// so a defect in a sibling seed file can never redden this task's suite. No network, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalogue } from "./catalogue";
import { validateCatalogueEntry, type CatalogueEntry } from "../../domain/catalogue/schema";

// The real, committed seed catalogue directory. Resolved from the repo root: `npm test`
// runs with cwd at the repo root, the same rooting server code uses for repo-relative dirs
// (CLAUDE.md: "Root such paths at process.cwd()").
const CATALOGUE_DIR = join(process.cwd(), "catalogue", "connectors");

// The brief / design launch target for person-supplied-key connectors.
const REQUIRED_API_KEY_COUNT = 60;

// The brief's browsable categories the api_key/basic seed must SPAN (task AC). Category
// strings in the data files are free-form kebab-case (the schema does not fix a vocabulary
// and existing entries use e.g. "developer-tools", "project-management", "ecommerce"), so
// each concept is matched at the CONCEPT level: at least one entry whose category contains
// one of these keywords. This tests "spanning the brief's categories" without locking the
// builder into one exact spelling.
const REQUIRED_CATEGORY_CONCEPTS: { concept: string; keywords: string[] }[] = [
  { concept: "email", keywords: ["email", "mail"] },
  { concept: "calendar", keywords: ["calendar"] },
  { concept: "files", keywords: ["file", "storage", "drive"] },
  { concept: "messaging", keywords: ["messag", "chat", "communication"] },
  { concept: "notes", keywords: ["note", "task"] },
  { concept: "finance", keywords: ["financ", "payment", "banking", "accounting"] },
  { concept: "travel", keywords: ["travel", "flight", "hotel", "transport"] },
  { concept: "shopping", keywords: ["shop", "commerce", "retail"] },
  { concept: "developer", keywords: ["develop", "code"] },
  { concept: "smart home", keywords: ["smart", "home", "iot"] },
];

interface SeedFile {
  fileName: string;
  raw: string;
  parsed: Record<string, unknown>;
}

// Read every `*.json` file in the real catalogue directory whose `auth_kind` is `api_key`
// or `basic` (a person-supplied-key connector). Files that are not a JSON object, or whose
// auth_kind is something else (the provider_mcp / oauth2 seeds owned by other tasks), are
// skipped — this task owns only the api_key/basic entries. Throws (ENOENT) if the directory
// is absent.
function readApiKeyFiles(dir: string): SeedFile[] {
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
    if (parsed === null || typeof parsed !== "object") continue;
    const authKind = (parsed as Record<string, unknown>).auth_kind;
    if (authKind === "api_key" || authKind === "basic") {
      out.push({ fileName, raw, parsed: parsed as Record<string, unknown> });
    }
  }
  return out;
}

// Validate a seed file against the real schema or fail with a field-level message.
function validateOrFail(file: SeedFile): CatalogueEntry {
  const result = validateCatalogueEntry(file.parsed);
  if (!result.ok) {
    assert.fail(
      `${file.fileName} must validate against the catalogue schema — ` +
        result.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  return result.entry;
}

// Find the first absolute https URL in a block of text, trimming trailing punctuation that
// a sentence would put after a link. Returns undefined if there is none.
function firstHttpsUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/[^\s"'`)<>\]]+/i);
  if (!match) return undefined;
  return match[0].replace(/[.,;:!?)]+$/, "");
}

// ===========================================================================
// AC — at least 60 api_key/basic entries load and validate against the schema.
// ===========================================================================

test("the seed catalogue has at least 60 api_key/basic entries, each validating against the schema", () => {
  const files = readApiKeyFiles(CATALOGUE_DIR);

  assert.ok(
    files.length >= REQUIRED_API_KEY_COUNT,
    `at least ${REQUIRED_API_KEY_COUNT} api_key/basic catalogue entries are present (got ${files.length})`,
  );

  for (const file of files) {
    const entry = validateOrFail(file);
    assert.ok(
      entry.auth_kind === "api_key" || entry.auth_kind === "basic",
      `${file.fileName} is an api_key or basic entry (got ${entry.auth_kind})`,
    );
  }
});

// ===========================================================================
// AC — each entry declares id, name, aliases, category and an https base URL;
// ids and aliases are unique across the seed.
// ===========================================================================

test("each api_key/basic entry declares id, name, aliases, category and an https base URL", () => {
  const files = readApiKeyFiles(CATALOGUE_DIR);
  assert.ok(
    files.length >= REQUIRED_API_KEY_COUNT,
    `at least ${REQUIRED_API_KEY_COUNT} api_key/basic entries (got ${files.length})`,
  );

  const ids: string[] = [];
  const aliasKeys: string[] = [];

  for (const file of files) {
    const entry = validateOrFail(file);

    // id — a non-empty string.
    assert.equal(typeof entry.id, "string", `${file.fileName} declares a string id`);
    assert.ok(entry.id.length > 0, `${file.fileName} declares a non-empty id`);
    ids.push(entry.id);

    // name — a non-empty string.
    assert.equal(typeof entry.name, "string", `${file.fileName} declares a string name`);
    assert.ok(entry.name.length > 0, `${file.fileName} declares a non-empty name`);

    // aliases — present as an array, with at least one non-empty string alias (the catalogue
    // is searchable by alias and connector requests are matched on aliases).
    assert.ok(Array.isArray(entry.aliases), `${file.fileName} declares an aliases array`);
    assert.ok(entry.aliases.length >= 1, `${file.fileName} declares at least one alias`);
    for (const alias of entry.aliases) {
      assert.ok(
        typeof alias === "string" && alias.length > 0,
        `${file.fileName} aliases are non-empty strings`,
      );
      aliasKeys.push(alias.toLowerCase());
    }

    // category — a non-empty string (the browsable categories are open-ended per the brief,
    // so the value is not constrained to a fixed set here; spanning is checked separately).
    assert.equal(typeof entry.category, "string", `${file.fileName} declares a string category`);
    assert.ok(entry.category.length > 0, `${file.fileName} declares a non-empty category`);

    // base URL — a valid https URL. A connector's general request tool resolves paths
    // relative to base_url and reaches it only over https through the SSRF guard (CLAUDE.md
    // security rules), so an http or malformed base URL is not acceptable.
    assert.equal(typeof entry.base_url, "string", `${file.fileName} declares a string base_url`);
    assert.ok(entry.base_url.length > 0, `${file.fileName} declares a non-empty base_url`);
    const url = new URL(entry.base_url); // validated as a URL by the schema already
    assert.equal(url.protocol, "https:", `${file.fileName} base URL is https`);
  }

  // Ids are unique across the api_key/basic seed: the loader indexes by id, so a collision
  // would silently shadow an entry.
  assert.equal(new Set(ids).size, ids.length, "api_key/basic entry ids are unique");

  // Aliases are unique (case-insensitively) across the api_key/basic seed: the loader's
  // alias index folds case, so a collision would make one entry unreachable by its alias.
  assert.equal(
    new Set(aliasKeys).size,
    aliasKeys.length,
    "api_key/basic entry aliases are unique (case-insensitively)",
  );
});

// ===========================================================================
// AC — each entry carries a header template and plain key-entry instructions with a
// provider docs link.
// ===========================================================================

test("each api_key/basic entry carries a header template and plain key-entry instructions with a provider docs link", () => {
  const files = readApiKeyFiles(CATALOGUE_DIR);
  assert.ok(
    files.length >= REQUIRED_API_KEY_COUNT,
    `at least ${REQUIRED_API_KEY_COUNT} api_key/basic entries (got ${files.length})`,
  );

  for (const file of files) {
    const entry = validateOrFail(file);

    // Header template — `entry.auth.header` (design §7: "header template like
    // `Authorization: Bearer {key}`"). The person's key is injected into this template at
    // connect time, so it must be a real HTTP header line (`Name: value`) with a
    // placeholder slot `{...}` where the key goes.
    const header = entry.auth.header;
    assert.equal(typeof header, "string", `${file.fileName} declares a string auth.header template`);
    assert.ok((header as string).length > 0, `${file.fileName} declares a non-empty header template`);
    assert.ok(
      (header as string).includes(":"),
      `${file.fileName} header template is an HTTP header line ("Name: value"): ${JSON.stringify(header)}`,
    );
    assert.match(
      header as string,
      /\{[^{}]+\}/,
      `${file.fileName} header template has a {placeholder} slot for the person's key: ${JSON.stringify(header)}`,
    );

    // Key-entry instructions — `entry.instructions`: plain words on where to find the key,
    // carrying a provider docs link. The schema has no dedicated docs-link field, so the
    // link lives inside the instructions text.
    const instructions = entry.instructions;
    assert.equal(typeof instructions, "string", `${file.fileName} declares string key-entry instructions`);
    assert.ok(
      (instructions as string).trim().length > 0,
      `${file.fileName} declares non-empty key-entry instructions`,
    );

    // The instructions carry a provider docs link: a valid absolute https URL to a real
    // host (a dotted domain).
    const docsUrl = firstHttpsUrl(instructions as string);
    assert.ok(
      docsUrl !== undefined,
      `${file.fileName} instructions carry a provider docs link (https URL): ${JSON.stringify(instructions)}`,
    );
    const parsedDocsUrl = new URL(docsUrl as string);
    assert.equal(parsedDocsUrl.protocol, "https:", `${file.fileName} docs link is https`);
    assert.ok(
      parsedDocsUrl.hostname.includes("."),
      `${file.fileName} docs link points at a real host: ${docsUrl}`,
    );

    // "plain key-entry instructions WITH a docs link" — removing the link must still leave
    // actual guidance text (a word), not a bare URL on its own.
    const withoutLink = (instructions as string).replace(docsUrl as string, " ");
    assert.match(
      withoutLink,
      /[a-z]{3,}/i,
      `${file.fileName} instructions are plain words, not just a link: ${JSON.stringify(instructions)}`,
    );
  }
});

// ===========================================================================
// AC — the api_key/basic seed spans the brief's categories (email, calendar, files,
// messaging, notes, finance, travel, shopping, developer, smart home).
// ===========================================================================

test("the api_key/basic seed spans the brief's categories", () => {
  const files = readApiKeyFiles(CATALOGUE_DIR);
  assert.ok(
    files.length >= REQUIRED_API_KEY_COUNT,
    `at least ${REQUIRED_API_KEY_COUNT} api_key/basic entries (got ${files.length})`,
  );

  const categories = files.map((f) => validateOrFail(f).category.toLowerCase());

  const missing = REQUIRED_CATEGORY_CONCEPTS.filter(
    ({ keywords }) => !categories.some((category) => keywords.some((kw) => category.includes(kw))),
  ).map(({ concept }) => concept);

  assert.deepEqual(
    missing,
    [],
    `the api_key/basic seed must span every brief category; missing: ${missing.join(", ")} ` +
      `(categories present: ${[...new Set(categories)].sort().join(", ")})`,
  );
});

// ===========================================================================
// AC (via the real boot loader) — the api_key/basic seed loads through the actual catalogue
// loader into a searchable index, and (design §7) every api_key/basic entry is connectable
// WITHOUT any operator client configuration (they need no operator-registered client).
// Copying only the api_key/basic files into a throwaway directory keeps this check dependent
// on THIS task's data alone.
// ===========================================================================

test("the api_key/basic seed loads through the boot loader: every entry is connectable and findable", () => {
  const files = readApiKeyFiles(CATALOGUE_DIR);
  assert.ok(
    files.length >= REQUIRED_API_KEY_COUNT,
    `at least ${REQUIRED_API_KEY_COUNT} api_key/basic entries (got ${files.length})`,
  );

  const dir = mkdtempSync(join(tmpdir(), "warthog-api-key-seed-"));
  try {
    for (const { fileName, raw } of files) {
      writeFileSync(join(dir, fileName), raw);
    }

    // `isOAuthClientConfigured` returns false for everything — an api_key/basic entry must
    // be connectable regardless, because it needs no operator-registered client (design §7).
    const index = loadCatalogue({ dir, isOAuthClientConfigured: () => false });

    const loaded = index.all();
    assert.equal(loaded.length, files.length, "every api_key/basic file loaded into the index");
    assert.ok(
      loaded.length >= REQUIRED_API_KEY_COUNT,
      `at least ${REQUIRED_API_KEY_COUNT} entries in the index (got ${loaded.length})`,
    );

    for (const entry of loaded) {
      assert.ok(
        entry.auth_kind === "api_key" || entry.auth_kind === "basic",
        "only api_key/basic entries were loaded",
      );

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

    // Every loaded api_key/basic entry is connectable, so the connectable set is the whole
    // set.
    assert.equal(
      index.connectable().length,
      loaded.length,
      "every api_key/basic entry is connectable",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
