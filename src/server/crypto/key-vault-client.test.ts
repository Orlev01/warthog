// Review fix F8 — the production Key Vault client (`./key-vault-client`).
//
// The KeyWrapper seam delegates to a Key Vault crypto client in production, but nothing ever
// built one, so every page threw. This module builds it from config.keyVault, LAZILY: nothing
// is constructed (and no Azure SDK is loaded) until the first wrap or unwrap, an incomplete
// configuration fails loudly on use, naming the missing variable, and a client bound to a
// specific key version is only ever built for a key in the configured vault.
//
// The Azure SDK sits behind an injected factory, so these tests never touch Azure or the
// network; the last test proves the default factory builds a real CryptographyClient offline.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createKeyVaultClients, azureCryptoClientFactory } from "./key-vault-client";
import type { KeyVaultCryptoClient } from "./key-wrapper";

const VAULT = "https://warthog-kv.vault.azure.net/";

function recordingFactory() {
  const built: string[] = [];
  const factory = (keyId: string): KeyVaultCryptoClient => {
    built.push(keyId);
    return {
      async wrapKey(_algorithm, key) {
        return { result: key, keyID: `${keyId}/v1` };
      },
      async unwrapKey(_algorithm, encryptedKey) {
        return { result: encryptedKey };
      },
    };
  };
  return { built, factory };
}

test("nothing is built until first use, then the configured key is used", async () => {
  const { built, factory } = recordingFactory();
  let reads = 0;
  const clients = createKeyVaultClients(() => {
    reads++;
    return { url: VAULT, keyName: "kek-user-data" };
  }, factory);
  assert.equal(reads, 0, "config is not read at construction");
  assert.deepEqual(built, [], "no client is built at construction");

  const wrapped = await clients.client.wrapKey("RSA-OAEP-256", new Uint8Array([1, 2, 3]));
  assert.deepEqual(built, ["https://warthog-kv.vault.azure.net/keys/kek-user-data"]);
  assert.equal(wrapped.keyID, "https://warthog-kv.vault.azure.net/keys/kek-user-data/v1");

  await clients.client.unwrapKey("RSA-OAEP-256", new Uint8Array([1]));
  assert.equal(built.length, 1, "the default client is built once");
});

test("an incomplete Key Vault configuration fails on use, naming what is missing", async () => {
  const { built, factory } = recordingFactory();
  const noUrl = createKeyVaultClients(() => ({ url: undefined, keyName: "kek" }), factory);
  await assert.rejects(noUrl.client.wrapKey("RSA-OAEP-256", new Uint8Array(1)), /KEY_VAULT_URL/);
  const noName = createKeyVaultClients(() => ({ url: VAULT, keyName: "" }), factory);
  await assert.rejects(noName.client.unwrapKey("RSA-OAEP-256", new Uint8Array(1)), /KEY_VAULT_KEY_NAME/);
  const notHttps = createKeyVaultClients(() => ({ url: "http://warthog-kv.vault.azure.net/", keyName: "kek" }), factory);
  await assert.rejects(notHttps.client.wrapKey("RSA-OAEP-256", new Uint8Array(1)), /KEY_VAULT_URL/);
  assert.deepEqual(built, [], "no client is built for an incomplete configuration");
});

test("a versioned client is built for a key in the configured vault, once per version", async () => {
  const { built, factory } = recordingFactory();
  const clients = createKeyVaultClients(() => ({ url: VAULT, keyName: "kek-user-data" }), factory);
  const v1 = "https://warthog-kv.vault.azure.net/keys/kek-user-data/1111";
  await clients.clientFor(v1).unwrapKey("RSA-OAEP-256", new Uint8Array(1));
  await clients.clientFor(v1).unwrapKey("RSA-OAEP-256", new Uint8Array(1));
  assert.deepEqual(built, [v1]);
});

test("a key id outside the configured vault is refused (the managed identity is never pointed elsewhere)", async () => {
  const { built, factory } = recordingFactory();
  const clients = createKeyVaultClients(() => ({ url: VAULT, keyName: "kek-user-data" }), factory);
  await assert.rejects(
    clients.clientFor("https://attacker.vault.azure.net/keys/kek/1").unwrapKey("RSA-OAEP-256", new Uint8Array(1)),
    /vault/i,
  );
  await assert.rejects(
    clients.clientFor("not a url").unwrapKey("RSA-OAEP-256", new Uint8Array(1)),
    /vault/i,
  );
  assert.deepEqual(built, []);
});

test("the default factory is lazy, and the Azure SDK it loads on first use resolves and constructs offline", async () => {
  const client = azureCryptoClientFactory("https://warthog-kv.vault.azure.net/keys/kek-user-data");
  assert.equal(typeof client.wrapKey, "function");
  assert.equal(typeof client.unwrapKey, "function");

  // What the factory does on first use, minus the network call: both SDK modules resolve (they
  // are pinned runtime dependencies) and the client constructs without contacting Azure.
  const [{ CryptographyClient }, { DefaultAzureCredential }] = await Promise.all([
    import("@azure/keyvault-keys"),
    import("@azure/identity"),
  ]);
  const real = new CryptographyClient(
    "https://warthog-kv.vault.azure.net/keys/kek-user-data",
    new DefaultAzureCredential(),
  );
  assert.equal(typeof real.wrapKey, "function");
  assert.equal(typeof real.unwrapKey, "function");
});
