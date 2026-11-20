// The eight admin views (src/components/admin/*-view.tsx; docs/design/admin-portal.md §5):
// each renders a bounded page — heading band, range tabs where ranged, panels — from a
// hand-built model, populated and empty, with plain words, en-AU numbers, no raw colour and
// no text loose on the canvas.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { OverviewView } from "./overview-view";
import { SignupsView } from "./signups-view";
import { UsageView } from "./usage-view";
import { AccountsView } from "./accounts-view";
import { RequestsView } from "./requests-view";
import { ReliabilityView } from "./reliability-view";
import { TrafficView } from "./traffic-view";
import { SystemView } from "./system-view";
import { AdminPageError } from "./view-common";
import * as F from "./test-fixtures";

const NO_HEX = /#[0-9a-fA-F]{3,8}\b/;

// Every visible text node sits inside a bounded component (docs/adr/contained-text.md): walk
// the markup with a tiny tag parser and refuse text whose nearest container is the page itself.
const BOUNDED = /\b(wh-page-heading|wh-panel|wh-list-group|wh-toolbar|wh-stat-tile|wh-notice|wh-empty|wh-tabstrip|wh-subtabs|wh-chip-track|wh-form-actions)\b/;
function looseText(html: string): string[] {
  const loose: string[] = [];
  const stack: boolean[] = [];
  const tokens = html.split(/(<[^>]+>)/).filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith("</")) { stack.pop(); continue; }
    if (token.startsWith("<")) {
      if (token.endsWith("/>")) continue;
      const cls = /class="([^"]*)"/.exec(token)?.[1] ?? "";
      stack.push((stack[stack.length - 1] ?? false) || BOUNDED.test(cls));
      continue;
    }
    if (token.trim() && !(stack[stack.length - 1] ?? false)) loose.push(token.trim());
  }
  return loose;
}

function check(html: string, name: string) {
  assert.doesNotMatch(html, NO_HEX, `${name}: no raw colour`);
  assert.match(html, /^<div class="wh-page">/, `${name}: a page`);
  assert.deepEqual(looseText(html), [], `${name}: no text loose on the canvas`);
}

