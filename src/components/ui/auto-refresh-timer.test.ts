import { test } from "node:test";
import assert from "node:assert/strict";

import { createAutoRefresh } from "./auto-refresh-timer";

function harness() {
  let now = 0;
  let hidden = false;
  let tick: (() => void) | null = null;
  let refreshes = 0;
  let cleared = 0;
  const timer = createAutoRefresh({
    intervalMs: 30_000,
    refresh: () => { refreshes += 1; },
    hidden: () => hidden,
    now: () => now,
    setInterval: (fn) => { tick = fn; return "handle"; },
    clearInterval: (handle) => { assert.equal(handle, "handle"); cleared += 1; tick = null; },
  });
  return {
    timer,
    advance(ms: number) { now += ms; tick?.(); },
    hide(value: boolean) { hidden = value; timer.visibilityChanged(); },
    get refreshes() { return refreshes; },
    get cleared() { return cleared; },
    get ticking() { return tick !== null; },
  };
}

test("refreshes every interval while the page is in sight", () => {
  const h = harness();
  h.timer.start();
  h.advance(30_000);
  h.advance(30_000);
  assert.equal(h.refreshes, 2);
  h.timer.stop();
  assert.equal(h.cleared, 1);
  assert.equal(h.ticking, false);
});

test("never refreshes out of sight, and catches up straight away on return when stale", () => {
  const h = harness();
  h.timer.start();
  h.hide(true);
  h.advance(30_000);
  h.advance(30_000);
  assert.equal(h.refreshes, 0, "nothing while hidden");
  h.hide(false);
  assert.equal(h.refreshes, 1, "back in sight and out of date: refreshed now");
  h.hide(true);
  h.hide(false);
  assert.equal(h.refreshes, 1, "back in sight but just refreshed: nothing extra");
});

test("paused, it never refreshes; resuming catches up when stale", () => {
  const h = harness();
  h.timer.start();
  h.timer.setPaused(true);
  h.advance(30_000);
  h.advance(30_000);
  assert.equal(h.refreshes, 0);
  h.timer.setPaused(false);
  assert.equal(h.refreshes, 1);
  h.advance(30_000);
  assert.equal(h.refreshes, 2);
});

test("starting twice keeps one timer", () => {
  const h = harness();
  h.timer.start();
  h.timer.start();
  h.timer.stop();
  h.timer.stop();
  assert.equal(h.cleared, 1);
});
