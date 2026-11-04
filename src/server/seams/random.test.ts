// E01-S01 — the randomness seam. A Random exposes randomBytes(n): Uint8Array.
// The real source draws real entropy; a deterministic fake can be substituted in
// tests so codes, tokens and nonces are reproducible without real randomness.
import { test } from "node:test";
import assert from "node:assert/strict";

import { systemRandom, fixedRandom } from "./random";

test("systemRandom.randomBytes(n) returns exactly n bytes", () => {
  for (const n of [1, 8, 16, 32]) {
    const bytes = systemRandom.randomBytes(n);
    assert.ok(bytes instanceof Uint8Array, "randomBytes should return a byte array");
    assert.equal(bytes.length, n);
  }
});

test("systemRandom draws real entropy: successive 32-byte draws differ", () => {
  const a = systemRandom.randomBytes(32);
  const b = systemRandom.randomBytes(32);
  assert.notDeepEqual([...a], [...b]);
});

test("fixedRandom(value) is a deterministic fake: randomBytes(n) returns n bytes of that value", () => {
  const rnd = fixedRandom(0xab);
  const bytes = rnd.randomBytes(4);

  assert.ok(bytes instanceof Uint8Array, "randomBytes should return a byte array");
  assert.equal(bytes.length, 4);
  assert.deepEqual([...bytes], [0xab, 0xab, 0xab, 0xab]);
});

test("fixedRandom is reproducible: identical config yields identical bytes on every draw", () => {
  const rnd = fixedRandom(0x01);
  assert.deepEqual([...rnd.randomBytes(8)], [...rnd.randomBytes(8)]);
});

test("fixedRandom honours the requested length for any n", () => {
  const rnd = fixedRandom(0x7f);
  for (const n of [1, 12, 20, 64]) {
    assert.equal(rnd.randomBytes(n).length, n);
  }
});
