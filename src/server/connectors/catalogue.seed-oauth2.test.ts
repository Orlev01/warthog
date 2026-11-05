// E09-S04 — Seed catalogue: Google and Microsoft oauth2 entries.
//
// Google and Microsoft are the founder-registered providers and the primary-journey
// connectors: Google — Gmail, Google Calendar, Google Drive (each an early-access entry);
// Microsoft — Outlook mail, Outlook calendar, OneDrive (design §7 "Connector engine",
// "Curated tools", "Google early access"; "Launch target: … + Google + Microsoft"). These
// are DATA FILES the operator deploys under `catalogue/connectors/<id>.json` — "Adding an
// entry = a PR + deploy; no code change" — validated at boot by the catalogue loader
// (E09-S01, `./catalogue`) against the catalogue schema (E03-S11,
// `src/domain/catalogue/schema.ts`). An oauth2 connector carries its authorize/token URLs
// and scopes, and is connectable ONLY when the operator has configured its client id/secret
// (design §7 "Availability").
//
// RED-first: the oauth2 seed data files do NOT exist yet (today the directory holds only the
// api_key/basic and provider_mcp seeds — no oauth2 entry at all), so reading the oauth2 files
// yields none and every test here fails until the builder adds the data files. That absence
// IS the point of test-first. As the TESTER I must NOT create or edit any data/source file to
// make these pass — including the catalogue entries themselves, which are this task's
// deliverable for the builder.
//
// These tests pin the BEHAVIOUR of the real seed DATA (what validates, what loads, what is
// connectable, what each entry carries) — never the source text of any file. They are scoped
// to the entries this task owns: every `*.json` file in the real catalogue directory whose
// `auth_kind` is `oauth2`. Sibling seed tasks (api_key/basic — E09-S03; provider_mcp —
// E09-S02) add OTHER files to the same directory; those are out of scope here and are
// deliberately skipped, so this file's result depends only on the oauth2 seed. The oauth2
// files are copied into a throwaway directory before the boot loader runs, so a defect in a
// sibling seed file can never redden this task's suite. No network, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalogue } from "./catalogue";
import { validateCatalogueEntry, type CatalogueEntry } from "../../domain/catalogue/schema";

// The real, committed seed catalogue directory. Resolved from the repo root: `npm test` runs
// with cwd at the repo root, the same rooting server code uses for repo-relative dirs
// (CLAUDE.md: "Root such paths at process.cwd()").
const CATALOGUE_DIR = join(process.cwd(), "catalogue", "connectors");

// This task's deliverable: 3 Google services + 3 Microsoft services = 6 oauth2 entries at
// least. (Other founder-registered oauth2 providers — Slack, GitHub, … — may be added by
// later tasks; they would be oauth2 too and so are swept up by the per-oauth2 checks below,
// never contradicted by them.)
const REQUIRED_GOOGLE_COUNT = 3;
const REQUIRED_MICROSOFT_COUNT = 3;
const REQUIRED_OAUTH2_COUNT = REQUIRED_GOOGLE_COUNT + REQUIRED_MICROSOFT_COUNT;

// The three primary-journey services each provider family must cover (task + design §7). Each
// is matched at the CONCEPT level against an entry's searchable identity (id + name +
// aliases): a service is "present" when some family member's identity contains one of its
// keywords. This verifies the three distinct services exist without locking the builder into
// one exact id/name spelling.
const SERVICE_CONCEPTS: { concept: string; keywords: string[] }[] = [
  { concept: "mail", keywords: ["mail", "email"] }, // "gmail"/"outlook mail" both contain "mail"
  { concept: "calendar", keywords: ["calendar"] },
  { concept: "files/drive", keywords: ["drive", "file", "storage"] }, // "onedrive" contains "drive"
];

// Markers that place an oauth2 entry in a provider family, matched against its searchable
// identity. These two families are disjoint (no provider carries both), so an entry lands in
// at most one.
const GOOGLE_MARKERS = ["google", "gmail", "gcal", "gdrive"];
const MICROSOFT_MARKERS = ["microsoft", "outlook", "onedrive", "office", "365"];

interface SeedFile {
  fileName: string;
  raw: string;
  parsed: Record<string, unknown>;
}

