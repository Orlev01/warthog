// Same-page link building for views, filters, chips and pagination (`./href`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { allParams, firstParam, hrefWith, hrefWithLists, resolveKey } from "./href";

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

test("a repeated parameter reads as each non-empty value once, in order, up to a bound", () => {
  assert.deepEqual(allParams(["b", "a", "", "b"]), ["b", "a"]);
  assert.deepEqual(allParams("a"), ["a"]);
  assert.deepEqual(allParams(undefined), []);
  assert.deepEqual(allParams(""), []);
  assert.equal(allParams(Array.from({ length: 100 }, (_, index) => `v${index}`)).length, 40, "a flood of values is cut to 40");
});

test("a link with repeated parameters keeps a stable order, each value in turn, and drops empty ones", () => {
  assert.equal(
    hrefWithLists("/life-admin", { view: "life", tab: "bookings", state: ["upcoming", "completed"], category: ["travel"], for_whom: [], page: undefined }),
    "/life-admin?category=travel&state=upcoming&state=completed&tab=bookings&view=life",
  );
  assert.equal(hrefWithLists("/life-admin", { q: "" }), "/life-admin");
});
