import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryNotice, memoryReturnUrl } from "./notices";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

test("a Memory action returns to the same search, filters and page, with its notice (interaction-14)", () => {
  assert.equal(
    memoryReturnUrl(form({ return_q: "seat", return_scope: "kept", return_source: "you", return_cursor: "abc" }), "deleted"),
    "/memory?cursor=abc&notice=deleted&q=seat&scope=kept&source=you",
  );
  assert.equal(memoryReturnUrl(form({}), "added"), "/memory?notice=added");
});

test("untrusted return values are bounded, unknown sharing values are dropped, and the path is always /memory", () => {
  const url = memoryReturnUrl(form({ return_scope: "everyone", return_q: "x".repeat(5000), return_source: "https://evil.example" }), "problem");
  assert.ok(url.startsWith("/memory?"), url);
  assert.ok(!url.includes("scope="), "an unknown sharing value is dropped");
  assert.ok(url.length < 400, "bounded");
});

test("a blank memory and a failed save say what happened and what to do", () => {
  assert.equal(memoryNotice("blank")?.tone, "error");
  assert.match(memoryNotice("blank")!.text, /can't be blank/);
  assert.doesNotMatch(memoryNotice("problem")!.text, /something went wrong/i);
  for (const value of [undefined, ["added"], "", "toString", "__proto__", "<script>"]) assert.equal(memoryNotice(value), null);
});
