// The production Key Vault crypto client behind the KeyWrapper seam (design §4.1: every
// per-person DEK is wrapped under the Key Vault KEK, RSA-OAEP-256; the app authenticates with
// its user-assigned managed identity, design §2).
//
// Built LAZILY: nothing is constructed — no config read, no Azure SDK loaded — until the first
// wrap or unwrap, so constructing a KeyWrapper on a page never throws, and dev/test (which use
// the local AES KEK) never load Azure at all. An incomplete configuration fails loudly on use,
// naming the missing variable (production also refuses it when the config loads).
//
// Two kinds of client are handed out:
//   - `client`: bound to the configured key WITHOUT a version, so wraps use the vault's current
//     key version; Key Vault reports the exact versioned key id it used, which the KeyWrapper
//     records in the wrapped DEK;
//   - `clientFor(keyId)`: bound to one exact (versioned) key id read back from a wrapped DEK, so
//     a DEK wrapped before a key rotation still unwraps under the version that wrapped it. Only
//     a key in the configured vault is accepted, so a stored value can never point the managed
//     identity at another vault.
//
// The Azure SDK sits behind the `CryptoClientFactory` seam (tests inject a fake; they never
// touch Azure or the network). This module reads no `process.env`: config arrives through the
// injected getter (`loadConfig().keyVault` in the process-wide default).

import { loadConfig, type KeyVaultConfig } from "../config";
import { processSingleton } from "../seams/process-singleton";
import type { KeyVaultClients, KeyVaultCryptoClient } from "./key-wrapper";

// Build a crypto client bound to one Key Vault key id (versioned or not).
export type CryptoClientFactory = (keyId: string) => KeyVaultCryptoClient;

// The real factory: an Azure CryptographyClient authenticated with DefaultAzureCredential (the
// app's managed identity in Azure). The SDK modules are imported on first use only.
export const azureCryptoClientFactory: CryptoClientFactory = (keyId) => {
  type AzureCryptoClient = {
    wrapKey(algorithm: string, key: Uint8Array): Promise<{ result: Uint8Array; keyID?: string }>;
    unwrapKey(algorithm: string, encryptedKey: Uint8Array): Promise<{ result: Uint8Array }>;
  };
  let pending: Promise<AzureCryptoClient> | undefined;
  const resolve = (): Promise<AzureCryptoClient> => {
    pending ??= (async () => {
      const [{ CryptographyClient }, { DefaultAzureCredential }] = await Promise.all([
        import("@azure/keyvault-keys"),
        import("@azure/identity"),
      ]);
      return new CryptographyClient(keyId, new DefaultAzureCredential()) as unknown as AzureCryptoClient;
    })();
    pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    async wrapKey(algorithm, key) {
      const { result, keyID } = await (await resolve()).wrapKey(algorithm, key);
      return { result, keyID };
    },
    async unwrapKey(algorithm, encryptedKey) {
      const { result } = await (await resolve()).unwrapKey(algorithm, encryptedKey);
      return { result };
    },
  };
};

// The validated vault: its origin (to vet versioned key ids) and the configured key's id.
interface ResolvedVault {
  readonly origin: string;
  readonly keyId: string;
}

function resolveVault(keyVault: KeyVaultConfig): ResolvedVault {
  let url: URL | undefined;
  try {
    url = keyVault.url ? new URL(keyVault.url) : undefined;
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "https:") {
    throw new Error("Key Vault is not configured: KEY_VAULT_URL must be an https URL");
  }
  if (!keyVault.keyName) {
    throw new Error("Key Vault is not configured: KEY_VAULT_KEY_NAME is required");
  }
  return {
    origin: url.origin,
    keyId: `${url.origin}/keys/${encodeURIComponent(keyVault.keyName)}`,
  };
}

// A client whose real client is built on first call.
function deferred(build: () => KeyVaultCryptoClient): KeyVaultCryptoClient {
  return {
    async wrapKey(algorithm, key) {
      return build().wrapKey(algorithm, key);
    },
    async unwrapKey(algorithm, encryptedKey) {
      return build().unwrapKey(algorithm, encryptedKey);
    },
  };
}

// Build the default and per-version clients over a config getter, lazily. One client per key
// id is built and reused.
export function createKeyVaultClients(
  keyVault: () => KeyVaultConfig,
  factory: CryptoClientFactory = azureCryptoClientFactory,
): KeyVaultClients {
  const built = new Map<string, KeyVaultCryptoClient>();
  const clientAt = (keyId: string): KeyVaultCryptoClient => {
    let client = built.get(keyId);
    if (!client) {
      client = factory(keyId);
      built.set(keyId, client);
    }
    return client;
  };

  return {
    client: deferred(() => clientAt(resolveVault(keyVault()).keyId)),
    clientFor: (keyId) =>
      deferred(() => {
        const vault = resolveVault(keyVault());
        let origin: string | undefined;
        try {
          origin = new URL(keyId).origin;
        } catch {
          origin = undefined;
        }
        if (origin !== vault.origin || !keyId.startsWith(`${vault.origin}/keys/`)) {
          throw new Error("Wrapped data key names a key outside the configured vault");
        }
        return clientAt(keyId);
      }),
  };
}

// The process-wide clients production uses, over the runtime config. Held on globalThis so
// Next's split module graphs share one set of SDK clients.
export function defaultKeyVaultClients(): KeyVaultClients {
  return processSingleton("crypto.keyVault.clients", () =>
    createKeyVaultClients(() => loadConfig().keyVault),
  );
}
