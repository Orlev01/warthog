// E03-S11 — Connector catalogue schema (`src/domain/catalogue/schema.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional (test-first) — the builder writes the schema
// AFTERWARDS to turn these green. Do NOT add the module to make them pass; the
// builder does that. These tests pin BEHAVIOUR (what the schema/validator ACCEPT
// and what they REJECT, and for a rejection WHICH field the error names), never
// the source text of the module, so a later rename or refactor that preserves
// behaviour must not redden them.
//
// Pure domain module (CLAUDE.md / conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now). Validating an entry is a pure function of
// its input.
//
// WHY the keys are snake_case: the catalogue is a set of DATA FILES authored by the
// operator (design §7: `catalogue/connectors/<id>.yaml`; "Adding an entry = a PR +
// deploy; no code change"). The schema validates those files with their native YAML
// keys. The task itself names the flag `google_early_access`, and the auth-kind
// VALUES (`api_key`, `provider_mcp`) are snake_case — both confirm snake_case.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (the builder implements EXACTLY this surface):
//
//   // The zod schema for one catalogue entry (a connector). Exported so a boot
//   // loader (a later task) can validate every data file against it.
//   const catalogueEntrySchema: z.ZodType<CatalogueEntry>;
//   type  CatalogueEntry = z.infer<typeof catalogueEntrySchema>;
//
//   // The entry validator — a safe (non-throwing) wrapper over the schema. On a
//   // well-formed entry it returns the parsed value; on a malformed entry it
//   // returns FIELD-LEVEL errors (each issue's `path` names the offending field).
//   function validateCatalogueEntry(input: unknown):
//     | { ok: true;  entry: CatalogueEntry }
//     | { ok: false; issues: { path: (string | number)[]; message: string }[] };
//
// The entry shape (design §7 — "id, name, aliases, category, auth kind, base URL,
// auth details, key-entry instructions + provider docs link, optional verify,
// curated tool set, Google early-access flag"):
//
//   id                  required, non-empty string
//   name                required, non-empty string
//   aliases             array of strings  (may be empty; a connector can have none)
//   category            required, non-empty string
//   auth_kind           one of "oauth2" | "api_key" | "basic" | "provider_mcp"
//   base_url            required, a valid URL  (the general request tool's paths are
//                       relative to it and the host can't be overridden → it must be
//                       a real URL)
//   auth                required object of auth details; its fields vary by kind —
//                       oauth2: authorize_url/token_url/scopes; api_key|basic: header
//                       template; provider_mcp: none (Warthog self-registers via CIMD,
//                       so an empty object is valid). `scopes`, when present, is an
//                       array of strings.
//   instructions        OPTIONAL string (key-entry services have it; oauth2 /
//                       provider_mcp need not)
//   verify              OPTIONAL request descriptor { path: string; method?: string }
//   curated_tools       OPTIONAL array of tools, each at least { name: string }
//   google_early_access OPTIONAL boolean flag
//
// Order of `issues` is NOT pinned — the tests locate an issue by its `path`, never
// by position, and never assert on the human-readable `message` text.

import { test } from "node:test";
import assert from "node:assert/strict";

import { catalogueEntrySchema, validateCatalogueEntry } from "./schema";

// ---------------------------------------------------------------------------
// Fixtures & helpers.
// ---------------------------------------------------------------------------

type AuthKind = "oauth2" | "api_key" | "basic" | "provider_mcp";
const AUTH_KINDS: readonly AuthKind[] = ["oauth2", "api_key", "basic", "provider_mcp"];

// The auth-detail block that each kind carries (design §7). Entries are plain data,
// so fixtures are built as `Record<string, unknown>` — that lets a malformed-case
// test freely delete a key or set a wrong type without fighting the type checker.
function authFor(kind: AuthKind): Record<string, unknown> {
  switch (kind) {
    case "oauth2":
      return {
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      };
    case "api_key":
      return { header: "Authorization: Bearer {key}" };
    case "basic":
      return { header: "Authorization: Basic {key}" };
    case "provider_mcp":
      return {};
  }
}

// A minimal well-formed entry: exactly the required fields, no optionals. A fresh
// object every call so a test can mutate its copy.
function validEntry(kind: AuthKind = "api_key"): Record<string, unknown> {
  return {
    id: "slack",
    name: "Slack",
    aliases: ["slack messaging", "slack chat"],
    category: "messaging",
    auth_kind: kind,
    base_url: "https://slack.com/api",
    auth: authFor(kind),
  };
}

// A maximal well-formed entry: every field present, including every optional. Used
// to prove the schema ACCEPTS an entry carrying the full field set the AC lists.
function fullEntry(): Record<string, unknown> {
  return {
    id: "gmail",
    name: "Gmail",
    aliases: ["google mail", "gmail email"],
    category: "email",
    auth_kind: "oauth2",
    base_url: "https://gmail.googleapis.com",
    auth: authFor("oauth2"),
    instructions: "Sign in with Google and approve the requested permissions.",
    verify: { method: "GET", path: "/gmail/v1/users/me/profile" },
    curated_tools: [{ name: "gmail_search" }, { name: "gmail_send" }],
    google_early_access: true,
  };
}

