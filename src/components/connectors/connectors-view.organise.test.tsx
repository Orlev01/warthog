// Connectors screen organisation (`./connectors-view`): category filter links over the
// catalogue (All first, with counts, keeping the search), a "Connected" word badge on
// services the person already has, a counted Connected tab, a tool summary with a
// "Show tools" disclosure on each connected card, and a confirmation step before
// Disconnect. Rendered with react-dom/server and read from the markup, like the sibling
// view tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectorsView, type ConnectorsViewProps, type ConnectionItem } from "./connectors-view";

const noop = async (_formData: FormData): Promise<void> => {};

const CONNECTION: ConnectionItem = {
  id: "conn-1",
  name: "Fastmail",
  accountLabel: "robin mailbox",
  status: "connected",
  connectedAt: "1 Jun 2026",
  tools: [
    { name: "search_mail", makesChange: false },
    { name: "read_message", makesChange: false },
    { name: "send_mail", makesChange: true },
  ],
  agents: ["Claude"],
};

function base(overrides: Partial<ConnectorsViewProps> = {}): ConnectorsViewProps {
  return {
    groups: [
      {
        category: "email",
        items: [
          { id: "fastmail", name: "Fastmail", connectable: true, gate: "connect", connected: true },
          { id: "proton", name: "Proton Mail", connectable: true, gate: "connect" },
        ],
      },
    ],
    categories: [
      { key: "calendar", count: 6 },
      { key: "email", count: 9 },
      { key: "smart-home", count: 3 },
    ],
    category: null,
    connections: [CONNECTION],
    query: null,
    canRequest: false,
    connectAction: noop,
    disconnectAction: noop,
    requestAction: noop,
    ...overrides,
  };
}

const render = (props: ConnectorsViewProps) => renderToStaticMarkup(<ConnectorsView {...props} />);

const text = (markup: string) =>
  markup
    .replace(/<script\b[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// The smallest list item (balanced, so a card's nested tool list stays inside it) that
// holds the first occurrence of `needle`.
function entry(markup: string, needle: string): string {
  const at = markup.indexOf(needle);
  const open: number[] = [];
  const ranges: Array<[number, number]> = [];
  for (const m of markup.matchAll(/<\/?li\b[^>]*>/g)) {
    if (m[0].startsWith("</")) ranges.push([open.pop()!, m.index! + m[0].length]);
    else open.push(m.index!);
  }
  const best = ranges.filter(([s, e]) => s <= at && at < e).sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0];
  return best ? markup.slice(best[0], best[1]) : "";
}

test("category links put All first with the total, then each category with its count", () => {
  const markup = render(base());
  const nav = markup.slice(markup.indexOf('<nav aria-label="Catalogue categories"'), markup.indexOf("</nav>", markup.indexOf('aria-label="Catalogue categories"')));
  assert.ok(nav.length > 0, "a category filter row is rendered");
  const labels = [...nav.matchAll(/<a [^>]*>([^<]*)<span[^>]*>(\d+)<\/span><\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(labels, [
    ["All", "18"],
    ["Calendar", "6"],
    ["Email", "9"],
    ["Smart home", "3"],
  ]);
  assert.match(nav, /href="\/connectors\?view=catalogue" aria-current="page"/, "All is current with no category");
  assert.match(nav, /href="\/connectors\?category=email&amp;view=catalogue"/);
});

test("a category link marks the current category and keeps the search text", () => {
  const markup = render(base({ category: "email", query: "mail" }));
  assert.match(markup, /href="\/connectors\?category=email&amp;q=mail&amp;view=catalogue" aria-current="page"/);
  assert.match(markup, /href="\/connectors\?q=mail&amp;view=catalogue"[^>]*>All/, "All drops only the category");
  const search = markup.match(/<form\b[^>]*method="get"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.match(search, /<input type="hidden" name="category" value="email"/, "searching stays inside the category");
});

test("the catalogue opens on its tab when a category is chosen", () => {
  const markup = render(base({ category: "email" }));
  const tabs = [...markup.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]*)/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(tabs.find(([label]) => label === "Catalogue"), ["Catalogue", "true"]);
});

test("nothing in the chosen category and search says so and offers a way to clear them", () => {
  const markup = render(base({ groups: [], category: "email", query: "zz" }));
  const t = text(markup);
  assert.ok(t.includes("No connectors match"));
  assert.match(markup, /href="\/connectors\?view=catalogue"[^>]*>Clear search and category/);
});

test("an entry the person already connected carries a Connected badge in words", () => {
  const markup = render(base({ connections: [] }));
  const connected = entry(markup, "Fastmail");
  assert.match(text(connected), /\bConnected\b/);
  assert.match(connected, /<svg/, "the badge has an icon as well as the word");
  assert.ok(text(connected).includes("Connect another account"), "connecting again adds another account");
  const other = entry(markup, "Proton Mail");
  assert.ok(!/\bConnected\b/.test(text(other)), "an entry not yet connected has no badge");
  assert.ok(/>\s*Connect\s*</.test(other));
});

test("the Connected tab label carries its count", () => {
  const markup = render(base({ connections: [CONNECTION, { ...CONNECTION, id: "conn-2", accountLabel: "work" }] }));
  assert.match(markup, /role="tab"[^>]*>Connected services \(2\)</);
});

test("a connected card summarises its tools and lists them behind Show tools", () => {
  const card = entry(render(base({ groups: [] })), "robin mailbox");
  assert.ok(text(card).includes("3 tools · 1 makes changes"), text(card));
  const disclosure = card.match(/<details\b[^>]*>([\s\S]*?)<\/details>/g)?.find((d) => d.includes("Show tools"));
  assert.ok(disclosure, "the full tool list is behind a Show tools disclosure");
  for (const tool of CONNECTION.tools) assert.ok(disclosure!.includes(tool.name));
});

test("a read-only service says so in its tool summary", () => {
  const readOnly = { ...CONNECTION, tools: [{ name: "search_mail", makesChange: false }] };
  const card = entry(render(base({ groups: [], connections: [readOnly] })), "robin mailbox");
  assert.ok(text(card).includes("1 tool · read-only"), text(card));
});

test("Disconnect asks for confirmation first, then submits the same action for this connection", () => {
  const card = entry(render(base({ groups: [] })), "robin mailbox");
  const confirm = card.match(/<details\b[^>]*>([\s\S]*?)<\/details>/g)?.find((d) => /<summary[^>]*>[^<]*Disconnect/.test(d));
  assert.ok(confirm, "a Disconnect disclosure exists");
  assert.match(text(confirm!), /every agent/i, "the confirmation says agents lose access");
  assert.match(confirm!, /<form action="javascript:[\s\S]*name="connectionId" value="conn-1"[\s\S]*Disconnect Fastmail[\s\S]*<\/form>/);
  const outside = card.replace(/<details\b[\s\S]*?<\/details>/g, "");
  assert.ok(!/<form/.test(outside), "no one-click Disconnect form outside the confirmation");
});
