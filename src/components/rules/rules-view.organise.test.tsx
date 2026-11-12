// Rules page organisation (src/components/rules/rules-view.tsx + ./rules-organise).
//
// The founder's brief: long flat lists across the app need grouping, filtering and a tidy
// layout. On Rules that means:
//   • the page is titled like its navigation entry ("Rules & budgets", the house h1);
//   • browsing and building are separate in-page views — "Your rules (n)", "New rule" and
//     "Budgets" — with validated view keys and the builder kept mounted (drafts survive);
//   • rules are grouped by scope: all agents first, then each agent by name, with counts;
//   • a status filter (?status=active|paused) shows as links with counts, an applied-filter
//     chip and an empty state with a way back;
//   • each rule shows its kind as a word ("Ask first" / "Never allow"), and its status in
//     words;
//   • Delete asks for confirmation in a native disclosure, then posts to the same handler;
//   • Budgets links each agent's real card-budget control (its workspace Spending section)
//     instead of the old disabled "template" radios.
//
// Rendered with react-dom/server and read as markup (no DOM), like the sibling tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { RulesView, type RulesViewProps, type RulesViewRule } from "./rules-view";
import { groupRulesByScope, rulesStatusHref } from "./rules-organise";
import type { RuleScope } from "@/domain/rules/rules";

const ANY: RuleScope = { type: "any_agent" };
const agent = (agentId: string, name: string): RuleScope => ({ type: "agent", agentId, name });

const RULES: RulesViewRule[] = [
  { id: "g-ask", sentence: "Ask me before any agent sends email", scope: ANY, status: "active", kind: "ask_first" },
  { id: "z-never", sentence: "Never allow Zed to make any change", scope: agent("c-zed", "Zed"), status: "active", kind: "never_allow" },
  { id: "a-ask", sentence: "Ask me before Alpha requests a card", scope: agent("c-alpha", "Alpha"), status: "paused", kind: "ask_first" },
  { id: "g-never", sentence: "Never allow any agent to request a high-tier identity detail", scope: ANY, status: "paused", kind: "never_allow" },
  { id: "a-never", sentence: "Never allow Alpha to send a post", scope: agent("c-alpha", "Alpha"), status: "active", kind: "never_allow" },
];

const AGENTS = [
  { id: "c-alpha", name: "Alpha", workspaceId: "w-alpha" },
  { id: "c-zed", name: "Zed", workspaceId: "w-zed" },
];

const noop = async (_: FormData): Promise<void> => {};

function render(overrides: Partial<RulesViewProps> = {}): string {
  return renderToStaticMarkup(
    <RulesView rules={RULES} agents={AGENTS} pauseAction={noop} deleteAction={noop} createAction={noop} {...overrides} />,
  );
}

// --- markup helpers -------------------------------------------------------------------

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

function findAll(markup: string, tag: string): Array<{ attrs: string; inner: string }> {
  return [...markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => ({
    attrs: m[1]!,
    inner: m[2]!,
  }));
}

type Tab = { label: string; selected: boolean };
function tabs(markup: string): Tab[] {
  return findAll(markup, "button")
    .filter((b) => attr(b.attrs, "role") === "tab")
    .map((b) => ({ label: visibleText(b.inner), selected: attr(b.attrs, "aria-selected") === "true" }));
}

// Each tab panel's opening-tag attributes and its markup up to the next panel (panels are
// siblings in tab order, so this slices the page into the three views).
function panels(markup: string): Array<{ hidden: boolean; html: string }> {
  const starts = [...markup.matchAll(/<div role="tabpanel"([^>]*)>/g)];
  return starts.map((m, i) => ({
    hidden: /\shidden=""/.test(m[1]!),
    html: markup.slice(m.index! + m[0].length, i + 1 < starts.length ? starts[i + 1]!.index : undefined),
  }));
}

function rulesPanel(markup: string): string {
  return panels(markup)[0]!.html;
}

// The group headings (title + count) in document order.
function groupHeadings(html: string): Array<{ title: string; count: number }> {
  return [...html.matchAll(/<h2 id="[^"]*-heading"[^>]*>([\s\S]*?)<\/h2>\s*<span[^>]*>(\d+)<\/span>/g)].map((m) => ({
    title: visibleText(m[1]!),
    count: Number(m[2]),
  }));
}

function rowFor(html: string, sentence: string): string {
  const row = findAll(html, "li").find((li) => visibleText(li.inner).includes(sentence));
  assert.ok(row, `a row reads back "${sentence}"`);
  return row.inner;
}

// --- page title and views ---------------------------------------------------------------

test("the page is titled like its navigation entry, with the house h1", () => {
  const markup = render();
  const h1s = findAll(markup, "h1");
  assert.equal(h1s.length, 1);
  assert.equal(visibleText(h1s[0]!.inner), "Rules & budgets");
  assert.equal(attr(h1s[0]!.attrs, "class"), "text-2xl font-semibold tracking-tight text-fg");
});

