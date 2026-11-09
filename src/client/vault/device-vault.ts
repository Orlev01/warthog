// Client device vault: set up, unlock and re-seal the vault key on this device (review fix
// W1; design §4.2 "Device-held vault"; brief "Vault unlock methods").
//
// Every vault-unlocking flow (add a card, add a high-tier detail, release from the inbox,
// the Vault recovery-phrase settings) composes this one framework-free seam over the
// unlock endpoints, so the rules live in one place:
//   • GET  /api/vault/unlock-material/<method>  — the non-secret material for a method;
//   • POST /api/vault/unlock-method             — save a wrapped vault key. Adding a method
//     proves possession of the vault key; replacing one also needs fresh step-up, otherwise the server
//     answers 403 step_up_required and keeps what it had (surfaced as StepUpRequiredError,
//     so the caller can offer "Confirm it's you").
//
// It adds no crypto of its own — it composes derive.ts, key.ts and recovery-phrase.ts —
// and never sends a secret: the passkey's PRF output, the passphrase, the recovery phrase
// and the vault key stay on the device. First setup additionally enrols a domain-separated
// verification key that cannot decrypt the vault; later saves send one-use HMAC proofs.
//
// Browser code: the injected `fetch` (same-origin, so the session cookie rides along and
// the browser sets Origin) and the injected passkey ceremony; WebCrypto, never Node APIs.

import { deriveWrappingKeyFromPassphrase, deriveWrappingKeyFromPrf } from "./derive";
import { unwrapVaultKey, wrapVaultKey } from "./key";
import { unlockWithRecoveryPhrase, wrapVaultKeyWithRecoveryPhrase } from "./recovery-phrase";
import { createVaultProof } from "./unlock-proof";
import type { VaultProofChallenge } from "../../domain/vault-unlock-proof";

export type VaultMethod = "passkey_prf" | "passphrase" | "recovery";

// The passkey assertion the OS prompt returns. The PRF output is base64url in
// clientExtensionResults.prf.results.first; a dismissed prompt REJECTS.
export type PasskeyAssertion = {
  clientExtensionResults?: { prf?: { results?: { first?: string } } } & Record<string, unknown>;
} & Record<string, unknown>;

export interface DeviceVaultDeps {
  readonly fetch: typeof fetch;
  readonly startAuthentication: (opts: { optionsJSON: unknown }) => Promise<PasskeyAssertion>;
  // Fresh vault-key entropy; called ONLY when a vault is set up for the first time.
  readonly createVaultKey?: () => Uint8Array;
}

// What adopting this device's passkey did: re-sealed the vault key under it, found it
// already unlocks, or found its device cannot unlock a vault at all (no PRF result).
export type AdoptOutcome = "adopted" | "unchanged" | "unsupported";

export interface DeviceVault {
  // Unlock with this device's passkey; with `createIfMissing`, a person with no vault yet
  // gets a fresh vault key sealed under it (`created` true).
  unlockWithPasskey(opts: {
    createIfMissing: boolean;
  }): Promise<{ vaultKey: Uint8Array<ArrayBuffer>; created: boolean }>;
  unlockWithPassphrase(passphrase: string, opts?: { createIfMissing: boolean }): Promise<Uint8Array<ArrayBuffer>>;
  unlockWithRecoveryPhrase(phrase: string): Promise<Uint8Array<ArrayBuffer>>;
  hasRecoveryPhrase(): Promise<boolean>;
  // Seal the vault key under a recovery phrase / a passphrase and save it.
  saveRecoveryPhrase(vaultKey: Uint8Array<ArrayBuffer>, phrase: string): Promise<void>;
  savePassphrase(vaultKey: Uint8Array<ArrayBuffer>, passphrase: string): Promise<void>;
  // Re-seal the vault key under this device's passkey (after a phrase or passphrase
  // unlock), confirming it's you in the same single passkey prompt.
  adoptPasskey(vaultKey: Uint8Array<ArrayBuffer>): Promise<AdoptOutcome>;
}

// A save the server refused because it would replace an existing method without a fresh
// step-up. Nothing changed; once the person confirms it's you the save can be retried.
export class StepUpRequiredError extends Error {
  constructor() {
    super("Confirm it's you before you change how your vault unlocks.");
    this.name = "StepUpRequiredError";
  }
}

const UNLOCK_MATERIAL_BASE = "/api/vault/unlock-material";
const UNLOCK_METHOD_URL = "/api/vault/unlock-method";
const STEP_UP_BASE = "/api/auth/step-up";
const PASSPHRASE_SALT_BYTES = 16;

