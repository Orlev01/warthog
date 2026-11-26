import { test } from "node:test";
import assert from "node:assert/strict";

import { DIFF_CELL_LIMIT, foldUnchanged, lineDiff } from "./line-diff";

const kinds = (before: string, after: string) => lineDiff(before, after)!.map((l) => `${l.kind[0]}:${l.text}`);

test("an added instruction is one added line among unchanged ones", () => {
  assert.deepEqual(kinds("1. Ask\n2. Plan\n3. Book", "1. Ask\n2. Plan\n2b. Email my boss the itinerary\n3. Book"), [
    "s:1. Ask", "s:2. Plan", "a:2b. Email my boss the itinerary", "s:3. Book",
  ]);
});

test("a changed line reads as the old one removed, then the new one added", () => {
  assert.deepEqual(kinds("Be brief.\nSign off: Oren", "Be brief.\nSign off: Thanks"), ["s:Be brief.", "r:Sign off: Oren", "a:Sign off: Thanks"]);
});

test("removed, added and identical texts", () => {
  assert.deepEqual(kinds("a\nb\nc", "a\nc"), ["s:a", "r:b", "s:c"]);
  assert.deepEqual(kinds("", "new"), ["r:", "a:new"]);
  assert.deepEqual(kinds("same\ntext", "same\ntext"), ["s:same", "s:text"]);
  assert.deepEqual(kinds("x\r\ny", "x\ny"), ["s:x", "s:y"], "line endings don't count as changes");
});

test("every line of both versions is accounted for, in order", () => {
  const before = "a\nb\nc\nd\ne\nf", after = "a\nx\nc\ny\nz\nf\ng";
  const lines = lineDiff(before, after)!;
  assert.deepEqual(lines.filter((l) => l.kind !== "added").map((l) => l.text).join("\n"), before);
  assert.deepEqual(lines.filter((l) => l.kind !== "removed").map((l) => l.text).join("\n"), after);
});

test("texts too long to compare give null, so both are shown in full", () => {
  const side = Math.ceil(Math.sqrt(DIFF_CELL_LIMIT)) + 1;
  const before = Array.from({ length: side }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: side }, (_, i) => `new ${i}`).join("\n");
  assert.equal(lineDiff(before, after), null);
  // A long text with one change is still compared: the shared start and end need no table.
  assert.ok(lineDiff(`${before}\nend`, `${before}\nchanged end`));
});

test("long unchanged stretches fold, keeping two lines beside each change", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[10] = "changed";
  const hunks = foldUnchanged(lineDiff(before.join("\n"), after.join("\n"))!);
  assert.deepEqual(hunks.map((h) => (h.kind === "unchanged" ? `…${h.count}` : h.lines.map((l) => l.kind[0]).join(""))), ["…8", "ssrass", "…7"]);
});