test("browsing, building and budgets are separate tabs; the rules tab counts every rule", () => {
  assert.deepEqual(tabs(render()), [
    { label: "Your rules (5)", selected: true },
    { label: "New rule", selected: false },
    { label: "Budgets", selected: false },
  ]);
  assert.deepEqual(
    tabs(render({ initialView: "new" })).map((t) => t.selected),
    [false, true, false],
    "?view=new opens the builder",
  );
  assert.deepEqual(
    tabs(render({ initialView: "javascript:alert(1)" })).map((t) => t.selected),
    [true, false, false],
    "an unknown view key falls back to the rules list",
  );
});

test("the builder stays mounted while another tab is shown, so a draft survives switching", () => {
  const markup = render();
  const [rules, builder] = panels(markup);
  assert.equal(rules!.hidden, false);
  assert.equal(builder!.hidden, true, "the builder panel is hidden, not unmounted");
  assert.match(builder!.html, /name="rule-template"/, "the create form is still in the page");
  assert.doesNotMatch(rules!.html, /name="rule-template"/, "the rules list does not carry the builder");
});

// --- grouping -------------------------------------------------------------------------

test("rules are grouped by scope: all agents first, then each agent by name, each with its count", () => {
  const html = rulesPanel(render());
  assert.deepEqual(groupHeadings(html), [
    { title: "All agents", count: 2 },
    { title: "Alpha", count: 2 },
    { title: "Zed", count: 1 },
  ]);
  // Within a group, active rules come before paused ones.
  const alpha = html.indexOf("Never allow Alpha to send a post");
  const alphaPaused = html.indexOf("Ask me before Alpha requests a card");
  assert.ok(alpha > -1 && alphaPaused > alpha, "Alpha's active rule is listed before its paused one");
  // An agent's group links to that agent's own Rules section.
  assert.match(html, /href="\/agents\/w-alpha\?section=rules"/);
  assert.match(html, /href="\/agents\/w-zed\?section=rules"/);
});

test("group ids never expose an agent's connection id", () => {
  const html = rulesPanel(render());
  assert.doesNotMatch(html, /c-alpha|c-zed/);
});

test("groupRulesByScope orders same-named agents by id and keeps every rule", () => {
  const twins: RulesViewRule[] = [
    { id: "2", sentence: "s2", scope: agent("c-2", "Helper"), status: "active", kind: "ask_first" },
    { id: "1", sentence: "s1", scope: agent("c-1", "Helper"), status: "active", kind: "ask_first" },
    { id: "0", sentence: "s0", scope: agent("c-0", "assistant"), status: "paused", kind: "never_allow" },
  ];
  const groups = groupRulesByScope(twins);
  assert.deepEqual(
    groups.map((g) => [g.title, g.agentId, g.rules.map((r) => r.id)]),
    [
      ["assistant", "c-0", ["0"]],
      ["Helper", "c-1", ["1"]],
      ["Helper", "c-2", ["2"]],
    ],
  );
  assert.deepEqual(groupRulesByScope([]), []);
});

// --- kind and status words --------------------------------------------------------------

test("each rule shows its kind and its status in words", () => {
  const html = rulesPanel(render());
  const ask = visibleText(rowFor(html, "Ask me before any agent sends email"));
  assert.match(ask, /Ask first/);
  assert.match(ask, /Active/);
  const never = visibleText(rowFor(html, "Never allow any agent to request a high-tier identity detail"))
    .replace("Never allow any agent to request a high-tier identity detail", "");
  assert.match(never, /Never allow/, "the kind badge, not only the sentence");
  assert.match(never, /Paused/);
});

// --- status filter --------------------------------------------------------------------

test("status filter links carry counts, mark the current one and keep the URL tidy", () => {
  const html = rulesPanel(render({ statusFilter: "paused" }));
  const nav = findAll(html, "nav").find((n) => attr(n.attrs, "aria-label") === "Filter rules by status");
  assert.ok(nav, "a labelled status filter");
  const links = findAll(nav.inner, "a").map((a) => ({
    href: decode(attr(a.attrs, "href") ?? ""),
    text: visibleText(a.inner),
    current: attr(a.attrs, "aria-current") === "page",
  }));
  assert.deepEqual(links, [
    { href: "/rules", text: "All 5", current: false },
    { href: "/rules?status=active", text: "Active 3", current: false },
    { href: "/rules?status=paused", text: "Paused 2", current: true },
  ]);
});

