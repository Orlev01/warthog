// Live or finished (`./lifecycle.ts`): standing items, bookings (by time, in their own zones) and
// cases, the status words agents use, and when reminders stop.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BUILT_IN } from "./catalogue";
import { anchorSpan, bookingDueDate, bookingSpan, localDate, parseWhen, phaseOf, remindUntilOf, statusFor } from "./lifecycle";

const SYD = "Australia/Sydney";
const type = (id: string) => BUILT_IN.type(id)!;
const at = (iso: string) => new Date(iso);
const standing = (dueDate: string | null, status = "active") => ({ status, dueDate, fields: {} });

test("standing items: current, due soon, overdue, date passed, paused and ended", () => {
  const now = at("2026-11-23T01:00:00Z"); // 23 Nov in Sydney
  const rego = type("vehicles.registration");
  assert.equal(phaseOf(standing(null), rego, now, SYD).phase, "current");
  assert.equal(phaseOf(standing("2027-03-01"), rego, now, SYD).phase, "current");
  const soon = phaseOf(standing("2026-12-14"), rego, now, SYD);
  assert.deepEqual([soon.phase, soon.comingUp, soon.inDays, soon.live], ["due_soon", true, 21, true]);
  assert.equal(phaseOf(standing("2026-11-23"), rego, now, SYD).phase, "due_soon");
  assert.equal(phaseOf(standing("2026-11-10"), rego, now, SYD).phase, "overdue");
  const passed = phaseOf(standing("2026-09-01"), rego, now, SYD);
  assert.deepEqual([passed.phase, passed.live, passed.comingUp], ["date_passed", true, false]);
  const paused = phaseOf(standing("2026-12-14", "paused"), rego, now, SYD);
  assert.deepEqual([paused.phase, paused.live, paused.bucket], ["paused", false, "on_hold"]);
  for (const status of ["cancelled", "expired", "done", "ended", "closed"]) {
    assert.equal(phaseOf(standing("2026-12-14", status), rego, now, SYD).bucket, "finished", status);
  }
  assert.equal(phaseOf(standing("2026-11-20"), type("belongings.receipt"), now, SYD).phase, "ended", "a passed return-by date ends it");
  assert.equal(phaseOf(standing("2026-12-14", "price_changed"), rego, now, SYD).live, true, "an older free-form status reads as live");
});

test("bookings finish by time, in their own zone", () => {
  const dinner = type("outings.restaurant");
  const booking = (starts: string, extra: Record<string, unknown> = {}, state?: string) => ({ status: "active", state, dueDate: starts.slice(0, 10), fields: { starts_at: starts, ...extra } });
  const start = "2026-12-03T19:30+11:00[Australia/Sydney]";
  assert.equal(phaseOf(booking(start), dinner, at("2026-12-03T08:00:00Z"), SYD).phase, "upcoming");
  assert.equal(phaseOf(booking(start), dinner, at("2026-12-03T08:45:00Z"), SYD).phase, "in_progress", "within 2 hours of 7:30 pm");
  const done = phaseOf(booking(start), dinner, at("2026-12-03T11:00:00Z"), SYD);
  assert.deepEqual([done.phase, done.live, done.bucket], ["completed", false, "finished"]);
  assert.equal(phaseOf(booking(start, {}, "cancelled"), dinner, at("2026-12-01T00:00:00Z"), SYD).phase, "cancelled");
  assert.equal(phaseOf(booking(start, {}, "no_show"), dinner, at("2026-12-04T00:00:00Z"), SYD).phase, "missed");
  const pending = booking(start, { hold_until: "2026-12-01T12:00+11:00[Australia/Sydney]" }, "pending");
  assert.equal(phaseOf(pending, dinner, at("2026-11-30T00:00:00Z"), SYD).phase, "pending");
  assert.equal(phaseOf(pending, dinner, at("2026-12-02T00:00:00Z"), SYD).phase, "lapsed", "a hold that ran out");
  // A date-only booking lasts the whole day.
  const allDay = booking("2026-12-03");
  assert.equal(phaseOf(allDay, dinner, at("2026-12-03T12:00:00Z"), SYD).phase, "in_progress");
  assert.equal(phaseOf(allDay, dinner, at("2026-12-03T13:30:00Z"), SYD).phase, "completed", "after midnight in Sydney");
});

