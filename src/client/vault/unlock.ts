// Client vault unlock + seal helper (design §4.2).
//
// The only place the unwrapped vault key (VK) ever lives is this in-memory client
// helper. VK is stored server-side only WRAPPED, once per unlock method, under a
// wrapping key that method derives. `unlockVault` RE-DERIVES that wrapping key and
// unwraps the stored envelope to recover the exact VK; `sealForSave` encrypts a
// high-tier value or a card number under the unlocked VK for saving. Composing
// derive + unwrap + encrypt here keeps the React layer thin and keeps VK off the
// server.
//
// This module adds no new crypto — it COMPOSES the sibling seams:
//   • derive.ts  — deriveWrappingKeyFrom{Prf,Passphrase,RecoveryCode}
//   • key.ts     — unwrapVaultKey (the VK unwrap primitive, GCM-tag verified)
//   • values.ts  — encryptValue (the value seal primitive)
//
// Unwrap is always GCM-tag verified by key.ts: a wrong secret, a wrong salt, a
// tampered envelope or any failed tag makes unwrap REJECT, and that rejection
// propagates straight out of unlockVault. unlockVault NEVER catches it and NEVER
// re-keys — so a failed passkey-PRF unlock simply throws, letting the React layer
// fall back to a passphrase or recovery-code unlock that recovers the ORIGINAL VK
// rather than silently creating a new one.
//
// Pure client crypto: it only reaches the WebCrypto-backed sibling seams, never a
// DOM, the network, a database, or Node's Buffer.

import { unwrapVaultKey } from "./key";
import {
  deriveWrappingKeyFromPrf,
  deriveWrappingKeyFromPassphrase,
  deriveWrappingKeyFromRecoveryCode,
} from "./derive";
import { encryptValue } from "./values";

// The STORED, non-secret unlock-method record: the `v1:` wrapped-VK envelope, plus
// the 16-byte PBKDF2 salt for a passphrase method (prf/recovery need no salt).
// Each branch carries exactly the material its derivation needs.
export type UnlockRequest =
  | { method: "prf"; material: { wrapped: string }; secret: Uint8Array<ArrayBuffer> }
  | {
      method: "passphrase";
      material: { wrapped: string; salt: Uint8Array<ArrayBuffer> };
      secret: string;
    }
  | { method: "recovery"; material: { wrapped: string }; secret: string };

// Re-derive the method's wrapping key from the user-supplied secret (PRF output
// bytes, or the passphrase / recovery-code string) — deterministic in its inputs,
// so the key wrapped on one device unwraps on any device that re-derives it.
function deriveWrappingKey(request: UnlockRequest): Promise<Uint8Array<ArrayBuffer>> {
  switch (request.method) {
    case "prf":
      return deriveWrappingKeyFromPrf(request.secret);
    case "passphrase":
      return deriveWrappingKeyFromPassphrase(request.secret, request.material.salt);
    case "recovery":
      return deriveWrappingKeyFromRecoveryCode(request.secret);
  }
}

// Derive the method's wrapping key and unwrap the stored VK envelope, returning the
// exact original vault-key bytes for a correct secret. Throws a plain Error (never
// returns a key, never re-keys) for a wrong secret, a wrong salt, a tampered
// envelope or any failed GCM tag — the rejection from unwrapVaultKey propagates
// unchanged, which is what lets a failed PRF fall back to passphrase/recovery.
export async function unlockVault(request: UnlockRequest): Promise<Uint8Array<ArrayBuffer>> {
  const wrappingKey = await deriveWrappingKey(request);
  return unwrapVaultKey(wrappingKey, request.material.wrapped);
}

// Encrypt a high-tier value or a card number under the unlocked VK as a storable
// `v1:` envelope for saving. The ciphertext round-trips back to the original under
// the same VK (via values.ts' decryptValue).
export function sealForSave(
  vaultKey: Uint8Array<ArrayBuffer>,
  value: string,
): Promise<string> {
  return encryptValue(vaultKey, value);
}
