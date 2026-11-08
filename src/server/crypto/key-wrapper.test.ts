// E01-S06 — the KeyWrapper seam (`src/server/crypto/key-wrapper.ts`).
//
// These tests are RED-first: the module does not exist yet. They pin BEHAVIOUR
// (what wrap/unwrap do with bytes), never the source text of the module.
//
// Per-person data keys (DEKs, 256-bit) are stored only WRAPPED by a key-encryption
// key (design §4.1). The seam lets the whole app run without Azure Key Vault:
//   - dev/test wraps under a LOCAL AES KEK supplied from config;
//   - production selects the KEY VAULT wrapper (RSA-OAEP-256), which the design
//     routes through an injected crypto client so tests never touch Azure/network.
//
// The contract this task's tests define:
//   interface KeyWrapper {
//     wrap(dek: Uint8Array): Promise<string>;   // the wrapped, storable form
//     unwrap(wrapped: string): Promise<Uint8Array>; // the recovered 256-bit DEK
//   }
//   localAesKeyWrapper(kek): KeyWrapper
//     • AES under a 256-bit local KEK; the test/dev wrapper.
//   selectKeyWrapper({ nodeEnv, localKek?, keyVaultClient? }): KeyWrapper
//     • nodeEnv "production" -> the Key Vault wrapper (delegates to keyVaultClient).
//     • any other nodeEnv    -> the local AES wrapper (uses localKek).
//
// wrap/unwrap are awaited everywhere so these tests pass whether an implementation
// is sync or async. Tests use only node:crypto for entropy and an in-memory fake
// Key Vault crypto client — never the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { localAesKeyWrapper, selectKeyWrapper, type KeyWrapper } from "./key-wrapper";

const KEK_BYTES = 32; // AES-256 key-encryption key
const DEK_BYTES = 32; // a 256-bit per-person data key

function freshKek(): Uint8Array {
  return randomBytes(KEK_BYTES);
}

function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// Change exactly one character in the middle of the wrapped string. For any
// authenticated wrapping (AES-GCM / AES-KW) this corrupts the ciphertext or its
// integrity tag, so unwrap must reject rather than return different bytes.
function tamper(wrapped: string): string {
  assert.ok(wrapped.length > 0, "cannot tamper with an empty wrapped value");
  const i = Math.floor(wrapped.length / 2);
  const replacement = wrapped[i] === "A" ? "B" : "A";
  return wrapped.slice(0, i) + replacement + wrapped.slice(i + 1);
}

// An in-memory stand-in for the Azure Key Vault crypto client (CryptographyClient's
// wrapKey/unwrapKey shape). Its "wrap" is a trivially reversible transform so the
// seam can be exercised offline; it also records the algorithm it was asked for.
function fakeKeyVaultClient() {
  const calls = { wrap: 0, unwrap: 0, algorithms: [] as string[] };
  const MARKER = 0x5a;
  return {
    calls,
    async wrapKey(algorithm: string, key: Uint8Array) {
      calls.wrap += 1;
      calls.algorithms.push(algorithm);
      const result = new Uint8Array(key.length + 1);
      result[0] = MARKER;
      result.set(key, 1);
      return { result, algorithm, keyID: "fake-kek" };
    },
    async unwrapKey(algorithm: string, encryptedKey: Uint8Array) {
      calls.unwrap += 1;
      calls.algorithms.push(algorithm);
      return { result: encryptedKey.slice(1), algorithm, keyID: "fake-kek" };
    },
  };
}

// --- AC: wrap/unwrap round-trips a 256-bit DEK (local AES KEK from config) ---

test("localAesKeyWrapper round-trips a 256-bit DEK to the exact same bytes", async () => {
  const wrapper: KeyWrapper = localAesKeyWrapper(freshKek());
  const dek = freshDek();

  const wrapped = await wrapper.wrap(dek);
  assert.equal(typeof wrapped, "string", "the wrapped DEK is a storable string");
  assert.ok(wrapped.length > 0, "the wrapped DEK is non-empty");

  const back = await wrapper.unwrap(wrapped);
  assert.ok(back instanceof Uint8Array, "unwrap returns raw bytes");
  assert.equal(back.length, DEK_BYTES, "the recovered DEK is still 256-bit");
  assert.deepEqual([...back], [...dek], "the recovered DEK equals the original");
});

