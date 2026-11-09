import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAccountTime } from "./display-time";

const instant = "2026-11-09T02:15:00Z";
test("account timestamps show each saved zone's date and an explicit zone label", () => {
  assert.match(formatAccountTime(instant, "UTC"), /9 Nov 2026, 2:15 am \(UTC\)/);
  assert.match(formatAccountTime(instant, "Australia/Sydney"), /9 Nov 2026, 1:15 pm \(Australia\/Sydney\)/);
  assert.match(formatAccountTime(instant, "America/Los_Angeles"), /8 Nov 2026, 6:15 pm \(America\/Los_Angeles\)/);
  assert.equal(formatAccountTime(instant, "America/Los_Angeles", { dateOnly: true }), "8 Nov 2026 (America/Los_Angeles)");
});
test("invalid or absent preferences use the labelled account fallback, never the server zone", () => {
  const expected = formatAccountTime(instant, "Australia/Sydney");
  assert.equal(formatAccountTime(instant, "not/a/zone"), expected);
  assert.equal(formatAccountTime(instant), expected);
  assert.equal(formatAccountTime(instant, "  UTC  "), formatAccountTime(instant, "UTC"));
  assert.equal(formatAccountTime("not a date", "UTC"), "Date unavailable");
});
