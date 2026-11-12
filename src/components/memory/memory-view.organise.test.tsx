// Memory screen organisation (`./memory-view`): date headings, scope and saved-by filter
// links, removable applied-filter chips, a "No memories match" state with a way out,
// pagination that keeps the filters, a confirmation step before Delete, and the house
// page heading. Rendered with react-dom/server and read from the markup, like the
// sibling view tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { MemoryView, type MemoryViewItem, type MemoryViewProps } from "./memory-view";

const TODAY: MemoryViewItem = {
  id: "mem-today",
  content: "Moving on the first of the month",
  savedAt: "1 Jun 2026",
  sourceAgentName: "Claude",
  scope: "shared",
  dateGroup: "today",
};
const WEEK_A: MemoryViewItem = {
  id: "mem-week-a",
  content: "Prefers an oat flat white",
  savedAt: "30 May 2026",
  sourceAgentName: null,
  scope: "kept",
  dateGroup: "week",
};
const WEEK_B: MemoryViewItem = { ...WEEK_A, id: "mem-week-b", content: "Allergic to penicillin" };
const OLD: MemoryViewItem = {
  id: "mem-old",
  content: "Window seat on long flights",
  savedAt: "2 Jan 2026",
  sourceAgentName: "ChatGPT",
  scope: "shared",
  dateGroup: "earlier",
};

const FILTERS: NonNullable<MemoryViewProps["filters"]> = {
  scope: null,
  source: null,
  scopeOptions: [
    { value: null, label: "All", count: 4 },
    { value: "shared", label: "Shared", count: 2 },
    { value: "kept", label: "Private", count: 2 },
  ],
  sourceOptions: [
    { value: null, label: "Anyone", count: 4 },
    { value: "you", label: "You", count: 2 },
    { value: "agent-claude", label: "Claude", count: 1 },
  ],
};

const noop = async (_formData: FormData): Promise<void> => {};

