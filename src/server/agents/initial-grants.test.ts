import { test } from "node:test";
import assert from "node:assert/strict";
import { initialGrants } from "./initial-grants";

test("explicit memory read and write choices independently override a starting set", () => {
  for (const memoryRead of [false, true]) {
    for (const memoryWrite of [false, true]) {
      const grants = initialGrants("person", "agent", { template: "custom", memoryRead, memoryWrite });
      assert.equal(grants.memoryRead, memoryRead);
      assert.equal(grants.memoryWrite, memoryWrite);
    }
  }
});

test("omitted memory choices retain the documented template defaults", () => {
  for (const template of ["minimal", "standard", "custom"] as const) {
    const grants = initialGrants("person", "agent", { template });
    assert.equal(grants.memoryRead, template !== "minimal");
    assert.equal(grants.memoryWrite, template !== "minimal");
  }
});

// docs/adr/default-services.md — a granted service that has an account on for new agents is
// set to that account; a service not granted is never pinned.
test("a granted service with an account on for new agents is set to that account", () => {
  const defaults = { "google-gmail": "gmail-home", notion: "notion-family" };
  const grants = initialGrants("person", "agent", { template: "standard" }, ["google-gmail", "outlook"], defaults);
  assert.deepEqual(grants.grantedConnectors, ["google-gmail", "outlook"]);
  assert.deepEqual(grants.connectorAccounts, { "google-gmail": "gmail-home" }, "notion was not granted, outlook has no default");
});

test("without accounts on for new agents no account is chosen", () => {
  const grants = initialGrants("person", "agent", { template: "standard" }, ["google-gmail"]);
  assert.equal(grants.connectorAccounts, undefined);
});
