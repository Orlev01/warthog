// E18-S01 — Portal navigation IA and active-section helper (src/components/shell/nav.ts).
//
// RED-first: src/components/shell/nav.ts does NOT exist yet, so importing `./nav`
// fails and every test here is red until the builder adds the module. That
// absence is the whole point of test-first — do not implement anything to make
// these pass.
//
// These tests pin BEHAVIOUR — the data the module EXPOSES and what the helper
// RETURNS — never the source text of nav.ts. A later behaviour-preserving
// refactor (different internal matching, reordered constants, extra helpers)
// stays green as long as the IA and the resolver keep behaving the same way.
//
// WHY this module exists: the app shell is prop-driven (AppShell takes an
// `activeSection` string), and the chrome + layout need ONE canonical list of
// portal destinations plus a way to light the current section, so every portal
// page is reachable from navigation.
//
// The contract the builder implements (exactly this):
//
//   type NavNode = {
//     key: string;                      // stable id; it IS the AppShell
//                                        // `activeSection` value (see below)
//     label: string;                    // the visible word ("Rules & budgets")
//     href?: string;                    // the node's own route
//     children?: readonly NavNode[];    // sub-destinations
//   };
//
//   PORTAL_NAV: readonly NavNode[]
//     — the FIVE primary sections, in documented order:
//         Home (/home), Inbox (/inbox), Activity (/activity), Agents (/agents),
//         and More.
//       The More node groups its children (the "More" menu), in order:
//         Vault (/vault), Connectors (/connectors), Rules & budgets (/rules),
//         Spending (/spending), Skills (/skills), Memory (/memory),
//         Life admin (/life-admin), Household (/household), Settings, Help (/help).
//       The Settings node groups its own children, in order:
//         Security (/settings/security), Notifications (/settings/notifications),
//         Data & privacy (/settings/data).
//
//   activeSectionForPath(pathname: string): string | null
//     — the `key` of the section a portal path belongs to, or a nullish value
//       (no active section) for a path the IA does not own — NEVER throws.
//       A section OWNS its route and everything under it, at a path-segment
//       boundary: /vault and /vault/cards → "vault"; the whole /settings area
//       (/settings, /settings/security, /settings/notifications, /settings/data)
//       → "settings"; the portal root "/" and /home → "home".
//
// The `key` values below mirror the `activeSection` keys AppShell already uses
// (src/components/shell/app-shell.tsx) and that pages already pass
// (settings/security/page.tsx renders <AppShell activeSection="settings">). They
// are a real cross-task contract, not an arbitrary naming choice: nav.ts is the
// canonical list AppShell consumes, so its keys must be the same words.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PORTAL_NAV, activeSectionForPath } from "./nav";

// --- structural view of the exported IA (runtime-tolerant) ------------------

type NavNode = {
  key: string;
  label: string;
  href?: string;
  children?: readonly NavNode[];
};

// Read PORTAL_NAV through a structural type so these tests compile against any
// compatible shape the builder picks for the node type.
const SECTIONS = PORTAL_NAV as readonly NavNode[];

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Find a node by an exact (case-insensitive) label.
function byLabel(nodes: readonly NavNode[], label: string): NavNode | undefined {
  return nodes.find((n) => norm(n.label) === norm(label));
}

// Find a node whose label contains a distinctive stem (case-insensitive) — used
// for the "&"-bearing labels ("Rules & budgets", "Data & privacy") so reworded
// copy stays green as long as the destination is still named.
function byStem(nodes: readonly NavNode[], stem: string): NavNode | undefined {
  const s = norm(stem);
  return nodes.find((n) => norm(n.label).includes(s));
}

// The active section of a path, as a plain string or null — never throws here.
function active(pathname: string): string | null {
  const r = activeSectionForPath(pathname) as unknown;
  return r == null ? null : (r as string);
}

// --- the IA: the five primary sections --------------------------------------

test("PORTAL_NAV exposes exactly the five primary sections, in order", () => {
  assert.ok(Array.isArray(SECTIONS), "PORTAL_NAV must be an array of nav nodes");
  assert.equal(
    SECTIONS.length,
    5,
    `exactly five primary sections expected, got ${SECTIONS.length}: ${JSON.stringify(
      SECTIONS.map((n) => n.label),
    )}`,
  );
  // Keys in documented left-to-right order — the AppShell activeSection values.
  assert.deepEqual(
    SECTIONS.map((n) => n.key),
    ["home", "inbox", "activity", "agents", "more"],
    "the five primary sections must be Home, Inbox, Activity, Agents, More (keyed as such, in order)",
  );
  // Each primary section carries its documented label, in order.
  const expectedLabels = ["Home", "Inbox", "Activity", "Agents", "More"];
  SECTIONS.forEach((node, i) => {
    assert.equal(
      norm(node.label),
      norm(expectedLabels[i]!),
      `primary section ${i} must be labelled "${expectedLabels[i]}", got "${node.label}"`,
    );
  });
});