test("a status filter shows only matching rules and a removable chip", () => {
  const html = rulesPanel(render({ statusFilter: "paused" }));
  const text = visibleText(html);
  assert.ok(text.includes("Ask me before Alpha requests a card"));
  assert.ok(text.includes("Never allow any agent to request a high-tier identity detail"));
  assert.ok(!text.includes("Ask me before any agent sends email"), "active rules are filtered out");
  assert.ok(!text.includes("Never allow Zed to make any change"), "active rules are filtered out");
  assert.deepEqual(groupHeadings(html), [
    { title: "All agents", count: 1 },
    { title: "Alpha", count: 1 },
  ]);
  assert.match(html, /<a href="\/rules"[^>]*><span class="sr-only">Remove filter <\/span>Status: Paused/);
  // The tab still counts every rule, not just the filtered ones.
  assert.equal(tabs(render({ statusFilter: "paused" }))[0]!.label, "Your rules (5)");
});

test("a filter that matches nothing says so and offers a way back", () => {
  const html = rulesPanel(render({ rules: RULES.filter((r) => r.status === "active"), statusFilter: "paused" }));
  assert.match(visibleText(html), /No paused rules/);
  assert.match(html, /<a [^>]*href="\/rules"[^>]*>Show all rules<\/a>/);
  assert.deepEqual(groupHeadings(html), []);
});

test("with no rules at all, an empty state points to the builder and no filter is offered", () => {
  const html = rulesPanel(render({ rules: [] }));
  assert.match(visibleText(html), /No rules yet/);
  assert.match(visibleText(html), /New rule/);
  assert.doesNotMatch(html, /Filter rules by status/);
});

test("rulesStatusHref builds the filter links from a fixed path", () => {
  assert.equal(rulesStatusHref(undefined), "/rules");
  assert.equal(rulesStatusHref("active"), "/rules?status=active");
  assert.equal(rulesStatusHref("paused"), "/rules?status=paused");
});

test("pause and delete remember the status filter, so the page returns to it", () => {
  const html = rulesPanel(render({ statusFilter: "active" }));
  const forms = findAll(html, "form").filter((f) => /name="rule-id"/.test(f.inner));
  assert.ok(forms.length > 0);
  for (const form of forms) {
    assert.match(form.inner, /<input type="hidden" name="return-status" value="active"\/>/);
  }
  const unfiltered = findAll(rulesPanel(render()), "form").filter((f) => /name="rule-id"/.test(f.inner));
  assert.ok(unfiltered.every((f) => !/name="return-status"/.test(f.inner)), "no filter, nothing to return to");
});

// --- delete confirmation ----------------------------------------------------------------

test("Delete asks first: each delete form sits in a closed disclosure with a plain warning", () => {
  const html = rulesPanel(render());
  const disclosures = findAll(html, "details");
  assert.equal(disclosures.length, RULES.length, "one delete disclosure per rule");
  for (const d of disclosures) {
    assert.doesNotMatch(d.attrs, /(?:^|\s)open(?:=""|="open")?(?=\s|$)/, "closed until the person asks");
    const summary = findAll(d.inner, "summary")[0];
    assert.ok(summary && /Delete/.test(visibleText(summary.inner)));
    assert.match(visibleText(d.inner), /cannot be undone/i);
    const form = findAll(d.inner, "form")[0];
    assert.ok(form && /^javascript:/.test(attr(form.attrs, "action") ?? ""), "bound to the delete handler");
    assert.match(form.inner, /name="rule-id"/);
  }
  // Outside the disclosures, no one-click delete remains.
  const outside = html.replace(/<details\b[\s\S]*?<\/details>/g, "");
  assert.ok(
    !findAll(outside, "form").some((f) => /\bDelete\b/.test(visibleText(f.inner))),
    "no delete form outside a confirmation",
  );
});

// --- budgets ----------------------------------------------------------------------------

test("Budgets links each agent's card budget to its workspace Spending section", () => {
  const html = panels(render())[2]!.html;
  const links = findAll(html, "a").map((a) => ({ href: decode(attr(a.attrs, "href") ?? ""), text: visibleText(a.inner) }));
  assert.ok(links.some((l) => l.href === "/agents/w-alpha?section=spending" && l.text === "Set Alpha's budget"), JSON.stringify(links));
  assert.ok(links.some((l) => l.href === "/agents/w-zed?section=spending" && l.text === "Set Zed's budget"), JSON.stringify(links));
  assert.ok(links.some((l) => l.href === "/spending"), "a route to what has been spent");
  assert.ok(links.some((l) => l.href === "/household"), "a route to the household budget");
  assert.doesNotMatch(html, /\bdisabled\b/, "no disabled stand-ins");
});

test("Budgets with no agents points to connecting one", () => {
  const html = panels(render({ agents: [] }))[2]!.html;
  assert.match(html, /href="\/agents\/connect"/);
  assert.doesNotMatch(html, /section=spending/);
});
