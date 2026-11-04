// The randomness seam. Everything that needs entropy (codes, tokens, nonces,
// session ids) draws bytes through a Random rather than calling the crypto
// library directly, so tests can inject a deterministic fake.

import { randomBytes as nodeRandomBytes } from "node:crypto";

export interface Random {
  randomBytes(n: number): Uint8Array;
}

// The real source: draws n bytes of cryptographic entropy.
export const systemRandom: Random = {
  randomBytes(n: number): Uint8Array {
    return nodeRandomBytes(n);
  },
};

// A deterministic fake: every byte of every draw is the given value.
export function fixedRandom(value: number): Random {
  return {
    randomBytes(n: number): Uint8Array {
      return new Uint8Array(n).fill(value);
    },
  };
}
