// Read-side protection — the event inside an email invitation (a text/calendar part), as an
// agent reads it (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now. A small,
// linear line parser for the handful of iCalendar fields an agent needs to add an invitation
// to a calendar: what, when, where and who sent it.

import { cleanText, type FilterCounts } from "./text-filters";

/** The event an invitation describes. */
export interface Invitation {
  readonly title?: string;
  readonly start?: string;
  readonly end?: string;
  readonly location?: string;
  readonly organizer?: string;
  /** REQUEST (an invitation), CANCEL (a cancellation) or REPLY. */
  readonly method?: string;
}

// "20261120T100000Z" → "2026-11-20 10:00 UTC"; "20261120" → "2026-11-20"; with a TZID it keeps the zone.
function when(value: string, tzid: string | undefined): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, m, d, hh, mm, , z] = match;
  if (!hh) return `${y}-${m}-${d}`;
  const zone = z ? " UTC" : tzid ? ` (${tzid.replace(/^"|"$/g, "").slice(0, 60)})` : "";
  return `${y}-${m}-${d} ${hh}:${mm}${zone}`;
}

// Undo iCalendar text escaping (\n, \, \; \\).
function unescape(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/** The first event of an iCalendar document, or null when there is none. */
export function parseInvitation(ics: string, counts: FilterCounts): Invitation | null {
  // Unfold continuation lines (a line starting with a space or tab continues the one above).
  const lines = ics.slice(0, 200_000).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  let method: string | undefined;
  let inEvent = false;
  const fields: Record<string, { value: string; tzid?: string }> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name, ...params] = head.split(";");
    const key = name!.toUpperCase();
    if (key === "METHOD" && !inEvent) method = value.trim().toUpperCase().slice(0, 20);
    if (key === "BEGIN" && value.trim().toUpperCase() === "VEVENT") inEvent = true;
    else if (key === "END" && value.trim().toUpperCase() === "VEVENT") break;
    else if (inEvent && ["SUMMARY", "DTSTART", "DTEND", "LOCATION", "ORGANIZER"].includes(key) && !fields[key]) {
      const tzid = params.find((param) => param.toUpperCase().startsWith("TZID="))?.slice(5);
      fields[key] = { value, ...(tzid ? { tzid } : {}) };
    }
  }
  if (!inEvent) return null;
  const text = (key: string, max: number) => (fields[key] ? cleanText(unescape(fields[key]!.value).slice(0, max), counts) : undefined);
  const organizer = fields.ORGANIZER?.value.replace(/^mailto:/i, "").trim().slice(0, 254);
  const invitation: Invitation = {
    ...(text("SUMMARY", 300) ? { title: text("SUMMARY", 300) } : {}),
    ...(fields.DTSTART && when(fields.DTSTART.value, fields.DTSTART.tzid) ? { start: when(fields.DTSTART.value, fields.DTSTART.tzid) } : {}),
    ...(fields.DTEND && when(fields.DTEND.value, fields.DTEND.tzid) ? { end: when(fields.DTEND.value, fields.DTEND.tzid) } : {}),
    ...(text("LOCATION", 500) ? { location: text("LOCATION", 500) } : {}),
    ...(organizer ? { organizer } : {}),
    ...(method ? { method } : {}),
  };
  return invitation;
}
