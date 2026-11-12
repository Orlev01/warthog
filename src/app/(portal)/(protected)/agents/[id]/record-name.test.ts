// interaction-12 / content-23 — an agent's Settings lists each life-admin record by the name
// the member gave it, never by its stored type ("renewal_appointment").

import { test } from "node:test";
import assert from "node:assert/strict";

import { recordName } from "./actions";

test("a record is named by its own name, item or title, whichever it has", () => {
  assert.equal(recordName({ name: "Netflix Premium", amount: "25.99" }, "subscription"), "Netflix Premium");
  assert.equal(recordName({ item: "Dyson V15 Detect", store: "JB Hi-Fi" }, "receipt_warranty"), "Dyson V15 Detect");
  assert.equal(recordName({ title: "Car registration" }, "renewal_appointment"), "Car registration");
  assert.equal(recordName({ what: "Dentist" }, "renewal_appointment"), "Dentist");
});

test("a record without a name falls back to its first detail, then to its type in words", () => {
  assert.equal(recordName({ provider: "NRMA" }, "renewal_appointment"), "NRMA");
  assert.equal(recordName({ name: "   " }, "renewal_appointment"), "Renewal or appointment");
  assert.equal(recordName({}, "receipt_warranty"), "Receipt or warranty");
  assert.equal(recordName({ amount: 12 }, "subscription"), "Subscription", "a non-text value is never shown as the name");
});
