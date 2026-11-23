// The in-process cache of unwrapped data keys (design §4.1: "Unwrapped DEKs are cached in
// process memory for at most 5 minutes"). Every page, action and agent request finds the
// person's DEK by unwrapping `users.wrapped_dek`, and in production each unwrap is one Key
// Vault operation against a quota every person shares (review 2026-11-23, High). The cache
// sits in front of the KeyWrapper's unwrap, so every caller benefits without changing.
//
// An entry is keyed by a domain-separated SHA-256 of the WRAPPED value itself, so the cache
// is a memo of a deterministic function: one wrapped value always unwraps to the same DEK.
// A new key, or the same key re-wrapped under a new vault key version, is a different
// wrapped value and so a fresh unwrap; a cached DEK is never served for a wrapped value it
// did not come from, and a rotation needs no invalidation.
//
//   • The TTL counts from the unwrap and is never extended by use, so a DEK is in memory at
//     most 5 minutes after Key Vault returned it. Eviction is active, as in the release
//     store: each entry arms an unref'd timer, and every call sweeps what is past its window.
//   • At most `maxEntries` keys are held; when full, the oldest goes first.
//   • The cache keeps its own copy and hands every caller a fresh one (callers zero their key
//     after use); the inner wrapper's buffer and a dropped entry are zeroed.
//   • A failed unwrap is never cached. `forget(wrapped)` drops one key now (account
//     deletion); an unwrap that was in flight across a forget is not stored.
//   • Nothing here logs. A DEK leaves this module only as the caller's copy.

import { createHash } from "node:crypto";

import type { KeyWrapper } from "./key-wrapper";
import { timerEviction, type ScheduleEviction } from "./release-store";
import { systemClock, type Clock } from "../seams/clock";
import { processSingleton } from "../seams/process-singleton";

// The design allows at most 5 minutes (§4.1).
export const DEK_CACHE_TTL_MS = 5 * 60 * 1000;
// Far above the people active in any 5 minutes at v1 scale; 32 bytes plus a key each.
const MAX_ENTRIES = 1000;

export interface DekCache {
  // The DEK `wrapped` unwraps to: the cached copy within the TTL, else `inner(wrapped)`.
  unwrap(wrapped: string, inner: (wrapped: string) => Promise<Uint8Array>): Promise<Uint8Array>;
  // Drop the key `wrapped` unwraps to, now.
  forget(wrapped: string): void;
  // How many keys are held (expired ones are swept first).
  size(): number;
}

export interface DekCacheOptions {
  readonly clock: Clock;
  readonly schedule?: ScheduleEviction;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface Entry {
  readonly dek: Uint8Array;
  readonly at: number; // when it was unwrapped, read through the clock
  cancelEviction: () => void;
}

// The entry key for a wrapped value. Domain-separated so it never equals another hash of
// the same value.
function keyOf(wrapped: string): string {
  return createHash("sha256").update("warthog/dek-cache/v1\u0000").update(wrapped, "utf8").digest("base64url");
}

export function createDekCache(options: DekCacheOptions): DekCache {
  const { clock } = options;
  const schedule = options.schedule ?? timerEviction;
  const ttlMs = options.ttlMs ?? DEK_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  // Map order is insertion order, which (with one TTL for all) is expiry order.
  const entries = new Map<string, Entry>();
  // Bumped by every forget, so an unwrap that was in flight across one is not stored.
  let forgets = 0;

  function drop(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entry.cancelEviction();
    entry.dek.fill(0);
    entries.delete(key);
  }

  function sweep(): void {
    const now = clock.now().getTime();
    for (const [key, entry] of entries) {
      if (now - entry.at >= ttlMs) drop(key);
    }
  }

  function store(key: string, dek: Uint8Array): void {
    drop(key);
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
    const entry: Entry = { dek, at: clock.now().getTime(), cancelEviction: () => {} };
    entry.cancelEviction = schedule(() => {
      // Only ever evict THIS entry, never a newer one stored under the same key.
      if (entries.get(key) === entry) drop(key);
    }, ttlMs);
    entries.set(key, entry);
  }

  return {
    async unwrap(wrapped, inner) {
      sweep();
      const key = keyOf(wrapped);
      const hit = entries.get(key);
      if (hit) return Uint8Array.from(hit.dek);
      const started = forgets;
      const raw = await inner(wrapped);
      const kept = Uint8Array.from(raw);
      raw.fill(0);
      if (forgets === started) store(key, Uint8Array.from(kept));
      return kept;
    },
    forget(wrapped) {
      forgets += 1;
      drop(keyOf(wrapped));
    },
    size() {
      sweep();
      return entries.size;
    },
  };
}

// A KeyWrapper whose unwrap goes through `cache`; wrapping is the inner wrapper's own.
export function cachedKeyWrapper(inner: KeyWrapper, cache: DekCache): KeyWrapper {
  return {
    wrap: (dek) => inner.wrap(dek),
    unwrap: (wrapped) => cache.unwrap(wrapped, (value) => inner.unwrap(value)),
  };
}

// The process-wide cache the production Key Vault wrapper uses, on globalThis so Next's split
// module graphs share one (and account deletion forgets from the same one pages read).
export function processDekCache(): DekCache {
  return processSingleton("crypto.dekCache", () => createDekCache({ clock: systemClock }));
}