test("localAesKeyWrapper round-trips many distinct DEKs", async () => {
  const wrapper = localAesKeyWrapper(freshKek());
  for (let i = 0; i < 10; i += 1) {
    const dek = freshDek();
    const back = await wrapper.unwrap(await wrapper.wrap(dek));
    assert.deepEqual([...back], [...dek]);
  }
});

// --- AC: unwrapping tampered ciphertext fails rather than returning garbage ---

test("localAesKeyWrapper rejects a tampered wrapped DEK instead of returning garbage", async () => {
  const wrapper = localAesKeyWrapper(freshKek());
  const wrapped = await wrapper.wrap(freshDek());

  await assert.rejects(
    () => wrapper.unwrap(tamper(wrapped)),
    "a one-character change to the wrapped DEK must be rejected, never silently decrypted",
  );
});

test("localAesKeyWrapper rejects a DEK wrapped under a different KEK", async () => {
  const wrapperA = localAesKeyWrapper(freshKek());
  const wrapperB = localAesKeyWrapper(freshKek());
  const wrapped = await wrapperA.wrap(freshDek());

  await assert.rejects(
    () => wrapperB.unwrap(wrapped),
    "unwrapping under the wrong KEK must fail, never return garbage bytes",
  );
});

// --- AC: dev/test selects the local AES wrapper; prod selects the Key Vault wrapper ---

test("selectKeyWrapper in development selects the local AES wrapper (round-trips with only a local KEK)", async () => {
  const wrapper: KeyWrapper = selectKeyWrapper({ nodeEnv: "development", localKek: freshKek() });
  const dek = freshDek();
  const back = await wrapper.unwrap(await wrapper.wrap(dek));
  assert.deepEqual([...back], [...dek]);
});

test("selectKeyWrapper in the test env selects the local AES wrapper", async () => {
  const wrapper: KeyWrapper = selectKeyWrapper({ nodeEnv: "test", localKek: freshKek() });
  const dek = freshDek();
  const back = await wrapper.unwrap(await wrapper.wrap(dek));
  assert.deepEqual([...back], [...dek]);
});

test("selectKeyWrapper in production selects the Key Vault wrapper (delegates to the injected client)", async () => {
  const client = fakeKeyVaultClient();
  const wrapper: KeyWrapper = selectKeyWrapper({ nodeEnv: "production", keyVaultClient: client });
  const dek = freshDek();

  const wrapped = await wrapper.wrap(dek);
  assert.equal(typeof wrapped, "string");
  assert.equal(client.calls.wrap, 1, "wrap must go through the Key Vault client in production");

  const back = await wrapper.unwrap(wrapped);
  assert.equal(client.calls.unwrap, 1, "unwrap must go through the Key Vault client in production");
  assert.deepEqual([...back], [...dek], "the DEK round-trips through the Key Vault wrapper");
});

test("selectKeyWrapper in production wraps the DEK under RSA-OAEP-256 (design §4.1)", async () => {
  const client = fakeKeyVaultClient();
  const wrapper = selectKeyWrapper({ nodeEnv: "production", keyVaultClient: client });

  await wrapper.unwrap(await wrapper.wrap(freshDek()));

  assert.ok(client.calls.algorithms.length > 0, "the Key Vault client was used");
  assert.ok(
    client.calls.algorithms.every((a) => a === "RSA-OAEP-256"),
    `every Key Vault call must use RSA-OAEP-256, saw: ${client.calls.algorithms.join(", ")}`,
  );
});

test("selectKeyWrapper selection is driven by nodeEnv: production uses Key Vault even when a local KEK is also present", async () => {
  const client = fakeKeyVaultClient();
  const wrapper = selectKeyWrapper({
    nodeEnv: "production",
    localKek: freshKek(),
    keyVaultClient: client,
  });

  await wrapper.wrap(freshDek());
  assert.equal(client.calls.wrap, 1, "production must use Key Vault, not the stray local KEK");
});

// ===========================================================================
// Review fix F8 — the production wrapper is built lazily and records which KEK version wrapped
// each data key.
//
// Every page builds its KeyWrapper with only { nodeEnv, localKek }; in production that used to
// throw at construction, breaking every page. Construction must never throw: the Key Vault
// client is resolved on first use. And a Key Vault key can be rotated: a DEK wrapped under one
// key version must still unwrap after the vault's current version moves on, so the wrapped form
// records the exact key id (with version) that wrapped it, and unwrap goes to that version.
// ===========================================================================

