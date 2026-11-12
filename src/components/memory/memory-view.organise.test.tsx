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
    { value: null, label: "All scopes", count: 4 },
    { value: "shared", label: "Shared", count: 2 },
    { value: "kept", label: "Kept", count: 2 },
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

test("scope and saved-by filter links mark the current choice, show counts and keep the search", () => {
  const markup = render({
    query: "seat",
    filters: { ...FILTERS, scope: "kept" },
  });
  assert.match(markup, /<nav aria-label="Filter by scope"/);
  assert.match(markup, /<nav aria-label="Filter by who saved it"/);
  assert.match(markup, /href="\/memory\?q=seat&amp;scope=kept" aria-current="page"/, "Kept is current and keeps the search");
  assert.match(markup, /href="\/memory\?q=seat"[^>]*>All scopes/, "All scopes removes only the scope");
  assert.match(markup, /href="\/memory\?q=seat&amp;scope=kept&amp;source=you"[^>]*>You/, "a saved-by link keeps scope and search");
  assert.match(markup, /href="\/memory\?q=seat&amp;scope=kept&amp;source=agent-claude"[^>]*>Claude/);
  assert.match(markup, />Kept<span[^>]*>2<\/span>/, "the count is shown with its option");
});

test("applied filters are removable chips with a Clear all, and the search form keeps them", () => {
  const markup = render({ query: "seat", filters: { ...FILTERS, scope: "kept", source: "agent-claude" } });
  const t = text(markup);
  assert.ok(t.includes("Remove filter Scope: Kept"));
  assert.ok(t.includes("Remove filter Saved by: Claude"));
  assert.ok(t.includes("Remove filter Search: “seat”"));
  assert.match(markup, /href="\/memory\?q=seat&amp;source=agent-claude"[^>]*><span class="sr-only">Remove filter <\/span>Scope: Kept/);
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
