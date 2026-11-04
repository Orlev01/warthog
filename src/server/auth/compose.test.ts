// E04-S21 — the auth composition root (`src/server/auth/compose.ts`).
//
// RED-first: the module under test does NOT exist yet, so importing `./compose`
// throws — every test here fails until the builder adds it. That absence IS the
// point of test-first; nothing is implemented to make these pass.
//
// What this module is (the contract these tests define): one composition root that
// builds the `SignupHandlerDeps` / `SigninHandlerDeps` bundles the thin HTTP
// entries wire, from validated config at CALL time. So the two functions take the
// config and the db GETTER by injection (defaulting, in production, to the real
// `loadConfig()` / `getServerDb()`), which lets every test here run WITHOUT a real
// environment, a real database, or Azure:
//
//   getSignupDeps(overrides?: { config?; getDb? }): Promise<SignupHandlerDeps>
//   getSigninDeps(overrides?: { config?; getDb? }): Promise<SigninHandlerDeps>
//
//   config  — a validated Config (from loadConfig); defaults to loadConfig().
//   getDb   — a () => Promise<Db> db getter; defaults to getServerDb. The bundle's
//             `db` is the value this getter resolves to.
//
// These tests pin BEHAVIOUR (what the built bundle DOES — the origin it derives, the
// wrapper that round-trips, the outbox that captures, the store that reads back),
// never the source text of the module. The secrets-from-env obligation (INV-103) is
// characterized behaviourally too: flipping a secret in the INJECTED config flips the
// bundle, which proves the secret flows from config (env) rather than a constant
// baked into the source — a greppable source-text check is deliberately avoided (it
// would redden on any rename that preserves behaviour).
//
// Acceptance criteria → tests:
//   AC1 "dev config -> getSignupDeps returns publicOrigin = origin of publicBaseUrl,
//        rpId from config, a KeyWrapper that round-trips a data key, and an email
//        sender whose sent message is captured by the dev outbox."
//   AC2 "dev tools off + no real email sender -> sending through the bundle's email
//        sender rejects saying email is not configured; never silently drops."
//   AC3 "getSigninDeps returns a totpSecrets store that reads what the TOTP secret
//        store saved for that person."
//   AC4 [obligation:secrets-from-env] "No secret value is hard-coded; config is read
//        from env." — hmacKey and the KeyWrapper KEK flow from the injected config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { getSignupDeps, getSigninDeps } from "./compose";
import { loadConfig } from "../config";
import { createTotpSecretStore } from "./totp-store";
import { selectKeyWrapper } from "../crypto/key-wrapper";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { outbox } from "../notify/outbox";
import { systemClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import type { Db } from "../db/index";

type Env = Record<string, string | undefined>;

// Well-formed base64 secrets built in-test (any bytes base64-encode cleanly), with
// distinctive fill bytes so flipping one proves the value flows from the injected
// config rather than a hard-coded constant. The HMAC key must decode to >= 32 bytes;
// the dev KEK must decode to EXACTLY 32 (AES-256).
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const HMAC_KEY_ALT_B64 = Buffer.alloc(48, 0x17).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");
const DEV_KEK_ALT_B64 = Buffer.alloc(32, 0x6d).toString("base64");

// A fully valid DEVELOPMENT environment: dev tools on, a local dev KEK, pglite — the
// base every test tweaks. loadConfig(env) is a pure function of this record, so no
// test mutates the real process environment.
const DEV_ENV: Env = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "http://localhost:3000",
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_DEV_TOOLS: "1",
  WARTHOG_HMAC_KEY: HMAC_KEY_B64,
  WARTHOG_DEV_KEK: DEV_KEK_B64,
};

function devConfig(overrides: Env = {}) {
  return loadConfig({ ...DEV_ENV, ...overrides } as NodeJS.ProcessEnv);
}

// A do-nothing Db for the signup-side tests, which never exercise the stored db —
// getSignupDeps only needs the getter to resolve to SOMETHING it can place in the
// bundle. The signin/totp test uses a real migrated freshDb instead.
function stubDb(): Db {
  return {
    async query() {
      return { rows: [] };
    },
    async close() {},
  };
}

// A random tag so outbox assertions (the outbox is a process-wide singleton shared
// with every other test) can find THIS test's message without assuming it is alone.
function tag(): string {
  return Math.random().toString(36).slice(2);
}

// --- AC1 -------------------------------------------------------------------------

test("getSignupDeps builds the dev bundle: publicOrigin, rpId, a round-tripping KeyWrapper, and a dev-outbox email sender", async () => {
  const config = devConfig();
  const db = stubDb();
  const deps = await getSignupDeps({ config, getDb: async () => db });

  // publicOrigin is the ORIGIN of publicBaseUrl; rpId comes straight from config.
  assert.equal(deps.publicOrigin, new URL(config.publicBaseUrl).origin);
  assert.equal(deps.rpId, config.webauthnRpId);

  // The KeyWrapper round-trips a 256-bit data key (the local AES wrapper over the
  // dev KEK, so the whole app runs without Key Vault).
  const dek = Buffer.alloc(32, 0x11);
  const wrapped = await deps.keyWrapper.wrap(dek);
  assert.deepEqual(Buffer.from(await deps.keyWrapper.unwrap(wrapped)), dek);

  // The email sender's message is captured by the process-wide dev outbox.
  const recipient = `s21-${tag()}@example.test`;
  const body = `captured-${tag()}`;
  await deps.emailSender.sendEmail({ recipient, body });
  const captured = outbox
    .list()
    .some((m) => m.channel === "email" && m.recipient === recipient && m.body === body);
  assert.ok(captured, "expected the sent email to be captured by the dev outbox");
});

