import { test } from "node:test";
import assert from "node:assert/strict";

import { describeDelta, formatBucket, formatCount, formatDate, formatDurationMs, formatPercent, formatRatio, formatShare, formatWhen, plural } from "./format";

test("counts, percentages and ratios read in en-AU and stay honest at small numbers", () => {
  assert.equal(formatCount(1204), "1,204");
  assert.equal(formatCount(2.345), "2.3");
  assert.equal(formatCount(Number.NaN), "0");
  assert.equal(formatPercent(0.834), "83%");
  assert.equal(formatRatio(5, 6), "5 of 6");
  assert.equal(formatShare(5, 6), "5 of 6");
  assert.equal(formatShare(50, 60), "83%");
  assert.equal(formatShare(0, 0), "none yet");
  assert.equal(plural(1, "account"), "1 account");
  assert.equal(plural(3, "account"), "3 accounts");
});

test("durations use plain units", () => {
  assert.equal(formatDurationMs(850), "850 ms");
  assert.equal(formatDurationMs(12_400), "12.4 s");
  assert.equal(formatDurationMs(4 * 60_000), "4 min");
  assert.equal(formatDurationMs(130 * 60_000), "2 h 10 min");
  assert.equal(formatDurationMs(120 * 60_000), "2 h");
  assert.equal(formatDurationMs(null), "not yet measured");
});

test("deltas are words, percentages only from a denominator of 10, with the tone set by which way is good", () => {
  assert.deepEqual(describeDelta(14, 12, "the previous 7 days"), { text: "up 17% on the previous 7 days", tone: "success", direction: "up" });
  assert.deepEqual(describeDelta(3, 5, "the previous 7 days"), { text: "down 2 on the previous 7 days", tone: "warning", direction: "down" });
  assert.deepEqual(describeDelta(3, 5, "the previous 7 days", "down"), { text: "down 2 on the previous 7 days", tone: "success", direction: "down" });
  assert.deepEqual(describeDelta(5, 5, "yesterday"), { text: "no change on yesterday", tone: "neutral", direction: "flat" });
  assert.deepEqual(describeDelta(5, null, "yesterday"), { text: "no earlier period to compare", tone: "neutral", direction: "none" });
  assert.equal(describeDelta(2, 0, "yesterday").text, "up 2 on yesterday");
});

test("instants render in the admin's zone with a plain fallback", () => {
  const now = new Date("2026-11-13T05:00:00Z");
  assert.equal(formatWhen("2026-11-13T04:04:00Z", "Australia/Sydney", now), "Today, 3:04 pm");
  assert.equal(formatWhen(null, "Australia/Sydney", now), "Never");
  assert.equal(formatDate("2026-11-12T20:00:00Z", "Australia/Sydney"), "13 Nov 2026");
  assert.equal(formatDate(null, "Australia/Sydney"), "Unknown");
  assert.equal(formatBucket("2026-11-09T13:00:00Z", "Australia/Sydney", now), "Tue, 10 Nov");
});
