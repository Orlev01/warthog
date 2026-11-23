// Live or finished (docs/adr/life-admin-profile.md, "Lifecycle"): the one place that decides
// where any life-admin record stands — a standing item (current, due soon, overdue, paused,
// ended), a booking (pending, upcoming, in progress, completed, cancelled, missed, lapsed) or a
// case (open, waiting, resolved).
//
// Nothing is swept or stored: a booking finishes by time when it is read, and a standing item or
// case finishes only when someone sets its status (which is journaled). Agents see live records
// by default; finished ones keep their history and stay one call away.
//
// A booking's detailed state (pending, confirmed, cancelled, no-show) is kept encrypted; the
// plaintext status holds only a coarse word (active, cancelled, done), so no plaintext column
// says a record is a booking.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now — "now" and the
// person's time zone are passed in.

import type { RecordTypeDef } from "./record-types";

export const WINDOWS = { comingUpDays: 60, overdueShownDays: 30, reminderGraceDays: 7 } as const;

export type Phase =
  | "current" | "due_soon" | "overdue" | "date_passed" | "paused" | "ended"
  | "pending" | "lapsed" | "upcoming" | "in_progress" | "completed" | "cancelled" | "missed"
  | "open" | "waiting" | "resolved";

export type Bucket = "live" | "on_hold" | "finished";

export interface PhaseView {
  readonly phase: Phase;
  readonly live: boolean;
  readonly bucket: Bucket;
  // Belongs in "coming up": due or happening within the window, or recently overdue.
  readonly comingUp: boolean;
  readonly label: string;
  // When a booking (or a trip's span) starts and ends.
  readonly starts?: Date;
  readonly ends?: Date;
  // Whole days from the person's today to the due or start date (negative when past).
  readonly inDays?: number;
}

export const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  current: "Current", due_soon: "Due soon", overdue: "Overdue", date_passed: "Date passed. Still current?",
  paused: "Paused", ended: "Ended", pending: "Waiting to be confirmed", lapsed: "Lapsed", upcoming: "Upcoming",
  in_progress: "Happening now", completed: "Completed", cancelled: "Cancelled", missed: "Missed",
  open: "Open", waiting: "Waiting", resolved: "Resolved",
};

const FINISHED: ReadonlySet<Phase> = new Set(["ended", "lapsed", "completed", "cancelled", "missed", "resolved"]);

// ---- statuses ------------------------------------------------------------------------------

export const RECORD_STATUSES = ["active", "paused", "cancelled", "expired", "done"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export type BookingState = "pending" | "confirmed" | "cancelled" | "no_show";
export type CaseState = "open" | "waiting" | "resolved";

const STANDING_WORDS: Readonly<Record<string, RecordStatus>> = {
  active: "active", current: "active", ok: "active", renewed: "active", confirmed: "active", open: "active",
  paused: "paused", on_hold: "paused",
  cancelled: "cancelled", canceled: "cancelled", ended: "cancelled", closed: "cancelled",
  expired: "expired", lapsed: "expired",
  done: "done", completed: "done", finished: "done", resolved: "done",
};
const BOOKING_WORDS: Readonly<Record<string, BookingState>> = {
  confirmed: "confirmed", booked: "confirmed", active: "confirmed", reservationconfirmed: "confirmed", scheduled: "confirmed",
  pending: "pending", hold: "pending", held: "pending", requested: "pending", waitlist: "pending", reservationpending: "pending", reservationhold: "pending", tentative: "pending",
  cancelled: "cancelled", canceled: "cancelled", reservationcancelled: "cancelled",
  no_show: "no_show", noshow: "no_show", missed: "no_show",
};
const CASE_WORDS: Readonly<Record<string, CaseState>> = {
  open: "open", active: "open", new: "open", submitted: "open", lodged: "open",
  waiting: "waiting", under_review: "waiting", in_review: "waiting", escalated: "waiting", pending: "waiting", on_hold: "waiting",
  resolved: "resolved", done: "resolved", closed: "resolved", cancelled: "resolved", canceled: "resolved", withdrawn: "resolved", paid: "resolved", approved: "resolved", declined: "resolved", rejected: "resolved",
};

const word = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, "_");

export interface StatusChoice {
  readonly status: RecordStatus;
  readonly state?: BookingState | CaseState;
}

