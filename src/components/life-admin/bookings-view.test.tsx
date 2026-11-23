// The Bookings tab (docs/adr/life-admin-profile.md): every booking from every category, built-in
// or the person's own, live (waiting to be confirmed, upcoming, happening now; soonest first)
// and past (completed, cancelled, missed, lapsed; newest first, by month, 30 to a page). Plain
// GET filters by category, who it's for and state, each multiple-choice (the same filter the
// Records tab uses). Each row says where it stands in words and an icon, its category, the
// anchor it belongs to and who is handling it, and links to the item's page.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";
import { bookingsView } from "./record-groups";
import { BUILT_IN, buildCatalogue } from "@/domain/life-admin/catalogue";
import { phased } from "./phase-fixture";

const TODAY = "2026-11-23";
const ZONE = "Australia/Sydney";

function booking(id: string, type: string, fields: Record<string, string>, over: Partial<LifeAdminRecordView> = {}): LifeAdminRecordView {
  const dueDate = fields.starts_at ? fields.starts_at.slice(0, 10) : null;
  return phased({ id, kind: "item", type, fields, dueDate, status: "active", state: "confirmed", reminderOffsets: [1, 0], ...over });
}

const TRIP = booking("trip", "travel.trip", { name: "Tokyo" });
const FLIGHT = booking("flight", "travel.flight", { provider: "Qantas", reference: "QF25", starts_at: "2026-12-03T09:00+11:00[Australia/Sydney]" }, { parentId: "trip", handling: { steward: "Instinct" } });
const PENDING = booking("hold", "outings.restaurant", { provider: "Sixpenny", starts_at: "2026-11-28T19:30+11:00[Australia/Sydney]", for_whom: "Mum" }, { state: "pending" });
const NOW_STAY = booking("stay", "travel.stay", { provider: "Park Hyatt", starts_at: "2026-11-22T15:00+11:00[Australia/Sydney]", ends_at: "2026-11-24T11:00+11:00[Australia/Sydney]" });
const PAST_DINNER = booking("ester", "outings.restaurant", { provider: "Ester", starts_at: "2026-10-02T19:00+10:00[Australia/Sydney]" });
const CANCELLED = booking("cancelled", "health.appointment", { provider: "Dr Lee", starts_at: "2026-10-20T09:00+11:00[Australia/Sydney]" }, { status: "cancelled", state: "cancelled" });
const MISSED = booking("missed", "outings.beauty", { provider: "Salon", starts_at: "2026-09-10T10:00+10:00[Australia/Sydney]", for_whom: "Mum" }, { status: "done", state: "no_show" });
const STANDING = phased({ id: "rego", kind: "item", type: "vehicles.registration", fields: { plate: "BX12AB" }, dueDate: "2026-12-14", status: "active", reminderOffsets: [] });

const ALL = [TRIP, FLIGHT, PENDING, NOW_STAY, PAST_DINNER, CANCELLED, MISSED, STANDING];

function render(over: Partial<LifeAdminViewProps> = {}): string {
  return renderToStaticMarkup(<LifeAdminView today={TODAY} zone={ZONE} records={ALL} checklist={[]} initialTab="bookings" {...over} />);
}

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

