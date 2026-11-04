// E06-S06 — per-agent access keys (`src/server/oauth/access-key.ts`).
//
// RED-first: `./access-key` does not exist yet, so importing it throws — every test
// here fails at import until the builder writes the module. That absence IS the point
// of test-first; do not implement anything to make these pass.
//
// Access keys are the static-Bearer credential Warthog issues to a platform that
// cannot complete the OAuth sign-in/consent flow (xAI API, Llama Stack): a
// `wh_ak_` + 32 base62 bytes value, SHOWN ONCE at issue, STORED only as a hash, that
// VERIFIES as a bearer (resolves to the one connection it binds to) and can be
// REVOKED or REPLACED — the same per-agent, per-connection model as OAuth tokens
// (design §6.1; constitution: access keys stored only as hashes; brief: "revoke or
// replace the key later from that agent's page").
//
// These tests pin BEHAVIOUR (what the module RETURNS, what later VERIFIES, and what
// stops verifying after a revoke/replace), never the source text of any module — a
// later rename that preserves behaviour must not redden them. "Stored hashed" is
// proven behaviourally: the module can verify the raw key it just handed out, yet the
// RAW key is not the stored natural key (`resolveAccessKey(raw)` finds nothing) — so
// what was persisted is a derived (hashed) form, proven WITHOUT pinning the hash
// algorithm (the constitution permits SHA-256 or HMAC).
//
// The contract this task defines (the builder implements exactly this):
//
//   issueAccessKey(db, { connectionId }, { random }): Promise<{ key: string }>
//     • mints `wh_ak_` + 32 base62 bytes, stores it only as a hash bound to
//       `connectionId`, and returns the RAW key once (`key`) — the one time it is
//       ever shown.
//   verifyAccessKey(db, presentedKey): Promise<{ connectionId: string } | null>
//     • a presented raw key resolves to its connection (verifies as a bearer), or
//       null when it matches no stored key.
//   revokeAccessKey(db, { connectionId }): Promise<void>
//     • deletes the connection's access key(s) so they no longer verify; other
//       connections are untouched.
//   replaceAccessKey(db, { connectionId }, { random }): Promise<{ key: string }>
//     • revokes the connection's current key and issues a fresh one; the old key no
//       longer verifies and the new key verifies to the same connection.
//
// `connectionId` is an OPAQUE uuid here (the connections table lands in a later
// migration, E09-S05), exactly as E06-S01's store treats it; access keys have no
// expiry, so the module needs no clock.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { issueAccessKey, verifyAccessKey, revokeAccessKey, replaceAccessKey } from "./access-key";
import { resolveAccessKey } from "./store";
import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";

// The key prefix every access key carries (design §6.1), kept here so the tests read
// the suffix without re-typing the literal.
const PREFIX = "wh_ak_";

// The randomness seam the module draws entropy from. Real entropy (not a fixed fake)
// so two successive keys differ — a fixed source would make every minted key identical
// and hide that each issue is a distinct, high-entropy secret.
const deps = { random: systemRandom };

// --- The issued key: wh_ak_ + 32 base62 bytes, shown once ---------------------------

test("issueAccessKey mints a wh_ak_ key whose suffix is base62 with at least 32 bytes of entropy", async () => {
  const db = await freshDb();
  try {
    const { key } = await issueAccessKey(db, { connectionId: randomUUID() }, deps);

    assert.ok(key.startsWith(PREFIX), `the key is prefixed ${PREFIX} (got "${key.slice(0, 8)}…")`);
    const suffix = key.slice(PREFIX.length);
    // base62 alphabet only — digits and letters, no URL/base64 punctuation (`-_+/=`).
    assert.match(suffix, /^[0-9A-Za-z]+$/, "the suffix is base62: digits and letters only, no punctuation");
    // 32 bytes of randomness floor (a char-per-byte mapping gives 32 chars; a base62
    // encoding of 32 bytes gives more) — asserted as a lower bound so either reading
    // of "32 base62 bytes" passes, and a short / low-entropy suffix fails.
    assert.ok(suffix.length >= 32, `the suffix carries >= 32 bytes of entropy (got length ${suffix.length})`);
  } finally {
    await db.close();
  }
});

test("each issued key is distinct (every issue is its own high-entropy secret)", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const a = (await issueAccessKey(db, { connectionId }, deps)).key;
    const b = (await issueAccessKey(db, { connectionId }, deps)).key;
    assert.notEqual(a, b, "two issued access keys must not collide");
  } finally {
    await db.close();
  }
});

// --- Shown once, stored hashed, verifies as a bearer --------------------------------

test("a freshly issued key verifies as a bearer, resolving to its connection", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const { key } = await issueAccessKey(db, { connectionId }, deps);

    const verified = await verifyAccessKey(db, key);
    assert.ok(verified != null, "the issued key verifies");
    assert.equal(verified?.connectionId, connectionId, "it resolves to the connection it was issued for");
  } finally {
    await db.close();
  }
});