/** A status word as this kind's plaintext status (and, for bookings and cases, its encrypted state); null when unknown. */
export function statusFor(type: Pick<RecordTypeDef, "lifecycle">, value: string): StatusChoice | null {
  const w = word(value);
  if (type.lifecycle === "booking") {
    if (w === "done" || w === "completed" || w === "finished") return { status: "done", state: "confirmed" };
    const state = BOOKING_WORDS[w];
    if (!state) return null;
    return { status: state === "cancelled" ? "cancelled" : state === "no_show" ? "done" : "active", state };
  }
  if (type.lifecycle === "case") {
    const state = CASE_WORDS[w];
    if (!state) return null;
    return { status: state === "resolved" ? "done" : "active", state };
  }
  const status = STANDING_WORDS[w];
  return status ? { status } : null;
}

// Statuses that end a record however it was saved (older free-form statuses included).
const ENDED_WORDS = new Set(["cancelled", "canceled", "expired", "done", "ended", "closed", "completed", "finished", "resolved", "lapsed"]);
const PAUSED_WORDS = new Set(["paused", "on_hold"]);

// ---- dates and times -----------------------------------------------------------------------

// "2026-12-03T19:30+11:00[Australia/Sydney]", "2026-12-03T19:30[Australia/Sydney]",
// "2026-12-03T19:30+11:00", "2026-12-03T19:30" or "2026-12-03".
const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?(?:\[([A-Za-z0-9_+\-/]+)\])?$/;

/** The UTC offset of a time zone at an instant, in minutes (Intl; falls back to 0 for an unknown zone). */
export function zoneOffsetMinutes(zone: string, at: Date): number {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part);
    if (!match) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return 0;
  }
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface When {
  readonly instant: Date;
  // The calendar date where it happens (YYYY-MM-DD).
  readonly date: string;
  readonly dateOnly: boolean;
  readonly zone: string;
}

/** A stored date or date-time, read in its own zone (or `fallbackZone`). Null when it isn't one. */
export function parseWhen(value: unknown, fallbackZone: string): When | null {
  if (typeof value !== "string") return null;
  const match = WHEN.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, offset, bracket] = match;
  const zone = bracket && isTimeZone(bracket) ? bracket : fallbackZone;
  const date = `${y}-${mo}-${d}`;
  const localMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  if (!Number.isFinite(localMs)) return null;
  let instantMs: number;
  if (offset) {
    const sign = offset === "Z" ? 1 : offset.startsWith("-") ? -1 : 1;
    const digits = offset === "Z" ? "0000" : offset.replace(/[+:-]/g, "");
    instantMs = localMs - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  } else {
    // Local wall time in the zone: correct the guess once for the offset at that instant.
    const guess = localMs - zoneOffsetMinutes(zone, new Date(localMs)) * 60_000;
    instantMs = localMs - zoneOffsetMinutes(zone, new Date(guess)) * 60_000;
  }
  return { instant: new Date(instantMs), date, dateOnly: h === undefined, zone };
}

/** The calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: isTimeZone(zone) ? zone : "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** The end of a local day, as an instant. */
function endOfDay(date: string, zone: string): Date {
  return new Date(parseWhen(`${addDays(date, 1)}T00:00`, zone)!.instant.getTime() - 1);
}

// ---- phases --------------------------------------------------------------------------------

export interface PhaseInput {
  readonly status: string;
  // A booking's or case's detailed state (decrypted from the record's meta).
  readonly state?: string | null;
  readonly dueDate: string | Date | null;
  readonly fields: Readonly<Record<string, unknown>>;
}