type ServerUnlockMaterial = {
  readonly wrapped: string | null;
  readonly params?: Record<string, unknown> | null;
  readonly credentials?: readonly { credentialId: string; wrapped: string }[];
  readonly options?: { extensions?: { prf?: unknown } } & Record<string, unknown>;
  readonly proof: VaultProofChallenge;
};

class VaultPossessionError extends Error {}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return base64ToBytes(b64 + padding);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// The PRF output an assertion carries, or null when the device could not produce one.
function prfOutputOf(assertion: PasskeyAssertion): Uint8Array<ArrayBuffer> | null {
  const first = assertion.clientExtensionResults?.prf?.results?.first;
  return typeof first === "string" ? base64UrlToBytes(first) : null;
}

function credentialIdOf(assertion: PasskeyAssertion): string {
  if (typeof assertion.id !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(assertion.id)) {
    throw new Error("the passkey did not identify its credential");
  }
  return assertion.id;
}

function envelopeFor(material: ServerUnlockMaterial, credentialId: string): string | null {
  // Only unlabelled pre-upgrade envelopes are a fallback. Never select another
  // credential's envelope or create a new vault key when the existing one fails.
  return material.credentials?.find((entry) => entry.credentialId === credentialId)?.wrapped ?? material.wrapped;
}