test("getSignupDeps publicOrigin is the ORIGIN of publicBaseUrl — any path or query is dropped", async () => {
  const config = devConfig({ PUBLIC_BASE_URL: "https://warthog.example.test:8443/base/path?x=1" });
  const db = stubDb();
  const deps = await getSignupDeps({ config, getDb: async () => db });

  assert.equal(deps.publicOrigin, "https://warthog.example.test:8443");
  // Scoped narrowly to the publicOrigin field: the path must not survive into it.
  assert.ok(
    !deps.publicOrigin.includes("/base/path"),
    "publicOrigin must be the origin, with the path stripped",
  );
});

test("both bundles wire systemClock, systemRandom and the injected db getter", async () => {
  const config = devConfig();
  const db = stubDb();

  const signup = await getSignupDeps({ config, getDb: async () => db });
  assert.equal(signup.clock, systemClock);
  assert.equal(signup.random, systemRandom);
  assert.equal(signup.db, db);

  const signin = await getSigninDeps({ config, getDb: async () => db });
  assert.equal(signin.clock, systemClock);
  assert.equal(signin.random, systemRandom);
  assert.equal(signin.db, db);
  // getSigninDeps builds the parallel fields the same way as getSignupDeps.
  assert.equal(signin.publicOrigin, new URL(config.publicBaseUrl).origin);
  assert.equal(signin.rpId, config.webauthnRpId);
});

// --- AC2 -------------------------------------------------------------------------

test("with dev tools off and no email sender configured, the bundle's email sender rejects rather than silently dropping", async () => {
  // Dev tools off -> selectSenders returns the REAL bundle; DEV_ENV configures no
  // ACS email connection string, so the real email channel is "not configured".
  const config = devConfig({ WARTHOG_DEV_TOOLS: "0" });
  const db = stubDb();
  const deps = await getSignupDeps({ config, getDb: async () => db });

  await assert.rejects(
    deps.emailSender.sendEmail({ recipient: `nobody-${tag()}@example.test`, body: "x" }),
    (err) =>
      err instanceof Error && /email/i.test(err.message) && /not configured/i.test(err.message),
    "sending with no email sender configured must reject saying email is not configured",
  );
});

// --- AC3 -------------------------------------------------------------------------

test("getSigninDeps exposes a totpSecrets store that reads what the TOTP secret store saved for that person", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    // The local AES wrapper over the SAME dev KEK the compose root uses, so a DEK
    // wrapped here unwraps inside the store compose builds (same KEK -> compatible).
    const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });

    // A genuine person row with a real wrapped DEK, then a secret saved through the
    // real TOTP secret store (what it "saved for that person").
    const wrappedDek = await keyWrapper.wrap(Buffer.alloc(32, 0x24));
    const person = await createUser(db, { email: `totp-${tag()}@warthog.com.au`, wrappedDek });
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    await createTotpSecretStore({ db, keyWrapper }).set(person.id, secret);

    const deps = await getSigninDeps({ config, getDb: async () => db });
    assert.equal(await deps.totpSecrets.get(person.id), secret);

    // A person with no enrolled secret reads back null (never another person's).
    const other = await createUser(db, { email: `no-totp-${tag()}@warthog.com.au`, wrappedDek });
    assert.equal(await deps.totpSecrets.get(other.id), null);
  } finally {
    await db.close();
  }
});

// --- AC4 [obligation:secrets-from-env] -------------------------------------------

test("[obligation:secrets-from-env] hmacKey flows from the injected config, not a hard-coded constant", async () => {
  const db = stubDb();
  const configA = devConfig({ WARTHOG_HMAC_KEY: HMAC_KEY_B64 });
  const configB = devConfig({ WARTHOG_HMAC_KEY: HMAC_KEY_ALT_B64 });

  const depsA = await getSignupDeps({ config: configA, getDb: async () => db });
  const depsB = await getSignupDeps({ config: configB, getDb: async () => db });

  // The bundle's hmacKey is exactly the bytes the injected config carried (read from
  // env), and flipping the config flips the bundle — so it is not a baked constant.
  assert.deepEqual(Buffer.from(depsA.hmacKey), Buffer.from(configA.hmacKey));
  assert.deepEqual(Buffer.from(depsB.hmacKey), Buffer.from(configB.hmacKey));
  assert.notDeepEqual(Buffer.from(depsA.hmacKey), Buffer.from(depsB.hmacKey));
});

test("[obligation:secrets-from-env] the KeyWrapper KEK flows from the injected config (dev KEK), not a hard-coded constant", async () => {
  const db = stubDb();
  const configA = devConfig({ WARTHOG_DEV_KEK: DEV_KEK_B64 });
  const configB = devConfig({ WARTHOG_DEV_KEK: DEV_KEK_ALT_B64 });

  const depsA = await getSignupDeps({ config: configA, getDb: async () => db });
  const depsB = await getSignupDeps({ config: configB, getDb: async () => db });

  const dek = Buffer.alloc(32, 0x33);
  const wrappedByA = await depsA.keyWrapper.wrap(dek);

  // A's wrapper round-trips its own envelope...
  assert.deepEqual(Buffer.from(await depsA.keyWrapper.unwrap(wrappedByA)), dek);
  // ...but B's wrapper — built from a DIFFERENT dev KEK in config — cannot unwrap it,
  // which it could if the KEK were a single hard-coded constant shared by both.
  await assert.rejects(depsB.keyWrapper.unwrap(wrappedByA));
});
