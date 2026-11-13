// The admin portal's data-display primitives (src/components/admin/*): stat tiles with deltas
// in words, an accessible inline sparkline, bar lists and funnels whose counts carry the
// meaning, a fact list over the existing inset, and range tabs as real links. Rendered with
// react-dom/server; behaviour pinned, never source text; no raw colour anywhere.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { StatTiles } from "./stat-tiles";
import { Sparkline } from "./sparkline";
import { BarList } from "./bar-list";
import { Funnel, biggestDropIndex } from "./funnel";
import { FactList } from "./fact-list";
import { RangeTabs, rangeHref } from "./range-tabs";

const NO_HEX = /#[0-9a-fA-F]{3,8}\b/;

test("stat tiles show the label, value, sub-line and the delta in words with an icon; a tile may link", () => {
  const html = renderToStaticMarkup(
    <StatTiles
      label="Headline numbers"
      tiles={[
        { key: "signups", label: "Sign-ups", value: "14", delta: { value: 14, previous: 12, previousLabel: "the previous 7 days" }, href: "/signups" },
        { key: "errors", label: "Failed requests", value: "3", sub: "of 40 requests", delta: { value: 3, previous: 5, previousLabel: "the previous 7 days", goodWhen: "down" } },
        { key: "attention", label: "Needs attention", value: "2", tone: "danger", href: "/reliability" },
      ]}
    />,
  );
  assert.match(html, /<ul class="wh-stat-tiles" aria-label="Headline numbers">/);
  assert.match(html, /<a href="\/signups" class="wh-stat-tile-link">/);
  assert.match(html, /up 17% on the previous 7 days/);
  assert.match(html, /wh-stat-delta wh-tone-success/);
  assert.match(html, /down 2 on the previous 7 days/);
  assert.match(html, /of 40 requests/);
  assert.match(html, /data-tone="danger"/);
  assert.doesNotMatch(html, NO_HEX);
});

test("the sparkline is an image with a summary and title, drawn in currentColor, with a hidden table for long series", () => {
  const short = renderToStaticMarkup(<Sparkline label="Sign-ups per day" points={[{ at: "2026-11-10T00:00:00Z", value: 1 }, { at: "2026-11-11T00:00:00Z", value: 4 }, { at: "2026-11-12T00:00:00Z", value: 2 }]} />);
  assert.match(short, /role="img" aria-label="Sign-ups per day: 1 to 4, latest 2"/);
  assert.match(short, /<title>Sign-ups per day: 1 to 4, latest 2<\/title>/);
  assert.match(short, /stroke="currentColor"/);
  assert.match(short, /vector-effect="non-scaling-stroke"/);
  assert.match(short, /class="wh-sparkline text-tint"/);
  assert.doesNotMatch(short, /<table/);
  const points = Array.from({ length: 10 }, (_, i) => ({ at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`, value: i }));
  const long = renderToStaticMarkup(<Sparkline label="Requests" points={points} height={56} timeZone="Australia/Sydney" />);
  assert.match(long, /<table class="sr-only"><caption>Requests<\/caption>/);
  assert.equal((long.match(/<tr>/g) ?? []).length, 11);
  assert.match(long, /data-height="56"/);
  const empty = renderToStaticMarkup(<Sparkline label="Nothing" points={[]} />);
  assert.match(empty, /aria-label="Nothing: no data yet"/);
  assert.doesNotMatch(short + long, NO_HEX);
});

test("a bar list names each row, shows its count, marks services, scales bars to the largest and is empty with a next step", () => {
  const html = renderToStaticMarkup(
    <BarList label="Top services" marks="service" empty="No services connected yet." rows={[
      { key: "gmail", label: "Gmail", value: 8, brand: "gmail", href: "/usage" },
      { key: "outlook", label: "Outlook", value: 2, brand: "outlook" },
      { key: "timeout", label: "Timed out", value: 1, tone: "danger" },
    ]} />,
  );
  assert.match(html, /<ol class="wh-bar-list" aria-label="Top services">/);
  assert.match(html, /<a href="\/usage"[^>]*>Gmail<\/a>/);
  assert.match(html, /wh-brand-tile/);
  assert.match(html, /style="width:100%"/);
  assert.match(html, /style="width:25%"/);
  assert.match(html, /data-tone="danger"/);
  assert.match(html, /aria-hidden="true"/);
  const empty = renderToStaticMarkup(<BarList label="x" empty="No services connected yet." rows={[]} />);
  assert.match(empty, /No services connected yet\./);
  assert.doesNotMatch(html, NO_HEX);
});

test("a funnel states conversion in words, honestly under ten, and names the biggest drop", () => {
  const steps = [
    { key: "accounts", label: "Accounts", count: 12, href: "/accounts" },
    { key: "factor", label: "Added a second factor", count: 10 },
    { key: "agent", label: "Connected an agent", count: 4 },
    { key: "service", label: "Connected a service", count: 3 },
  ];
  assert.equal(biggestDropIndex(steps), 2);
  const html = renderToStaticMarkup(<Funnel label="Activation" empty="No accounts yet." steps={steps} />);
  assert.match(html, /<ol class="wh-funnel" aria-label="Activation">/);
  assert.match(html, /83% went on/);
  assert.match(html, /40% went on/);
  assert.match(html, /3 of 4 went on/);
  assert.match(html, /biggest drop/);
  assert.equal((html.match(/data-drop=""/g) ?? []).length, 1);
  assert.match(html, /style="width:25%"/);
  const empty = renderToStaticMarkup(<Funnel label="Activation" empty="No accounts yet." steps={[{ key: "a", label: "Accounts", count: 0 }]} />);
  assert.match(empty, /No accounts yet\./);
  assert.doesNotMatch(html, NO_HEX);
});

test("a fact list is a definition list on the existing inset, and range tabs are real links that keep other parameters", () => {
  const facts = renderToStaticMarkup(<FactList label="System facts" facts={[{ key: "m", label: "Migration", value: "0112" }, { key: "s", label: "SMS", value: "Off" }]} />);
  assert.match(facts, /<dl class="wh-evidence-facts wh-fact-list" aria-label="System facts">/);
  assert.match(facts, /<dt>Migration<\/dt><dd>0112<\/dd>/);
  assert.equal(rangeHref("/accounts", "30d", { filter: "no_factor", range: "7d" }), "/accounts?filter=no_factor&range=30d");
  const tabs = renderToStaticMarkup(<RangeTabs path="/usage" active="7d" />);
  assert.match(tabs, /aria-label="Time range"/);
  assert.match(tabs, /href="\/usage\?range=7d" aria-current="page"/);
  assert.match(tabs, /href="\/usage\?range=90d"/);
  assert.match(tabs, />Today</);
  assert.doesNotMatch(tabs, /role="tab"/);
});
