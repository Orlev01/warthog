// The Now view (docs/adr/agent-runs.md, amendment of 25 November 2026): conversations grouped
// by provider, each with the agent's own description (quoted and attributed), how it came in,
// its latest action and whether it called recently; loose actions and quiet agents are still
// accounted for; and no copy claims an app is live or online.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsNowView, type AgentsNowViewProps, type NowConversationView } from "./agents-now-view";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&rsquo;/g, "’").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const conversation = (overrides: Partial<NowConversationView> = {}): NowConversationView => ({
  id: "5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e",
  href: "/activity?run=5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e",
  label: "Fixing the website tests",
  via: "Claude Code",
  entries: 4,
  lastCall: "3 min ago",
  lastCallAt: "2026-11-25T11:57:00.000Z",
  statusChanged: null,
  latest: { title: "Send", outcome: "Waiting for you", outcomeGroup: "waiting", service: "Gmail" },
  active: true,
  ...overrides,
});

const PROPS: AgentsNowViewProps = {
  providers: [
    {
      key: "claude",
      label: "Claude",
      agents: [{
        id: "a-cc", name: "Claude Code · laptop", platform: "Claude", connected: true, href: "/agents/a-cc",
        conversations: [
          conversation(),
          conversation({ id: "r2", href: "/activity?run=r2", label: null, via: null, entries: 1, active: false, latest: null, lastCall: "2 hours ago", statusChanged: null }),
        ],
        unlinked: null,
      }],
    },
    {
      key: "gemini",
      label: "Gemini",
      agents: [{
        id: "a-gem", name: "Gemini CLI · research", platform: "localhost", connected: true, href: "/agents/a-gem",
        conversations: [conversation({ id: "r3", href: "/activity?run=r3", label: "Writing the release notes", via: "Gemini CLI", statusChanged: "1 min ago", latest: { title: "Search memories", outcome: "Allowed", outcomeGroup: "done", service: null } })],
        unlinked: { count: 3, href: "/activity?agent=a-gem&run=none", lastCall: "5 min ago" },
      }],
    },
  ],
  quiet: [{ id: "a-gpt", name: "ChatGPT", href: "/agents/a-gpt" }, { id: "a-dev", name: "Dev console", href: "/agents/a-dev" }],
  activeCount: 2,
  updatedAt: "12:00 pm",
  updatedAtIso: "2026-11-25T12:00:00.000Z",
};

test("conversations are grouped by provider, each agent named and linked", () => {
  const html = renderToStaticMarkup(<AgentsNowView {...PROPS} />);
  const shown = text(html);
  assert.ok(shown.indexOf("Claude Code · laptop") < shown.indexOf("Gemini CLI · research"), "providers keep the loader's order");
  assert.match(html, /<h2[^>]*>Claude<\/h2>/);
  assert.match(html, /<h2[^>]*>Gemini<\/h2>/);
  assert.match(html, /href="\/agents\/a-gem"[^>]*>Gemini CLI · research<\/a>/);
  assert.match(shown, /3 conversations in the last day · 2 active/);
  assert.match(shown, /Updated 12:00 pm/);
});

test("a conversation shows the agent's own words, how it came in, its latest action and whether it called lately", () => {
  const html = renderToStaticMarkup(<AgentsNowView {...PROPS} />);
  const shown = text(html);
  assert.match(html, /href="\/activity\?run=5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e"/);
  assert.match(html, /<span class="sr-only">Claude Code · laptop’s description: <\/span>“Fixing the website tests”/, "quoted and attributed to the agent");
  assert.match(shown, /via Claude Code · 4 entries · last call 3 min ago/);
  assert.match(shown, /Latest: Send · Gmail Waiting for you/);
  assert.match(shown, /Active/);
  assert.match(shown, /Untitled conversation 1 entry · last call 2 hours ago/, "a conversation the agent didn't describe");
  assert.match(shown, /description changed 1 min ago/);
});

test("an agent's calls outside any conversation, and quiet agents, are still accounted for", () => {
  const html = renderToStaticMarkup(<AgentsNowView {...PROPS} />);
  assert.match(html, /href="\/activity\?agent=a-gem&amp;run=none"[^>]*>3 actions not in a conversation<\/a>/);
  assert.match(text(html), /Nothing in the last day from ChatGPT and Dev console ?\./);
});

test("the page says what active means and never claims an app is live or online", () => {
  const shown = text(renderToStaticMarkup(<AgentsNowView {...PROPS} />));
  assert.match(shown, /Active means it called Warthog in the last 15 minutes/);
  assert.match(shown, /Warthog only sees calls made to it/);
  assert.doesNotMatch(shown, /\blive\b|\bonline\b/i);
});

test("with nothing in the last day it says how conversations appear", () => {
  const shown = text(renderToStaticMarkup(<AgentsNowView {...PROPS} providers={[]} activeCount={0} />));
  assert.match(shown, /No conversations in the last day/);
  assert.doesNotMatch(shown, /in the last day · /, "no summary count when empty");
});