test("the key is stored only as a hash: the raw key is not the stored natural key", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const { key } = await issueAccessKey(db, { connectionId }, deps);

    // The module can verify the raw key it just handed out...
    assert.equal(
      (await verifyAccessKey(db, key))?.connectionId,
      connectionId,
      "the module re-derives the stored form to verify the raw key",
    );
    // ...yet the RAW key resolves nothing in the store — what was persisted is a
    // derived (hashed) form, not the plaintext. Together these prove "stored hashed"
    // without pinning the hash algorithm.
    assert.equal(
      await resolveAccessKey(db, key),
      null,
      "the raw key is not the stored key — only its hash is persisted",
    );
  } finally {
    await db.close();
  }
});

test("verifyAccessKey rejects an unknown key and a tampered key", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const { key } = await issueAccessKey(db, { connectionId }, deps);

    // A key that was never issued matches nothing.
    assert.equal(
      await verifyAccessKey(db, `${PREFIX}${randomUUID().replace(/-/g, "")}neverIssued`),
      null,
      "a never-issued key does not verify",
    );

    // A one-character tweak of a valid key hashes differently, so it no longer matches.
    const tampered = key.slice(0, -1) + (key.at(-1) === "a" ? "b" : "a");
    assert.notEqual(tampered, key, "the tampered key differs from the real one");
    assert.equal(await verifyAccessKey(db, tampered), null, "a tampered key does not verify");
  } finally {
    await db.close();
  }
});

test("each key binds to exactly one connection: two keys verify to their own connections", async () => {
  const db = await freshDb();
  try {
    const connA = randomUUID();
    const connB = randomUUID();
    assert.notEqual(connA, connB, "two connections are distinct");
    const keyA = (await issueAccessKey(db, { connectionId: connA }, deps)).key;
    const keyB = (await issueAccessKey(db, { connectionId: connB }, deps)).key;

    assert.equal((await verifyAccessKey(db, keyA))?.connectionId, connA, "key A resolves to connection A");
    assert.equal((await verifyAccessKey(db, keyB))?.connectionId, connB, "key B resolves to connection B");
  } finally {
    await db.close();
  }
});

// --- Revoke -------------------------------------------------------------------------

test("revokeAccessKey stops the connection's key verifying", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const { key } = await issueAccessKey(db, { connectionId }, deps);
    assert.ok((await verifyAccessKey(db, key)) != null, "the key verifies before revocation");

    await revokeAccessKey(db, { connectionId });

    assert.equal(await verifyAccessKey(db, key), null, "the revoked key no longer verifies");
  } finally {
    await db.close();
  }
});

test("revoking one connection's key leaves another connection's key working", async () => {
  const db = await freshDb();
  try {
    const connA = randomUUID();
    const connB = randomUUID();
    const keyA = (await issueAccessKey(db, { connectionId: connA }, deps)).key;
    const keyB = (await issueAccessKey(db, { connectionId: connB }, deps)).key;

    await revokeAccessKey(db, { connectionId: connA });

    assert.equal(await verifyAccessKey(db, keyA), null, "connection A's key is revoked");
    assert.equal(
      (await verifyAccessKey(db, keyB))?.connectionId,
      connB,
      "connection B's key is untouched — revocation is per-connection",
    );
  } finally {
    await db.close();
  }
});

// --- Replace ------------------------------------------------------------------------

test("replaceAccessKey issues a new key and retires the old one", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const { key: oldKey } = await issueAccessKey(db, { connectionId }, deps);
    assert.ok((await verifyAccessKey(db, oldKey)) != null, "the original key verifies before replacement");

    const { key: newKey } = await replaceAccessKey(db, { connectionId }, deps);

    assert.notEqual(newKey, oldKey, "replacement hands back a fresh, distinct key");
    assert.ok(newKey.startsWith(PREFIX), "the replacement key is a wh_ak_ key too");
    assert.equal(await verifyAccessKey(db, oldKey), null, "the old key no longer verifies after replacement");
    assert.equal(
      (await verifyAccessKey(db, newKey))?.connectionId,
      connectionId,
      "the new key verifies to the same connection",
    );
  } finally {
    await db.close();
  }
});

test("a replaced key can itself be revoked", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    await issueAccessKey(db, { connectionId }, deps);
    const { key } = await replaceAccessKey(db, { connectionId }, deps);
    assert.ok((await verifyAccessKey(db, key)) != null, "the replacement key verifies");

    await revokeAccessKey(db, { connectionId });

    assert.equal(await verifyAccessKey(db, key), null, "the replacement key is revocable like any other");
  } finally {
    await db.close();
  }
});
