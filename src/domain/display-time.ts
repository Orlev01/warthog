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
