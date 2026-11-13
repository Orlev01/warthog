// Presentation helpers for the admin portal (docs/design/admin-portal.md §5): numbers in
// en-AU, durations in plain units, and deltas in WORDS ("up 12% on the previous 7 days")
// rather than a bare sign — with absolute deltas and "n of m" whenever the denominator is
// under 10, so small numbers are never dressed up as rates. Pure functions, no I/O; times
// go through the shared display-time helpers in the admin's zone.

import type { Tone } from "./model";
import { dayOf, formatAccountTime, relativeDayTime } from "../display-time";

const count = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 });

/** A whole count ("1,204"); a non-integer keeps one decimal. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? count.format(value) : decimal.format(value);
}

/** A ratio as a whole percentage ("83%"). */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  return `${Math.round(ratio * 100)}%`;
}

/** "5 of 6" — the honest form under a denominator of 10. */
export function formatRatio(numerator: number, denominator: number): string {
  return `${formatCount(numerator)} of ${formatCount(denominator)}`;
}

/** "Rate" wording: a percentage from 10 upwards, "n of m" below. */
export function formatShare(numerator: number, denominator: number): string {
  if (denominator <= 0) return "none yet";
  return denominator >= 10 ? formatPercent(numerator / denominator) : formatRatio(numerator, denominator);
}

/** "850 ms", "12 s", "4 min", "2 h 10 min"; null reads as not yet measured. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "not yet measured";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${decimal.format(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export type DeltaDirection = "up" | "down" | "flat" | "none";

export interface Delta {
  readonly text: string;
  readonly tone: Tone;
  readonly direction: DeltaDirection;
}

/**
 * The change against the previous window, in words. `goodWhen` says which direction is
 * welcome (more sign-ups, fewer failures) and sets the tone; the words never change.
 */
export function describeDelta(
  value: number,
  previous: number | null,
  previousLabel: string,
  goodWhen: "up" | "down" = "up",
): Delta {
  if (previous == null) return { text: "no earlier period to compare", tone: "neutral", direction: "none" };
  if (value === previous) return { text: `no change on ${previousLabel}`, tone: "neutral", direction: "flat" };
  const direction: DeltaDirection = value > previous ? "up" : "down";
  const magnitude = Math.abs(value - previous);
  const amount = previous >= 10 ? formatPercent(magnitude / previous) : formatCount(magnitude);
  const welcome = direction === goodWhen;
  return { text: `${direction} ${amount} on ${previousLabel}`, tone: welcome ? "success" : "warning", direction };
}

/** "Today, 3:04 pm" / "Mon 10 Nov, 3:04 pm" in the admin's zone; null reads as never. */
export function formatWhen(iso: string | null | undefined, timeZone: string, now: Date, never = "Never"): string {
  if (!iso) return never;
  return relativeDayTime(iso, timeZone, now);
}

/** "12 Nov 2026" in the admin's zone. */
export function formatDate(iso: string | null | undefined, timeZone: string, never = "Unknown"): string {
  if (!iso) return never;
  return formatAccountTime(iso, timeZone, { dateOnly: true });
}

/** The short day heading for a series bucket ("Mon 10 Nov", "Today"). */
export function formatBucket(iso: string, timeZone: string, now?: Date): string {
  return dayOf(iso, timeZone, now).label;
}

/** "1 account" / "3 accounts". */
export function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(value)} ${value === 1 ? singular : pluralForm}`;
}