// Narrowing helpers. `accept` fails loudly (showing the issues) if an entry we
// expect to be valid is rejected; `reject` fails if an entry we expect to be
// malformed slips through. Both return the narrowed result for further assertions.
function accept(input: unknown) {
  const r = validateCatalogueEntry(input);
  if (!r.ok) {
    assert.fail(`expected a valid catalogue entry, but it was rejected with: ${JSON.stringify(r.issues)}`);
  }
  return r; // { ok: true; entry }
}
function reject(input: unknown) {
  const r = validateCatalogueEntry(input);
  if (r.ok) {
    assert.fail("expected the entry to be rejected, but it validated");
  }
  return r; // { ok: false; issues }
}

const sameArr = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// Does some issue name exactly this field path? (A "field-level error".)
function hasFieldError(
  issues: ReadonlyArray<{ path: readonly unknown[] }>,
  path: readonly unknown[],
): boolean {
  return issues.some((i) => sameArr(i.path, path));
}

// Assert the entry is rejected AND the rejection names the given field path.
function assertRejectedAt(input: unknown, path: readonly unknown[]): void {
  const r = reject(input);
  // Every issue must be field-shaped: a path array and a string message.
  for (const i of r.issues) {
    assert.ok(Array.isArray(i.path), "each issue carries a field path (an array)");
    assert.equal(typeof i.message, "string", "each issue carries a human-readable message");
  }
  assert.ok(
    hasFieldError(r.issues, path),
    `expected a field-level error at ${JSON.stringify(path)}, got ${JSON.stringify(r.issues.map((i) => i.path))}`,
  );
}

// ===========================================================================
// AC1 — the schema VALIDATES a well-formed entry carrying every listed field.
// ===========================================================================

test("the validator accepts a full entry and returns the parsed value", () => {
  const { entry } = accept(fullEntry());

  // Every field the AC enumerates survives the parse.
  assert.equal(entry.id, "gmail");
  assert.equal(entry.name, "Gmail");
  assert.deepEqual(entry.aliases, ["google mail", "gmail email"]);
  assert.equal(entry.category, "email");
  assert.equal(entry.auth_kind, "oauth2");
  assert.equal(entry.base_url, "https://gmail.googleapis.com");
  assert.equal(entry.google_early_access, true);
  assert.equal(typeof entry.instructions, "string");
  // auth details and verify came through as structured data.
  assert.ok(entry.auth && typeof entry.auth === "object", "auth details survive as an object");
  assert.ok(entry.verify && typeof entry.verify === "object", "the verify request survives as an object");
  assert.ok(Array.isArray(entry.curated_tools), "curated tools survive as an array");
});

test("the validator accepts a minimal entry (only the required fields)", () => {
  const { entry } = accept(validEntry("api_key"));

  assert.equal(entry.id, "slack");
  assert.equal(entry.auth_kind, "api_key");
  // The optionals were omitted and that is fine — the entry is still valid.
});

test("a well-formed entry validates for each of the four auth kinds", () => {
  for (const kind of AUTH_KINDS) {
    const { entry } = accept(validEntry(kind));
    assert.equal(entry.auth_kind, kind, `the ${kind} entry keeps its auth kind`);
  }
});

test("a provider_mcp entry needs no auth details (an empty auth block is valid)", () => {
  // Warthog self-registers via CIMD, so provider_mcp carries no stored auth details.
  const { entry } = accept(validEntry("provider_mcp"));
  assert.equal(entry.auth_kind, "provider_mcp");
});

test("an entry may carry no aliases (an empty alias list is valid)", () => {
  const e = validEntry("api_key");
  e.aliases = [];
  const { entry } = accept(e);
  assert.deepEqual(entry.aliases, []);
});

test("google_early_access is optional — an entry without it is valid, with it is valid", () => {
  accept(validEntry("api_key")); // absent → valid

  const flagged = validEntry("api_key");
  flagged.google_early_access = true;
  assert.equal(accept(flagged).entry.google_early_access, true);

  const notFlagged = validEntry("api_key");
  notFlagged.google_early_access = false;
  assert.equal(accept(notFlagged).entry.google_early_access, false);
});

test("the optional verify request is accepted when present and may be omitted", () => {
  const withVerify = validEntry("api_key");
  withVerify.verify = { method: "GET", path: "/users.identity" };
  accept(withVerify);

  // method defaults are the builder's choice; verify with only a path is also valid.
  const pathOnly = validEntry("api_key");
  pathOnly.verify = { path: "/users.identity" };
  accept(pathOnly);
});

// --- the exported zod schema is usable directly -----------------------------

test("catalogueEntrySchema is an exported zod schema that validates a well-formed entry", () => {
  const parsed = catalogueEntrySchema.safeParse(fullEntry());
  assert.equal(parsed.success, true, "the exported schema accepts a well-formed entry");
  if (parsed.success) {
    assert.equal(parsed.data.id, "gmail");
    assert.equal(parsed.data.auth_kind, "oauth2");
  }
});