// Read every `*.json` file in the real catalogue directory whose `auth_kind` is `oauth2`.
// Files that are not a JSON object, or whose auth_kind is something else (the api_key/basic
// and provider_mcp seeds owned by other tasks), are skipped — this task owns only the oauth2
// entries. Throws (ENOENT) only if the directory itself is absent.
function readOAuth2Files(dir: string): SeedFile[] {
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
      (parsed as Record<string, unknown>).auth_kind === "oauth2"
    ) {
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

// An entry's searchable identity: id + name + aliases, lowercased (what family/concept
// matching reads). base_url is deliberately excluded — a googleapis/graph host would muddy
// the "which service is this" question.
function identityText(entry: CatalogueEntry): string {
  return [entry.id, entry.name, ...entry.aliases].join(" ").toLowerCase();
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw));
}

// Assert an oauth2 entry carries the three auth details the AC demands: an authorize URL, a
// token URL (both valid absolute https URLs — oauth2 endpoints are reached over https), and a
// non-empty list of non-empty scope strings. The schema leaves these optional (each auth kind
// supplies its own), so "present + well-formed" is a real behaviour this test enforces.
function assertOAuthDetails(entry: CatalogueEntry, fileName: string): void {
  const auth = entry.auth;

  const authorizeUrl = auth.authorize_url;
  assert.equal(
    typeof authorizeUrl,
    "string",
    `${fileName} declares a string auth.authorize_url`,
  );
  assert.ok((authorizeUrl as string).length > 0, `${fileName} authorize_url is non-empty`);
  const authorize = new URL(authorizeUrl as string); // throws (failing the test) if malformed
  assert.equal(authorize.protocol, "https:", `${fileName} authorize_url is https`);
  assert.ok(
    authorize.hostname.includes("."),
    `${fileName} authorize_url points at a real host: ${authorizeUrl}`,
  );

  const tokenUrl = auth.token_url;
  assert.equal(typeof tokenUrl, "string", `${fileName} declares a string auth.token_url`);
  assert.ok((tokenUrl as string).length > 0, `${fileName} token_url is non-empty`);
  const token = new URL(tokenUrl as string);
  assert.equal(token.protocol, "https:", `${fileName} token_url is https`);
  assert.ok(
    token.hostname.includes("."),
    `${fileName} token_url points at a real host: ${tokenUrl}`,
  );

  const scopes = auth.scopes;
  assert.ok(Array.isArray(scopes), `${fileName} declares an auth.scopes array`);
  assert.ok((scopes as string[]).length >= 1, `${fileName} declares at least one scope`);
  for (const scope of scopes as unknown[]) {
    assert.ok(
      typeof scope === "string" && scope.trim().length > 0,
      `${fileName} scopes are non-empty strings (got ${JSON.stringify(scope)})`,
    );
  }
}

// ===========================================================================
// AC — the Google and Microsoft oauth2 entries load and validate, each with an authorize
// URL, a token URL and scopes. (All oauth2 entries this task owns are held to this; a later
// oauth2 provider would be too.)
// ===========================================================================

test("the seed catalogue has the oauth2 entries, each validating against the schema with authorize/token URLs and scopes", () => {
  const files = readOAuth2Files(CATALOGUE_DIR);

  assert.ok(
    files.length >= REQUIRED_OAUTH2_COUNT,
    `at least ${REQUIRED_OAUTH2_COUNT} oauth2 catalogue entries are present (got ${files.length})`,
  );

  for (const file of files) {
    const entry = validateOrFail(file);
    assert.equal(entry.auth_kind, "oauth2", `${file.fileName} is an oauth2 entry`);
    assertOAuthDetails(entry, file.fileName);
  }
});

// ===========================================================================
// AC — each oauth2 entry declares id, name, aliases, category and an https base URL; ids and
// aliases are unique across the oauth2 seed.
// ===========================================================================

test("each oauth2 entry declares id, name, aliases, category and an https base URL", () => {
  const files = readOAuth2Files(CATALOGUE_DIR);
  assert.ok(
    files.length >= REQUIRED_OAUTH2_COUNT,
    `at least ${REQUIRED_OAUTH2_COUNT} oauth2 entries (got ${files.length})`,
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

    // category — a non-empty string (the browsable categories are open-ended per the brief).
    assert.equal(typeof entry.category, "string", `${file.fileName} declares a string category`);
    assert.ok(entry.category.length > 0, `${file.fileName} declares a non-empty category`);

    // base URL — a valid https URL. A connector's general request tool resolves paths relative
    // to base_url and reaches it only over https through the SSRF guard (CLAUDE.md security
    // rules), so an http or malformed base URL is not acceptable.
    assert.equal(typeof entry.base_url, "string", `${file.fileName} declares a string base_url`);
    assert.ok(entry.base_url.length > 0, `${file.fileName} declares a non-empty base_url`);
    const url = new URL(entry.base_url); // validated as a URL by the schema already
    assert.equal(url.protocol, "https:", `${file.fileName} base URL is https`);
  }

  // Ids are unique across the oauth2 seed: the loader indexes by id, so a collision would
  // silently shadow an entry.
  assert.equal(new Set(ids).size, ids.length, "oauth2 entry ids are unique");

  // Aliases are unique (case-insensitively) across the oauth2 seed: the loader's alias index
  // folds case, so a collision would make one entry unreachable by its alias.
  assert.equal(
    new Set(aliasKeys).size,
    aliasKeys.length,
    "oauth2 entry aliases are unique (case-insensitively)",
  );
});

