// The KeyWrapper seam. Per-person data keys (DEKs, 256-bit) are stored only
// WRAPPED by a key-encryption key (KEK); see design §4.1. This seam lets the
// whole app run without Azure Key Vault:
//   - dev/test wraps the DEK under a LOCAL AES-256 KEK from config;
//   - production wraps it under the Key Vault KEK (RSA-OAEP-256), delegating to
//     an injected crypto client so tests never touch Azure or the network.
//
// The production wrapper is built LAZILY: with no injected client it uses the process-wide
// Key Vault client (`./key-vault-client`), which reads config and loads the Azure SDK only on
// the first wrap or unwrap — so constructing a KeyWrapper (every page does) never throws.
//
// A Key Vault wrapped DEK records the exact key id and version that wrapped it —
// `kv1:<base64url(key id)>:<base64(wrapped bytes)>` — and is unwrapped by a client bound to
// that version, so rotating the vault key never strands existing DEKs. A legacy value (plain
// base64, no key id) unwraps through the default client.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { defaultKeyVaultClients } from "./key-vault-client";

export interface KeyWrapper {
  // The wrapped, storable form of a DEK.
  wrap(dek: Uint8Array): Promise<string>;
  // The recovered 256-bit DEK, or a rejection if the wrapped value is tampered.
  unwrap(wrapped: string): Promise<Uint8Array>;
}

// The subset of Azure's Key Vault CryptographyClient the seam uses. The real
// client returns more fields; we read `result` and, from a wrap, `keyID` — the versioned id
// of the key that wrapped it.
export interface KeyVaultCryptoClient {
  wrapKey(algorithm: string, key: Uint8Array): Promise<{ result: Uint8Array; keyID?: string }>;
  unwrapKey(algorithm: string, encryptedKey: Uint8Array): Promise<{ result: Uint8Array }>;
}

// The production clients: the default one (the configured key, current version) and one bound
// to an exact versioned key id read back from a wrapped DEK.
export interface KeyVaultClients {
  readonly client: KeyVaultCryptoClient;
  readonly clientFor: (keyId: string) => KeyVaultCryptoClient;
}

// AES-256-GCM authenticated envelope: nonce || ciphertext || tag, base64-encoded.
// The tag makes any tampering fail the unwrap rather than return garbage.
const AES_GCM = "aes-256-gcm";
const NONCE_BYTES = 12; // 96-bit nonce per design §4.1
const TAG_BYTES = 16;

// The Key Vault KEK is an RSA-HSM key; DEKs are wrapped under RSA-OAEP-256.
const RSA_OAEP_256 = "RSA-OAEP-256";

// AES under a local 256-bit KEK — the dev/test wrapper.
export function localAesKeyWrapper(kek: Uint8Array): KeyWrapper {
  return {
    async wrap(dek: Uint8Array): Promise<string> {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(AES_GCM, kek, nonce);
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([nonce, ciphertext, tag]).toString("base64");
    },
    async unwrap(wrapped: string): Promise<Uint8Array> {
      const bytes = Buffer.from(wrapped, "base64");
      const nonce = bytes.subarray(0, NONCE_BYTES);
      const ciphertext = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
      const tag = bytes.subarray(bytes.length - TAG_BYTES);
      const decipher = createDecipheriv(AES_GCM, kek, nonce);
      decipher.setAuthTag(tag);
      // decipher.final() throws if the tag does not match (tamper / wrong KEK).
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    },
  };
}

// The versioned envelope a Key Vault wrapped DEK is stored in.
const KV_ENVELOPE = /^kv1:([A-Za-z0-9_-]+):([A-Za-z0-9+/]+={0,2})$/;

// RSA-OAEP-256 under the Key Vault KEK — the production wrapper. A wrap records the versioned
// key id Key Vault reports; an unwrap goes to the client bound to that id.
function keyVaultKeyWrapper(clients: KeyVaultClients): KeyWrapper {
  return {
    async wrap(dek: Uint8Array): Promise<string> {
      const { result, keyID } = await clients.client.wrapKey(RSA_OAEP_256, dek);
      const wrapped = Buffer.from(result).toString("base64");
      return keyID ? `kv1:${Buffer.from(keyID, "utf8").toString("base64url")}:${wrapped}` : wrapped;
    },
    async unwrap(wrapped: string): Promise<Uint8Array> {
      if (wrapped.startsWith("kv1:")) {
        const match = KV_ENVELOPE.exec(wrapped);
        if (!match) {
          throw new Error("malformed wrapped data key");
        }
        const keyId = Buffer.from(match[1]!, "base64url").toString("utf8");
        const encryptedKey = Buffer.from(match[2]!, "base64");
        const { result } = await clients.clientFor(keyId).unwrapKey(RSA_OAEP_256, encryptedKey);
        return result;
      }
      const encryptedKey = Buffer.from(wrapped, "base64");
      const { result } = await clients.client.unwrapKey(RSA_OAEP_256, encryptedKey);
      return result;
    },
  };
}

export interface SelectKeyWrapperOptions {
  nodeEnv: string;
  localKek?: Uint8Array;
  // Production: the Key Vault client (default: the process-wide lazy client from config) and,
  // for versioned wrapped DEKs, the client bound to one key id (default: the process-wide
  // per-version client when the default client is used, else the injected client itself).
  keyVaultClient?: KeyVaultCryptoClient;
  keyVaultClientFor?: (keyId: string) => KeyVaultCryptoClient;
}

// Selection is driven by nodeEnv: production uses Key Vault; every other env
// uses the local AES wrapper. Production construction never throws: the Key Vault client is
// resolved on first use.
export function selectKeyWrapper(options: SelectKeyWrapperOptions): KeyWrapper {
  if (options.nodeEnv === "production") {
    const injected = options.keyVaultClient;
    if (injected) {
      return keyVaultKeyWrapper({
        client: injected,
        clientFor: options.keyVaultClientFor ?? (() => injected),
      });
    }
    return keyVaultKeyWrapper(defaultKeyVaultClients());
  }
  if (!options.localKek) {
    throw new Error("local KeyWrapper requires a local AES KEK");
  }
  return localAesKeyWrapper(options.localKek);
}
