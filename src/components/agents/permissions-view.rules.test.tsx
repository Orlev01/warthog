// The agent workspace's Rules section (src/components/agents/permissions-view.tsx,
// section="rules"). Global rules apply to every agent and an agent's own rules add to them
// (docs/adr/agent-first-management.md: "The agent workspace shows both inherited global and
// individual rules"). One flat list hid which was which, and the old empty message ("No
// rules just for X yet") read as if nothing applied even when global rules did. The section
// now shows two titled groups with counts — inherited global rules and the agent's own —
// and its empty message says whether global rules still apply.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { PermissionsView, type PermissionsViewProps } from "./permissions-view";
import { ruleSentence, type Rule } from "@/domain/rules/rules";

const GLOBAL_ASK: Rule = { kind: "ask_first", scope: { type: "any_agent" }, action: { type: "send_message", channel: "chat" } };
const GLOBAL_NEVER: Rule = { kind: "never_allow", scope: { type: "any_agent" }, action: { type: "high_tier_request" } };
const OWN_NEVER: Rule = {
  kind: "never_allow",
  scope: { type: "agent", agentId: "conn-1", name: "Claude" },
  action: { type: "send_message", channel: "email" },
  condition: { type: "recipient_is", address: "manager@example.com" },
};

function render(rules: Rule[]): string {
  const props: PermissionsViewProps = {
    agentName: "Claude",
    section: "rules",
    connectors: [],
    lowTierRead: false,
    highTierRequest: false,
    cardAccess: false,
    budget: null,
    skills: [],
    tasksAccess: false,
    recordsAccess: false,
    sharedMemoryRead: false,
    learningSharing: false,
    rules,
  };
  return renderToStaticMarkup(<PermissionsView {...props} />);
}

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Each titled group: its heading text, its count and its markup (up to the next group).
function groups(markup: string): Array<{ title: string; count: number; html: string }> {
  const starts = [...markup.matchAll(/<section aria-labelledby="[^"]*"[^>]*>/g)];
  return starts.map((m, i) => {
    const html = markup.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index : undefined);
    const heading = html.match(/<h3 id="[^"]*"[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>(\d+)<\/span>/);
    assert.ok(heading, `a group carries a heading and count: ${html}`);
    return { title: visibleText(heading[1]!), count: Number(heading[2]), html };
  });
}

test("rules for all agents and the agent's own rules are separate groups with counts", () => {
  const markup = render([GLOBAL_ASK, OWN_NEVER, GLOBAL_NEVER]);
  const found = groups(markup);
  assert.deepEqual(
    found.map(({ title, count }) => ({ title, count })),
    [
      { title: "Rules for all agents", count: 2 },
      { title: "Just for Claude", count: 1 },
    ],
  );
  const [inherited, own] = found;
  for (const rule of [GLOBAL_ASK, GLOBAL_NEVER]) {
    assert.ok(visibleText(inherited!.html).includes(ruleSentence(rule)), "a global rule sits in the inherited group");
    assert.ok(!visibleText(own!.html).includes(ruleSentence(rule)), "and not in the agent's own group");
  }
  assert.ok(visibleText(own!.html).includes(ruleSentence(OWN_NEVER)));
  assert.ok(!visibleText(inherited!.html).includes(ruleSentence(OWN_NEVER)));
  // Kind reads as a word on each row, beyond the sentence itself ("Ask me first", the house
  // wording the shared RuleKindBadge uses).
  assert.match(visibleText(inherited!.html), /Ask me first/);
});

test("with rules for all agents but none of its own, the empty message says those rules still apply", () => {
  const markup = render([GLOBAL_ASK, GLOBAL_NEVER]);
  const own = groups(markup).find((g) => g.title === "Just for Claude");
  assert.ok(own, "the agent's own group is shown even when empty");
  assert.equal(own.count, 0);
  const text = visibleText(own.html);
  assert.match(text, /No rules just for Claude yet/);
  assert.match(text, /2 rules for all agents above still apply/);
  assert.match(own.html, /href="\/rules\?view=new"/, "a route to the rule builder");
});

test("with one global rule the message is singular", () => {
  const own = groups(render([GLOBAL_ASK])).find((g) => g.title === "Just for Claude");
  assert.match(visibleText(own!.html), /The rule for all agents above still applies/);
});

test("with no rules at all, the message says nothing applies yet and no inherited group is shown", () => {
  const markup = render([]);
  const found = groups(markup);
  assert.deepEqual(found.map((g) => g.title), ["Just for Claude"]);
  const text = visibleText(found[0]!.html);
  assert.match(text, /No rules just for Claude yet/);
  assert.match(text, /no rules for all agents apply either/i);
  assert.match(markup, /href="\/rules"/, "the section still links the Rules page");
});

test("with only its own rules, there is no empty inherited group", () => {
  const found = groups(render([OWN_NEVER]));
  assert.deepEqual(found.map(({ title, count }) => ({ title, count })), [{ title: "Just for Claude", count: 1 }]);
});