function render(props: Partial<MemoryViewProps> = {}): string {
  return renderToStaticMarkup(
    <MemoryView memories={[TODAY, WEEK_A, WEEK_B, OLD]} filters={FILTERS} deleteAction={noop} {...props} />,
  );
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

function hrefsOf(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

test("the page heading uses the shared workspace page heading", () => {
  assert.match(render(), /<header class="wh-page-heading">.*<h1>Memory<\/h1>/s);
});

test("memories sit under Today / This week / Earlier headings, each with its count, in that order", () => {
  const markup = render();
  const headings = [...markup.matchAll(/<h2 id="memories-(\w+)-heading"[^>]*>([^<]*)<\/h2>/g)].map((m) => m[2]);
  assert.deepEqual(headings, ["Today", "This week", "Earlier"]);
  const weekSection = markup.slice(markup.indexOf('id="memories-week-heading"'), markup.indexOf('id="memories-earlier-heading"'));
  assert.match(weekSection, />2<\/span>/, "the This week heading counts its two memories");
  assert.ok(weekSection.includes(WEEK_A.content) && weekSection.includes(WEEK_B.content));
  assert.ok(!weekSection.includes(OLD.content), "an earlier memory is not under This week");
});

test("a heading with no memories is left out", () => {
  const markup = render({ memories: [OLD] });
  assert.ok(markup.includes('id="memories-earlier-heading"'));
  assert.ok(!markup.includes('id="memories-today-heading"'));
  assert.ok(!markup.includes('id="memories-week-heading"'));
});

test("sharing and saved-by filter links mark the current choice, show counts and keep the search", () => {
  const markup = render({
    query: "seat",
    filters: { ...FILTERS, scope: "kept" },
  });
  assert.match(markup, /<nav aria-label="Filter by sharing"/);
  assert.match(markup, /<nav aria-label="Filter by who saved it"/);
  assert.match(markup, /href="\/memory\?q=seat&amp;scope=kept" aria-current="page"/, "Private is current and keeps the search");
  assert.match(markup, /href="\/memory\?q=seat"[^>]*>All</, "All removes only the sharing filter");
  assert.match(markup, /href="\/memory\?q=seat&amp;scope=kept&amp;source=you"[^>]*>You/, "a saved-by link keeps scope and search");
  assert.match(markup, /href="\/memory\?q=seat&amp;scope=kept&amp;source=agent-claude"[^>]*>Claude/);
  assert.match(markup, />Private<span[^>]*>2<\/span>/, "the count is shown with its option");
});

test("applied filters are removable chips with a Clear all, and the search form keeps them", () => {
  const markup = render({ query: "seat", filters: { ...FILTERS, scope: "kept", source: "agent-claude" } });
  const t = text(markup);
  assert.ok(t.includes("Remove filter Sharing: Private"));
  assert.ok(t.includes("Remove filter Saved by: Claude"));
  assert.ok(t.includes("Remove filter Search: “seat”"));
  assert.match(markup, /href="\/memory\?q=seat&amp;source=agent-claude"[^>]*><span class="sr-only">Remove filter <\/span>Sharing: Private/);
  assert.match(markup, /href="\/memory"[^>]*>Clear all filters/);
  const search = markup.match(/<form\b[^>]*method="get"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.match(search, /<input type="hidden" name="scope" value="kept"/);
  assert.match(search, /<input type="hidden" name="source" value="agent-claude"/);
});

test("with no filter applied there are no chips", () => {
  assert.ok(!render().includes("Clear all filters"));
});

test("a filtered view with nothing in it says so and offers a way to clear the filters", () => {
  const markup = render({ memories: [], filters: { ...FILTERS, scope: "kept" } });
  const t = text(markup);
  assert.ok(t.includes("No memories match"));
  assert.ok(!t.includes("No memories yet"));
  assert.match(markup, /href="\/memory"[^>]*>Clear filters/);
});

test("with no memories at all and no filters, the first-run empty state shows", () => {
  const t = text(render({ memories: [], filters: undefined }));
  assert.ok(t.includes("No memories yet"));
  assert.ok(!t.includes("No memories match"));
});

test("page links carry the filters and the search", () => {
  const hrefs = hrefsOf(render({ query: "seat", filters: { ...FILTERS, scope: "kept" }, nextCursor: "abc", hasPreviousPage: true }));
  assert.ok(hrefs.includes("/memory?q=seat&scope=kept"), `First page keeps filters; hrefs=${hrefs.join(" ")}`);
  assert.ok(hrefs.includes("/memory?cursor=abc&q=seat&scope=kept"), `Older keeps filters; hrefs=${hrefs.join(" ")}`);
});

test("Delete asks for confirmation first: the delete form sits inside a disclosure", () => {
  const markup = render({ memories: [TODAY] });
  const disclosures = [...markup.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)].map((m) => m[1]!);
  const confirm = disclosures.find((d) => /<summary[^>]*>[\s\S]*Delete[\s\S]*<\/summary>/.test(d));
  assert.ok(confirm, "a Delete disclosure exists");
  assert.match(confirm!, /cannot be undone/i, "the confirmation says what happens");
  assert.match(confirm!, /<form[^>]*>[\s\S]*name="id" value="mem-today"[\s\S]*Delete memory[\s\S]*<\/form>/);
  const outside = markup.replace(/<details\b[\s\S]*?<\/details>/g, "");
  assert.ok(!/<button[^>]*>[\s\S]{0,200}Delete/.test(outside), "no one-click Delete button outside the confirmation");
});

test("a memory's three controls share one action row; Edit and Delete open underneath it", () => {
  const markup = render({ memories: [TODAY] });
  const row = markup.match(/<div class="flex min-w-0 flex-wrap items-center gap-2">([\s\S]*)<\/div><\/div><\/li>/)?.[1] ?? "";
  assert.match(row, /Make private/, "the sharing control is in the row");
  assert.equal((row.match(/<details\b/g) ?? []).length, 2, "Edit and Delete disclosures are in the same row");
  assert.match(row, /<summary[^>]*>[\s\S]*?Edit<\/summary>/);
  assert.match(row, /<summary[^>]*class="[^"]*border-danger[^"]*"[^>]*>[\s\S]*?Delete<\/summary>/, "Delete is styled as destructive");
});

test("first run: no search or filters around an empty list, just the add panel and the empty state", () => {
  const markup = render({ memories: [], filters: { ...FILTERS, scopeOptions: FILTERS.scopeOptions.map((o) => ({ ...o, count: 0 })) } });
  assert.ok(!markup.includes('aria-label="Find memories"'), "no toolbar until there is something to find");
  assert.ok(markup.includes("Add a memory"));
  assert.ok(text(markup).includes("No memories yet"));
  assert.ok(render().includes('aria-label="Find memories"'), "the toolbar returns once there are memories");
});

test("every form tells the page which search, filters and page to return to", () => {
  const markup = render({ memories: [TODAY], query: "seat", filters: { ...FILTERS, scope: "shared" }, cursor: "abc", hasPreviousPage: true, rescopeAction: noop, editAction: noop, addAction: noop });
  const forms = [...markup.matchAll(/<form\b(?![^>]*method="get")[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]!);
  assert.ok(forms.length >= 4, "add, rescope, edit and delete forms");
  for (const form of forms) {
    assert.match(form, /name="return_q" value="seat"/);
    assert.match(form, /name="return_scope" value="shared"/);
    assert.match(form, /name="return_cursor" value="abc"/);
  }
});

test("the outcome notice sits straight after the heading band", () => {
  const markup = render({ notice: { tone: "success", text: "Memory deleted." } });
  const heading = markup.indexOf("</header>");
  const notice = markup.indexOf("Memory deleted.");
  const add = markup.indexOf("Add a memory");
  assert.ok(heading > 0 && notice > heading && notice < add, "heading, then notice, then the page");
});