function dateOf(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function view(phase: Phase, extra: Partial<PhaseView> = {}): PhaseView {
  const finished = FINISHED.has(phase);
  return {
    phase,
    live: !finished && phase !== "paused",
    bucket: finished ? "finished" : phase === "paused" ? "on_hold" : "live",
    comingUp: false,
    label: PHASE_LABELS[phase],
    ...extra,
  };
}

/** When a booking starts and ends (its own fields, else its due date), or a trip's span from its bookings. */
export function bookingSpan(item: PhaseInput, type: RecordTypeDef, zone: string): { start: Date; end: Date; startDate: string } | null {
  const start = parseWhen(item.fields.starts_at, zone) ?? (dateOf(item.dueDate) ? parseWhen(dateOf(item.dueDate), zone) : null);
  if (!start) return null;
  const endField = parseWhen(item.fields.ends_at, start.zone);
  const end = endField
    ? (endField.dateOnly ? endOfDay(endField.date, endField.zone) : endField.instant)
    : start.dateOnly
      ? endOfDay(start.date, start.zone)
      : new Date(start.instant.getTime() + (type.defaultMinutes ?? 60) * 60_000);
  return { start: start.instant, end: end.getTime() >= start.instant.getTime() ? end : start.instant, startDate: start.date };
}

/** A trip's (or any anchor's) span: the earliest start and latest end of its live bookings. */
export function anchorSpan(spans: readonly { start: Date; end: Date }[]): { start: Date; end: Date } | null {
  if (spans.length === 0) return null;
  return {
    start: new Date(Math.min(...spans.map((span) => span.start.getTime()))),
    end: new Date(Math.max(...spans.map((span) => span.end.getTime()))),
  };
}

/** Where a record stands now. `span` overrides a booking's own dates (a trip's, from its bookings). */
export function phaseOf(
  item: PhaseInput,
  type: RecordTypeDef,
  now: Date,
  zone: string,
  span?: { start: Date; end: Date } | null,
): PhaseView {
  const status = word(item.status);
  const today = localDate(now, zone);
  const due = dateOf(item.dueDate);
  const inDays = due ? daysBetween(today, due) : undefined;
  const dueComingUp = inDays !== undefined && inDays <= WINDOWS.comingUpDays && inDays >= -WINDOWS.overdueShownDays;

  if (type.lifecycle === "booking") {
    const state = item.state ? word(item.state) : status === "cancelled" ? "cancelled" : "confirmed";
    if (state === "cancelled" || status === "cancelled") return view("cancelled");
    if (state === "no_show") return view("missed");
    const own = bookingSpan(item, type, zone);
    const times = span ?? (own ? { start: own.start, end: own.end } : null);
    const startDays = times ? daysBetween(today, localDate(times.start, zone)) : undefined;
    const when = times ? { starts: times.start, ends: times.end, inDays: startDays } : {};
    if (ENDED_WORDS.has(status)) return view("completed", when);
    if (state === "pending") {
      const hold = parseWhen(item.fields.hold_until, zone);
      if ((hold && now >= hold.instant) || (times && now >= times.start)) return view("lapsed", when);
      return view("pending", { ...when, comingUp: startDays !== undefined && startDays <= WINDOWS.comingUpDays });
    }
    if (!times) return view("upcoming");
    if (now < times.start) return view("upcoming", { ...when, comingUp: startDays! <= WINDOWS.comingUpDays });
    if (now < times.end) return view("in_progress", { ...when, comingUp: true });
    return view("completed", when);
  }

  if (type.lifecycle === "case") {
    const state = item.state ? word(item.state) : null;
    if (state === "resolved" || ENDED_WORDS.has(status)) return view("resolved", inDays !== undefined ? { inDays } : {});
    return view(state === "waiting" ? "waiting" : "open", { comingUp: dueComingUp, ...(inDays !== undefined ? { inDays } : {}) });
  }

  if (ENDED_WORDS.has(status)) return view("ended", inDays !== undefined ? { inDays } : {});
  if (PAUSED_WORDS.has(status)) return view("paused", inDays !== undefined ? { inDays } : {});
  if (inDays === undefined || inDays > WINDOWS.comingUpDays) return view("current", inDays !== undefined ? { inDays } : {});
  if (inDays >= 0) return view("due_soon", { comingUp: true, inDays });
  // A passed return-by date simply ends the chance to return it.
  if (type.due?.means === "return_by") return view("ended", { inDays });
  if (inDays >= -WINDOWS.overdueShownDays) return view("overdue", { comingUp: true, inDays });
  return view("date_passed", { inDays });
}

/**
 * The last day a record's reminders may go out (plaintext, so the keyless reminders job needs no
 * status list): due + grace for a live standing item or case, the start date for a live booking,
 * none for anything finished, paused or undated.
 */
export function remindUntilOf(type: Pick<RecordTypeDef, "lifecycle">, status: string, state: string | null | undefined, dueDate: string | Date | null): string | null {
  const due = dateOf(dueDate);
  if (!due) return null;
  const s = word(status);
  if (ENDED_WORDS.has(s) || PAUSED_WORDS.has(s)) return null;
  if (type.lifecycle === "booking") {
    const st = state ? word(state) : "confirmed";
    return st === "cancelled" || st === "no_show" ? null : due;
  }
  if (type.lifecycle === "case" && state && word(state) === "resolved") return null;
  return addDays(due, WINDOWS.reminderGraceDays);
}

/** A booking's due date: the local date its start falls on, in its own zone. */
export function bookingDueDate(fields: Readonly<Record<string, unknown>>, zone: string): string | null {
  return parseWhen(fields.starts_at, zone)?.date ?? null;
}