test("catalogueEntrySchema rejects a malformed entry via safeParse", () => {
  const bad = validEntry("api_key");
  delete bad.name;
  const parsed = catalogueEntrySchema.safeParse(bad);
  assert.equal(parsed.success, false, "the exported schema rejects an entry missing a required field");
});

// ===========================================================================
// AC2 — a malformed entry is REJECTED with a FIELD-LEVEL error.
//
// Each case corrupts exactly one field of an otherwise-valid entry and asserts the
// rejection names that field (its `path`). The corruption is scoped to the one
// field under test, so the error is attributable to it and not to collateral damage.
// ===========================================================================

test("a missing id is a field-level error at [id]", () => {
  const e = validEntry();
  delete e.id;
  assertRejectedAt(e, ["id"]);
});

test("an empty id is rejected at [id]", () => {
  const e = validEntry();
  e.id = "";
  assertRejectedAt(e, ["id"]);
});

test("a missing name is a field-level error at [name]", () => {
  const e = validEntry();
  delete e.name;
  assertRejectedAt(e, ["name"]);
});

test("a missing category is a field-level error at [category]", () => {
  const e = validEntry();
  delete e.category;
  assertRejectedAt(e, ["category"]);
});

test("a missing auth_kind is a field-level error at [auth_kind]", () => {
  const e = validEntry();
  delete e.auth_kind;
  assertRejectedAt(e, ["auth_kind"]);
});

test("an auth_kind outside the allowed set is a field-level error at [auth_kind]", () => {
  const e = validEntry();
  e.auth_kind = "magic"; // not one of oauth2 | api_key | basic | provider_mcp
  assertRejectedAt(e, ["auth_kind"]);
});

test("a missing base_url is a field-level error at [base_url]", () => {
  const e = validEntry();
  delete e.base_url;
  assertRejectedAt(e, ["base_url"]);
});

test("a base_url that is not a valid URL is a field-level error at [base_url]", () => {
  const e = validEntry();
  e.base_url = "not a url";
  assertRejectedAt(e, ["base_url"]);
});

test("a missing auth block is a field-level error at [auth]", () => {
  const e = validEntry();
  delete e.auth;
  assertRejectedAt(e, ["auth"]);
});

test("aliases of the wrong type (a string, not a list) is a field-level error at [aliases]", () => {
  const e = validEntry();
  e.aliases = "slack";
  assertRejectedAt(e, ["aliases"]);
});

test("a non-string alias element is a field-level error at [aliases, <index>]", () => {
  const e = validEntry();
  e.aliases = ["ok", 123];
  assertRejectedAt(e, ["aliases", 1]);
});

test("a malformed nested auth detail (scopes not a list) is a field-level error at [auth, scopes]", () => {
  const e = validEntry("oauth2");
  e.auth = { ...authFor("oauth2"), scopes: "read" }; // scopes must be a list of strings
  assertRejectedAt(e, ["auth", "scopes"]);
});

test("a non-boolean google_early_access is a field-level error at [google_early_access]", () => {
  const e = validEntry();
  e.google_early_access = "yes";
  assertRejectedAt(e, ["google_early_access"]);
});

test("a non-string instructions value is a field-level error at [instructions]", () => {
  const e = validEntry();
  e.instructions = 123;
  assertRejectedAt(e, ["instructions"]);
});

test("curated_tools of the wrong type (not a list) is a field-level error at [curated_tools]", () => {
  const e = validEntry();
  e.curated_tools = "gmail_search";
  assertRejectedAt(e, ["curated_tools"]);
});

test("a curated tool missing its name is a field-level error at [curated_tools, <index>, name]", () => {
  const e = validEntry();
  e.curated_tools = [{ name: "ok" }, {}];
  assertRejectedAt(e, ["curated_tools", 1, "name"]);
});

test("a verify request missing its path is a field-level error at [verify, path]", () => {
  const e = validEntry();
  e.verify = { method: "GET" }; // a verify request needs a path (relative to base_url)
  assertRejectedAt(e, ["verify", "path"]);
});

// ===========================================================================
// Validator robustness — it is SAFE (returns a result, never throws) and always
// reports at least one issue for a rejected entry.
// ===========================================================================

test("the validator never throws and rejects a non-object input", () => {
  for (const bad of [null, undefined, 42, "x", [], true]) {
    let result: ReturnType<typeof validateCatalogueEntry> | undefined;
    assert.doesNotThrow(() => {
      result = validateCatalogueEntry(bad as unknown);
    }, `validating ${String(bad)} must not throw`);
    assert.ok(result && result.ok === false, `${String(bad)} is rejected`);
  }
});

test("a rejected entry always carries at least one issue", () => {
  const e = validEntry();
  delete e.name;
  const r = reject(e);
  assert.ok(r.issues.length >= 1, "a rejection reports at least one field-level issue");
});

test("a valid entry carries no issues (the ok branch has none to report)", () => {
  const r = validateCatalogueEntry(fullEntry());
  assert.equal(r.ok, true);
  // On the ok branch there is an entry and no issues list to inspect.
  if (r.ok) assert.ok(r.entry, "the accepted entry is returned");
});
