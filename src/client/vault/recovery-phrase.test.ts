// Review fix W1 — the vault recovery phrase (`src/client/vault/recovery-phrase.ts`).
//
// The review found that nothing ever wrapped the vault key (VK) for recovery: a person who
// lost every passkey and set no vault passphrase could never unlock their vault again. The
// operator's decision: the browser generates a VAULT RECOVERY PHRASE when the vault is first
// set up (at least 128 bits, shown in a readable grouped form), wraps VK under a key derived
// from it and saves that envelope as unlock method 'recovery'. The server never sees the
// phrase.
//
// These tests pin behaviour: the phrase's entropy and readable form, the forgiving
// normalisation of a typed or handwritten copy, and that VK wrapped under a phrase unlocks
// with that phrase (however it is typed) and with nothing else — through the real WebCrypto
// primitives.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateRecoveryPhrase,
  normaliseRecoveryPhrase,
  wrapVaultKeyWithRecoveryPhrase,
  unlockWithRecoveryPhrase,
  recoveryPhraseFileText,
} from "./recovery-phrase";
import { createVaultKey } from "./key";
import { unlockVault } from "./unlock";

const BASE32 = /^[A-Z2-7]+$/;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

test("a generated phrase is 8 groups of 4 base32 characters (160 random bits)", () => {
  const phrase = generateRecoveryPhrase();
  assert.match(phrase, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/, `readable grouped form, got ${phrase}`);
  const canonical = phrase.replace(/-/g, "");
  assert.equal(canonical.length, 32, "32 base32 characters carry 160 bits — at least 128");
  assert.match(canonical, BASE32);
});

test("each generated phrase is fresh entropy", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i += 1) seen.add(generateRecoveryPhrase());
  assert.equal(seen.size, 50, "no two phrases coincide");
});

test("normalising accepts lower case, spaces, missing dashes and the look-alike digits 0 and 1", () => {
  const phrase = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567";
  const canonical = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  assert.equal(normaliseRecoveryPhrase(phrase), canonical);
  assert.equal(normaliseRecoveryPhrase(phrase.toLowerCase()), canonical);
  assert.equal(normaliseRecoveryPhrase(` ${phrase.replace(/-/g, " ")}  `), canonical);
  assert.equal(normaliseRecoveryPhrase(canonical), canonical);
  // A handwritten O read back as 0, or I as 1, still matches.
  assert.equal(normaliseRecoveryPhrase("ABCD-EFGH-1JKL-MN0P-QRST-UVWX-YZ23-4567"), canonical);
});

test("normalising refuses a phrase of the wrong length (a typo or the sign-in recovery code)", () => {
  assert.equal(normaliseRecoveryPhrase(""), null);
  assert.equal(normaliseRecoveryPhrase("ABCD-EFGH"), null, "too short");
  assert.equal(normaliseRecoveryPhrase("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), null, "a 26-character sign-in code is not a vault phrase");
  assert.equal(normaliseRecoveryPhrase("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567A"), null, "too long");
});

test("a vault key wrapped under a phrase unlocks with that phrase, however it is typed", async () => {
  const vaultKey = createVaultKey();
  const phrase = generateRecoveryPhrase();
  const wrapped = await wrapVaultKeyWithRecoveryPhrase(phrase, vaultKey);
  assert.match(wrapped, /^v1:/, "a storable versioned envelope");
  assert.ok(!wrapped.includes(phrase.replace(/-/g, "")), "the envelope never carries the phrase");

  assert.equal(hex(await unlockWithRecoveryPhrase(phrase, wrapped)), hex(vaultKey));
  assert.equal(hex(await unlockWithRecoveryPhrase(phrase.toLowerCase().replace(/-/g, " "), wrapped)), hex(vaultKey));
  // The shared unlock seam (the release flow's) recovers the same key from a typed copy.
  assert.equal(
    hex(await unlockVault({ method: "recovery", material: { wrapped }, secret: phrase.toLowerCase() })),
    hex(vaultKey),
  );
});

test("a wrong or malformed phrase never returns a key", async () => {
  const vaultKey = createVaultKey();
  const wrapped = await wrapVaultKeyWithRecoveryPhrase(generateRecoveryPhrase(), vaultKey);
  await assert.rejects(unlockWithRecoveryPhrase(generateRecoveryPhrase(), wrapped), "a different phrase fails the tag check");
  await assert.rejects(unlockWithRecoveryPhrase("not a phrase", wrapped), "a malformed phrase is refused");
});

test("the download text carries the grouped phrase and plain instructions", () => {
  const phrase = generateRecoveryPhrase();
  const text = recoveryPhraseFileText(phrase);
  assert.ok(text.includes(phrase), "the grouped phrase is in the file");
  assert.match(text, /Warthog/);
  assert.match(text, /vault/i);
});