export function createDeviceVault(deps: DeviceVaultDeps): DeviceVault {
  async function material(method: VaultMethod): Promise<ServerUnlockMaterial> {
    const response = await deps.fetch(`${UNLOCK_MATERIAL_BASE}/${method}`, { credentials: "same-origin" });
    if (!response.ok) throw new Error("vault unlock material is unavailable on this device");
    return (await response.json()) as ServerUnlockMaterial;
  }

  async function save(vaultKey: Uint8Array<ArrayBuffer>, body: { method: VaultMethod; wrapped: string; params?: Record<string, unknown> }): Promise<void> {
    const current = await material(body.method);
    const proof = await createVaultProof(vaultKey, current.proof, body);
    const response = await deps.fetch(UNLOCK_METHOD_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, proof }),
      credentials: "same-origin",
    });
    if (response.status === 403 || response.status === 409) {
      let code: unknown = null;
      try {
        code = ((await response.json()) as { error?: unknown }).error;
      } catch {
        code = null;
      }
      if (code === "step_up_required") throw new StepUpRequiredError();
      if (code === "vault_unlock_required" || code === "vault_setup_conflict") throw new VaultPossessionError("Unlock the existing vault before changing its unlock methods.");
      if (code === "vault_proof_upgrade_required") throw new Error("This vault needs a security upgrade before its unlock methods can change. Your existing unlock methods still work.");
    }
    if (!response.ok) throw new Error("could not save the vault unlock method");
  }

  async function postStepUp(step: "begin" | "finish", body?: unknown): Promise<Response> {
    const response = await deps.fetch(`${STEP_UP_BASE}/${step}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("we couldn't check it's you");
    return response;
  }

  async function unlockWithPasskey(opts: { createIfMissing: boolean }) {
    const passkey = await material("passkey_prf");
    const assertion = await deps.startAuthentication({ optionsJSON: passkey.options });
    const prf = prfOutputOf(assertion);
    if (prf === null) throw new Error("this passkey can't unlock your vault");
    const credentialId = credentialIdOf(assertion);
    const wrappingKey = await deriveWrappingKeyFromPrf(prf);

    const wrapped = envelopeFor(passkey, credentialId);
    if (wrapped != null) {
      return { vaultKey: await unwrapVaultKey(wrappingKey, wrapped), created: false };
    }
    if (passkey.proof.mode !== "enroll") throw new Error("Unlock your existing vault with another method, then add this passkey.");
    if (!opts.createIfMissing || !deps.createVaultKey) throw new Error("there is no vault to unlock yet");

    // First use: create the vault key and save it sealed under this passkey. The save is
    // insert-only, so if another tab or device set the vault up a moment ago the server
    // refuses ours — then adopt THEIR key (sealed under the same passkey) instead of
    // leaving two vault keys behind.
    const vaultKey = deps.createVaultKey() as Uint8Array<ArrayBuffer>;
    try {
      await save(vaultKey, { method: "passkey_prf", wrapped: await wrapVaultKey(wrappingKey, vaultKey), params: { credentialId } });
      return { vaultKey, created: true };
    } catch (error) {
      if (!(error instanceof StepUpRequiredError) && !(error instanceof VaultPossessionError)) throw error;
      const winner = await material("passkey_prf");
      const winnerWrapped = envelopeFor(winner, credentialId);
      if (winnerWrapped == null) throw error;
      return { vaultKey: await unwrapVaultKey(wrappingKey, winnerWrapped), created: false };
    }
  }

  async function unlockWithPassphrase(passphrase: string, opts = { createIfMissing: false }) {
    let stored = await material("passphrase");
    if (stored.wrapped == null) {
      if (!opts.createIfMissing || stored.proof.mode !== "enroll" || !deps.createVaultKey) {
        throw new Error("No vault passphrase is set. Unlock your existing vault with another method.");
      }
      if (passphrase.length < 12) throw new Error("Choose a vault passphrase with at least 12 characters.");
      const vaultKey = deps.createVaultKey() as Uint8Array<ArrayBuffer>;
      try {
        await savePassphrase(vaultKey, passphrase);
        return vaultKey;
      } catch (error) {
        vaultKey.fill(0);
        if (!(error instanceof StepUpRequiredError) && !(error instanceof VaultPossessionError)) throw error;
        stored = await material("passphrase");
        if (stored.wrapped == null) throw error;
      }
    }
    const salt = stored.params?.salt;
    if (typeof salt !== "string") throw new Error("No vault passphrase is set.");
    const wrappingKey = await deriveWrappingKeyFromPassphrase(passphrase, base64ToBytes(salt));
    return unwrapVaultKey(wrappingKey, stored.wrapped);
  }

  async function unlockWithPhrase(phrase: string) {
    const stored = await material("recovery");
    if (stored.wrapped == null) throw new Error("no vault recovery phrase is set");
    return unlockWithRecoveryPhrase(phrase, stored.wrapped);
  }

  async function hasRecoveryPhrase() {
    return (await material("recovery")).wrapped != null;
  }

  async function saveRecoveryPhrase(vaultKey: Uint8Array<ArrayBuffer>, phrase: string) {
    await save(vaultKey, { method: "recovery", wrapped: await wrapVaultKeyWithRecoveryPhrase(phrase, vaultKey) });
  }

  async function savePassphrase(vaultKey: Uint8Array<ArrayBuffer>, passphrase: string) {
    const salt = crypto.getRandomValues(new Uint8Array(PASSPHRASE_SALT_BYTES));
    const wrappingKey = await deriveWrappingKeyFromPassphrase(passphrase, salt);
    await save(vaultKey, {
      method: "passphrase",
      wrapped: await wrapVaultKey(wrappingKey, vaultKey),
      params: { salt: toBase64(salt) },
    });
  }

  // One passkey prompt does both jobs: it signs the step-up challenge (replacing the
  // passkey envelope is a security change) and, through the PRF extension evaluated with
  // the person's vault salt, yields this passkey's wrapping key. The PRF output is
  // stripped before the assertion is posted — it never reaches the server.
  async function adoptPasskey(vaultKey: Uint8Array<ArrayBuffer>): Promise<AdoptOutcome> {
    const passkey = await material("passkey_prf");
    const begin = await postStepUp("begin");
    const { options } = (await begin.json()) as { options?: Record<string, unknown> & { extensions?: object } };
    if (options === undefined) throw new Error("we couldn't check it's you");
    const optionsJSON = {
      ...options,
      extensions: { ...(options.extensions ?? {}), prf: passkey.options?.extensions?.prf },
    };
    const assertion = await deps.startAuthentication({ optionsJSON });
    const { clientExtensionResults: _results, ...signed } = assertion;
    await postStepUp("finish", { authenticationResponse: { ...signed, clientExtensionResults: {} } });

    const prf = prfOutputOf(assertion);
    if (prf === null) return "unsupported";
    const credentialId = credentialIdOf(assertion);
    const wrappingKey = await deriveWrappingKeyFromPrf(prf);

    const wrapped = envelopeFor(passkey, credentialId);
    if (wrapped != null) {
      try {
        if (sameBytes(await unwrapVaultKey(wrappingKey, wrapped), vaultKey)) return "unchanged";
      } catch {
        // Sealed under a different passkey: re-seal under this one below.
      }
    }
    await save(vaultKey, { method: "passkey_prf", wrapped: await wrapVaultKey(wrappingKey, vaultKey), params: { credentialId } });
    return "adopted";
  }

  return {
    unlockWithPasskey,
    unlockWithPassphrase,
    unlockWithRecoveryPhrase: unlockWithPhrase,
    hasRecoveryPhrase,
    saveRecoveryPhrase,
    savePassphrase,
    adoptPasskey,
  };
}
