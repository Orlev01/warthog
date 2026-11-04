// The KeyWrapper seam. Per-person data keys (DEKs, 256-bit) are stored only
// WRAPPED by a key-encryption key (KEK); see design §4.1. This seam lets the
// whole app run without Azure Key Vault:
//   - dev/test wraps the DEK under a LOCAL AES-256 KEK from config;
//   - production wraps it under the Key Vault KEK (RSA-OAEP-256), delegating to
//     an injected crypto client so tests never touch Azure or the network.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface KeyWrapper {
  // The wrapped, storable form of a DEK.
  wrap(dek: Uint8Array): Promise<string>;
  // The recovered 256-bit DEK, or a rejection if the wrapped value is tampered.
  unwrap(wrapped: string): Promise<Uint8Array>;
}

// The subset of Azure's Key Vault CryptographyClient the seam uses. The real
// client returns more fields; we read only `result`.
export interface KeyVaultCryptoClient {
  wrapKey(algorithm: string, key: Uint8Array): Promise<{ result: Uint8Array }>;
  unwrapKey(algorithm: string, encryptedKey: Uint8Array): Promise<{ result: Uint8Array }>;
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

// RSA-OAEP-256 under the Key Vault KEK — the production wrapper.
function keyVaultKeyWrapper(client: KeyVaultCryptoClient): KeyWrapper {
  return {
    async wrap(dek: Uint8Array): Promise<string> {
      const { result } = await client.wrapKey(RSA_OAEP_256, dek);
      return Buffer.from(result).toString("base64");
    },
    async unwrap(wrapped: string): Promise<Uint8Array> {
      const encryptedKey = Buffer.from(wrapped, "base64");
      const { result } = await client.unwrapKey(RSA_OAEP_256, encryptedKey);
      return result;
    },
  };
}

export interface SelectKeyWrapperOptions {
  nodeEnv: string;
  localKek?: Uint8Array;
  keyVaultClient?: KeyVaultCryptoClient;
}

// Selection is driven by nodeEnv: production uses Key Vault; every other env
// uses the local AES wrapper.
export function selectKeyWrapper(options: SelectKeyWrapperOptions): KeyWrapper {
  if (options.nodeEnv === "production") {
    if (!options.keyVaultClient) {
      throw new Error("production KeyWrapper requires a Key Vault crypto client");
    }
    return keyVaultKeyWrapper(options.keyVaultClient);
  }
  if (!options.localKek) {
    throw new Error("local KeyWrapper requires a local AES KEK");
  }
  return localAesKeyWrapper(options.localKek);
}
