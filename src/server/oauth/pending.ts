// E10-S12 — the server-side pending-authorization store (design §6.1; brief
// "Agent consent screen").
//
// Consent now happens FIRST: a signed-in, valid `/oauth/authorize` request is no
// longer issued a code outright. `beginAuthorization` carries the whole authorize
// request HERE — server-side, under an opaque handle — and sends the person to the
// internal `/oauth/consent` screen. The GET route puts the handle in a host-locked
// cookie (never a URL/form field), so the consent page and the consent decision read
// the request back from this store by its handle and NEVER trust a form value.
//
// The store is the release-store pattern: a process-wide Map keyed by a full-entropy
// handle, held through `processSingleton` so every module graph Next builds (route,
// page, action) resolves the same one. Nothing is written to the database — a pending
// request is transient state that lives only until the person decides. The handle is
// unguessable, so a wrong or forged handle resolves to nothing.

import { processSingleton } from "../seams/process-singleton";
import type { Random } from "../seams/random";

// 256 bits of entropy, rendered as hex — the same opaque-bearer shape codes and
// sessions use, so a handle is unguessable and never collides across callers.
const HANDLE_ENTROPY_BYTES = 32;

// A pending authorize request held server-side: the agent's whole OAuth query,
// carried through to the consent screen and the decision verbatim.
export interface PendingAuthorization {
  readonly params: URLSearchParams;
}

// The process-wide store (the release-store pattern). Held through processSingleton
// (globalThis) so route handlers, pages and actions — which Next bundles into
// separate module graphs — all share the one Map.
// A request waiting on the consent screen lives for ten minutes; an abandoned one is pruned
// and can never be approved late (operator review of E10-S12).
export const PENDING_TTL_MS = 10 * 60 * 1000;

// At most this many requests wait on the consent screen at once, process-wide; past it
// the OLDEST is dropped (review fix: the store was unbounded, so one account could grow
// the heap by opening authorize requests). Ample for real use — a request waits only
// while a person is looking at the consent screen.
export const MAX_PENDING_AUTHORIZATIONS = 10_000;

type Entry = { readonly params: URLSearchParams; readonly createdAtMs: number };

const pending = processSingleton(
  "oauth.pendingAuthorizations",
  () => new Map<string, Entry>(),
);

// The time source (injectable for tests; the wall clock in production).
type Now = () => number;
const wallClock: Now = () => Date.now();

// The live entry for a handle, or null once it has expired (expired entries are dropped).
function live(handle: string, now: Now): Entry | null {
  const entry = pending.get(handle);
  if (entry == null) return null;
  if (now() - entry.createdAtMs > PENDING_TTL_MS) {
    pending.delete(handle);
    return null;
  }
  return entry;
}

// Drop expired requests from the front of the store. Entries are kept in insertion
// (= creation) order, so pruning stops at the first live one — amortised O(1) per insert
// rather than a scan of the whole store.
function pruneExpired(now: Now): void {
  for (const key of pending.keys()) {
    if (live(key, now) != null) break;
  }
}

// Carry an authorize request into the store and return its opaque handle. A copy of
// the params is stored so a later mutation of the caller's object can't leak in. Expired
// requests are pruned first; if the store is still full, the oldest waiting request is
// dropped to make room (it then reads as expired).
export function putPendingAuthorization(
  params: URLSearchParams,
  random: Random,
  now: Now = wallClock,
): string {
  pruneExpired(now);
  while (pending.size >= MAX_PENDING_AUTHORIZATIONS) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  const handle = Buffer.from(random.randomBytes(HANDLE_ENTROPY_BYTES)).toString("hex");
  pending.set(handle, { params: new URLSearchParams(params), createdAtMs: now() });
  return handle;
}

// Resolve the pending request under a handle WITHOUT consuming it — the consent page
// renders from this, and the person approves afterwards, so rendering must not remove
// the one-time request. An unknown/expired handle resolves to null. A copy of the
// params is returned so a reader cannot mutate the stored request.
export function getPendingAuthorization(handle: string, now: Now = wallClock): PendingAuthorization | null {
  const entry = live(handle, now);
  if (entry == null) return null;
  return { params: new URLSearchParams(entry.params) };
}

// Resolve AND consume the pending request under a handle (single use): the consent
// decision reads it here, so a replayed handle resolves to null the second time and
// creates nothing. An unknown/forged handle resolves to null.
export function consumePendingAuthorization(handle: string, now: Now = wallClock): PendingAuthorization | null {
  const entry = live(handle, now);
  if (entry == null) return null;
  pending.delete(handle);
  return { params: new URLSearchParams(entry.params) };
}

// How many requests are waiting (for the store's bound to be observable in tests).
export function pendingAuthorizationCount(): number {
  return pending.size;
}