test("Overview: five tiles with Needs attention first when non-zero, named problems, the funnel, trends and top services", () => {
  const html = renderToStaticMarkup(<OverviewView model={F.OVERVIEW} />);
  check(html, "overview");
  assert.match(html, /<h1>Overview<\/h1>/);
  assert.match(html, /Times are Sydney time\./);
  assert.match(html, /href="\/\?range=30d"/);
  assert.match(html, /href="\/\?range=7d" aria-current="page"/);
  const tiles = [...html.matchAll(/class="wh-stat-label">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(tiles, ["Needs attention", "Sign-ups", "Active people", "Agent requests", "Approvals decided"]);
  assert.match(html, /up 17% on the previous 7 days/);
  assert.match(html, /12 refused or failed/);
  assert.match(html, /median reply 4 min/);
  assert.match(html, /2 connections need reconnecting \(Gmail\)/);
  assert.match(html, /href="\/system"/);
  assert.match(html, /biggest drop/);
  assert.match(html, /aria-label="Top services"/);
  assert.match(html, /role="img" aria-label="Sign-ups per day: 0 to 4, latest 2"/);
});

test("Overview empty: nothing needs attention, tiles read zero with no comparison, every panel names its next step", () => {
  const html = renderToStaticMarkup(<OverviewView model={F.OVERVIEW_EMPTY} />);
  check(html, "overview-empty");
  const tiles = [...html.matchAll(/class="wh-stat-label">([^<]+)</g)].map((m) => m[1]);
  assert.equal(tiles[tiles.length - 1], "Needs attention");
  assert.match(html, /Nothing needs attention/);
  assert.match(html, /no earlier period to compare/);
  assert.match(html, /No accounts yet\. Share the sign-up link/);
  assert.match(html, /No services connected yet/);
});

test("Sign-ups: the funnel in words, refusals, factors and milestones with median days", () => {
  const html = renderToStaticMarkup(<SignupsView model={F.SIGNUPS} />);
  check(html, "signups");
  assert.match(html, /<h1>Sign-ups<\/h1>/);
  assert.match(html, /14 sign-ups the last 7 days · 42 accounts in total/);
  assert.match(html, /85% went on/);
  assert.match(html, /Too many codes/);
  assert.match(html, /Authenticator app/);
  assert.match(html, /Median: same day/);
  assert.match(html, /Median: 2 days/);
  assert.match(html, /href="\/signups\?range=90d"/);
  const empty = renderToStaticMarkup(<SignupsView model={F.SIGNUPS_EMPTY} />);
  check(empty, "signups-empty");
  assert.match(empty, /No one started signing up in this period/);
  assert.match(empty, /No accounts yet\./);
});

test("Usage: active people and agents, request outcomes, latency, approvals and connections with reconnect badges", () => {
  const html = renderToStaticMarkup(<UsageView model={F.USAGE} />);
  check(html, "usage");
  assert.match(html, /<h1>Usage<\/h1>/);
  assert.match(html, /9 people active in the last 7 days/);
  assert.match(html, /<dt>Last 30 days<\/dt><dd>20<\/dd>/);
  assert.match(html, /Waiting for approval/);
  assert.match(html, /<dd>120 ms<\/dd>/);
  assert.match(html, /<dd>850 ms<\/dd>/);
  assert.match(html, /<span class="wh-stat-value">9%<\/span>/);
  assert.match(html, /2 need reconnecting/);
  assert.match(html, /Notion/);
  const empty = renderToStaticMarkup(<UsageView model={F.USAGE_EMPTY} />);
  check(empty, "usage-empty");
  assert.match(empty, /No agent requests in this period/);
  assert.match(empty, /not yet measured/);
  assert.match(empty, /none yet/);
});

test("Accounts: an exact lookup form, the found account's facts, filters with counts and rows with flags — never an address", () => {
  const html = renderToStaticMarkup(<AccountsView model={F.ACCOUNTS} now={F.NOW} />);
  check(html, "accounts");
  assert.match(html, /<h1>Accounts<\/h1>/);
  assert.match(html, /<form [^>]*action="\/accounts"[^>]*method="get"/);
  assert.match(html, /type="email"/);
  assert.match(html, /Account <span class="font-medium tabular-nums">a1b2c3d4<\/span>/);
  assert.match(html, /<dt>Agent requests<\/dt><dd>57<\/dd>/);
  assert.match(html, /href="\/accounts\?filter=no_factor"/);
  assert.match(html, /aria-current="page"[^>]*>All accounts/);
  assert.match(html, /Signed up 10 Nov 2026/);
  assert.match(html, /Last active Today, 3:04 pm/);
  assert.match(html, /Passkey and Authenticator/);
  assert.match(html, /No second factor/);
  assert.match(html, /1 connection to reconnect/);
  assert.doesNotMatch(html, /@/, "no address anywhere in the page");
  const empty = renderToStaticMarkup(<AccountsView model={F.ACCOUNTS_EMPTY} now={F.NOW} />);
  check(empty, "accounts-empty");
  assert.match(empty, /No accounts yet/);
  assert.doesNotMatch(empty, /No account has that address/, "no search, no result message");
  const miss = renderToStaticMarkup(<AccountsView model={{ ...F.ACCOUNTS_EMPTY, lookup: { searched: true, account: null } }} now={F.NOW} />);
  assert.match(miss, /No account has that address\./);
});

test("Requests: a Contact us message shows its text as written, with a reply link and a mark-done form", () => {
  const base = F.REQUESTS.requests[0]!;
  const message = {
    ...base,
    kind: "contact" as const,
    serviceName: "A privacy request",
    topic: "A privacy request",
    message: "Please delete my history.\n\n<script>alert(1)</script> Thanks",
    resolution: null,
  };
  const html = renderToStaticMarkup(<RequestsView model={{ ...F.REQUESTS, requests: [message] }} now={F.NOW} />);
  check(html, "requests-message");
  assert.match(html, />Message</);
  assert.match(html, /A privacy request/);
  assert.match(html, /<p class="whitespace-pre-line[^"]*">Please delete my history\.\n\n&lt;script&gt;alert\(1\)&lt;\/script&gt; Thanks<\/p>/);
  assert.match(html, /href="mailto:sam@example.test\?subject=Re%3A%20your%20message%20to%20Warthog"/);
  assert.match(html, /Reply by email, then mark it done/);
  assert.match(html, /name="to" value="done"/);
});

test("Requests: each request names who asked with their account facts, what would settle it, and a mark-done form", () => {
  const html = renderToStaticMarkup(<RequestsView model={F.REQUESTS} now={F.NOW} />);
  check(html, "requests");
  assert.match(html, /<h1>Requests<\/h1>/);
  assert.match(html, /only page that shows addresses/);
  assert.match(html, /2 waiting · 5 requests in all/);
  assert.match(html, /Marked done\./);
  assert.match(html, /href="\/requests\?filter=all" aria-current="page"/);
  assert.match(html, /href="\/requests"[^>]*>Waiting/);
  assert.match(html, /href="mailto:sam@example.test\?subject=Your%20Warthog%20request%3A%20LinkedIn"/);
  const sneaky = renderToStaticMarkup(<RequestsView model={{ ...F.REQUESTS, requests: [{ ...F.REQUESTS.requests[0]!, person: { ...F.REQUESTS.requests[0]!.person, email: "x?cc=me%40evil.test&body=hi@evil.test" } }] }} now={F.NOW} />);
  assert.match(sneaky, /href="mailto:x%3Fcc%3Dme%2540evil.test%26body%3Dhi@evil.test\?subject=/, "an address can't add recipients or a body to the draft");
  const capped = renderToStaticMarkup(<RequestsView model={{ ...F.REQUESTS, capped: true }} now={F.NOW} />);
  assert.match(capped, /Only the newest 200 are read/);
  assert.match(html, />sam@example.test<\/a>/);
  assert.match(html, /Account <span class="tabular-nums">a1b2c3d4<\/span> · asked Today, 2:00 pm/);
  assert.match(html, /2 agents \(Claude, ChatGPT\)/);
  assert.match(html, /3 services \(Gmail ×2, Notion\)/);
  assert.match(html, /1 connection to reconnect/);
  assert.match(html, /57 agent requests/);
  assert.match(html, /Currency AUD/);
  assert.match(html, /2 requests from them/);
  assert.match(html, /No agent yet/);
  assert.match(html, /New service/);
  assert.match(html, /Google early access/);
  assert.match(html, /Not in the catalogue yet\./);
  assert.match(html, /add their address to the Google early-access list/);
  assert.match(html, /Spotify is in the catalogue now/);
  assert.match(html, /on the Google early-access list, so they can connect it/);
  assert.match(html, /You marked this done on 11 Nov 2026\./);
  const forms = [...html.matchAll(/<form [^>]*action="\/requests\/update" method="post"[\s\S]*?<\/form>/g)].map((m) => m[0]);
  assert.equal(forms.length, 3, "the two waiting requests and the one the operator marked done; settled ones have none");
  assert.match(forms[0]!, /name="id" value="11111111-1111-4111-8111-111111111111"/);
  assert.match(forms[0]!, /name="to" value="done"/);
  assert.match(forms[0]!, /name="filter" value="all"/);
  assert.match(forms[0]!, /Mark done/);
  assert.match(forms[2]!, /name="to" value="waiting"/);
  assert.match(forms[2]!, /Move back to waiting/);

  const empty = renderToStaticMarkup(<RequestsView model={F.REQUESTS_EMPTY} now={F.NOW} />);
  check(empty, "requests-empty");
  assert.match(empty, /Nothing is waiting/);
  assert.doesNotMatch(empty, /<form/);
  const problem = renderToStaticMarkup(<RequestsView model={{ ...F.REQUESTS_EMPTY, notice: "problem" }} now={F.NOW} />);
  assert.match(problem, /role="alert"[\s\S]*couldn&#x27;t be changed/);
});

test("Reliability: failure tiles, sign-in and request failures, connector trouble, integrity, jobs and the sweep table", () => {
  const html = renderToStaticMarkup(<ReliabilityView model={F.RELIABILITY} now={F.NOW} />);
  check(html, "reliability");
  assert.match(html, /<h1>Reliability<\/h1>/);
  assert.match(html, /12 failed agent requests the last 7 days · 3 failed sign-ins · 1 failed job · 1 sweep overdue/);
  assert.match(html, /down 20% on the previous 7 days/);
  assert.match(html, /wh-stat-delta wh-tone-success/, "fewer failures is welcome");
  assert.match(html, /1 lockout alert sent/);
  assert.match(html, /Tool error/);
  assert.match(html, /<caption>Each sweep/);
  assert.match(html, /<th scope="col">Sweep<\/th>/);
  assert.match(html, />Overdue</);
  assert.match(html, />On time</);
  assert.match(html, /role="region" aria-label="Background sweeps" tabindex="0"/);
  assert.match(html, /connection\.refresh · failed/);
  const empty = renderToStaticMarkup(<ReliabilityView model={F.RELIABILITY_EMPTY} now={F.NOW} />);
  check(empty, "reliability-empty");
  assert.match(empty, /Not yet run/);
  assert.match(empty, /Every connection is healthy\./);
  assert.match(empty, /No sweeps have run yet\./);
});

test("Traffic: totals, trends, route and host breakdowns, and the Azure link only when configured", () => {
  const html = renderToStaticMarkup(<TrafficView model={F.TRAFFIC} />);
  check(html, "traffic");
  assert.match(html, /<h1>Traffic<\/h1>/);
  assert.match(html, /5,200 requests the last 7 days · 900 page loads · 3 refusals/);
  assert.match(html, /href="https:\/\/portal\.azure\.com[^"]*" rel="noreferrer" target="_blank"/);
  assert.match(html, /Signed-in app/);
  assert.match(html, /Admin portal/);
  assert.match(html, /Today by hour/);
  // Azure's health checks are their own tile, not part of the requests.
  assert.match(html, /<span class="wh-stat-label">Requests<\/span><span class="wh-stat-value">5,200<\/span><span class="wh-stat-sub">Not counting health checks<\/span>/);
  assert.match(html, /<span class="wh-stat-label">Health checks<\/span><span class="wh-stat-value">60,480<\/span><span class="wh-stat-sub">Azure checking the app is running, not visitors<\/span>/);
  assert.doesNotMatch(html, /health probes/, "the route breakdown no longer carries the probes");
  const empty = renderToStaticMarkup(<TrafficView model={F.TRAFFIC_EMPTY} />);
  check(empty, "traffic-empty");
  assert.doesNotMatch(empty, /portal\.azure\.com/);
  assert.match(empty, /No traffic counted yet/);
});

test("System: release, totals, the metric store and sweeps; the error page is bounded with one notice", () => {
  const html = renderToStaticMarkup(<SystemView model={F.SYSTEM} now={F.NOW} />);
  check(html, "system");
  assert.match(html, /<h1>System<\/h1>/);
  assert.match(html, /Schema 0112_admin_indexes/);
  assert.match(html, /<dt>Text messages<\/dt><dd>Off<\/dd>/);
  assert.match(html, /<dd>12,345<\/dd>/);
  assert.match(html, /<dd>400 days<\/dd>/);
  assert.match(html, /traffic-flush/);
  const empty = renderToStaticMarkup(<SystemView model={F.SYSTEM_EMPTY} now={F.NOW} />);
  check(empty, "system-empty");
  assert.match(empty, /Schema unknown/);
  assert.match(empty, /None yet/);
  const error = renderToStaticMarkup(<AdminPageError title="Usage" description="Who is active." />);
  check(error, "error");
  assert.match(error, /role="alert"/);
  assert.match(error, /Some numbers couldn&#x27;t be loaded\. Refresh to try again\./);
});
