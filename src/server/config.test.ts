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
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

import { loadConfig } from "./config";

type Env = Record<string, string | undefined>;

// --- E04-S20 key material ---------------------------------------------------------
// Server secrets are base64 env vars that loadConfig decodes to byte arrays:
//   WARTHOG_HMAC_KEY — keys the one-way HMAC of codes/link tokens; >= 32 bytes,
//     required in EVERY environment.
//   WARTHOG_DEV_KEK  — the local KeyWrapper's AES-256 KEK; EXACTLY 32 bytes,
//     required OUTSIDE production and refused IN production.
// Generated in-test so the base64 is always well-formed; distinctive fill bytes let
// us prove each decoded value flows from its env var rather than a hard-coded literal.
const HMAC_KEY_BYTES = Buffer.alloc(48, 0x2a); // 48 bytes, comfortably over the 32-byte floor
const HMAC_KEY_B64 = HMAC_KEY_BYTES.toString("base64");
const HMAC_KEY_32_BYTES = Buffer.alloc(32, 0x3d); // exactly at the 32-byte floor
const HMAC_KEY_32_B64 = HMAC_KEY_32_BYTES.toString("base64");
const DEV_KEK_BYTES = Buffer.alloc(32, 0x5c); // exactly 32 bytes (AES-256)
const DEV_KEK_B64 = DEV_KEK_BYTES.toString("base64");
const DEV_KEK_ALT_BYTES = Buffer.alloc(32, 0x6d); // a second, distinct 32-byte KEK
const DEV_KEK_ALT_B64 = DEV_KEK_ALT_BYTES.toString("base64");

// A fully valid DEVELOPMENT environment: pglite + dev tools, which production forbids
// but development allows. Carries only the vars dev needs (see .env.example).
const DEV_ENV: Env = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "http://localhost:3000",
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_DEV_TOOLS: "1",
  // The server secrets are now required even in dev (HMAC key everywhere, dev KEK
  // outside production), so the base DEV fixture carries valid values.
  WARTHOG_HMAC_KEY: HMAC_KEY_B64,
  WARTHOG_DEV_KEK: DEV_KEK_B64,
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
  // The HMAC key is required in every environment. The dev KEK is deliberately
  // ABSENT here: production refuses it, so a valid production fixture omits it.
  WARTHOG_HMAC_KEY: HMAC_KEY_B64,
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
  const touched = [
    "NODE_ENV",
    "PUBLIC_BASE_URL",
    "WEBAUTHN_RP_ID",
    "DATABASE_URL",
    "WARTHOG_DEV_TOOLS",
    "WARTHOG_HMAC_KEY",
    "WARTHOG_DEV_KEK",
  ];
  const saved = new Map(touched.map((k) => [k, process.env[k]]));
  try {
    process.env.NODE_ENV = "development";
    process.env.PUBLIC_BASE_URL = "https://from-process-env.example";
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.DATABASE_URL = "pglite:memory";
    delete process.env.WARTHOG_DEV_TOOLS;
    process.env.WARTHOG_HMAC_KEY = HMAC_KEY_B64;
    process.env.WARTHOG_DEV_KEK = DEV_KEK_B64;

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

// ===================================================================================
// E04-S20 — server secrets: hmacKey (WARTHOG_HMAC_KEY) and devKek (WARTHOG_DEV_KEK)
// ===================================================================================
// Email codes and link tokens are HMAC'd with a server key, and the dev KeyWrapper
// needs a KEK. loadConfig surfaces both as byte arrays decoded from base64 env vars
// so a composition root can build the auth handlers. The HMAC key is required in
// every environment (>= 32 bytes); the dev KEK is the local KEK (exactly 32 bytes),
// required outside production and refused in production.

// A base64 WARTHOG_HMAC_KEY that decodes to only 16 bytes — below the 32-byte floor.
const SHORT_HMAC_B64 = Buffer.from("short-dev-hmac!!").toString("base64");
// Base64 dev KEKs of the wrong length (31 and 33 bytes); only exactly 32 is accepted.
const KEK_31_B64 = Buffer.alloc(31, 0xb7).toString("base64");
const KEK_33_B64 = Buffer.alloc(33, 0xc9).toString("base64");

// Assert a value is a byte array and return its bytes as plain numbers, so the
// comparison works whether the builder returns a Buffer or a bare Uint8Array.
function asBytes(view: unknown, label: string): number[] {
  assert.ok(view instanceof Uint8Array, `${label} should be a byte array (Uint8Array/Buffer)`);
  return [...(view as Uint8Array)];
}

// loadConfig must reject with an error that NAMES the variable but never echoes its
// (secret) value. Omit `secretValue` for a missing-var case, where there is no value
// to leak.
function assertRejectedNaming(run: () => unknown, varName: string, secretValue?: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, `expected loadConfig to reject (${varName})`);
  const message = (thrown as Error).message;
  assert.ok(message.includes(varName), `error should name ${varName}; got: ${message}`);
  if (secretValue !== undefined) {
    assert.ok(
      !message.includes(secretValue),
      `error for ${varName} must not echo the secret value`,
    );
  }
}

