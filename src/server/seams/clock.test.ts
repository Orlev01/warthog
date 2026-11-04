// E01-S01 — the clock seam. A Clock exposes now(): Date. The real clock reports
// wall-clock time; an injected fixed clock reports a frozen instant so expiries,
// nonces and anything time-dependent can be tested without the real wall clock.
import { test } from "node:test";
import assert from "node:assert/strict";

import { systemClock, fixedClock } from "./clock";

test("systemClock.now() reports the real current time", () => {
  const before = Date.now();
  const got = systemClock.now();
  const after = Date.now();

  assert.ok(got instanceof Date, "now() should return a Date");
  const t = got.getTime();
  assert.ok(
    t >= before && t <= after,
    `now() ${t} should fall within the call window [${before}, ${after}]`,
  );
});

test("fixedClock(instant).now() returns the injected fixed time, not the wall clock", () => {
  const instant = new Date("2026-01-02T03:04:05.000Z");
  const clock = fixedClock(instant);

  const got = clock.now();
  assert.ok(got instanceof Date, "now() should return a Date");
  assert.equal(got.getTime(), instant.getTime());
});

test("a fixed clock does not advance: repeated now() calls return the same instant", () => {
  const instant = new Date("2020-06-07T08:09:10.123Z");
  const clock = fixedClock(instant);

  assert.equal(clock.now().getTime(), instant.getTime());
  assert.equal(clock.now().getTime(), instant.getTime());
});

test("two fixed clocks are independent: each reports its own injected instant", () => {
  const a = fixedClock(new Date("2000-01-01T00:00:00.000Z"));
  const b = fixedClock(new Date("2030-12-31T23:59:59.000Z"));

  assert.equal(a.now().getTime(), Date.parse("2000-01-01T00:00:00.000Z"));
  assert.equal(b.now().getTime(), Date.parse("2030-12-31T23:59:59.000Z"));
});
