// Home's "Build your profile" block (src/components/home/profile-build-block.tsx;
// docs/adr/profile-build.md): one fixed prompt to copy into the person's agent, or what's missing,
// or what waits for the person to check. One primary action, plain words, no vault promises.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ProfileBuildBlock } from "./profile-build-block";
import { DashboardView } from "./dashboard-view";
import { computeSetupChecklist } from "@/domain/home/checklist";
import { PROFILE_PROMPT } from "@/domain/life-admin/profile-skill";

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const primaries = (markup: string) => (markup.match(/bg-accent text-accent-fg/g) ?? []).length;

test("ready: the prompt to copy, what the agent can read, and one primary Copy for the agent", () => {
  const markup = renderToStaticMarkup(<ProfileBuildBlock view={{ state: "ready", agentName: "Claude", sources: ["Gmail", "Google Calendar", "Google Drive"] }} />);
  assert.match(markup, /<section id="build-profile"/);
  assert.match(text(markup), /Let Claude build your profile/);
  assert.match(text(markup), /Claude can read: Gmail, Google Calendar and Google Drive\./);
  assert.match(text(markup), /It can't fill in your vault or cards; you add those yourself\./);
  assert.ok(markup.includes(PROFILE_PROMPT.split("\n")[0]!), "the prompt itself is shown");
  assert.match(markup, /Copy for Claude/);
  assert.equal(primaries(markup), 1, "one primary action");
});

test("no sources or no records: says what's missing and links to the fix on the agent's page", () => {
  const sources = renderToStaticMarkup(<ProfileBuildBlock view={{ state: "no_sources", agentName: "Claude", agentHref: "/agents/a1?section=connectors" }} />);
  assert.match(text(sources), /Claude can't read anything yet/);
  assert.match(sources, /href="\/agents\/a1\?section=connectors"[^>]*>[\s\S]*?Choose what Claude can read/);
  assert.doesNotMatch(sources, /Copy for/);
  const records = renderToStaticMarkup(<ProfileBuildBlock view={{ state: "no_records", agentName: "Claude", agentHref: "/agents/a1?section=settings" }} />);
  assert.match(text(records), /Claude can't save to your Life admin yet/);
  assert.match(records, /href="\/agents\/a1\?section=settings"[^>]*>[\s\S]*?Let Claude use Life admin/);
});

test("waiting: how many things wait, with a way to check each kind", () => {
  const both = renderToStaticMarkup(<ProfileBuildBlock view={{ state: "waiting", records: 10, aboutYou: 2 }} />);
  assert.match(text(both), /Your agent found 12 things for you to check/);
  assert.match(both, /href="\/life-admin"[^>]*>Check 10 records in Life admin/);
  assert.match(both, /href="\/vault"[^>]*>Check 2 details in About you/);
  assert.equal(primaries(both), 1);
  const one = renderToStaticMarkup(<ProfileBuildBlock view={{ state: "waiting", records: 0, aboutYou: 1 }} />);
  assert.match(text(one), /found 1 thing for you to check/);
  assert.equal(primaries(one), 1, "About you becomes the primary when it's the only one");
});

test("Home shows the block inside Finish setting up, in every state, so the step's row always lands on it", () => {
  const props = {
    personName: "Sam",
    checklist: computeSetupChecklist({ agentConnected: true }),
    pendingApprovals: 0,
    activity: [],
    reminders: [],
    profileBuild: { state: "ready" as const, agentName: "Claude", sources: ["Gmail"] },
  };
  const withAgent = renderToStaticMarkup(
    <DashboardView {...props} agents={[{ id: "a1", name: "Claude", status: "connected", lastActive: "Today", href: "/agents/a1" } as never]} />,
  );
  assert.match(withAgent, /id="build-profile"/);
  assert.match(withAgent, /href="\/home#build-profile"/, "the step's row leads to it");
  const noAgent = renderToStaticMarkup(<DashboardView {...props} checklist={computeSetupChecklist({})} agents={[]} profileBuild={{ state: "no_agent" }} />);
  assert.match(noAgent, /id="build-profile"/, "before an agent too: the row still lands somewhere");
  assert.match(text(noAgent), /Connect an agent to build your profile/);
  assert.equal(primaries(noAgent), 1, "only Connect your first agent is primary");
});

test("the block outlines itself when a link lands on it", () => {
  const markup = renderToStaticMarkup(<ProfileBuildBlock view={{ state: "no_agent" }} />);
  assert.match(markup, /<section id="build-profile"[^>]*class="[^"]*target:outline/);
});

test("on Life admin the block is quiet: every button secondary, with a way to connect an agent", () => {
  const ready = renderToStaticMarkup(<ProfileBuildBlock view={{ state: "ready", agentName: "Claude", sources: ["Gmail"] }} quiet />);
  assert.equal(primaries(ready), 0);
  assert.match(ready, /Copy for Claude/);
  const none = renderToStaticMarkup(<ProfileBuildBlock view={{ state: "no_agent" }} quiet />);
  assert.match(none, /href="\/agents\/connect"[^>]*>[\s\S]*?Connect an agent/);
  assert.equal(primaries(none), 0);
});
