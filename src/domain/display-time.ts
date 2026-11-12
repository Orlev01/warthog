import { accountTimeZone } from "./time-zone";

// Pure and safe in both client and server views. An explicit IANA label keeps
// boundary dates and daylight-saving changes clear. Calendar-only due dates and
// financial period calculations are separate concerns.
export function formatAccountTime(
  instant: Date | string,
  timeZone?: string | null,
  options: { dateOnly?: boolean } = {},
): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  const zone = accountTimeZone(timeZone);
  const when = new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    dateStyle: "medium",
    ...(options.dateOnly ? {} : { timeStyle: "short" as const }),
  }).format(date);
  return `${when} (${zone})`;
}

// Day headings and times of day, in the account time zone, for lists grouped by day.

function dayKeyIn(instant: Date, zone: string): string {
  // en-CA formats a calendar date as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** The calendar day an instant falls on in `zone`, and its heading ("Today", "Mon 10 Nov"). */
export function dayOf(iso: string, timeZone: string | undefined, now?: Date): { key: string; label: string } {
  const zone = accountTimeZone(timeZone);
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return { key: "unknown", label: "Date unavailable" };
  const key = dayKeyIn(instant, zone);
  if (now) {
    if (key === dayKeyIn(now, zone)) return { key, label: "Today" };
    if (key === dayKeyIn(new Date(now.getTime() - 86_400_000), zone)) return { key, label: "Yesterday" };
  }
  const sameYear = now !== undefined && key.slice(0, 4) === dayKeyIn(now, zone).slice(0, 4);
  const label = new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" as const }),
  }).format(instant);
  return { key, label };
}

/** "3:04 pm" in the account time zone. */
export function timeOfDay(iso: string, timeZone: string | undefined): string {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", { timeZone: accountTimeZone(timeZone), hour: "numeric", minute: "2-digit" }).format(instant);
}

