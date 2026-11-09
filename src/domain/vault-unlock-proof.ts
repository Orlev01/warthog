// Shared, versioned transcript. Sorted JSON keys prevent property insertion order
// from changing a proof; arrays retain their order. No platform-specific crypto.
export interface VaultProofPayload { method: string; wrapped: string; params?: Record<string, unknown> }
export interface VaultProofChallenge { challenge: string; mode: "enroll" | "prove" | "legacy" }
export interface VaultProof { challenge: string; mac: string; verifier?: string }

export function vaultProofTranscript(challenge: string, body: VaultProofPayload): string {
  function canonical(value: unknown, depth = 0): string {
    if (depth > 16) throw new Error("Vault parameters are too deeply nested");
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
    if (typeof value === "object" && value !== null) {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`).join(",")}}`;
    }
    throw new Error("Vault parameters must be JSON values");
  }
  return canonical(["warthog.vault-unlock-proof.v1", challenge, body.method, body.wrapped, body.params ?? {}]);
}