test("a flight is read in its own zone, ending in the arrival zone", () => {
  const flight = type("travel.flight");
  const fields = { starts_at: "2026-12-10T00:30+09:00[Asia/Tokyo]", ends_at: "2026-12-10T10:45+11:00[Australia/Sydney]" };
  assert.equal(bookingDueDate(fields, SYD), "2026-12-10", "the departure's own date, not Sydney's");
  const span = bookingSpan({ status: "active", dueDate: null, fields }, flight, SYD)!;
  assert.equal(span.start.toISOString(), "2026-12-09T15:30:00.000Z");
  assert.equal(span.end.toISOString(), "2026-12-09T23:45:00.000Z");
  assert.equal(phaseOf({ status: "active", dueDate: "2026-12-10", fields }, flight, at("2026-12-09T20:00:00Z"), SYD).phase, "in_progress");
});

test("wall times are read across daylight-saving changes", () => {
  // Sydney leaves daylight saving at 3 am on 5 April 2026.
  assert.equal(parseWhen("2026-04-04T12:00[Australia/Sydney]", "UTC")!.instant.toISOString(), "2026-04-04T01:00:00.000Z");
  assert.equal(parseWhen("2026-04-06T12:00[Australia/Sydney]", "UTC")!.instant.toISOString(), "2026-04-06T02:00:00.000Z");
  assert.equal(parseWhen("not a date", SYD), null);
  assert.equal(localDate(at("2026-11-22T14:00:00Z"), SYD), "2026-11-23");
});

test("a trip spans its bookings", () => {
  const span = anchorSpan([
    { start: at("2026-12-10T00:00:00Z"), end: at("2026-12-10T04:00:00Z") },
    { start: at("2026-12-10T05:00:00Z"), end: at("2026-12-14T01:00:00Z") },
  ])!;
  assert.equal(span.start.toISOString(), "2026-12-10T00:00:00.000Z");
  assert.equal(span.end.toISOString(), "2026-12-14T01:00:00.000Z");
  const trip = type("travel.trip");
  assert.equal(phaseOf({ status: "active", dueDate: null, fields: {} }, trip, at("2026-12-12T00:00:00Z"), SYD, span).phase, "in_progress");
  assert.equal(anchorSpan([]), null);
});

test("cases are open, waiting or resolved", () => {
  const fine = type("government.fine");
  assert.equal(phaseOf({ status: "active", state: "open", dueDate: "2026-12-01", fields: {} }, fine, at("2026-11-23T00:00:00Z"), SYD).comingUp, true);
  assert.equal(phaseOf({ status: "active", state: "waiting", dueDate: null, fields: {} }, fine, at("2026-11-23T00:00:00Z"), SYD).phase, "waiting");
  assert.equal(phaseOf({ status: "done", state: "resolved", dueDate: null, fields: {} }, fine, at("2026-11-23T00:00:00Z"), SYD).bucket, "finished");
});

test("status words become the kind's status and state", () => {
  assert.deepEqual(statusFor(type("vehicles.registration"), "Canceled"), { status: "cancelled" });
  assert.deepEqual(statusFor(type("outings.restaurant"), "ReservationConfirmed"), { status: "active", state: "confirmed" });
  assert.deepEqual(statusFor(type("outings.restaurant"), "hold"), { status: "active", state: "pending" });
  assert.deepEqual(statusFor(type("outings.restaurant"), "cancelled"), { status: "cancelled", state: "cancelled" });
  assert.deepEqual(statusFor(type("outings.restaurant"), "no show"), { status: "done", state: "no_show" });
  assert.deepEqual(statusFor(type("government.fine"), "under review"), { status: "active", state: "waiting" });
  assert.deepEqual(statusFor(type("government.fine"), "paid"), { status: "done", state: "resolved" });
  assert.equal(statusFor(type("vehicles.registration"), "sideways"), null);
});

test("reminders stop for anything finished, paused or undated", () => {
  const rego = type("vehicles.registration");
  assert.equal(remindUntilOf(rego, "active", null, "2026-12-14"), "2026-12-21");
  assert.equal(remindUntilOf(rego, "paused", null, "2026-12-14"), null);
  assert.equal(remindUntilOf(rego, "cancelled", null, "2026-12-14"), null);
  assert.equal(remindUntilOf(rego, "active", null, null), null);
  assert.equal(remindUntilOf(type("outings.restaurant"), "active", "confirmed", "2026-12-03"), "2026-12-03");
  assert.equal(remindUntilOf(type("outings.restaurant"), "cancelled", "cancelled", "2026-12-03"), null);
  assert.equal(remindUntilOf(type("government.fine"), "done", "resolved", "2026-12-03"), null);
});
