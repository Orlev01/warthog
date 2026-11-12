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
