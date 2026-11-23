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

// docs/adr/several-accounts-per-agent.md — the person ticks accounts, not services. Each ticked
// account of a service the starting set grants is given to the agent, with the agent's own
// settings; Minimal grants none.
const HOME = { id: "gmail-home", connectorId: "google-gmail" };
const BILLING = { id: "gmail-billing", connectorId: "google-gmail" };
const NOTION = { id: "notion-family", connectorId: "notion" };

test("every ticked account is granted, two accounts of one service included", () => {
  const grants = initialGrants("person", "agent", { template: "standard", tickedAccounts: [HOME, BILLING, NOTION] });
  assert.deepEqual(grants.accounts, [{ accountId: "gmail-home" }, { accountId: "gmail-billing" }, { accountId: "notion-family" }]);
  assert.equal(grants.readTools, true, "reads are on for the granted accounts");
  assert.equal(grants.changeTools, "ask_first", "changes ask first");
});

test("an account ticked twice is granted once", () => {
  const grants = initialGrants("person", "agent", { template: "custom", tickedAccounts: [HOME, HOME] });
  assert.deepEqual(grants.accounts, [{ accountId: "gmail-home" }]);
});

test("Minimal grants no accounts, even ticked ones", () => {
  const grants = initialGrants("person", "agent", { template: "minimal", tickedAccounts: [HOME, NOTION] });
  assert.deepEqual(grants.accounts, []);
  assert.equal(grants.readTools, false);
  assert.equal(grants.changeTools, "off");
});

test("with nothing ticked no account is granted", () => {
  const grants = initialGrants("person", "agent", { template: "standard" });
  assert.deepEqual(grants.accounts, []);
  assert.equal(grants.readTools, false);
  assert.equal(grants.changeTools, "off");
});
