import { test } from "node:test";
import assert from "node:assert/strict";

import { agoText } from "./display-time";

test("how long ago reads in minutes, then hours", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");
  const ago = (ms: number) => agoText(new Date(now.getTime() - ms), now);
  assert.equal(ago(10_000), "just now");
  assert.equal(ago(60_000), "1 min ago");
  assert.equal(ago(3 * 60_000), "3 min ago");
  assert.equal(ago(60 * 60_000), "1 hour ago");
  assert.equal(ago(5 * 60 * 60_000), "5 hours ago");
});
