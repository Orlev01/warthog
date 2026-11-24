import { test } from "node:test";
import assert from "node:assert/strict";
import { sealedVaultSchema, plaintextVaultSchema, cardBillingAddressesSchema } from "./data-transfer";

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

// docs/adr/card-billing-addresses.md: a card's billing address is a postal address from About
// you (billingAddressId), a card-only address (billingEntryId) or none yet — never both.
test("a card carries at most one kind of billing reference, and may carry none", () => {
  const sealedCard = { brand: "Visa", lastFour: "4242", nickname: "card", expiryMonth: 9, expiryYear: 2030, numberCiphertext: `v1:${"A".repeat(44)}` };
  const plainCard = { brand: "Visa", lastFour: "4242", nickname: "card", expiryMonth: 9, expiryYear: 2030, number: "4242424242424242" };
  for (const [schema, card] of [[sealedVaultSchema, sealedCard], [plaintextVaultSchema, plainCard]] as const) {
    const parse = (extra: object) => schema.safeParse({ highTierFields: [], cards: [{ ...card, ...extra }] }).success;
    assert.equal(parse({}), true, "a card with no billing address yet is accepted");
    assert.equal(parse({ billingAddressId: "postal-1" }), true, "an About you postal reference is accepted (older exports)");
    assert.equal(parse({ billingEntryId: "billing-1" }), true, "a card-only reference is accepted");
    assert.equal(parse({ billingAddressId: "postal-1", billingEntryId: "billing-1" }), false, "both kinds at once are refused");
    assert.equal(parse({ billingEntryId: "" }), false, "an empty reference is refused");
  }
});

test("card-only billing addresses are bounded, trimmed text with optional ids", () => {
  const parsed = cardBillingAddressesSchema.safeParse([{ id: "billing-1", value: "  1 Card St, Sydney NSW 2000  " }, { value: "PO Box 9, Perth WA 6000" }]);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, [{ id: "billing-1", value: "1 Card St, Sydney NSW 2000" }, { value: "PO Box 9, Perth WA 6000" }]);
  for (const bad of [
    [{ id: "billing-1", value: "   " }],
    [{ id: "billing-1", value: "x".repeat(4097) }],
    [{ id: "billing-1", value: 42 }],
    [{ id: "", value: "1 Card St" }],
    [{ id: "billing-1", value: "1 Card St", userId: "someone else" }],
    Array.from({ length: 1001 }, (_, i) => ({ id: `billing-${i}`, value: "1 Card St" })),
  ]) {
    assert.equal(cardBillingAddressesSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(cardBillingAddressesSchema.safeParse(Array.from({ length: 1000 }, (_, i) => ({ id: `billing-${i}`, value: "x".repeat(4096) }))).success, true);
});