const V1 = "https://warthog-kv.vault.azure.net/keys/kek-user-data/1111";
const V2 = "https://warthog-kv.vault.azure.net/keys/kek-user-data/2222";

// A fake Key Vault in which each key version has its own secret byte, so unwrapping under the
// wrong version yields the wrong bytes (and a real RSA unwrap would fail outright).
function versionedVault() {
  const secretOf = (keyId: string) => (keyId === V1 ? 0x11 : keyId === V2 ? 0x22 : 0x00);
  const unwrapCalls: string[] = [];
  const clientAt = (keyId: string, currentVersion: () => string) => ({
    async wrapKey(_algorithm: string, key: Uint8Array) {
      const version = currentVersion();
      return { result: Uint8Array.from(key, (b) => b ^ secretOf(version)), keyID: version };
    },
    async unwrapKey(_algorithm: string, encryptedKey: Uint8Array) {
      const version = keyId === "current" ? currentVersion() : keyId;
      unwrapCalls.push(version);
      return { result: Uint8Array.from(encryptedKey, (b) => b ^ secretOf(version)) };
    },
  });
  return { clientAt, unwrapCalls };
}

test("selectKeyWrapper in production constructs without a client: construction never throws", () => {
  assert.doesNotThrow(() => selectKeyWrapper({ nodeEnv: "production" }));
  assert.doesNotThrow(() => selectKeyWrapper({ nodeEnv: "production", localKek: undefined }));
});

test("the production wrapper records the wrapping key's id and version in the wrapped DEK", async () => {
  const vault = versionedVault();
  let current = V1;
  const wrapper = selectKeyWrapper({
    nodeEnv: "production",
    keyVaultClient: vault.clientAt("current", () => current),
    keyVaultClientFor: (keyId) => vault.clientAt(keyId, () => current),
  });
  const wrapped = await wrapper.wrap(freshDek());
  const match = /^kv1:([A-Za-z0-9_-]+):/.exec(wrapped);
  assert.ok(match, `the wrapped DEK carries a versioned envelope, got ${wrapped.slice(0, 12)}…`);
  assert.equal(Buffer.from(match[1]!, "base64url").toString("utf8"), V1, "it names the exact key version");
});

test("a DEK wrapped before a key rotation still unwraps, through the version that wrapped it", async () => {
  const vault = versionedVault();
  let current = V1;
  const wrapper = selectKeyWrapper({
    nodeEnv: "production",
    keyVaultClient: vault.clientAt("current", () => current),
    keyVaultClientFor: (keyId) => vault.clientAt(keyId, () => current),
  });
  const dek = freshDek();
  const wrappedUnderV1 = await wrapper.wrap(dek);

  current = V2; // the vault's key rotates
  const back = await wrapper.unwrap(wrappedUnderV1);
  assert.deepEqual([...back], [...dek], "the old DEK unwraps after rotation");
  assert.deepEqual(vault.unwrapCalls, [V1], "the unwrap went to the version that wrapped it");

  // New DEKs wrap under the new version and round-trip too.
  const dek2 = freshDek();
  assert.deepEqual([...(await wrapper.unwrap(await wrapper.wrap(dek2)))], [...dek2]);
});

test("a legacy wrapped DEK (plain base64, no key id) still unwraps through the default client", async () => {
  const client = fakeKeyVaultClient();
  const wrapper = selectKeyWrapper({ nodeEnv: "production", keyVaultClient: client });
  const dek = freshDek();
  const legacy = Buffer.concat([Buffer.from([0x5a]), Buffer.from(dek)]).toString("base64");
  assert.deepEqual([...(await wrapper.unwrap(legacy))], [...dek]);
});

test("a malformed versioned envelope is refused rather than sent to Key Vault", async () => {
  const client = fakeKeyVaultClient();
  const wrapper = selectKeyWrapper({ nodeEnv: "production", keyVaultClient: client });
  await assert.rejects(wrapper.unwrap("kv1:not valid!:AAAA"));
  await assert.rejects(wrapper.unwrap("kv1::AAAA"));
  assert.equal(client.calls.unwrap, 0, "nothing malformed reaches Key Vault");
});
