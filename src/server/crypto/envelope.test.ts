// E01-S07 — per-person DEK envelope encryption (`src/server/crypto/envelope.ts`).
//
// These tests are RED-first: the module does not exist yet. They pin BEHAVIOUR
// (what encrypt/decrypt do with bytes and AAD), never the source text of the module.
//
// Every personal-content column is encrypted with the person's DEK using
// AES-256-GCM with a random 96-bit nonce and a `v1:` versioned envelope (design
// §4.1). The associated data (AAD) binds a ciphertext to its exact row — the
// table name, the column name and the row id — so an envelope lifted into a
// different row/column/table fails to decrypt.
//
// The contract this task's tests define:
//   encrypt(dek, table, column, rowId, plaintext) -> envelope (a storable string)
//     • AES-256-GCM under the 256-bit DEK, random nonce, `v1:` versioned envelope,
//       AAD = (table, column, rowId).
//   decrypt(dek, table, column, rowId, envelope) -> plaintext
//     • round-trips the exact plaintext under the same DEK + AAD;
//     • throws if the DEK, any AAD component, or the ciphertext differs/was altered.
//
// encrypt/decrypt are awaited everywhere so these tests pass whether an
// implementation is sync or async. Tests use only node:crypto for the DEK bytes
// and never touch the network, Azure or a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { encrypt, decrypt } from "./envelope";

const DEK_BYTES = 32; // a 256-bit per-person data key

function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A plaintext with hyphens: the hyphen is NOT in the base64 alphabet, so if the
// whole string ever appears verbatim in the (base64) envelope it was not encrypted.
const SECRET = "SECRET-SAUCE-0007-do-not-leak";

// Change exactly one character in the middle of the envelope. For AES-GCM this
// corrupts the ciphertext or its integrity tag, so decrypt must reject rather
// than return different bytes.
function tamper(envelope: string): string {
  assert.ok(envelope.length > 0, "cannot tamper with an empty envelope");
  const i = Math.floor(envelope.length / 2);
  const replacement = envelope[i] === "A" ? "B" : "A";
  return envelope.slice(0, i) + replacement + envelope.slice(i + 1);
}

// Robust across sync-throw and async-reject implementations: the async wrapper
// turns a synchronous throw into a rejection, and a non-throwing return into a
// resolution (which assert.rejects then fails on, as intended).
async function assertDecryptRejects(
  dek: Uint8Array,
  table: string,
  column: string,
  rowId: string,
  envelope: string,
  message: string,
): Promise<void> {
  await assert.rejects(async () => {
    await decrypt(dek, table, column, rowId, envelope);
  }, message);
}

// --- AC: encrypt produces a v1 versioned envelope with a random nonce ---

test("encrypt produces a non-empty, storable, v1-versioned envelope string", async () => {
  const dek = freshDek();

  const envelope = await encrypt(dek, "memories", "body", "row-1", SECRET);

  assert.equal(typeof envelope, "string", "the envelope is a storable string");
  assert.ok(envelope.length > 0, "the envelope is non-empty");
  assert.ok(
    envelope.startsWith("v1"),
    `the envelope must carry its version marker, saw: ${envelope.slice(0, 8)}`,
  );
});

test("encrypt does not leak the plaintext into the envelope", async () => {
  const dek = freshDek();

  const envelope = await encrypt(dek, "memories", "body", "row-1", SECRET);

  assert.ok(
    !envelope.includes(SECRET),
    "the plaintext must not appear in clear inside the envelope",
  );
});

test("encrypt uses a random nonce: the same inputs produce different envelopes that both decrypt", async () => {
  const dek = freshDek();

  const a = await encrypt(dek, "memories", "body", "row-1", SECRET);
  const b = await encrypt(dek, "memories", "body", "row-1", SECRET);

  assert.notEqual(a, b, "a random nonce must make repeat encryptions differ");
  assert.equal(await decrypt(dek, "memories", "body", "row-1", a), SECRET);
  assert.equal(await decrypt(dek, "memories", "body", "row-1", b), SECRET);
});