function bookingsPanel(markup: string): string {
  const starts = [...markup.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map((m) => m.index!);
  return markup.slice(starts[2], starts[3]);
}

test("live bookings soonest first (waiting, upcoming, happening now); past ones newest first by month; standing items never", () => {
  const view = bookingsView(ALL, BUILT_IN, {}, ZONE);
  assert.deepEqual(view.live.map((row) => [row.record.id, row.record.phase!.phase]), [["stay", "in_progress"], ["hold", "pending"], ["flight", "upcoming"], ["trip", "upcoming"]]);
  assert.deepEqual(view.past.map((month) => [month.label, month.rows.map((row) => row.record.id)]), [
    ["October 2026", ["cancelled", "ester"]],
    ["September 2026", ["missed"]],
  ]);
  assert.equal(view.pastTotal, 3);
  assert.equal(view.live.find((row) => row.record.id === "flight")!.anchor?.id, "trip", "a booking knows the anchor it belongs to");
  assert.deepEqual(view.options.forWhom, ["Mum"]);
  assert.deepEqual(view.options.categories.map((category) => category.id), ["travel", "health", "outings"]);
});

test("filters narrow both parts by category, who it's for and state; a value that matches nothing shows nothing", () => {
  assert.deepEqual(bookingsView(ALL, BUILT_IN, { categories: ["outings"] }, ZONE).live.map((row) => row.record.id), ["hold"]);
  const mum = bookingsView(ALL, BUILT_IN, { forWhom: ["mum"] }, ZONE);
  assert.deepEqual([mum.live.map((row) => row.record.id), mum.past.flatMap((month) => month.rows.map((row) => row.record.id))], [["hold"], ["missed"]]);
  const cancelled = bookingsView(ALL, BUILT_IN, { states: ["cancelled"] }, ZONE);
  assert.deepEqual([cancelled.live.length, cancelled.pastTotal], [0, 1]);
  assert.deepEqual(bookingsView(ALL, BUILT_IN, { categories: ["pets"] }, ZONE).total, ALL.length - 1, "the total is every booking; the lists are what matches");
});

test("each filter takes several values, and offers what's chosen even when nothing matches it, with counts", () => {
  const several = bookingsView(ALL, BUILT_IN, { categories: ["outings", "health"], states: ["pending", "cancelled", "missed"] }, ZONE);
  assert.deepEqual([several.live.map((row) => row.record.id), several.past.flatMap((month) => month.rows.map((row) => row.record.id))], [["hold"], ["cancelled", "missed"]]);
  const pets = bookingsView(ALL, BUILT_IN, { categories: ["pets"], forWhom: ["Sam"], states: ["lapsed"] }, ZONE);
  assert.ok(pets.options.categories.some((category) => category.id === "pets"), "a chosen category can be unticked");
  assert.ok(pets.options.forWhom.includes("Sam"));
  assert.ok(pets.options.states.some((state) => state.phase === "lapsed"));
  const counted = bookingsView(ALL, BUILT_IN, { states: ["upcoming"] }, ZONE);
  assert.deepEqual([counted.counts.categories.travel, counted.counts.categories.outings], [2, 0], "categories count what the other filters leave");
  assert.deepEqual([counted.counts.states.upcoming, counted.counts.states.completed], [2, 1], "states count across every state");
});

test("past bookings are paged 30 at a time", () => {
  const many = Array.from({ length: 65 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 9, 31) - index * 86_400_000).toISOString().slice(0, 10);
    return booking(`b${index}`, "outings.restaurant", { provider: `Place ${index}`, starts_at: `${day}T19:00+10:00[Australia/Sydney]` });
  });
  const first = bookingsView(many, BUILT_IN, {}, ZONE);
  assert.deepEqual([first.page, first.pages, first.past.flatMap((month) => month.rows).length], [1, 3, 30]);
  const last = bookingsView(many, BUILT_IN, { page: 9 }, ZONE);
  assert.deepEqual([last.page, last.past.flatMap((month) => month.rows).length, last.past.at(-1)!.rows.at(-1)!.record.id], [3, 5, "b64"], "a page past the end shows the last one");
});

test("a custom category's bookings are bookings too", () => {
  const catalogue = buildCatalogue([{ slug: "x_7kq2mz", state: "active", definition: { label: "Rowing club", description: "d", lifeArea: "everyday", icon: "trophy", kinds: [{ key: "regatta", label: "Regatta", lifecycle: "booking", use: "u", fields: [] }] } }]);
  const regatta: LifeAdminRecordView = { id: "reg", kind: "item", type: "x_7kq2mz.regatta", fields: { provider: "Head of the Harbour", starts_at: "2026-12-12T08:00+11:00[Australia/Sydney]" }, dueDate: "2026-12-12", status: "active", reminderOffsets: [], phase: { phase: "upcoming", bucket: "live", live: true, label: "Upcoming", comingUp: true, inDays: 19 } };
  const view = bookingsView([regatta], catalogue, {}, ZONE);
  assert.deepEqual(view.live.map((row) => [row.record.id, row.category?.label]), [["reg", "Rowing club"]]);
});

