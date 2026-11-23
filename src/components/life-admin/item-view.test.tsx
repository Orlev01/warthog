// An item's own page (docs/adr/life-admin-journal.md): the heading names the item, its kind,
// category and where it stands; "Where it stands" is the one line agents get; Next steps (each
// with Mark done; done ones collapsed); Decisions (replaced ones collapsed, "Replaced by …");
// Notes and hand-over notes; one form to add a note, decision or next step (280 characters,
// said beside the box); "Handled by" (the person's connected agents, or no one); and History —
// Warthog's own changes by day and by who, collapsed, with "See in Activity". Finished items
// keep all of it. Nothing anyone wrote becomes a link.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminItemView } from "./item-view";
import { BUILT_IN } from "@/domain/life-admin/catalogue";
import type { LifeAdminItemData } from "./record-view-types";

const noop = () => {};
const ID = "0f8a4b2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c";

const DATA: LifeAdminItemData = {
  today: "2026-11-23",
  zone: "Australia/Sydney",
  record: {
    id: ID,
    kind: "item",
    type: "outings.restaurant",
    fields: { provider: "Ester", reference: "E-77", starts_at: "2026-11-20T19:00+11:00[Australia/Sydney]", notes: "See https://pay.example.test/now" },
    dueDate: "2026-11-20",
    status: "active",
    state: "confirmed",
    reminderOffsets: [1, 0],
    reviewState: "confirmed",
    addedBy: { kind: "agent", agentId: "a1", name: "Instinct" },
    phase: { phase: "completed", bucket: "finished", live: false, label: "Completed", comingUp: false, inDays: -3 },
  },
  type: BUILT_IN.type("outings.restaurant")!,
  name: "Ester",
  kindLabel: "Restaurant",
  categoryLabel: "Going out",
  lifecycle: "booking",
  whereItStands: "Ester · starts 20 Nov, 3 days ago · decided: Move to the 8 pm sitting (Muse, 19 Nov) · handled by Instinct · last touched today by you",
  parent: { id: "11111111-1111-4111-8111-111111111111", name: "Sam's birthday", kindLabel: "Trip" },
  children: [],
  steward: { agentId: "a1", name: "Instinct" },
  agents: [{ id: "a1", name: "Instinct" }, { id: "a2", name: "Muse" }],
  openSteps: [{ id: "s2", at: "2026-11-19T01:00:00.000Z", when: "19 Nov", by: "Muse", text: "Leave a review at https://reviews.example.test", due: "2026-11-25" }],
  doneSteps: [{ id: "s1", at: "2026-11-17T01:00:00.000Z", when: "17 Nov", by: "Instinct", text: "Confirm numbers", due: "2026-11-18", doneWhen: "19 Nov", doneBy: "Muse" }],
  decisions: [{ id: "d2", at: "2026-11-19T01:00:00.000Z", when: "19 Nov", by: "Muse", text: "Move to the 8 pm sitting" }],
  replaced: [{ id: "d1", at: "2026-11-17T01:00:00.000Z", when: "17 Nov", by: "Instinct", text: "Book Ester for Sam's birthday", replacedBy: "Move to the 8 pm sitting" }],
  notes: [{ id: "n1", at: "2026-11-18T01:00:00.000Z", when: "18 Nov", by: "You", text: "Sam is vegetarian." }],
  handovers: [{ id: "h1", at: "2026-11-19T01:00:00.000Z", when: "19 Nov", by: "Muse", text: "All set; deposit paid on the card." }],
  history: [
    { day: "Mon 23 Nov 2026", groups: [{ by: "You", lines: ["You confirmed this"] }] },
    { day: "Tue 17 Nov 2026", groups: [{ by: "Instinct", lines: ["Instinct is handling this", "Instinct added this"] }] },
  ],
  entries: 9,
};

function render(data: LifeAdminItemData | null = DATA, actions = true): string {
  return renderToStaticMarkup(
    <LifeAdminItemView
      data={data}
      {...(actions ? { addJournalAction: noop, markNextDoneAction: noop, setStewardAction: noop } : {})}
    />,
  );
}

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

