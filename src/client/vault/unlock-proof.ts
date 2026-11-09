import { vaultProofTranscript, type VaultProofPayload, type VaultProofChallenge, type VaultProof } from "../../domain/vault-unlock-proof";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function deriveVaultVerifier(vaultKey: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (vaultKey.length !== 32) throw new Error("Invalid vault key");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", vaultKey, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256",
    salt: encoder.encode("warthog.vault-unlock-proof.v1"), info: encoder.encode("verification-key") }, key, 256));
}

export async function createVaultProof(vaultKey: Uint8Array<ArrayBuffer>, challenge: VaultProofChallenge, body: VaultProofPayload): Promise<VaultProof> {
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge.challenge)) throw new Error("Vault unlock proof is unavailable. Reload and try again.");
  if (challenge.mode === "legacy") throw new Error("This vault needs a security upgrade before its unlock methods can change. Your existing unlock methods still work.");
  if (challenge.mode !== "enroll" && challenge.mode !== "prove") throw new Error("Unknown vault proof version");
  const verifier = await deriveVaultVerifier(vaultKey);
  try {
    const key = await crypto.subtle.importKey("raw", verifier, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(vaultProofTranscript(challenge.challenge, body))));
    return { challenge: challenge.challenge, mac: base64url(mac), ...(challenge.mode === "enroll" ? { verifier: base64url(verifier) } : {}) };
  } finally { verifier.fill(0); }
}
