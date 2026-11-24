// Read-side protection — the event inside an email invitation (a text/calendar part), as an
// agent reads it (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now. A small,
// linear line parser for the handful of iCalendar fields an agent needs to add an invitation
// to a calendar: what, when, where and who sent it.

import { cleanText, type CleanOptions, type FilterCounts } from "./text-filters";

/** The event an invitation describes. */
export interface Invitation {
  readonly title?: string;
  readonly start?: string;
  readonly end?: string;
  readonly location?: string;
  readonly organizer?: string;
  /** REQUEST (an invitation), CANCEL (a cancellation) or REPLY. */
  readonly method?: string;
  /** The event's UID, so an agent can check the calendar before adding it a second time. */
  readonly uid?: string;
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;

// A time zone name as written (Olson or Windows style), cleaned and with nothing else in it.
function zoneName(tzid: string, counts: FilterCounts, options: CleanOptions): string {
  return cleanText(tzid.replace(/^"|"$/g, ""), counts, options).replace(/[^\w/+.():, -]/g, "").trim().slice(0, 60);
}

// "20261120T100000Z" → "2026-11-20 10:00 UTC"; "20261120" → "2026-11-20"; with a TZID it keeps the zone.
function when(value: string, tzid: string | undefined, counts: FilterCounts, options: CleanOptions): string | undefined {
  const match = DATE_TIME.exec(value.trim());
  if (!match) return undefined;
  const [, y, m, d, hh, mm, , z] = match;
  if (!hh) return `${y}-${m}-${d}`;
  const named = !z && tzid ? zoneName(tzid, counts, options) : "";
  const zone = z ? " UTC" : named ? ` (${named})` : "";
  return `${y}-${m}-${d} ${hh}:${mm}${zone}`;
}

// An all-day event's DTEND is the day AFTER it ends; the last day it covers, or undefined when
// that's its first day too.
function lastAllDay(start: string, end: string): string | undefined {
  const s = DATE_TIME.exec(start.trim());
  const e = DATE_TIME.exec(end.trim());
  if (!s || !e || s[4] || e[4]) return undefined;
  const last = new Date(Date.UTC(Number(e[1]), Number(e[2]) - 1, Number(e[3]) - 1));
  const first = Date.UTC(Number(s[1]), Number(s[2]) - 1, Number(s[3]));
  return last.getTime() > first ? last.toISOString().slice(0, 10) : undefined;
}

// Undo iCalendar text escaping (\n, \, \; \\).
function unescape(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

// A content line's name-and-parameters and its value, split at the first colon that isn't
// inside a quoted parameter (`SENT-BY="mailto:pa@acme.com.au"`, `TZID="(UTC+10:00) Sydney"`).
function splitLine(line: string): { params: string[]; value: string } | null {
  const params: string[] = [];
  let quoted = false;
  let from = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") quoted = !quoted;
    else if (!quoted && ch === ";") {
      params.push(line.slice(from, i));
      from = i + 1;
    } else if (!quoted && ch === ":") {
      params.push(line.slice(from, i));
      return { params, value: line.slice(i + 1) };
    }
  }
  return null;
}

/** The first event of an iCalendar document, or null when there is none. Its text is checked at the person's level (`options.level`). */
export function parseInvitation(ics: string, counts: FilterCounts, options: CleanOptions = {}): Invitation | null {
  // Unfold continuation lines (a line starting with a space or tab continues the one above).
  const lines = ics.slice(0, 200_000).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  let method: string | undefined;
  let inEvent = false;
  const fields: Record<string, { value: string; tzid?: string }> = {};
  for (const line of lines) {
    const split = splitLine(line);
    if (!split) continue;
    const [name, ...params] = split.params;
    const { value } = split;
    const key = name!.toUpperCase();
    if (key === "METHOD" && !inEvent && /^[A-Za-z-]{1,20}$/.test(value.trim())) method = value.trim().toUpperCase();
    if (key === "BEGIN" && value.trim().toUpperCase() === "VEVENT") inEvent = true;
    else if (key === "END" && value.trim().toUpperCase() === "VEVENT") break;
    else if (inEvent && ["SUMMARY", "DTSTART", "DTEND", "LOCATION", "ORGANIZER", "UID"].includes(key) && !fields[key]) {
      const tzid = params.find((param) => param.toUpperCase().startsWith("TZID="))?.slice(5);
      fields[key] = { value, ...(tzid ? { tzid } : {}) };
    }
  }
  if (!inEvent) return null;
  const text = (key: string, max: number) => (fields[key] ? cleanText(unescape(fields[key]!.value).slice(0, max), counts, options) : undefined);
  const organizer = fields.ORGANIZER ? cleanText(fields.ORGANIZER.value.replace(/^mailto:/i, "").trim().slice(0, 254), counts, options) : undefined;
  const start = fields.DTSTART ? when(fields.DTSTART.value, fields.DTSTART.tzid, counts, options) : undefined;
  const allDay = fields.DTSTART && fields.DTEND && start !== undefined && !start.includes(":");
  const end = allDay ? lastAllDay(fields.DTSTART!.value, fields.DTEND!.value) : fields.DTEND ? when(fields.DTEND.value, fields.DTEND.tzid, counts, options) : undefined;
  const title = text("SUMMARY", 300);
  const location = text("LOCATION", 500);
  const uid = text("UID", 255);
  const invitation: Invitation = {
    ...(title ? { title } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(location ? { location } : {}),
    ...(organizer ? { organizer } : {}),
    ...(method ? { method } : {}),
    ...(uid ? { uid } : {}),
  };
  return invitation;
}