test("the four primary leaf sections carry their real routes", () => {
  const leaves: ReadonlyArray<[string, string]> = [
    ["home", "/home"],
    ["inbox", "/inbox"],
    ["activity", "/activity"],
    ["agents", "/agents"],
  ];
  for (const [key, href] of leaves) {
    const node = SECTIONS.find((n) => n.key === key);
    assert.ok(node, `a primary section keyed "${key}" must exist`);
    assert.equal(node!.href, href, `the ${key} section must link to ${href}, got ${node!.href}`);
  }
});

// --- the IA: the More group --------------------------------------------------

function moreNode(): NavNode {
  const more = byLabel(SECTIONS, "More") ?? SECTIONS.find((n) => n.key === "more");
  assert.ok(more, "PORTAL_NAV must include a primary 'More' section");
  return more!;
}

function moreChildren(): readonly NavNode[] {
  const children = moreNode().children;
  assert.ok(
    Array.isArray(children) && children!.length > 0,
    "the More section must group its children (Vault, Connectors, …)",
  );
  return children!;
}

test("the More section groups exactly its ten children, in order", () => {
  const children = moreChildren();
  assert.deepEqual(
    children.map((n) => n.key),
    [
      "vault",
      "connectors",
      "rules",
      "spending",
      "skills",
      "memory",
      "life-admin",
      "household",
      "settings",
      "help",
    ],
    "the More group must contain exactly Vault, Connectors, Rules & budgets, Spending, " +
      "Skills, Memory, Life admin, Household, Settings, Help (keyed as such, in order)",
  );
});

test("each More-group child carries its documented label", () => {
  const children = moreChildren();
  const expected: ReadonlyArray<[string, string]> = [
    ["vault", "Vault"],
    ["connectors", "Connectors"],
    ["rules", "Rules"], // stem of "Rules & budgets"
    ["spending", "Spending"],
    ["skills", "Skills"],
    ["memory", "Memory"],
    ["life-admin", "Life admin"],
    ["household", "Household"],
    ["settings", "Settings"],
    ["help", "Help"],
  ];
  for (const [key, stem] of expected) {
    const node = children.find((n) => n.key === key);
    assert.ok(node, `a More-group child keyed "${key}" must exist`);
    assert.ok(
      norm(node!.label).includes(norm(stem)),
      `the ${key} child must be labelled with "${stem}", got "${node!.label}"`,
    );
  }
});

test("each More-group child carries its real route", () => {
  const children = moreChildren();
  const routes: ReadonlyArray<[string, string]> = [
    ["vault", "/vault"],
    ["connectors", "/connectors"],
    ["rules", "/rules"],
    ["spending", "/spending"],
    ["skills", "/skills"],
    ["memory", "/memory"],
    ["life-admin", "/life-admin"],
    ["household", "/household"],
    ["help", "/help"],
  ];
  for (const [key, href] of routes) {
    const node = children.find((n) => n.key === key);
    assert.ok(node, `a More-group child keyed "${key}" must exist`);
    assert.equal(node!.href, href, `the ${key} child must link to ${href}, got ${node!.href}`);
  }
  // Settings leads into the settings area; its own href is left to the builder
  // (either /settings or a first sub-page), so only require it to live there.
  const settings = children.find((n) => n.key === "settings");
  assert.ok(settings, "a More-group child keyed 'settings' must exist");
  assert.ok(
    typeof settings!.href === "string" && settings!.href.startsWith("/settings"),
    `the Settings child must point into the /settings area, got ${settings!.href}`,
  );
});

// --- the IA: the Settings sub-group -----------------------------------------

