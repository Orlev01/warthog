import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAccountTime } from "./display-time";
import { relativeDayTime, timeZoneName, timeZoneNote } from "../domain/display-time";

const instant = "2026-11-09T02:15:00Z";
test("account timestamps show each saved zone's date and time without repeating the zone", () => {
  assert.equal(formatAccountTime(instant, "UTC"), "9 Nov 2026, 2:15 am");
  assert.equal(formatAccountTime(instant, "Australia/Sydney"), "9 Nov 2026, 1:15 pm");
  assert.equal(formatAccountTime(instant, "America/Los_Angeles"), "8 Nov 2026, 6:15 pm");
  assert.equal(formatAccountTime(instant, "America/Los_Angeles", { dateOnly: true }), "8 Nov 2026");
});
test("a value outside the member's own zone can name its zone in plain words", () => {
  assert.equal(formatAccountTime(instant, "UTC", { showZone: true }), "9 Nov 2026, 2:15 am (UTC)");
  assert.equal(formatAccountTime(instant, "Australia/Sydney", { showZone: true }), "9 Nov 2026, 1:15 pm (Sydney time)");
  assert.equal(formatAccountTime(instant, "America/Los_Angeles", { dateOnly: true, showZone: true }), "8 Nov 2026 (Los Angeles time)");
});
test("a page states its zone once, in friendly words", () => {
  assert.equal(timeZoneName("Australia/Sydney"), "Sydney time");
  assert.equal(timeZoneName("America/Los_Angeles"), "Los Angeles time");
  assert.equal(timeZoneName("UTC"), "UTC");
  assert.equal(timeZoneName("not/a/zone"), "Sydney time", "the account fallback zone");
  assert.equal(timeZoneNote("Australia/Sydney"), "Times are Sydney time.");
  assert.equal(timeZoneNote("UTC"), "Times are in UTC.");
});
test("relative day and time matches Home's 'Today, 1:15 pm' wording", () => {
  const now = new Date("2026-11-09T05:00:00Z");
  assert.equal(relativeDayTime(instant, "Australia/Sydney", now), "Today, 1:15 pm");
  assert.equal(relativeDayTime(instant, "Australia/Sydney", new Date("2026-11-10T05:00:00Z")), "Yesterday, 1:15 pm");
  assert.equal(relativeDayTime("not a date", "UTC", now), "Date unavailable");
});
test("invalid or absent preferences use the account fallback, never the server zone", () => {
  const expected = formatAccountTime(instant, "Australia/Sydney");
  assert.equal(formatAccountTime(instant, "not/a/zone"), expected);
  assert.equal(formatAccountTime(instant), expected);
  assert.equal(formatAccountTime(instant, "  UTC  "), formatAccountTime(instant, "UTC"));
  assert.equal(formatAccountTime("not a date", "UTC"), "Date unavailable");
});
