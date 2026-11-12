// How an approval's expiry reads in words: the presets the Rules page offers for the
// person's approval expiry, a duration in plain words, and the time a waiting request has
// left in the Inbox. The expiry runs from 2 minutes to 24 hours (brief "Agents wait
// safely"), so a long wait reads in hours and minutes, never as thousands of minutes.
//
// Pure copy: no React, no I/O, so the server page, its actions and the client view all
// read the same values.

import { DEFAULT_EXPIRY_MINUTES, MAX_EXPIRY_MINUTES, MIN_EXPIRY_MINUTES } from "./state-machine";

// The choices the Rules page offers, in minutes, shortest first: 2, 5, 10, 15 (the
// default) and 30 minutes, then 1, 2, 4, 8, 12 and 24 hours.
export const APPROVAL_EXPIRY_PRESETS: readonly number[] = [
  MIN_EXPIRY_MINUTES,
  5,
  10,
  DEFAULT_EXPIRY_MINUTES,
  30,
  60,
  120,
  240,
  480,
  720,
  MAX_EXPIRY_MINUTES,
];

const MINUTE_MS = 60_000;

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/** A whole number of minutes in words: "15 minutes", "1 hour", "1 hour 30 minutes". */
export function expiryDurationLabel(minutes: number): string {
  if (minutes < 60) return count(minutes, "minute", "minutes");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const inHours = count(hours, "hour", "hours");
  return rest === 0 ? inHours : `${inHours} ${count(rest, "minute", "minutes")}`;
}

/** Time left before a pending request expires, rounded up to the minute; "Expired" at zero. */
export function timeLeftLabel(timeLeftMs: number): string {
  if (timeLeftMs <= 0) return "Expired";
  return `${expiryDurationLabel(Math.ceil(timeLeftMs / MINUTE_MS))} left`;
}
