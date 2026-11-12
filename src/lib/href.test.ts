// Same-page link building for views, filters, chips and pagination (`./href`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { firstParam, hrefWith, resolveKey } from "./href";

test("a patch changes one parameter and keeps the rest", () => {
  assert.equal(hrefWith("/activity", { agent: "a1", q: "mail" }, { view: "agents" }), "/activity?agent=a1&q=mail&view=agents");
});

test("an empty or undefined patch value removes that parameter, and drop removes others", () => {
  assert.equal(hrefWith("/activity", { agent: "a1", before: "9" }, { agent: undefined }, ["before"]), "/activity");
  assert.equal(hrefWith("/memory", { scope: "kept" }, { scope: "" }), "/memory");
});

test("drop strips carried-over state but never a value the patch sets", () => {
  assert.equal(hrefWith("/activity", { before: "9", q: "x" }, { before: "4" }, ["before"]), "/activity?before=4&q=x");
});

test("values are encoded and the path is always the caller's own", () => {
  assert.equal(hrefWith("/activity", { q: "a&b=c" }), "/activity?q=a%26b%3Dc");
  assert.equal(hrefWith("/activity", { next: "https://evil.example" }).startsWith("/activity?"), true);
});

test("parameters read as their first non-empty value and views validate against known keys", () => {
  assert.equal(firstParam(["a", "b"]), "a");
  assert.equal(firstParam(""), undefined);
  assert.equal(resolveKey("agents", ["timeline", "agents"] as const, "timeline"), "agents");
  assert.equal(resolveKey("../settings", ["timeline", "agents"] as const, "timeline"), "timeline");
  assert.equal(resolveKey(undefined, ["timeline"] as const, "timeline"), "timeline");
});
