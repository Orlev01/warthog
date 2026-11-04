// E01-S02 — the runtime config seam. `src/server/config.ts` is the ONLY module
// that reads process.env. It exposes typed config and refuses to start an unsafe
// production process.
//
// These tests drive the module through `loadConfig(env)` — a pure function of an
// env record — so the contract is exercised without mutating the real process
// environment and without a running server. loadConfig() with no argument reads
// the real process.env (the production call site); every other test passes a fake
// env so importing the module never requires a fully-populated environment.
//
// Scope note: the task carries the shared [obligation:validate-and-parameterize-input]
// acceptance criterion. config.ts has no database access and no HTTP handler, so the
// SQL-injection / parameter-binding half of that obligation is characterized where
// queries actually live (E01-S03, the db module, which repeats the same criterion).
// config's share of "reject malformed input" is validation of its env input: a
// missing required variable is rejected (throws) rather than silently defaulted.
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config";

type Env = Record<string, string | undefined>;

// A fully valid DEVELOPMENT environment: pglite + dev tools, which production forbids
// but development allows. Carries only the vars dev needs (see .env.example).
const DEV_ENV: Env = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "http://localhost:3000",
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_DEV_TOOLS: "1",
};

// A fully valid PRODUCTION environment: a real postgres URL, no dev tools, and every
// secret group populated with a distinctive sentinel so we can prove each value flows
// from the environment into the config (and is never hard-coded). Flipping one field
// of this base isolates each production-refusal condition.
const PROD_ENV: Env = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://warthog.com.au",
  WEBAUTHN_RP_ID: "warthog.com.au",
  DATABASE_URL:
    "postgres://wh:SENTINEL_DB_PW_z9@db.privatelink.postgres.database.azure.com:5432/warthog?sslmode=require",
  PORT: "8080",
  KEY_VAULT_URL: "https://warthog-kv.vault.azure.net/",
  KEY_VAULT_KEY_NAME: "SENTINEL_KV_KEYNAME_d4",
  ACS_EMAIL_CONNECTION_STRING:
    "endpoint=https://acs.australia.communication.azure.com/;accesskey=SENTINEL_ACS_EMAIL_a1",
  ACS_SMS_CONNECTION_STRING:
    "endpoint=https://acs-sms.australia.communication.azure.com/;accesskey=SENTINEL_ACS_SMS_b2",
  VAPID_SUBJECT: "mailto:no-reply@warthog.com.au",
  VAPID_PUBLIC_KEY: "SENTINEL_VAPID_PUBLIC_e5",
  VAPID_PRIVATE_KEY: "SENTINEL_VAPID_PRIV_c3",
  GOOGLE_EARLY_ACCESS: "founder@warthog.com.au",
};

function load(env: Env) {
  return loadConfig(env as NodeJS.ProcessEnv);
}

function omit(env: Env, ...keys: string[]): Env {
  const copy: Env = { ...env };
  for (const k of keys) delete copy[k];
  return copy;
}

// True if `needle` appears in any string leaf of `value` (object / array / Map / Set,
// recursively). Lets us assert a secret flowed from env into the config WITHOUT pinning
// the exact field name or nesting the builder chooses.
function deepContainsString(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const children: unknown[] =
    value instanceof Map
      ? [...value.values()]
      : value instanceof Set
        ? [...value]
        : Array.isArray(value)
          ? value
          : Object.values(value as Record<string, unknown>);
  return children.some((child) => deepContainsString(child, needle, seen));
}

// --- AC1: reads the documented variables from the environment --------------------

test("surfaces the core string config read from the environment", () => {
  const cfg = load(PROD_ENV);
  assert.equal(cfg.publicBaseUrl, PROD_ENV.PUBLIC_BASE_URL);
  assert.equal(cfg.webauthnRpId, PROD_ENV.WEBAUTHN_RP_ID);
  assert.equal(cfg.databaseUrl, PROD_ENV.DATABASE_URL);
});

test("core string config is read from env, not a hard-coded constant", () => {
  const a = load({ ...DEV_ENV, PUBLIC_BASE_URL: "https://a.example" });
  const b = load({ ...DEV_ENV, PUBLIC_BASE_URL: "https://b.example" });
  assert.equal(a.publicBaseUrl, "https://a.example");
  assert.equal(b.publicBaseUrl, "https://b.example");
  assert.notEqual(a.publicBaseUrl, b.publicBaseUrl);
});

test("WARTHOG_DEV_TOOLS is parsed as a boolean keyed on the literal \"1\"", () => {
  assert.equal(load(DEV_ENV).devTools, true);
  assert.equal(load(omit(DEV_ENV, "WARTHOG_DEV_TOOLS")).devTools, false);
  assert.equal(load({ ...DEV_ENV, WARTHOG_DEV_TOOLS: "0" }).devTools, false);
});

test("GOOGLE_EARLY_ACCESS parses into a trimmed collection of emails", () => {
  const cfg = load({ ...DEV_ENV, GOOGLE_EARLY_ACCESS: "alice@example.com, bob@example.com" });
  const emails = [...(cfg.googleEarlyAccess as Iterable<string>)];
  assert.equal(emails.length, 2);
  assert.ok(emails.includes("alice@example.com"), "expected alice in the early-access list");
  assert.ok(emails.includes("bob@example.com"), "expected bob in the early-access list");
});

