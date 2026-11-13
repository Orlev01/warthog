// Ranges, windows and buckets for the admin portal (docs/design/admin-portal.md §5). Every
// page shows one window — today, or the last 7, 30 or 90 days — beside the equal-length
// window before it, in the portal's display time zone, so "today" and "day" buckets follow
// the operator's calendar rather than UTC. Pure and deterministic: time comes in as `now`,
// the zone as a name, and every instant goes out as ISO-8601.

import { RANGE_KEYS, type RangeKey, type RangeWindow, type SeriesPoint, type Measure } from "./model";

export const DEFAULT_RANGE: RangeKey = "7d";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DAYS: Readonly<Record<Exclude<RangeKey, "today">, number>> = { "7d": 7, "30d": 30, "90d": 90 };

/** The validated range from a query value; anything unknown is the default. */
export function parseRange(value: string | string[] | undefined): RangeKey {
  const key = Array.isArray(value) ? value[0] : value;
  return key && (RANGE_KEYS as readonly string[]).includes(key) ? (key as RangeKey) : DEFAULT_RANGE;
}

// The zone's UTC offset at an instant, in milliseconds (positive east of Greenwich), read
// from the formatter rather than assumed, so DST transitions come out right.
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

function wallDate(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Midnight at the start of the calendar day `instant` falls on in the zone. */
export function startOfDayIn(instant: Date, timeZone: string): Date {
  const { y, m, d } = wallDate(instant, timeZone);
  const wallMidnight = Date.UTC(y, m - 1, d);
  // First guess with the offset in force at `instant`; a transition between midnight and
  // `instant` changes the offset, so re-read it at the guess and correct once.
  const guess = wallMidnight - offsetMs(instant, timeZone);
  const corrected = wallMidnight - offsetMs(new Date(guess), timeZone);
  return new Date(corrected);
}

/** The start of the day `days` calendar days after (or before, negative) the given day start. */
export function addDays(dayStart: Date, days: number, timeZone: string): Date {
  // Step through noon so a 23- or 25-hour day never lands on the wrong date.
  return startOfDayIn(new Date(dayStart.getTime() + days * DAY_MS + 12 * HOUR_MS), timeZone);
}

export function rangeWindow(key: RangeKey, now: Date, timeZone: string): RangeWindow {
  const today = startOfDayIn(now, timeZone);
  if (key === "today") {
    const yesterday = addDays(today, -1, timeZone);
    return {
      key, from: today.toISOString(), to: now.toISOString(),
      previousFrom: yesterday.toISOString(), previousTo: today.toISOString(),
      bucket: "hour", label: "today", previousLabel: "yesterday",
    };
  }
  const days = DAYS[key];
  const from = addDays(today, -(days - 1), timeZone);
  const previousFrom = addDays(from, -days, timeZone);
  return {
    key, from: from.toISOString(), to: now.toISOString(),
    previousFrom: previousFrom.toISOString(), previousTo: from.toISOString(),
    bucket: "day", label: `the last ${days} days`, previousLabel: `the previous ${days} days`,
  };
}

/** The bucket an instant belongs to: the hour (UTC-aligned) or the zone's day start. */
export function bucketStartFor(instant: Date, bucket: "hour" | "day", timeZone: string): string {
  if (bucket === "hour") return new Date(Math.floor(instant.getTime() / HOUR_MS) * HOUR_MS).toISOString();
  return startOfDayIn(instant, timeZone).toISOString();
}

/** Every bucket start from the window's start up to (not including) its end. */
export function bucketStarts(window: Pick<RangeWindow, "from" | "to" | "bucket">, timeZone: string): string[] {
  const from = new Date(window.from);
  const to = new Date(window.to).getTime();
  const starts: string[] = [];
  if (window.bucket === "hour") {
    for (let t = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS; t < to; t += HOUR_MS) starts.push(new Date(t).toISOString());
    return starts;
  }
  for (let day = startOfDayIn(from, timeZone); day.getTime() < to; day = addDays(day, 1, timeZone)) starts.push(day.toISOString());
  return starts;
}

/** A zero-filled series over the window's buckets, summing the values that fall in each. */
export function fillSeries(
  window: Pick<RangeWindow, "from" | "to" | "bucket">,
  timeZone: string,
  samples: readonly { readonly at: Date | string; readonly value: number }[],
): SeriesPoint[] {
  const totals = new Map<string, number>(bucketStarts(window, timeZone).map((at) => [at, 0]));
  for (const sample of samples) {
    const at = bucketStartFor(new Date(sample.at), window.bucket, timeZone);
    if (totals.has(at)) totals.set(at, totals.get(at)! + sample.value);
  }
  return [...totals.entries()].map(([at, value]) => ({ at, value }));
}

export function measure(value: number, previous: number | null): Measure {
  return { value, previous };
}

/** Today's hours so far (UTC-aligned hour buckets from the zone's day start). */
export function hoursOfToday(now: Date, timeZone: string): Pick<RangeWindow, "from" | "to" | "bucket"> {
  return { from: startOfDayIn(now, timeZone).toISOString(), to: now.toISOString(), bucket: "hour" };
}
