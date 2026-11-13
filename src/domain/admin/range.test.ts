// Range windows and buckets (src/domain/admin/range.ts): today is the zone's calendar day in
// hour buckets; N-day windows are the last N calendar days ending now, with the equal window
// before; buckets are zero-filled; day arithmetic survives a daylight-saving transition.
import { test } from "node:test";
import assert from "node:assert/strict";

import { addDays, bucketStarts, fillSeries, parseRange, rangeWindow, startOfDayIn } from "./range";

const SYDNEY = "Australia/Sydney";

test("parseRange accepts only the known keys and defaults to 7d", () => {
  assert.equal(parseRange("today"), "today");
  assert.equal(parseRange(["90d"]), "90d");
  assert.equal(parseRange("1y"), "7d");
  assert.equal(parseRange(undefined), "7d");
});

test("today is the zone's calendar day so far, in hours, with yesterday before it", () => {
  // 13 Nov 2026 09:30 in Sydney (AEDT, UTC+11) is 22:30 UTC on the 12th.
  const now = new Date("2026-11-12T22:30:00Z");
  const w = rangeWindow("today", now, SYDNEY);
  assert.equal(w.from, "2026-11-12T13:00:00.000Z", "midnight Sydney on 13 Nov");
  assert.equal(w.to, now.toISOString());
  assert.equal(w.previousFrom, "2026-11-11T13:00:00.000Z");
  assert.equal(w.previousTo, w.from);
  assert.equal(w.bucket, "hour");
  assert.equal(w.label, "today");
  assert.equal(w.previousLabel, "yesterday");
  assert.deepEqual(bucketStarts(w, SYDNEY).slice(0, 2), ["2026-11-12T13:00:00.000Z", "2026-11-12T14:00:00.000Z"]);
  assert.equal(bucketStarts(w, SYDNEY).length, 10, "13:00 to 22:30 is ten started hours");
});

test("a 7-day window is the last seven calendar days ending now, with the previous seven before it", () => {
  const now = new Date("2026-11-12T22:30:00Z"); // 13 Nov 09:30 Sydney
  const w = rangeWindow("7d", now, SYDNEY);
  assert.equal(w.from, "2026-11-06T13:00:00.000Z", "midnight on 7 Nov Sydney");
  assert.equal(w.previousFrom, "2026-10-30T13:00:00.000Z");
  assert.equal(w.previousTo, w.from);
  assert.equal(w.bucket, "day");
  assert.equal(w.label, "the last 7 days");
  assert.equal(w.previousLabel, "the previous 7 days");
  const days = bucketStarts(w, SYDNEY);
  assert.equal(days.length, 7);
  assert.equal(days[0], w.from);
  assert.equal(days[6], "2026-11-12T13:00:00.000Z");
  assert.equal(rangeWindow("30d", now, SYDNEY).label, "the last 30 days");
  assert.equal(bucketStarts(rangeWindow("90d", now, SYDNEY), SYDNEY).length, 90);
});

test("day starts and day arithmetic cross the October daylight-saving transition correctly", () => {
  // Sydney moves from AEST (+10) to AEDT (+11) at 02:00 on Sunday 4 October 2026.
  const before = startOfDayIn(new Date("2026-10-03T05:00:00Z"), SYDNEY); // 3 Oct 15:00 local
  assert.equal(before.toISOString(), "2026-10-02T14:00:00.000Z", "midnight 3 Oct is 14:00 UTC the day before (+10)");
  const after = startOfDayIn(new Date("2026-10-05T05:00:00Z"), SYDNEY); // 5 Oct 16:00 local
  assert.equal(after.toISOString(), "2026-10-04T13:00:00.000Z", "midnight 5 Oct is 13:00 UTC (+11)");
  assert.equal(addDays(before, 2, SYDNEY).toISOString(), after.toISOString(), "two calendar days, 47 hours");
  const w = rangeWindow("7d", new Date("2026-10-07T00:00:00Z"), SYDNEY);
  const starts = bucketStarts(w, SYDNEY);
  assert.equal(starts.length, 7);
  assert.equal(new Set(starts).size, 7, "no bucket repeats across the transition");
  // The day of the transition is 23 hours long; its neighbours are 24.
  const lengths = starts.slice(1).map((s, i) => (new Date(s).getTime() - new Date(starts[i]!).getTime()) / 3_600_000);
  assert.ok(lengths.includes(23) && lengths.every((h) => h === 23 || h === 24));
});

test("fillSeries zero-fills every bucket and sums samples into the zone's day", () => {
  const now = new Date("2026-11-12T22:30:00Z");
  const w = rangeWindow("7d", now, SYDNEY);
  const series = fillSeries(w, SYDNEY, [
    { at: "2026-11-12T13:30:00Z", value: 1 }, // 13 Nov 00:30 Sydney → today's bucket
    { at: "2026-11-12T12:30:00Z", value: 2 }, // 12 Nov 23:30 Sydney → yesterday's bucket
    { at: "2026-11-01T00:00:00Z", value: 99 }, // outside the window, ignored
  ]);
  assert.equal(series.length, 7);
  assert.equal(series[6]!.value, 1);
  assert.equal(series[5]!.value, 2);
  assert.equal(series.slice(0, 5).reduce((n, p) => n + p.value, 0), 0);
});
