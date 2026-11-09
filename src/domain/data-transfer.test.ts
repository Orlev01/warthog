import { test } from "node:test";
import assert from "node:assert/strict";
import { sealedVaultSchema, plaintextVaultSchema } from "./data-transfer";

test("transfer upload accepts only ciphertext and validated metadata", () => {
  const field = { type: "passport", label: "Passport", ciphertext: `v1:${"A".repeat(44)}` };
  assert.equal(sealedVaultSchema.safeParse({ highTierFields: [field], cards: [] }).success, true);
  for (const bad of [{ ...field, value: "secret passport" }, { ...field, ciphertext: "secret passport" }, { ...field, userId: "someone else" }]) {
    assert.equal(sealedVaultSchema.safeParse({ highTierFields: [bad], cards: [] }).success, false);
  }
});
test("old incomplete card exports cannot silently become unusable restored cards", () => {
  assert.equal(plaintextVaultSchema.safeParse({ highTierFields: [], cards: [{ brand: "Visa", lastFour: "4242", nickname: "card", number: "4242424242424242" }] }).success, false);
});