test("the Settings section groups exactly Security, Notifications, Data & privacy", () => {
  const settings = moreChildren().find((n) => n.key === "settings");
  assert.ok(settings, "a Settings node must exist under the More group");
  const subs = settings!.children;
  assert.ok(Array.isArray(subs), "Settings must group its own children (Security, Notifications, …)");
  assert.equal(
    subs!.length,
    3,
    `Settings must have exactly three sub-pages, got ${subs!.length}: ${JSON.stringify(
      subs!.map((n) => n.label),
    )}`,
  );

  // Labels in documented order (matched by distinctive stem).
  const security = subs![0]!;
  const notifications = subs![1]!;
  const data = subs![2]!;
  assert.ok(norm(security.label).includes("security"), `Settings[0] must be Security, got "${security.label}"`);
  assert.ok(
    norm(notifications.label).includes("notifications"),
    `Settings[1] must be Notifications, got "${notifications.label}"`,
  );
  assert.ok(norm(data.label).includes("data"), `Settings[2] must be Data & privacy, got "${data.label}"`);

  // Real routes, in order.
  assert.deepEqual(
    subs!.map((n) => n.href),
    ["/settings/security", "/settings/notifications", "/settings/data"],
    "the Settings sub-pages must link to /settings/security, /settings/notifications, /settings/data in order",
  );

  // And confirm the stem-found nodes resolve to the same three routes, so a
  // reorder that kept the labels is still caught by the ordered check above.
  assert.equal(byStem(subs!, "Security")?.href, "/settings/security");
  assert.equal(byStem(subs!, "Notifications")?.href, "/settings/notifications");
  assert.equal(byStem(subs!, "Data")?.href, "/settings/data");
});

// --- activeSectionForPath: the resolver -------------------------------------

test("activeSectionForPath maps the portal root and /home to Home", () => {
  assert.equal(active("/"), "home", "the portal root '/' must resolve to the Home section");
  assert.equal(active("/home"), "home", "/home must resolve to the Home section");
});

test("activeSectionForPath maps each primary leaf path to its section", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["/inbox", "inbox"],
    ["/activity", "activity"],
    ["/agents", "agents"],
    ["/agents/connect", "agents"], // a sub-path lights its owning section
  ];
  for (const [path, key] of cases) {
    assert.equal(active(path), key, `${path} must resolve to the "${key}" section`);
  }
});

test("activeSectionForPath maps a More-group path (and its sub-paths) to that child", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["/vault", "vault"],
    ["/vault/cards", "vault"], // AC: /vault/cards resolves to the Vault entry
    ["/connectors", "connectors"],
    ["/rules", "rules"],
    ["/spending", "spending"],
    ["/skills", "skills"],
    ["/memory", "memory"],
    ["/life-admin", "life-admin"],
    ["/household", "household"],
    ["/help", "help"],
    ["/help/compatibility", "help"],
  ];
  for (const [path, key] of cases) {
    assert.equal(active(path), key, `${path} must resolve to the "${key}" section`);
  }
});

test("activeSectionForPath maps the whole /settings area to the single Settings section", () => {
  for (const path of ["/settings", "/settings/security", "/settings/notifications", "/settings/data"]) {
    assert.equal(active(path), "settings", `${path} must resolve to the "settings" section`);
  }
});

test("activeSectionForPath maps the More landing page to the More section", () => {
  assert.equal(active("/more"), "more", "/more must resolve to the More section");
});

// The IA and the resolver must agree: visiting any destination lights its own
// section. Derived from PORTAL_NAV itself, so it can't drift from the data.
test("every IA destination lights its own section (IA ↔ resolver agree)", () => {
  const leaves = SECTIONS.filter((n) => n.key !== "more"); // More's href is optional
  const nodes = [...leaves, ...moreChildren()];
  for (const node of nodes) {
    assert.ok(
      typeof node.href === "string" && node.href.startsWith("/"),
      `section "${node.key}" must carry an absolute route, got ${node.href}`,
    );
    assert.equal(
      active(node.href!),
      node.key,
      `visiting ${node.href} must light the "${node.key}" section`,
    );
  }
});

test("activeSectionForPath returns no active section for a path the IA does not own", () => {
  // Real app routes that are NOT portal sections, plus plainly-unknown paths.
  for (const path of ["/privacy", "/signin", "/signup", "/oauth/authorize", "/nope", "/x/y/z"]) {
    assert.equal(active(path), null, `${path} is not a portal section and must resolve to none`);
  }
});

test("activeSectionForPath does not light a section for a sibling that merely shares a prefix", () => {
  // "/homework" is not under Home; "/vaultage" is not under Vault. A naive
  // startsWith would wrongly light them — resolution is at a segment boundary.
  assert.equal(active("/homework"), null, "/homework must not resolve to the Home section");
  assert.equal(active("/vaultage"), null, "/vaultage must not resolve to the Vault section");
});

test("activeSectionForPath never throws, whatever path it is given", () => {
  for (const path of ["", "/", "/home", "/settings/security", "/nope", "/a/b/c/d", "/vault/cards"]) {
    assert.doesNotThrow(() => activeSectionForPath(path), `activeSectionForPath(${JSON.stringify(path)}) must not throw`);
  }
});
