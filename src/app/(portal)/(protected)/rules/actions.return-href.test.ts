// The Rules page's URL state (`rulesPageState`) and where each rule action returns to
// (`rulesReturnHref`). View and status values are validated against their known keys —
// anything else is dropped, so a crafted form field or query value can never steer a
// redirect or inject copy — and only the fixed /rules path is ever produced.

import { test } from "node:test";
import assert from "node:assert/strict";

import { rulesPageState, rulesReturnHref } from "./actions";

test("adding a rule returns to the builder with its outcome", () => {
  assert.equal(rulesReturnHref("created", { view: "new" }), "/rules?notice=created&view=new");
  assert.equal(rulesReturnHref("invalid", { view: "new" }), "/rules?notice=invalid&view=new");
});

test("pausing or deleting returns to the same status filter", () => {
  assert.equal(rulesReturnHref("paused", { status: "active" }), "/rules?notice=paused&status=active");
  assert.equal(rulesReturnHref("deleted", { status: "paused" }), "/rules?notice=deleted&status=paused");
  assert.equal(rulesReturnHref("deleted", {}), "/rules?notice=deleted");
});

test("unknown views, statuses and non-string values are dropped", () => {
  assert.equal(
    rulesReturnHref("deleted", { status: "https://evil.example", view: "rules?x=1" }),
    "/rules?notice=deleted",
  );
  assert.equal(rulesReturnHref("paused", { status: new File([], "x"), view: null }), "/rules?notice=paused");
  // The rules list is the default view, so it is never written into the URL.
  assert.equal(rulesReturnHref("updated", { view: "rules" }), "/rules?notice=updated");
});

test("the page reads its view, status filter and notice from the query, first value wins", () => {
  assert.deepEqual(rulesPageState({}), { view: "rules", status: undefined, notice: undefined });
  assert.deepEqual(
    rulesPageState({ view: "budgets", status: ["paused", "active"], notice: "created" }),
    { view: "budgets", status: "paused", notice: "created" },
  );
  assert.deepEqual(
    rulesPageState({ view: "<script>", status: "all", notice: ["", "deleted"] }),
    { view: "rules", status: undefined, notice: undefined },
  );
});