// --- AC: decrypt round-trips the plaintext under the same DEK + AAD ---

test("decrypt round-trips the exact plaintext under the same DEK and AAD", async () => {
  const dek = freshDek();

  const envelope = await encrypt(dek, "memories", "body", "row-42", SECRET);
  const back = await decrypt(dek, "memories", "body", "row-42", envelope);

  assert.equal(back, SECRET, "the recovered plaintext equals the original");
});

test("decrypt round-trips an empty string", async () => {
  const dek = freshDek();

  const envelope = await encrypt(dek, "preferences", "value", "row-7", "");
  const back = await decrypt(dek, "preferences", "value", "row-7", envelope);

  assert.equal(back, "", "an empty personal-content value still round-trips");
});

test("decrypt round-trips a multi-line, unicode plaintext", async () => {
  const dek = freshDek();
  const plaintext = "line one\nlínea dos — 🦟\tt鍵";

  const envelope = await encrypt(dek, "activity", "details", "row-9", plaintext);
  const back = await decrypt(dek, "activity", "details", "row-9", envelope);

  assert.equal(back, plaintext, "non-ASCII content round-trips byte-for-byte");
});

test("many distinct values round-trip under one DEK", async () => {
  const dek = freshDek();
  for (let i = 0; i < 10; i += 1) {
    const plaintext = `memory #${i}: ${randomBytes(8).toString("hex")}`;
    const rowId = `row-${i}`;
    const back = await decrypt(
      dek,
      "memories",
      "body",
      rowId,
      await encrypt(dek, "memories", "body", rowId, plaintext),
    );
    assert.equal(back, plaintext);
  }
});

// --- AC: decrypt with a different AAD throws (the AAD binds ciphertext to its row) ---

test("decrypt rejects when the table differs from the one it was encrypted with", async () => {
  const dek = freshDek();
  const envelope = await encrypt(dek, "memories", "body", "row-1", SECRET);

  await assertDecryptRejects(
    dek,
    "tasks", // different table
    "body",
    "row-1",
    envelope,
    "an envelope must not decrypt under a different table (AAD mismatch)",
  );
});

test("decrypt rejects when the column differs from the one it was encrypted with", async () => {
  const dek = freshDek();
  const envelope = await encrypt(dek, "memories", "body", "row-1", SECRET);

  await assertDecryptRejects(
    dek,
    "memories",
    "title", // different column
    "row-1",
    envelope,
    "an envelope must not decrypt under a different column (AAD mismatch)",
  );
});

test("decrypt rejects when the rowId differs from the one it was encrypted with", async () => {
  const dek = freshDek();
  const envelope = await encrypt(dek, "memories", "body", "row-1", SECRET);

  await assertDecryptRejects(
    dek,
    "memories",
    "body",
    "row-2", // different row id
    envelope,
    "an envelope must not decrypt under a different row id (AAD mismatch)",
  );
});

// --- AC: decrypt with altered ciphertext throws (never returns garbage) ---

test("decrypt rejects an altered envelope instead of returning garbage", async () => {
  const dek = freshDek();
  const envelope = await encrypt(dek, "memories", "body", "row-1", SECRET);

  await assertDecryptRejects(
    dek,
    "memories",
    "body",
    "row-1",
    tamper(envelope),
    "a one-character change to the envelope must be rejected, never silently decrypted",
  );
});

test("decrypt rejects an envelope encrypted under a different DEK", async () => {
  const dekA = freshDek();
  const dekB = freshDek();
  const envelope = await encrypt(dekA, "memories", "body", "row-1", SECRET);

  await assertDecryptRejects(
    dekB,
    "memories",
    "body",
    "row-1",
    envelope,
    "decrypting under the wrong DEK must fail, never return garbage bytes",
  );
});