// Parse a KEY=VALUE dotenv file (ignoring blank and #-comment lines) into an env record.
function parseDotenv(text: string): Env {
  const env: Env = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

// --- AC1: hmacKey and devKek are byte arrays decoded from base64 ------------------

test("decodes WARTHOG_HMAC_KEY from base64 into the exact bytes", () => {
  const cfg = load(DEV_ENV);
  assert.deepEqual(asBytes(cfg.hmacKey, "hmacKey"), [...HMAC_KEY_BYTES]);
});

test("decodes WARTHOG_DEV_KEK from base64 into exactly 32 bytes", () => {
  const cfg = load(DEV_ENV);
  const kek = asBytes(cfg.devKek, "devKek");
  assert.equal(kek.length, 32);
  assert.deepEqual(kek, [...DEV_KEK_BYTES]);
});

test("accepts a WARTHOG_HMAC_KEY of exactly 32 bytes (the floor)", () => {
  const cfg = load({ ...DEV_ENV, WARTHOG_HMAC_KEY: HMAC_KEY_32_B64 });
  assert.deepEqual(asBytes(cfg.hmacKey, "hmacKey"), [...HMAC_KEY_32_BYTES]);
});

// --- AC1: malformed values are rejected, naming the variable but never its value ---

test("rejects a missing WARTHOG_HMAC_KEY in development (required everywhere)", () => {
  assertRejectedNaming(() => load(omit(DEV_ENV, "WARTHOG_HMAC_KEY")), "WARTHOG_HMAC_KEY");
});

test("rejects a missing WARTHOG_HMAC_KEY in production (required everywhere)", () => {
  assertRejectedNaming(() => load(omit(PROD_ENV, "WARTHOG_HMAC_KEY")), "WARTHOG_HMAC_KEY");
});

test("rejects a WARTHOG_HMAC_KEY shorter than 32 bytes, naming the var but not its value", () => {
  assertRejectedNaming(
    () => load({ ...DEV_ENV, WARTHOG_HMAC_KEY: SHORT_HMAC_B64 }),
    "WARTHOG_HMAC_KEY",
    SHORT_HMAC_B64,
  );
});

test("rejects a WARTHOG_DEV_KEK that is not exactly 32 bytes, naming the var but not its value", () => {
  for (const bad of [KEK_31_B64, KEK_33_B64]) {
    assertRejectedNaming(() => load({ ...DEV_ENV, WARTHOG_DEV_KEK: bad }), "WARTHOG_DEV_KEK", bad);
  }
});

// --- AC2: production vs. development rules for the dev KEK -------------------------

test("production refuses a set WARTHOG_DEV_KEK, naming the var but not its value", () => {
  // DEV_KEK_B64 is a perfectly valid 32-byte KEK — the refusal is about production,
  // not about the value being malformed.
  assertRejectedNaming(
    () => load({ ...PROD_ENV, WARTHOG_DEV_KEK: DEV_KEK_B64 }),
    "WARTHOG_DEV_KEK",
    DEV_KEK_B64,
  );
});

test("outside production a missing WARTHOG_DEV_KEK is rejected", () => {
  assertRejectedNaming(() => load(omit(DEV_ENV, "WARTHOG_DEV_KEK")), "WARTHOG_DEV_KEK");
});

test("a valid production config (hmac key, no dev KEK) does not throw and carries the hmac key", () => {
  const cfg = load(PROD_ENV); // PROD_ENV sets WARTHOG_HMAC_KEY and deliberately omits the dev KEK
  assert.deepEqual(asBytes(cfg.hmacKey, "hmacKey"), [...HMAC_KEY_BYTES]);
  assert.equal(cfg.devKek, undefined, "production has no local dev KEK");
});

// --- AC3: .env.example carries dev-only values loadConfig accepts -----------------

test("the .env.example values load as a valid dev config with correct key sizes", () => {
  const text = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const cfg = load(parseDotenv(text));
  const hmac = asBytes(cfg.hmacKey, "hmacKey (.env.example)");
  assert.ok(hmac.length >= 32, "example WARTHOG_HMAC_KEY must decode to at least 32 bytes");
  const kek = asBytes(cfg.devKek, "devKek (.env.example)");
  assert.equal(kek.length, 32, "example WARTHOG_DEV_KEK must decode to exactly 32 bytes");
});

// --- AC4 [obligation:secrets-from-env]: both come from env, never a hard-coded value

test("hmacKey and devKek are read from env, not hard-coded constants", () => {
  const a = load({ ...DEV_ENV, WARTHOG_HMAC_KEY: HMAC_KEY_B64, WARTHOG_DEV_KEK: DEV_KEK_B64 });
  const b = load({ ...DEV_ENV, WARTHOG_HMAC_KEY: HMAC_KEY_32_B64, WARTHOG_DEV_KEK: DEV_KEK_ALT_B64 });
  assert.notDeepEqual(asBytes(a.hmacKey, "hmacKey"), asBytes(b.hmacKey, "hmacKey"));
  assert.notDeepEqual(asBytes(a.devKek, "devKek"), asBytes(b.devKek, "devKek"));
});

// --- Review fix F8: production refuses an incomplete Key Vault configuration at start-up --------
//
// Production wraps every data key under the Key Vault KEK, so without the vault URL and key name
// no person's data can be read. That is refused when the config is loaded (the readiness probe
// loads it), naming the variable but never echoing a value.

test("production refuses to start without KEY_VAULT_URL or KEY_VAULT_KEY_NAME, naming the variable", () => {
  assertRejectedNaming(() => load(omit(PROD_ENV, "KEY_VAULT_URL")), "KEY_VAULT_URL");
  assertRejectedNaming(() => load(omit(PROD_ENV, "KEY_VAULT_KEY_NAME")), "KEY_VAULT_KEY_NAME");
  assertRejectedNaming(() => load({ ...PROD_ENV, KEY_VAULT_URL: "" }), "KEY_VAULT_URL");
});

test("production refuses a KEY_VAULT_URL that is not an https URL", () => {
  assertRejectedNaming(() => load({ ...PROD_ENV, KEY_VAULT_URL: "http://warthog-kv.vault.azure.net/" }), "KEY_VAULT_URL");
  assertRejectedNaming(() => load({ ...PROD_ENV, KEY_VAULT_URL: "not a url" }), "KEY_VAULT_URL");
});

test("outside production the Key Vault settings stay optional (the local KEK wraps data keys)", () => {
  const cfg = load(omit(DEV_ENV, "KEY_VAULT_URL", "KEY_VAULT_KEY_NAME"));
  assert.equal(cfg.keyVault.url, undefined);
});

// --- Review fix: production refuses the published dev HMAC key ----------------------------------

test("production refuses the WARTHOG_HMAC_KEY published in .env.example", () => {
  const text = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const published = parseDotenv(text).WARTHOG_HMAC_KEY;
  assert.ok(published, ".env.example publishes a dev HMAC key");
  assertRejectedNaming(() => load({ ...PROD_ENV, WARTHOG_HMAC_KEY: published }), "WARTHOG_HMAC_KEY");
  // Development may use it (that is what it is for).
  assert.doesNotThrow(() => load({ ...DEV_ENV, WARTHOG_HMAC_KEY: published }));
});

// --- Admin portal origin (docs/design/admin-portal.md §1) --------------------------------
import { adminHostFromEnv } from "./config";

test("adminBaseUrl is derived from PUBLIC_BASE_URL: app. becomes admin., localhost gains an admin. label", () => {
  assert.equal(loadConfig({ ...DEV_ENV, PUBLIC_BASE_URL: "https://app.warthog.example" }).adminBaseUrl, "https://admin.warthog.example");
  assert.equal(loadConfig(DEV_ENV).adminBaseUrl, "http://admin.localhost:3000");
});

test("ADMIN_BASE_URL overrides the derivation outside production and is refused in production", () => {
  assert.equal(loadConfig({ ...DEV_ENV, ADMIN_BASE_URL: "http://portal.localhost:4000/ignored" }).adminBaseUrl, "http://portal.localhost:4000");
  assert.throws(() => loadConfig({ ...DEV_ENV, ADMIN_BASE_URL: "nope" }), /ADMIN_BASE_URL/);
  assert.throws(() => loadConfig({ ...PROD_ENV, ADMIN_BASE_URL: "https://admin.example.test" }), /ADMIN_BASE_URL/);
  assert.equal(loadConfig(PROD_ENV).adminBaseUrl, "https://admin.warthog.com.au");
});

test("adminHostFromEnv reads the same derivation without throwing, for the request proxy", () => {
  assert.equal(adminHostFromEnv({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://app.warthog.example" }), "admin.warthog.example");
  assert.equal(adminHostFromEnv({ NODE_ENV: "development", PUBLIC_BASE_URL: "http://localhost:3000", ADMIN_BASE_URL: "http://portal.localhost:3000" }), "portal.localhost");
  assert.equal(adminHostFromEnv({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://app.warthog.example", ADMIN_BASE_URL: "https://x.example" }), "admin.warthog.example", "production ignores the override here; loadConfig refuses it");
  assert.equal(adminHostFromEnv({ NODE_ENV: "production" }), null);
  assert.equal(adminHostFromEnv({ NODE_ENV: "production", PUBLIC_BASE_URL: "garbage" }), null);
});

import { onWebsiteHost, publicHomeFor, publicLinksFromEnv, websiteFromEnv } from "./config";

test("websiteFromEnv derives the website host from an app. public base URL without throwing", () => {
  assert.equal(websiteFromEnv({ PUBLIC_BASE_URL: "https://app.warthog.example" })?.origin, "https://warthog.example");
  assert.equal(websiteFromEnv({ PUBLIC_BASE_URL: "http://localhost:3000" }), null);
  assert.equal(websiteFromEnv({ PUBLIC_BASE_URL: "garbage" }), null);
  assert.equal(websiteFromEnv({}), null);
  assert.deepEqual(publicLinksFromEnv({ PUBLIC_BASE_URL: "https://app.warthog.example" }), { home: "https://warthog.example/", account: "https://app.warthog.example" });
  assert.deepEqual(publicLinksFromEnv({}), { home: "/", account: "" });
});

test("only the website's own host is the website, and only the admin host keeps its own home", () => {
  const env = { NODE_ENV: "production", PUBLIC_BASE_URL: "https://app.warthog.example" };
  assert.equal(onWebsiteHost("warthog.example", env), true);
  for (const host of ["app.warthog.example", "www.warthog.example", "admin.warthog.example", null]) assert.equal(onWebsiteHost(host, env), false, String(host));
  assert.equal(onWebsiteHost("localhost", { PUBLIC_BASE_URL: "http://localhost:3000" }), false, "no website without an app. base URL");
  for (const host of ["app.warthog.example", "warthog.example", "unknown.example", null]) assert.equal(publicHomeFor(host, env), "https://warthog.example/", String(host));
  assert.equal(publicHomeFor("admin.warthog.example", env), "/", "the admin host's / is the portal");
  assert.equal(publicHomeFor("localhost", { PUBLIC_BASE_URL: "http://localhost:3000" }), "/");
});
