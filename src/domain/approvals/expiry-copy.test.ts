// How an approval's expiry reads in words (`./expiry-copy`): the presets the Rules page
// offers, each preset's plain duration, and the time a waiting request has left in the
// Inbox. With an expiry of up to 24 hours, the Inbox must not read "1440 minutes left".
// Pure: no React, no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";

import { APPROVAL_EXPIRY_PRESETS, expiryDurationLabel, timeLeftLabel } from "./expiry-copy";
import { DEFAULT_EXPIRY_MINUTES, MAX_EXPIRY_MINUTES, MIN_EXPIRY_MINUTES } from "./state-machine";

const MINUTE = 60_000;

test("the presets run from the minimum to the maximum, in order, and include the default", () => {
  assert.deepEqual([...APPROVAL_EXPIRY_PRESETS], [2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440]);
  assert.equal(APPROVAL_EXPIRY_PRESETS[0], MIN_EXPIRY_MINUTES);
  assert.equal(APPROVAL_EXPIRY_PRESETS[APPROVAL_EXPIRY_PRESETS.length - 1], MAX_EXPIRY_MINUTES);
  assert.ok(APPROVAL_EXPIRY_PRESETS.includes(DEFAULT_EXPIRY_MINUTES));
});

test("a duration reads in minutes under an hour and in whole hours from an hour", () => {
  assert.equal(expiryDurationLabel(2), "2 minutes");
  assert.equal(expiryDurationLabel(15), "15 minutes");
  assert.equal(expiryDurationLabel(1), "1 minute");
  assert.equal(expiryDurationLabel(60), "1 hour");
  assert.equal(expiryDurationLabel(240), "4 hours");
  assert.equal(expiryDurationLabel(1440), "24 hours");
  assert.equal(expiryDurationLabel(90), "1 hour 30 minutes");
  assert.equal(expiryDurationLabel(121), "2 hours 1 minute");
});

test("time left reads in minutes under an hour, unchanged from before", () => {
  assert.equal(timeLeftLabel(0), "Expired");
  assert.equal(timeLeftLabel(-5), "Expired");
  assert.equal(timeLeftLabel(1), "1 minute left", "part of a minute rounds up");
  assert.equal(timeLeftLabel(MINUTE), "1 minute left");
  assert.equal(timeLeftLabel(4 * MINUTE + 1), "5 minutes left");
  assert.equal(timeLeftLabel(15 * MINUTE), "15 minutes left");
  assert.equal(timeLeftLabel(59 * MINUTE), "59 minutes left");
});

test("time left of an hour or more reads in hours and minutes, never thousands of minutes", () => {
  assert.equal(timeLeftLabel(60 * MINUTE), "1 hour left");
  assert.equal(timeLeftLabel(90 * MINUTE), "1 hour 30 minutes left");
  assert.equal(timeLeftLabel(120 * MINUTE), "2 hours left");
  assert.equal(timeLeftLabel(1439 * MINUTE + 1), "24 hours left");
  assert.equal(timeLeftLabel(1440 * MINUTE), "24 hours left");
  assert.equal(timeLeftLabel(23 * 60 * MINUTE + 59 * MINUTE), "23 hours 59 minutes left");
});
