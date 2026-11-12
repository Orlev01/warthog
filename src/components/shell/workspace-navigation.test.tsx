import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NAV_GROUPS,
  sectionNavigation,
  agentNavigation,
  navGroupFor,
  pageMeasureFor,
} from "./workspace-navigation";
import { SectionNavigation } from "./section-navigation";

test("grouped navigation preserves every existing destination exactly once", () => {
  const keys = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.key));
  assert.equal(new Set(keys).size, keys.length);
  for (const key of [
    "home",
    "agents",
    "inbox",
    "activity",
    "spending",
    "vault",
    "connectors",
    "skills",
    "memory",
    "life-admin",
    "rules",
    "household",
    "settings",
    "help",
  ])
    assert.ok(keys.includes(key), key);
});
test("section navigation resolves nested routes and does not capture lookalike routes", () => {
  assert.equal(
    sectionNavigation("/settings/security/").items.find((i) => i.active)?.href,
    "/settings/security",
  );
  assert.equal(
    sectionNavigation("/vault/cards").items.find((i) => i.active)?.href,
    "/vault/cards",
  );
  assert.equal(sectionNavigation("/agents/access-key").items.find(i => i.active)?.href, "/agents/connect");
  assert.equal(sectionNavigation("/vaultage").items.length, 0);
  assert.equal(sectionNavigation("/agents/my-agent").items.length, 0);
});
test("agent navigation keeps all resource permissions reachable without leaving the agent", () => {
  for (const section of [
    "connectors",
    "vault",
    "skills",
    "memory",
    "spending",
    "rules",
    "settings",
    "overview",
    "activity",
  ] as const) {
    const nav = agentNavigation("agent-with-id", section);
    assert.equal(nav.primary.filter((i) => i.active).length, 1);
    if (nav.secondary.length)
      assert.equal(nav.secondary.filter((i) => i.active).length, 1);
    for (const item of [...nav.primary, ...nav.secondary])
      assert.match(item.href, /^\/agents\/agent-with-id\?section=/);
  }
  assert.deepEqual(
    agentNavigation("a", "memory").secondary.map((i) => i.label),
    ["Connectors", "Vault", "Skills", "Memory"],
  );
});
test("cross-page tabs are real links with a current-page marker", () => {
  const html = renderToStaticMarkup(
    <SectionNavigation pathname="/settings/security" />,
  );
  assert.match(html, /aria-label="Settings sections"/);
  assert.match(html, /href="\/settings\/security" aria-current="page"/);
  assert.doesNotMatch(html, /role="tab"/);
});
test("sibling route tabs share one page width per section family", () => {
  const measure = (paths: string[]) => new Set(paths.map((p) => pageMeasureFor(p)));
  for (const family of [
    ["/settings", "/settings/agents", "/settings/security", "/settings/notifications", "/settings/data"],
    ["/memory", "/skills"],
    ["/vault", "/vault/cards"],
    ["/activity", "/spending"],
    ["/agents", "/agents/connect", "/agents/access-key", "/agents/some-id"],
  ])
    assert.equal(measure(family).size, 1, family.join(" "));
  assert.equal(pageMeasureFor("/settings/security"), "form");
  assert.equal(pageMeasureFor("/home"), "wide");
  assert.equal(pageMeasureFor("/connectors/key"), "reading");
  assert.equal(pageMeasureFor("/nowhere"), undefined);
});
test("navigation uses the canonical names", () => {
  assert.equal(navGroupFor("help")?.label, "Help");
  assert.equal(navGroupFor("memory")?.label, "Account resources");
  assert.deepEqual(agentNavigation("a", "activity").primary.map((i) => i.label), ["Overview", "Resources", "Controls", "Activity"]);
  assert.deepEqual(sectionNavigation("/vault").items.map((i) => i.label), ["About you", "Cards"]);
  assert.equal(sectionNavigation("/settings/agents").items.find((i) => i.active)?.label, "Agent defaults");
});
