// What Warthog never keeps, in the free text agents save to its own stores: memories and tasks
// (src/domain/content/never-kept.ts; docs/adr/profile-build.md).
import { test } from "node:test";
import assert from "node:assert/strict";

import { neverKeptMessage, neverKeptRule, tidyKeptText } from "./never-kept";

test("the identifiers Warthog never keeps are found in free text", () => {
  assert.equal(neverKeptRule("My TFN is 123 456 782"), "tax_file_number");
  assert.equal(neverKeptRule("Bank: BSB 062-000 account 12345678"), "bank_account");
  assert.equal(neverKeptRule("Pay with BPAY biller code 12345 ref 9876543210"), "payment_details");
  assert.equal(neverKeptRule("Prefers window seats and morning flights"), null);
  assert.equal(neverKeptRule("Rego for BX12AB is due 14 Dec"), null);
});

test("a refusal names what was refused and the rule, never the text", () => {
  const message = neverKeptMessage("The memory", "tax_file_number");
  assert.equal(message, "The memory looks like it has a tax file number. Warthog never keeps tax file numbers.");
  for (const rule of ["tax_file_number", "secret", "bank_account", "government_id", "medicare", "payment_details"] as const) {
    assert.match(neverKeptMessage("The task", rule), /^The task looks like it has /, rule);
  }
});

test("card numbers are masked to their last four", () => {
  assert.equal(tidyKeptText("Card 4111 1111 1111 1111 for the gym"), "Card ••••1111 for the gym");
  assert.equal(tidyKeptText("No numbers here"), "No numbers here");
});
