// What a life-admin record must never hold (`./identifiers.ts`): the refusals fire on the
// field names and value shapes they target, name the field and rule but never the value, and
// leave ordinary policy, member, account and meter numbers alone.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findForbidden,
  findingMessage,
  forbiddenFieldName,
  forbiddenValue,
  linksToSiteNames,
  maskCards,
  siteName,
} from "./identifiers";

test("forbidden field names are refused whatever their case or punctuation", () => {
  assert.equal(forbiddenFieldName("TFN"), "tax_file_number");
  assert.equal(forbiddenFieldName("tax_file_number"), "tax_file_number");
  assert.equal(forbiddenFieldName("Password"), "secret");
  assert.equal(forbiddenFieldName("portal_password"), "secret");
  assert.equal(forbiddenFieldName("account PIN"), "secret");
  assert.equal(forbiddenFieldName("cardNumber"), "secret");
  assert.equal(forbiddenFieldName("BSB"), "bank_account");
  assert.equal(forbiddenFieldName("passport_number"), "government_id");
  assert.equal(forbiddenFieldName("licence card number"), "government_id");
  assert.equal(forbiddenFieldName("medicare_number"), "medicare");
  assert.equal(forbiddenFieldName("biller_code"), "payment_details");
  assert.equal(forbiddenFieldName("how_to_pay"), "payment_details");
  assert.equal(forbiddenFieldName("Payment link"), "payment_details");
});

test("ordinary field names pass", () => {
  for (const name of ["reference", "policy_number", "member_number", "account_number", "meter_id", "plate", "provider", "notes", "spin_class", "last4"]) {
    assert.equal(forbiddenFieldName(name), null, name);
  }
});

test("a tax file number is refused only with the words that say it is one", () => {
  assert.equal(forbiddenValue("notes", "My TFN is 123 456 782", null), "tax_file_number");
  assert.equal(forbiddenValue("tax_reference", "tax file 123456782", null), "tax_file_number");
  assert.equal(forbiddenValue("reference", "123456782", "health.insurance"), null);
});

test("a Medicare number is refused with the word, or on the Medicare card's record", () => {
  assert.equal(forbiddenValue("notes", "Medicare 2123 45670 1", null), "medicare");
  assert.equal(forbiddenValue("people", "2123456701", "id.medicare"), "medicare");
  // A phone number of the same shape on a health provider is not a Medicare number.
  assert.equal(forbiddenValue("contact", "61 2 1234 5670 1", "health.provider"), null);
  // A meter id (NMIs also start 2–6) is never one.
  assert.equal(forbiddenValue("meter_id", "Medicare-shaped 2123456701", "utility.energy"), null);
});

test("passport, licence and visa grant numbers are refused", () => {
  assert.equal(forbiddenValue("notes", "Passport PA1234567", null), "government_id");
  assert.equal(forbiddenValue("notes", "licence number 12345678", null), "government_id");
  assert.equal(forbiddenValue("notes", "visa grant 0123456789012", null), "government_id");
  // On an ID document's own record any document number is refused, whatever it's called.
  assert.equal(forbiddenValue("country", "Australia N1234567", "id.passport"), "government_id");
  assert.equal(forbiddenValue("conditions", "12345678", "id.driver_licence"), "government_id");
});

test("ID document records keep their ordinary details", () => {
  assert.equal(forbiddenValue("country", "Australia", "id.passport"), null);
  assert.equal(forbiddenValue("licence_class", "C", "id.driver_licence"), null);
  assert.equal(forbiddenValue("visa_type", "Subclass 482", "id.visa"), null);
  assert.equal(forbiddenValue("notes", "Renew on 20270109 at the post office", "id.passport"), null);
  // A working with children check number is on a public register, so it may be kept.
  assert.equal(forbiddenValue("reference", "WWC1234567E", "id.check"), null);
});

test("secrets written into a value are refused", () => {
  assert.equal(forbiddenValue("how_to_cancel", "Call and give your PIN: 4821", null), "secret");
  assert.equal(forbiddenValue("notes", "password is hunter2", null), "secret");
  assert.equal(forbiddenValue("notes", "BSB 062-000 account 12345678", null), "bank_account");
});

test("ordinary values pass", () => {
  assert.equal(forbiddenValue("reference", "MPA-2045-7781", "vehicle.insurance"), null);
  assert.equal(forbiddenValue("reference", "4012345678", "health.insurance"), null);
  assert.equal(forbiddenValue("plate", "BX12AB", "vehicle.vehicle"), null);
  assert.equal(forbiddenValue("meter_id", "4103123456", "utility.energy"), null);
  assert.equal(forbiddenValue("notes", "Cancel any time in the app", "subscription.service"), null);
});

test("findForbidden reports each offending field once, names first", () => {
  const findings = findForbidden({ tfn: "x", notes: "My TFN is 123 456 782", provider: "Bupa" }, null);
  assert.deepEqual(findings, [
    { field: "tfn", rule: "tax_file_number" },
    { field: "notes", rule: "tax_file_number" },
  ]);
});

test("a finding's message names the field but never the value", () => {
  const message = findingMessage({ field: "notes", rule: "medicare" });
  assert.match(message, /"notes"/);
  assert.match(message, /Vault/);
  assert.doesNotMatch(message, /\d{4}/);
});

test("card numbers are masked to their last four", () => {
  assert.deepEqual(maskCards("Paid with 4242 4242 4242 4242 today"), { value: "Paid with ••••4242 today", masked: true });
  assert.deepEqual(maskCards("Policy 1234567890123"), { value: "Policy 1234567890123", masked: false });
});

test("links become their site name", () => {
  assert.equal(siteName("https://www.service.nsw.gov.au/renew?x=1"), "service.nsw.gov.au");
  assert.equal(siteName("netflix.com/cancelplan"), "netflix.com");
  assert.deepEqual(linksToSiteNames("Pay at https://evil.example/pay?ref=1 now"), { value: "Pay at evil.example now", changed: true });
  assert.deepEqual(linksToSiteNames("No links here"), { value: "No links here", changed: false });
});