// ===========================================================================
// AC — the Google services (Gmail, Google Calendar, Google Drive) are present as oauth2
// entries; each carries the early-access flag and its authorize/token URLs + scopes.
// ===========================================================================

test("the Google oauth2 entries (mail, calendar, drive) are present, each carrying the early-access flag and oauth details", () => {
  const files = readOAuth2Files(CATALOGUE_DIR);

  const google = files
    .map(validateOrFail)
    .filter((entry) => matchesAny(identityText(entry), GOOGLE_MARKERS));

  assert.ok(
    google.length >= REQUIRED_GOOGLE_COUNT,
    `at least ${REQUIRED_GOOGLE_COUNT} Google oauth2 entries (got ${google.length}: ` +
      `${google.map((e) => e.id).join(", ")})`,
  );

  // The three primary-journey Google services are each represented.
  const missing = SERVICE_CONCEPTS.filter(
    ({ keywords }) => !google.some((entry) => matchesAny(identityText(entry), keywords)),
  ).map(({ concept }) => concept);
  assert.deepEqual(
    missing,
    [],
    `the Google oauth2 seed must cover Gmail, Google Calendar and Google Drive; missing: ` +
      `${missing.join(", ")} (present: ${google.map((e) => e.id).join(", ")})`,
  );

  for (const entry of google) {
    // AC: the Google entries carry the early-access flag.
    assert.equal(
      entry.google_early_access,
      true,
      `${entry.id} (a Google connector) carries the early-access flag google_early_access=true`,
    );

    // Each Google entry still carries its oauth authorize/token URLs and scopes…
    assertOAuthDetails(entry, entry.id);

    // …pointed at Google's own OAuth endpoints (catches a copy-pasted provider endpoint).
    assert.ok(
      new URL(entry.auth.authorize_url as string).hostname.includes("google"),
      `${entry.id} authorize_url is a Google endpoint: ${entry.auth.authorize_url}`,
    );
    assert.ok(
      new URL(entry.auth.token_url as string).hostname.includes("google"),
      `${entry.id} token_url is a Google endpoint: ${entry.auth.token_url}`,
    );
  }
});

// ===========================================================================
// AC — the Microsoft services (Outlook mail, Outlook calendar, OneDrive) are present as
// oauth2 entries, each with its authorize/token URLs + scopes. Microsoft is NOT an
// early-access (Testing-mode) provider, so these entries are not Google-early-access flagged.
// ===========================================================================

test("the Microsoft oauth2 entries (outlook mail, outlook calendar, onedrive) are present with oauth details and are not early-access flagged", () => {
  const files = readOAuth2Files(CATALOGUE_DIR);

  const microsoft = files
    .map(validateOrFail)
    .filter((entry) => matchesAny(identityText(entry), MICROSOFT_MARKERS));

  assert.ok(
    microsoft.length >= REQUIRED_MICROSOFT_COUNT,
    `at least ${REQUIRED_MICROSOFT_COUNT} Microsoft oauth2 entries (got ${microsoft.length}: ` +
      `${microsoft.map((e) => e.id).join(", ")})`,
  );

  // The three primary-journey Microsoft services are each represented.
  const missing = SERVICE_CONCEPTS.filter(
    ({ keywords }) => !microsoft.some((entry) => matchesAny(identityText(entry), keywords)),
  ).map(({ concept }) => concept);
  assert.deepEqual(
    missing,
    [],
    `the Microsoft oauth2 seed must cover Outlook mail, Outlook calendar and OneDrive; missing: ` +
      `${missing.join(", ")} (present: ${microsoft.map((e) => e.id).join(", ")})`,
  );

  for (const entry of microsoft) {
    // Each Microsoft entry carries its oauth authorize/token URLs and scopes…
    assertOAuthDetails(entry, entry.id);

    // …pointed at Microsoft's own OAuth endpoints.
    assert.ok(
      new URL(entry.auth.authorize_url as string).hostname.includes("microsoft"),
      `${entry.id} authorize_url is a Microsoft endpoint: ${entry.auth.authorize_url}`,
    );
    assert.ok(
      new URL(entry.auth.token_url as string).hostname.includes("microsoft"),
      `${entry.id} token_url is a Microsoft endpoint: ${entry.auth.token_url}`,
    );

    // Microsoft is a founder-registered provider in full (not Testing mode), so a Microsoft
    // entry is not Google early-access. The flag is the Google discriminator; a Microsoft
    // entry carrying it would be a mis-tag. (Narrowly scoped to this entry's own field.)
    assert.notEqual(
      entry.google_early_access,
      true,
      `${entry.id} (a Microsoft connector) is NOT Google early-access flagged`,
    );
  }
});

