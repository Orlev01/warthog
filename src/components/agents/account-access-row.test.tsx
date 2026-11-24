// One connected account's row on an agent's Connectors section (./account-access-row,
// docs/adr/several-accounts-per-agent.md). An agent can use several accounts of one service, so
// each account has its own row with its own on/off, reading, changes and tool choices. The row is
// self-contained — the account, this agent's grant of it and the agent's defaults are all it
// takes — so it can move to another tab of the agent page unchanged (UI/UX audit redesign §3.4).
//
// Rendered with react-dom/server and read as markup: behaviour, not source.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountAccessRow, type AccountAccessRowProps } from "./account-access-row";

const ID = "5e2b8f0c-7d1a-4c3b-9e8f-0a1b2c3d4e5f";
const ACCOUNT: AccountAccessRowProps["account"] = {
  id: ID,
  connectorId: "google-gmail",
  serviceName: "Gmail",
  label: "levyorenbilling@gmail.com",
  connected: true,
  readTools: ["google-gmail__search", "google-gmail__read"],
  changeTools: ["google-gmail__draft", "google-gmail__send"],
};

function render(over: Partial<AccountAccessRowProps> = {}): string {
  const props: AccountAccessRowProps = {
    agentName: "ChatGPT",
    account: ACCOUNT,
    grant: {},
    defaults: { readTools: true, changeTools: "ask_first" },
    ...over,
  };
  return renderToStaticMarkup(<ul><AccountAccessRow {...props} /></ul>);
}

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function summary(markup: string): string {
  return text(markup.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)![1]!);
}

test("the row stands alone: headed by service and account, from its account, grant and the agent's defaults", () => {
  const markup = render({ defaults: { readTools: false, changeTools: "allow" } });
  assert.match(summary(markup), /^Gmail · levyorenbilling@gmail\.com ChatGPT can use it/);
  assert.match(text(markup), /Same as this agent's setting \(off\)/, "the reading default named in words");
  assert.match(text(markup), /Same as this agent's setting \(allowed, subject to rules\)/, "the changes default named in words");
  assert.match(summary(markup), /Reads off/);
  assert.match(summary(markup), /Changes: allowed, subject to rules/);
  assert.match(summary(markup), /All 4 tools/);
  assert.match(markup, new RegExp(`<input[^>]*name="account:${ID}"[^>]*checked=""`));
});

test("an account the agent may not use says so, and its toggle starts off", () => {
  const markup = render({ grant: null });
  assert.match(summary(markup), /Not allowed/);
  assert.doesNotMatch(summary(markup), /can use it|Reads |Changes:/, "no access summary for an account it can't use");
  assert.doesNotMatch(markup, new RegExp(`<input[^>]*name="account:${ID}"[^>]*checked=""`));
  assert.match(text(markup), /Let ChatGPT use levyorenbilling@gmail\.com/);
});

test("an account that needs reconnecting says so in its header and offers the way to fix it", () => {
  const markup = render({ account: { ...ACCOUNT, connected: false } });
  assert.match(summary(markup), /ChatGPT can use it Reconnect needed/);
  assert.match(text(markup), /This account needs reconnecting\. ChatGPT can't use it until you reconnect it on the Connectors page ?\./);
  assert.match(markup, /<a href="\/connectors"/);
  assert.doesNotMatch(summary(render()), /Reconnect needed/);
});

test("the account's own settings are preselected and its chosen tools ticked", () => {
  const markup = render({ grant: { readTools: false, changeTools: "off", allowedTools: ["google-gmail__search"] } });
  assert.match(markup, new RegExp(`name="accountRead:${ID}"><option value="default">[^]*?<option value="off" selected=""`));
  assert.match(markup, new RegExp(`name="accountChange:${ID}"><option value="default">[^]*?<option value="off" selected=""`));
  assert.match(markup, new RegExp(`name="accountToolScope:${ID}"><option value="all">[^]*?<option value="chosen" selected=""`));
  assert.match(summary(markup), /Reads off/);
  assert.match(summary(markup), /1 of 4 tools/);
  const ticked = [...markup.matchAll(/<input\b([^>]*)\/>/g)]
    .filter((m) => m[1]!.includes(`name="accountTool:${ID}"`) && /\schecked=""/.test(m[1]!))
    .map((m) => m[1]!.match(/value="([^"]*)"/)![1]);
  assert.deepEqual(ticked, ["google-gmail__search"]);
  // Changes are off for this account, so its change tools say so beside them.
  assert.match(text(markup), /Makes changes \(2\) Draft google-gmail__draft Off/);
});

test("an account with changes left to the agent shows Ask me first beside its change tools", () => {
  assert.match(text(render()), /Send google-gmail__send Ask me first/);
});

test("an account whose tools couldn't be loaded says so, with the way to fix it", () => {
  const markup = render({ account: { ...ACCOUNT, connectorId: "notion", serviceName: "Notion", label: "Notion 2", readTools: [], changeTools: [] } });
  assert.match(summary(markup), /^Notion · Notion 2/);
  assert.match(summary(markup), /No tools found/);
  assert.match(text(markup), /We couldn't load this account's tools\. Try reconnecting it on the Connectors page\./);
});

// UI/UX audit W-35: the row is a divided list row, not a bordered card inside the panel.
test("the row is a list row with no box of its own", () => {
  const markup = render();
  assert.match(markup, /^<ul><li\b/);
  assert.doesNotMatch(markup, /rounded-card|wh-connector-module|wh-tool-group|wh-card/);
  // Neither the row nor its tool groups draw a box: the panel's dividers separate rows.
  for (const tag of ["li", "details", "fieldset"]) {
    for (const m of markup.matchAll(new RegExp(`<${tag}\\b[^>]*class="([^"]*)"`, "g"))) {
      assert.doesNotMatch(m[1]!, /(^|\s)(border|rounded-card|shadow)(\s|$)/, `<${tag} class="${m[1]}">`);
    }
  }
});
