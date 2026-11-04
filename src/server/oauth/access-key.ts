// E06-S06 — per-agent access keys (design §6.1).
//
// Access keys are the static-Bearer credential Warthog issues to a platform that
// cannot complete the OAuth sign-in/consent flow (xAI API, Llama Stack): a `wh_ak_` +
// 32 base62 bytes value, SHOWN ONCE at issue and STORED only as a hash, that VERIFIES
// as a bearer (resolves to the one connection it binds to) and can be REVOKED or
// REPLACED — the same per-agent, per-connection model OAuth tokens use.
//
// The raw key is returned once, in the issue response, and never persisted: only its
// SHA-256 hash is stored (constitution: access keys are stored only as hashes), the
// same hashing contract tokens are kept under. The hash is the store's natural key, so
// looking the plaintext up finds nothing — what was persisted is a derived form.
//
// `connectionId` is an OPAQUE uuid here (the connections table lands in a later
// migration, E09-S05), exactly as the store and the token seam treat it. Access keys
// have no expiry — they are retired by revoke/replace — so this module needs no clock.

import { createHash } from "node:crypto";

import { createAccessKey, resolveAccessKey } from "./store";
import type { Db } from "../db/index";
import type { Random } from "../seams/random";

// The prefix every access key carries (design §6.1): a platform-visible marker that a
// credential is a Warthog per-agent access key.
const PREFIX = "wh_ak_";

// base62 alphabet — digits and letters only, no URL/base64 punctuation (`-_+/=`), so
// the key pastes into any Authorization header or config field without escaping.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 32 bytes of entropy, each rendered as one base62 character: a 32-char high-entropy
// suffix (design §6.1: `wh_ak_` + 32 base62 bytes).
const KEY_ENTROPY_BYTES = 32;

// The seams the access-key operations draw on: a randomness source for the secret
// (access keys have no expiry, so no clock is needed).
export interface AccessKeyDeps {
  readonly random: Random;
}

// SHA-256 hex of a value — how a key is addressed in storage (never the raw value),
// the same contract tokens are stored under (design §6.1).
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Mint a `wh_ak_` + 32 base62 bytes key from the randomness seam: each of the 32 random
// bytes maps to one base62 character, so every issue is a distinct, high-entropy secret.
function mintAccessKey(random: Random): string {
  const bytes = random.randomBytes(KEY_ENTROPY_BYTES);
  let suffix = "";
  for (const byte of bytes) suffix += BASE62.charAt(byte % BASE62.length);
  return PREFIX + suffix;
}

// Issue a fresh access key for a connection: mint it, store ONLY its hash bound to the
// connection, and return the RAW key once — the single time it is ever shown.
export async function issueAccessKey(
  db: Db,
  { connectionId }: { connectionId: string },
  { random }: AccessKeyDeps,
): Promise<{ key: string }> {
  const key = mintAccessKey(random);
  await createAccessKey(db, { keyHash: sha256Hex(key), connectionId });
  return { key };
}

// Verify a presented raw key as a bearer: re-derive its stored hash and resolve it to
// the one connection it binds to, or null when it matches no stored key.
export async function verifyAccessKey(
  db: Db,
  presentedKey: string,
): Promise<{ connectionId: string } | null> {
  const stored = await resolveAccessKey(db, sha256Hex(presentedKey));
  return stored ? { connectionId: stored.connectionId } : null;
}

// Revoke a connection's access key(s): delete them so they no longer verify. Scoped to
// the one connection (`connection_id` bound as a parameter), so other connections' keys
// are untouched. `oauth_access_keys` is not an activity table, so DELETE is fine.
export async function revokeAccessKey(
  db: Db,
  { connectionId }: { connectionId: string },
): Promise<void> {
  await db.query("DELETE FROM oauth_access_keys WHERE connection_id = $1::uuid", [connectionId]);
}

// Replace a connection's access key: revoke the current key(s) and issue a fresh one,
// so the old key stops verifying and the new key verifies to the same connection.
export async function replaceAccessKey(
  db: Db,
  { connectionId }: { connectionId: string },
  deps: AccessKeyDeps,
): Promise<{ key: string }> {
  await revokeAccessKey(db, { connectionId });
  return issueAccessKey(db, { connectionId }, deps);
}