// ===========================================================================
// AC (via the real boot loader) — the oauth2 seed loads through the actual catalogue loader
// into a searchable index, and (design §7 "Availability") an oauth2 entry is connectable ONLY
// when its client id/secret are configured — it keys that decision on the entry's OWN id.
// Copying only the oauth2 files into a throwaway directory keeps this check dependent on THIS
// task's data alone.
// ===========================================================================

test("the oauth2 seed loads through the boot loader and is connectable only when its client is configured", () => {
  const files = readOAuth2Files(CATALOGUE_DIR);
  assert.ok(
    files.length >= REQUIRED_OAUTH2_COUNT,
    `at least ${REQUIRED_OAUTH2_COUNT} oauth2 entries (got ${files.length})`,
  );

  const dir = mkdtempSync(join(tmpdir(), "warthog-oauth2-seed-"));
  try {
    for (const { fileName, raw } of files) {
      writeFileSync(join(dir, fileName), raw);
    }

    // With NO oauth client configured, no oauth2 entry is connectable (unlike api_key/basic/
    // provider_mcp, which are always connectable).
    const noneConfigured = loadCatalogue({ dir, isOAuthClientConfigured: () => false });
    const loaded = noneConfigured.all();
    assert.equal(loaded.length, files.length, "every oauth2 file loaded into the index");
    assert.ok(
      loaded.length >= REQUIRED_OAUTH2_COUNT,
      `at least ${REQUIRED_OAUTH2_COUNT} entries in the index (got ${loaded.length})`,
    );
    for (const entry of loaded) {
      assert.equal(entry.auth_kind, "oauth2", "only oauth2 entries were loaded");
      assert.equal(
        noneConfigured.isConnectable(entry.id),
        false,
        `${entry.id} is NOT connectable without a configured client`,
      );

      // Findable regardless of connectability — by id, by category, and (case-insensitively)
      // by its first alias.
      assert.equal(noneConfigured.get(entry.id)?.id, entry.id, `${entry.id} is found by id`);
      assert.ok(
        noneConfigured.byCategory(entry.category).some((e) => e.id === entry.id),
        `${entry.id} is found under its category`,
      );
      const firstAlias = entry.aliases[0];
      assert.ok(
        typeof firstAlias === "string" && firstAlias.length > 0,
        `${entry.id} declares at least one alias`,
      );
      assert.equal(
        noneConfigured.byAlias(firstAlias.toUpperCase())?.id,
        entry.id,
        `${entry.id} is found case-insensitively by its alias`,
      );
    }
    assert.equal(
      noneConfigured.connectable().length,
      0,
      "no oauth2 entry is connectable while no client is configured",
    );

    // With EVERY oauth client configured, every oauth2 entry becomes connectable.
    const allConfigured = loadCatalogue({ dir, isOAuthClientConfigured: () => true });
    for (const entry of allConfigured.all()) {
      assert.equal(
        allConfigured.isConnectable(entry.id),
        true,
        `${entry.id} is connectable once its client is configured`,
      );
    }
    assert.equal(
      allConfigured.connectable().length,
      loaded.length,
      "every oauth2 entry is connectable once its client is configured",
    );

    // The decision is keyed on the entry's OWN id: configure only the first entry's client and
    // only that entry turns connectable.
    const onlyFirstId = loaded[0].id;
    const seenIds: string[] = [];
    const onlyFirst = loadCatalogue({
      dir,
      isOAuthClientConfigured: (id) => {
        seenIds.push(id);
        return id === onlyFirstId;
      },
    });
    assert.ok(
      seenIds.includes(onlyFirstId),
      "the loader asks isOAuthClientConfigured about the entry's own id",
    );
    assert.equal(
      onlyFirst.isConnectable(onlyFirstId),
      true,
      `${onlyFirstId} is connectable when only its client is configured`,
    );
    assert.deepEqual(
      onlyFirst.connectable().map((e) => e.id),
      [onlyFirstId],
      "only the entry whose client is configured is connectable",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