test("each row: its state in words and an icon, its name linking to the item, kind, category, when, who for, the anchor and who is handling it", () => {
  const panel = bookingsPanel(render());
  const flight = panel.slice(panel.indexOf('href="/life-admin/items/flight"') - 1200, panel.indexOf('href="/life-admin/items/flight"') + 1500);
  assert.match(flight, /<span class="wh-badge[^"]*"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg>Upcoming<\/span>/, "a badge with an icon and the word");
  assert.match(text(flight), /Upcoming Flight · QF25 Flight · Trips and travel · Starts Thu 3 Dec, 9:00 am AEDT/, "a flight goes by its reference");
  assert.match(text(flight), /Part of Tokyo/);
  assert.match(text(flight), /Handled by Instinct/);
  assert.match(text(panel), /Waiting to be confirmed Sixpenny Restaurant · Going out · Starts Sat 28 Nov, 7:30 pm AEDT · For Mum/);
  assert.match(text(panel), /Missed Salon/);
  assert.doesNotMatch(text(panel), /BX12AB/, "a standing item isn't a booking");
});

test("the filters are the same multiple-choice filters as Records, in a plain GET form that keeps the tab, with removable chips and live counts", () => {
  const panel = bookingsPanel(render({ bookingFilters: { categories: ["outings"], forWhom: ["Mum"] } }));
  const form = /<form\b[^>]*aria-label="Filter bookings"[^>]*>([\s\S]*?)<\/form>/.exec(panel)!;
  assert.ok(form, "a GET form, so it works without JavaScript and Back/Forward keep it");
  assert.doesNotMatch(form[0], /method="post"/i);
  assert.match(form[1]!, /<input type="hidden" name="view" value="life"\/><input type="hidden" name="tab" value="bookings"\/>/);
  const summaries = [...form[1]!.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => text(m[1]!));
  assert.deepEqual(summaries, ["Category: Going out", "For: Mum", "State: Any"]);
  const boxes = [...form[1]!.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]).map((box) => [/name="([^"]+)"/.exec(box)![1], /value="([^"]+)"/.exec(box)![1], /\bchecked=""/.test(box)]);
  assert.deepEqual(boxes.filter(([, , checked]) => checked), [["category", "outings", true], ["for_whom", "Mum", true]], "the chosen values are ticked");
  assert.ok(boxes.some(([name, value]) => name === "state" && value === "upcoming"), "every state there is can be chosen");
  assert.match(form[1]!, /type="submit"[^>]*>Apply</, "Apply, for when there's no JavaScript");
  assert.match(panel, /href="\/life-admin\?for_whom=Mum&amp;tab=bookings&amp;view=life"[^>]*>[\s\S]*?Category: Going out/, "removing one filter keeps the other");
  assert.match(text(panel), /1 live · 1 past \(filtered\)/);
});

test("past bookings page with Newer and Older links that keep the filters", () => {
  const many = Array.from({ length: 35 }, (_, index) => booking(`b${index}`, "outings.restaurant", { provider: `Place ${index}`, starts_at: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T19:00+11:00[Australia/Sydney]` }));
  const first = bookingsPanel(render({ records: many, bookingFilters: { categories: ["outings"] } }));
  assert.match(first, /href="\/life-admin\?category=outings&amp;page=2&amp;tab=bookings&amp;view=life"[^>]*>Older/);
  assert.match(text(first), /Page 1 of 2/);
  const second = bookingsPanel(render({ records: many, bookingFilters: { categories: ["outings"], page: 2 } }));
  assert.match(second, /href="\/life-admin\?category=outings&amp;tab=bookings&amp;view=life"[^>]*>Newer/);
});

test("no bookings yet says how to add one, under Records", () => {
  const panel = bookingsPanel(render({ records: [STANDING] }));
  assert.match(text(panel), /No bookings yet\. Ask your agent to look for booking confirmations in your email, or add one yourself under Records\./);
  assert.match(panel, /href="\/life-admin\?view=life&amp;tab=records#new-record"[^>]*>Add a booking/);
});