test("GOOGLE_EARLY_ACCESS absent yields an empty collection", () => {
  const cfg = load(omit(DEV_ENV, "GOOGLE_EARLY_ACCESS"));
  assert.equal([...(cfg.googleEarlyAccess as Iterable<string>)].length, 0);
});

test("reads the KEY_VAULT, ACS and VAPID secret groups from the environment", () => {
  const cfg = load(PROD_ENV);
  // Each sentinel was supplied only via its env var; finding it in the config proves
  // the group was read from env (field path intentionally not pinned).
  assert.ok(deepContainsString(cfg, "SENTINEL_KV_KEYNAME_d4"), "KEY_VAULT not read from env");
  assert.ok(deepContainsString(cfg, "SENTINEL_ACS_EMAIL_a1"), "ACS email not read from env");
  assert.ok(deepContainsString(cfg, "SENTINEL_ACS_SMS_b2"), "ACS sms not read from env");
  assert.ok(deepContainsString(cfg, "SENTINEL_VAPID_PRIV_c3"), "VAPID not read from env");
});

test("loadConfig() with no argument reads the real process.env", () => {
  const touched = ["NODE_ENV", "PUBLIC_BASE_URL", "WEBAUTHN_RP_ID", "DATABASE_URL", "WARTHOG_DEV_TOOLS"];
  const saved = new Map(touched.map((k) => [k, process.env[k]]));
  try {
    process.env.NODE_ENV = "development";
    process.env.PUBLIC_BASE_URL = "https://from-process-env.example";
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.DATABASE_URL = "pglite:memory";
    delete process.env.WARTHOG_DEV_TOOLS;

    const cfg = loadConfig();
    assert.equal(cfg.publicBaseUrl, "https://from-process-env.example");
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// --- AC2: refuses an unsafe production startup -----------------------------------

test("throws when NODE_ENV=production and WARTHOG_DEV_TOOLS=1", () => {
  assert.throws(() => load({ ...PROD_ENV, WARTHOG_DEV_TOOLS: "1" }));
});

test("throws when NODE_ENV=production and DATABASE_URL is a pglite: URL", () => {
  assert.throws(() => load({ ...PROD_ENV, DATABASE_URL: "pglite:memory" }));
  assert.throws(() => load({ ...PROD_ENV, DATABASE_URL: "pglite:./.data/dev" }));
});

test("throws when production has both unsafe conditions at once", () => {
  assert.throws(() =>
    load({ ...PROD_ENV, DATABASE_URL: "pglite:memory", WARTHOG_DEV_TOOLS: "1" }),
  );
});

test("a valid production config (postgres URL, no dev tools) does NOT throw", () => {
  const cfg = load(PROD_ENV);
  assert.equal(typeof cfg, "object");
  assert.equal(cfg.databaseUrl, PROD_ENV.DATABASE_URL);
});

test("development allows pglite and dev tools (the refusal is production-scoped)", () => {
  const cfg = load(DEV_ENV);
  assert.equal(cfg.devTools, true);
  assert.equal(cfg.databaseUrl, "pglite:memory");
});

// --- AC3 / AC5: secrets come from env, never hard-coded in source ----------------

test("database credentials and the VAPID private key flow from env (not hard-coded)", () => {
  const cfg = load(PROD_ENV);
  assert.ok(deepContainsString(cfg, "SENTINEL_DB_PW_z9"), "db credential not sourced from env");
  assert.ok(deepContainsString(cfg, "SENTINEL_VAPID_PRIV_c3"), "vapid secret not sourced from env");
});

test("a secret absent from the environment never appears (nothing hard-coded)", () => {
  // DEV_ENV carries no KEY_VAULT/ACS/VAPID vars; the production sentinels must not leak
  // from source into a config built without them.
  const cfg = load(DEV_ENV);
  assert.equal(deepContainsString(cfg, "SENTINEL_VAPID_PRIV_c3"), false);
  assert.equal(deepContainsString(cfg, "SENTINEL_ACS_EMAIL_a1"), false);
  assert.equal(deepContainsString(cfg, "SENTINEL_KV_KEYNAME_d4"), false);
  assert.equal(deepContainsString(cfg, "SENTINEL_DB_PW_z9"), false);
});

// --- AC (validate): a required variable missing is rejected, not silently defaulted

test("rejects a missing required variable rather than inventing a default", () => {
  assert.throws(() => load(omit(DEV_ENV, "DATABASE_URL")), "DATABASE_URL must be required");
  assert.throws(() => load(omit(DEV_ENV, "PUBLIC_BASE_URL")), "PUBLIC_BASE_URL must be required");
  assert.throws(() => load(omit(DEV_ENV, "WEBAUTHN_RP_ID")), "WEBAUTHN_RP_ID must be required");
});

// --- AC6: the PORT comes from the environment, never a literal -------------------

test("reads PORT from the environment and honours the supplied value", () => {
  assert.equal(load({ ...DEV_ENV, PORT: "8123" }).port, 8123);
});

test("a different PORT yields a different bound port (proves it is not a literal)", () => {
  const a = load({ ...DEV_ENV, PORT: "8123" }).port;
  const b = load({ ...DEV_ENV, PORT: "9456" }).port;
  assert.equal(a, 8123);
  assert.equal(b, 9456);
  assert.notEqual(a, b);
});
