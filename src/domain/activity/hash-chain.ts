// E03-S03 — Activity hash chain (design §9).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// A SHA-256 over in-memory bytes is pure computation, so the tamper-evident
// linkage of the activity record belongs here. The integrity check recomputes
// the chain over the stored ciphertext (`payload_ct`) without ever decrypting
// it: `entry_hash = SHA-256(prev_hash ‖ canonical(all other fields))`.

import { createHash } from "node:crypto";

/**
 * The hashed content of one activity entry — the columns the hash covers
 * (everything except `prev_hash` and `entry_hash` themselves). Modelled loosely
 * here; the real column set is the data layer's.
 */
export type Fields = Record<string, string | number>;

/** One link of the chain, carrying everything needed to re-verify it. */
export interface ChainEntry {
  seq: number;
  prevHash: string;
  entryHash: string;
  fields: Fields;
}

/** The result of walking a chain: intact, or broken at the first failing seq. */
export type VerifyResult = { intact: true } | { intact: false; brokenSeq: number };

/**
 * A canonical encoding of `fields` that does not depend on key insertion order:
 * keys are sorted, then each key and its value are emitted with their lengths so
 * no two distinct field sets can collide on the same byte sequence.
 */
function canonical(fields: Fields): string {
  const keys = Object.keys(fields).sort();
  let out = "";
  for (const key of keys) {
    const value = String(fields[key]);
    out += `${key.length}:${key}=${value.length}:${value};`;
  }
  return out;
}

/**
 * `entryHash(prevHash, fields)` — SHA-256, as a hex digest, over `prevHash`
 * followed by a canonical encoding of `fields`. Pure and deterministic: the same
 * content always hashes the same, however the `fields` object was built or
 * re-read, and any change to `prevHash` or any field value changes the digest.
 */
export function entryHash(prevHash: string, fields: Fields): string {
  return createHash("sha256")
    .update(`${prevHash.length}:${prevHash}|${canonical(fields)}`)
    .digest("hex");
}

/**
 * Walks `entries` in the order given and returns whether the chain is intact.
 * An entry verifies when (a) its stored `entryHash` recomputes from
 * (`prevHash`, `fields`) and (b) its `prevHash` equals the previous entry's
 * `entryHash`. The first entry's `prevHash` is the chain anchor, accepted as
 * given. The first entry that fails is reported via `brokenSeq`.
 */
export function verifyChain(entries: readonly ChainEntry[]): VerifyResult {
  let prevEntryHash: string | undefined;
  for (const entry of entries) {
    if (prevEntryHash !== undefined && entry.prevHash !== prevEntryHash) {
      return { intact: false, brokenSeq: entry.seq };
    }
    if (entry.entryHash !== entryHash(entry.prevHash, entry.fields)) {
      return { intact: false, brokenSeq: entry.seq };
    }
    prevEntryHash = entry.entryHash;
  }
  return { intact: true };
}