function panelOf(markup: string, title: string): string {
  const at = markup.search(new RegExp(`<h2\\b[^>]*>${title}</h2>`));
  assert.ok(at >= 0, `a "${title}" panel renders`);
  const start = markup.lastIndexOf("<section", at);
  const next = markup.slice(at).search(/<section aria-labelledby="[^"]*" class="wh-panel[ "]/);
  return markup.slice(start, next < 0 ? undefined : at + next);
}

test("the heading names the item, its kind and category, and where it stands in words and an icon", () => {
  const markup = render();
  const heading = /<header class="wh-page-heading">([\s\S]*?)<\/header>/.exec(markup)![1]!;
  assert.match(text(heading), /^Life admin Ester Restaurant · Going out Completed Back to Life admin$/);
  assert.match(heading, /<svg[^>]*aria-hidden="true"[\s\S]*?<\/svg>Completed/);
  assert.match(heading, new RegExp(`href="/life-admin\\?view=life&amp;tab=records&amp;status=active&amp;status=finished#record-${ID}"`), "back to its row, with its status shown");
});

test("Where it stands is the agents' one-line summary, with the item's facts, provenance and the anchor it belongs to", () => {
  const panel = text(panelOf(render(), "Where it stands"));
  assert.match(panel, /Ester · starts 20 Nov, 3 days ago · decided: Move to the 8 pm sitting \(Muse, 19 Nov\) · handled by Instinct · last touched today by you/);
  assert.match(panel, /Restaurant · Starts Fri 20 Nov, 7:00 pm AEDT/);
  assert.match(panel, /Reference E-77/);
  assert.match(panel, /Added by Instinct\./);
  assert.match(panel, /Part of Sam's birthday \(Trip\)/);
});

test("Next steps: each open one with Mark done posting its record and step; done ones collapsed with who and when", () => {
  const panel = panelOf(render(), "Next steps");
  assert.match(text(panel), /Leave a review at https:\/\/reviews\.example\.test Muse · 19 Nov Due 25 Nov/);
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(panel)![1]!;
  assert.match(form, /<input type="hidden" name="recordId" value="0f8a4b2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c"\/><input type="hidden" name="stepId" value="s2"\/>/);
  assert.match(text(form), /Mark done : Leave a review/);
  const done = /<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/.exec(panel)![1]!;
  assert.match(text(done), /^Done 1 Confirm numbers Instinct · 17 Nov Done 19 Nov by Muse$/);
});

test("Decisions: the ones in force, and replaced ones collapsed with what replaced them", () => {
  const panel = panelOf(render(), "Decisions");
  assert.match(text(panel), /Move to the 8 pm sitting Muse · 19 Nov/);
  const replaced = /<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/.exec(panel)![1]!;
  assert.match(text(replaced), /^Replaced 1 Book Ester for Sam's birthday Instinct · 17 Nov Replaced by: Move to the 8 pm sitting$/);
});

test("Notes and hand-over notes say who wrote them", () => {
  const panel = text(panelOf(render(), "Notes"));
  assert.match(panel, /Hand-over notes 1 All set; deposit paid on the card\. Muse · 19 Nov/);
  assert.match(panel, /Notes 1 Sam is vegetarian\. You · 18 Nov/);
});

test("one form adds a note, a decision or a next step: 280 characters, said beside the box, and an optional due date", () => {
  const panel = panelOf(render(), "Add a note or decision");
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(panel)![1]!;
  assert.match(form, /<input type="hidden" name="recordId" value="0f8a4b2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c"\/>/);
  assert.deepEqual([...(/<select[^>]*name="entryKind"[^>]*>([\s\S]*?)<\/select>/.exec(form)![1]!).matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]), [
    ["note", "A note"],
    ["decision", "A decision, and why"],
    ["next", "A next step"],
  ]);
  assert.match(form, /<textarea[^>]*maxLength="280"[^>]*name="text"|<textarea[^>]*name="text"[^>]*maxLength="280"/);
  assert.match(text(form), /One or two lines, up to 280 characters \(0 used\)\. Never passwords, card, bank or ID numbers\./);
  assert.match(form, /type="date"[^>]*name="due"|name="due"[^>]*type="date"/);
  assert.match(form, /wh-button[^"]*bg-accent[^>]*>Add to the log/, "the page's one primary action");
});

test("Handled by offers the person's connected agents and No one, saying it's a label only", () => {
  const panel = panelOf(render(), "Handled by");
  assert.match(text(panel), /Instinct is handling this\./);
  assert.deepEqual([...(/<select[^>]*name="agentId"[^>]*>([\s\S]*?)<\/select>/.exec(panel)![1]!).matchAll(/<option value="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]), [
    ["none", "No one"],
    ["a1", "Instinct"],
    ["a2", "Muse"],
  ]);
  assert.match(panel, /<option value="a1" selected="">Instinct<\/option>/);
  assert.match(text(panel), /It never changes what an agent can see or do\./);
});

test("History: Warthog's own changes by day and by who, collapsed, with See in Activity", () => {
  const panel = panelOf(render(), "History");
  const history = /<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/.exec(panel)![1]!;
  assert.match(text(history), /^Show history \(3 changes\) Mon 23 Nov 2026 You You confirmed this Tue 17 Nov 2026 Instinct Instinct is handling this Instinct added this$/);
  assert.match(panel, /<a href="\/activity\?record=[0-9a-f-]{36}"[^>]*>See in Activity<\/a>/, "Activity opens on this item's own entries");
});

test("nothing anyone wrote, or any field, becomes a link; the only links are the page's own", () => {
  const hrefs = [...render().matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(hrefs.every((href) => href.startsWith("/")), `only the page's own links: ${hrefs.join(", ")}`);
  assert.ok(!hrefs.some((href) => /example\.test/.test(href)));
});

test("without the actions, each control is disabled and says why (no dead controls)", () => {
  const markup = text(render(DATA, false));
  assert.match(markup, /Adding to the log isn't available just now\./);
  assert.match(markup, /Changing who handles this isn't available just now\./);
});

test("an empty journal says what to do next; with no agents connected, Handled by says how to connect one", () => {
  const empty = render({ ...DATA, openSteps: [], doneSteps: [], decisions: [], replaced: [], notes: [], handovers: [], history: [], steward: null, agents: [] });
  assert.match(text(panelOf(empty, "Next steps")), /No open next steps\. Add one below, so whoever picks this up next knows what to do\./);
  assert.match(text(panelOf(empty, "Decisions")), /No decisions recorded yet\./);
  assert.match(text(panelOf(empty, "Notes")), /No notes yet\./);
  assert.match(text(panelOf(empty, "Handled by")), /No one is handling this\. No agents connected\. Connect an agent to ask it to handle this\. Go to Agents/);
  assert.match(text(panelOf(empty, "History")), /Nothing recorded yet\./);
});

test("an item that isn't the person's (or no longer exists) says so, with a way back", () => {
  const markup = text(render(null));
  assert.match(markup, /Item not found/);
  assert.match(markup, /This item isn't in your Life admin\. It may have been deleted or marked as not yours\./);
  assert.match(render(null), /href="\/life-admin\?view=life&amp;tab=records"[^>]*>Back to Life admin/);
});

test("the item page uses tokens, never raw hex", () => {
  assert.doesNotMatch(render(), /#[0-9a-fA-F]{3,8}\b/);
});
