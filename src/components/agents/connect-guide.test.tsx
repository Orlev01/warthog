// E10-S04 — Guided connect view per platform (src/components/agents/connect-guide.tsx).
//
// RED-first: src/components/agents/connect-guide.tsx does NOT exist yet, so importing
// `./connect-guide` throws and EVERY test in this file fails until the builder adds the
// component. That absence is the entire point of test-first — do NOT implement anything
// to make these pass.
//
// WHY this component exists (brief "Connect an agent"; task E10-S04): a signed-in person
// on the Agents area needs plain, per-platform steps for pasting Warthog's connector
// address into each AI client, a button to copy that address, and — where a platform
// cannot yet use a remote connector — a note of that gap and what to do instead. From ONE
// render-testable component it shows, for Claude, ChatGPT, Gemini, Grok, Llama-based
// clients and "Other":
//   • Warthog's connector address, shown to paste, with a COPY control, and
//   • ORDERED step text telling the person exactly where to paste it, and
//   • any current platform GAP (e.g. a platform that does not yet support remote
//     connectors) together with WHAT TO DO INSTEAD.
//
// ── The contract the builder implements (test-first spec) ─────────────────────────────
//
//   ConnectGuide({ connectorAddress: string }): JSX.Element
//     • connectorAddress — Warthog's connector address to paste. It is config-driven
//       (INV-21 / constitution #21: the public address is read from configuration, the
//       public base URL, never hard-coded in a component). src/components/** is PURE
//       (no config, no DB), so the value arrives as a PROP — the page/entry that mounts
//       this view derives it from `config.publicBaseUrl` and passes it in, exactly as the
//       sibling public Help view takes `connectorAddress`. The view DISPLAYS whatever
//       address it is given (so swapping the config value swaps what the screen shows and
//       what Copy copies) and never bakes an address into the component.
//     • Renders a section per platform (Claude, ChatGPT, Gemini, Grok, Llama, Other) with
//       ORDERED steps, a COPY control for the address, and a note of any platform gap and
//       what to do instead.
//
// ── How these tests stay honest ───────────────────────────────────────────────────────
//   * They pin BEHAVIOUR — what the component RENDERS and the accessible controls it
//     exposes — never the source text of connect-guide.tsx. A behaviour-preserving
//     refactor (different wrapper elements, reworded-but-still-plain copy, extra classes,
//     a different icon, next/link vs <a>) stays green as long as the assembled view still
//     names every platform, shows the config-driven address with a live Copy control and
//     ordered steps, and notes a gap with an alternative.
//   * The COPY control is a client component (it writes to the clipboard on click). There
//     is no DOM/jsdom here and React component / E2E testing is a per-job ADR, so
//     `renderToStaticMarkup` renders a client component's markup but never runs its click
//     handler. We therefore assert the OBSERVABLE render guarantee — a live (not-dead)
//     Copy control is present alongside the address it copies — rather than grepping the
//     module for a "use client" directive (source text) or driving a handler we cannot
//     reach. The client-component nature itself is enforced by the framework at build
//     time (an onClick in a server component fails the build), not by these render tests.
//   * Every absence check (a config-driven address NOT shown after it is changed; no raw
//     hex; no protocol jargon) is scoped to THIS component's own rendered output and to
//     the exact string under test — the same substring may legitimately appear elsewhere.
//     The jargon scan runs over PROSE only (URLs stripped first), because the connector
//     address a person pastes is a URL that legitimately ends in "/mcp" — that path is
//     data to copy, not the screen "saying MCP" as jargon.
//
// We render with `react-dom/server` (no DOM/jsdom), exactly as the sibling component
// tests (help.test.tsx, consent-view.test.tsx, install-prompt.test.tsx) do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectGuide, CONNECT_GROUPS } from "./connect-guide";
import { AGENT_PLATFORMS } from "@/domain/agents/compatibility";

// ── tiny markup helpers (no DOM), mirrored from the sibling component tests ────────────

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

// Visible text with tags stripped and entities decoded: exactly the words a sighted
// reader sees (an <svg> icon contributes none), whitespace collapsed.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// All human-facing text: the visible copy PLUS the words a screen reader announces from
// the attributes that carry them (aria-label / title / alt / placeholder). The gap and
// jargon scans use this so a gap note or a control name carried in an aria-label counts.
function faceText(markup: string): string {
  const parts = [visibleText(markup)];
  for (const re of [
    /aria-label="([^"]*)"/gi,
    /placeholder="([^"]*)"/gi,
    /\btitle="([^"]*)"/gi,
    /\balt="([^"]*)"/gi,
  ]) {
    for (const m of markup.matchAll(re)) parts.push(decode(m[1]!));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Human-facing PROSE: faceText with URLs removed, so the connector address a person
// copies (a URL that legitimately contains "/mcp") is not mistaken for jargon prose.
function faceProse(markup: string): string {
  return faceText(markup).replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

// A boolean/valueless attribute present as its own token — ` disabled`, ` disabled=""`
// or ` disabled="disabled"`. Tested against a leading space so the first attribute also
// has a boundary. (React renders a true boolean `disabled` prop as `disabled=""`.)
function hasBoolAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}

// Every <tag>…</tag> in the markup, each as { attrs, inner }.
function findAll(markup: string, tag: string): { attrs: string; inner: string }[] {
  const out: { attrs: string; inner: string }[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}

// The visible text of every section label — a heading (h1–h6), an accordion <summary>,
// or a definition term (<dt>). "Per-platform" means each platform gets its OWN labelled
// section, so we assert against these, not loose body text (which avoids matching an
// incidental "other" inside a sentence).
function sectionLabels(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<(h[1-6]|summary|dt)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    out.push(visibleText(m[2]!));
  }
  return out;
}

// Every ordered list (<ol>) with the visible text of each of its <li> items. "Ordered
// step text" means the steps are a genuinely ordered list (a screen reader announces
// "list, N items, item 1…"), so this reads the accessible ordered-list semantics — not
// any one rendering of a step.
function orderedLists(markup: string): { items: string[]; text: string }[] {
  const out: { items: string[]; text: string }[] = [];
  for (const m of markup.matchAll(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi)) {
    const inner = m[1]!;
    const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((li) =>
      visibleText(li[1]!),
    );
    out.push({ items, text: visibleText(inner) });
  }
  return out;
}

// Accessible names of every actionable (not-disabled) <button>: its visible label, else
// its aria-label. Proves a control is a live affordance, never dead static text.
function actionableButtons(markup: string): string[] {
  return findAll(markup, "button")
    .filter((b) => !hasBoolAttr(b.attrs, "disabled"))
    .map((b) => (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim())
    .filter((n) => n.length > 0);
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────

// A distinctive, obviously-fake connector address passed in as the config-driven prop.
// The real entry derives this from `config.publicBaseUrl` (INV-21); here we only need a
// value we can look for in the output to prove it is what the screen displays and copies.
const CONNECTOR_ADDRESS = "https://connect.warthog.test/mcp";
// A DIFFERENT config value, to prove the address is driven by the prop (config), not a
// hard-coded literal: render with this and the first address must no longer appear.
const OTHER_ADDRESS = "https://home.someone-else.example/mcp";

function render(connectorAddress: string = CONNECTOR_ADDRESS): string {
  return renderToStaticMarkup(<ConnectGuide connectorAddress={connectorAddress} />);
}

// The six agent platforms the task/brief name (Claude, ChatGPT, Gemini, Grok, Llama,
// Other). "Llama" matches as a substring so "Llama-based clients" also satisfies it.
const PLATFORMS: { name: string; re: RegExp }[] = [
  { name: "Claude", re: /\bclaude\b/i },
  { name: "ChatGPT", re: /\bchat\s*gpt\b/i },
  { name: "Gemini", re: /\bgemini\b/i },
  { name: "Grok", re: /\bgrok\b/i },
  { name: "Llama", re: /\bllama\b/i },
  { name: "Other", re: /\bother\b/i },
];

// Signals that the view notes a CURRENT PLATFORM GAP (brief "Connect an agent": "a note of
// any platform gap … and what to do instead"). Any one is enough — wording is the
// builder's to choose.
const GAP_SIGNALS: RegExp[] = [
  /\bnot yet\b/i,
  /\bdoesn['’]?t\s+(?:yet\s+)?support/i,
  /\bdoes not\s+(?:yet\s+)?support/i,
  /\bisn['’]?t\s+(?:yet\s+)?(?:supported|available)/i,
  /\byet to\s+(?:support|add)/i,
  /\bcan['’]?t\s+(?:yet\s+)?(?:use|connect)/i,
  /\bcannot\s+(?:yet\s+)?(?:use|connect)/i,
];

// Signals that the view says WHAT TO DO INSTEAD when a platform cannot use a remote
// connector (brief: "create an access key" lets the person connect that agent instead).
const ALTERNATIVE_SIGNALS: RegExp[] = [
  /\baccess key\b/i,
  /\bwhat to do instead\b/i,
  /\binstead\b/i,
];

// Pure protocol/security jargon that must never surface on this primary screen (brief
// design_ux.copy: no protocol jargon on primary screens). Deliberately limited to
// acronyms that are never needed in plain connect steps — "connector"/"custom connector"
// is user-facing product language (not jargon), "MCP" lives only inside the URL (stripped
// by faceProse), and "encryption key" is allowed inside agent set-up guides, so none of
// those appear here.
const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "FIDO", re: /\bfido\b/i },
  { label: "TOTP", re: /\btotp\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "JWT", re: /\bjwt\b/i },
  { label: "SAML", re: /\bsaml\b/i },
];

// ════════════════════════════════════════════════════════════════════════════════════════
// AC1 — a section per agent platform
// ════════════════════════════════════════════════════════════════════════════════════════

test("names every agent platform as its own section (Claude, ChatGPT, Gemini, Grok, Llama, Other)", () => {
  const markup = render();
  const labels = sectionLabels(markup);
  assert.ok(
    labels.length > 0,
    `the guide must be organised into labelled sections (headings / accordion summaries / terms), got markup: ${markup}`,
  );
  for (const platform of PLATFORMS) {
    assert.ok(
      labels.some((label) => platform.re.test(label)),
      `the guide must have a section for "${platform.name}", got section labels: ${JSON.stringify(labels)}`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// AC2 — the connector address comes from configuration (the public base URL)
//   The view DISPLAYS whatever config-driven address it is handed, verbatim, and does NOT
//   bake one in: change the prop and the shown address changes with it.
// ════════════════════════════════════════════════════════════════════════════════════════

test("shows the connector address it is given, exactly as supplied", () => {
  const markup = render(CONNECTOR_ADDRESS);
  assert.ok(
    decode(markup).includes(CONNECTOR_ADDRESS),
    `the guide must display the connector address it is given ("${CONNECTOR_ADDRESS}") so people can paste it, got: ${decode(markup)}`,
  );
});

test("the connector address is config-driven, not hard-coded (changing the prop changes what is shown)", () => {
  const other = decode(render(OTHER_ADDRESS));
  assert.ok(
    other.includes(OTHER_ADDRESS),
    `rendering with a different configured address must show that address ("${OTHER_ADDRESS}"), got: ${other}`,
  );
  // Scoped to the exact first sentinel: if the component baked in CONNECTOR_ADDRESS it
  // would still appear even though we rendered OTHER_ADDRESS. It must not.
  assert.ok(
    !other.includes(CONNECTOR_ADDRESS),
    `the connector address must come from the prop (configuration), not a hard-coded literal — "${CONNECTOR_ADDRESS}" must not appear when a different address is configured, got: ${other}`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════
// AC1 — a COPY control for the connector address (a live, client-side affordance)
//   A copy button that does nothing is a dead control (conventions: "no dead controls").
//   We prove a live (not-disabled) copy affordance is present; its onClick cannot run here
//   (no DOM), and the client-component requirement is enforced by the framework at build.
// ════════════════════════════════════════════════════════════════════════════════════════

test("renders a live Copy control for the connector address", () => {
  const markup = render();
  const buttons = actionableButtons(markup);
  assert.ok(
    buttons.some((label) => /\bcopy\b/i.test(label)),
    `the guide must offer a live (actionable) Copy control for the connector address, got actionable buttons: ${JSON.stringify(buttons)}`,
  );
});

test("the Copy control is actionable, not a dead/disabled button", () => {
  const markup = render();
  // Find the copy button by its accessible name and confirm it carries no native
  // `disabled` attribute (matching the ATTRIBUTE, never a Tailwind `disabled:` class).
  const copyButton = findAll(markup, "button").find((b) => {
    const name = (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim();
    return /\bcopy\b/i.test(name);
  });
  assert.ok(
    copyButton,
    `the guide must render a Copy control (a button named to copy), got markup: ${markup}`,
  );
  assert.ok(
    copyButton && !hasBoolAttr(copyButton.attrs, "disabled"),
    `the Copy control must be actionable (no native disabled attribute), got: <button ${copyButton?.attrs ?? ""}>`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════
// AC1 — ORDERED step text, per platform
//   "Ordered step text" ⇒ the steps render as ordered lists (<ol><li>…). A guided view
//   per platform gives each platform its own ordered steps, so there is at least one
//   ordered list per platform, and the steps are genuinely multi-step overall.
// ════════════════════════════════════════════════════════════════════════════════════════

test("renders ordered step text — one ordered list per platform, genuinely multi-step", () => {
  const lists = orderedLists(render()).filter((l) => l.items.length >= 1);
  assert.ok(
    lists.length >= PLATFORMS.length,
    `each platform must have its own ordered step list (<ol>); expected at least ${PLATFORMS.length} non-empty ordered lists, got ${lists.length}`,
  );
  const totalSteps = lists.reduce((n, l) => n + l.items.length, 0);
  assert.ok(
    totalSteps >= PLATFORMS.length * 2,
    `the ordered steps must be genuinely multi-step (averaging ≥2 per platform); got ${totalSteps} step items across ${lists.length} lists`,
  );
});

test("the ordered steps tell the person to add/paste the connector address", () => {
  const stepsText = orderedLists(render())
    .map((l) => l.text)
    .join(" | ")
    .toLowerCase();
  assert.match(
    stepsText,
    /\b(paste|add|enter)\b/i,
    `the ordered steps must tell people what to do with the connector address (paste / add / enter), got steps: "${stepsText}"`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════
// AC1 — a current platform GAP and WHAT TO DO INSTEAD
//   The AC is conditional ("a platform with a known gap shows the gap and what to do
//   instead"). We assert at the VIEW level — the guide surfaces a gap note and an
//   alternative — because which platform is marked gapped is the builder's data to own
//   (and may change as platforms add support), not a fact these tests should pin.
// ════════════════════════════════════════════════════════════════════════════════════════

test("notes a current platform gap (a platform that cannot yet use a remote connector)", () => {
  const text = faceText(render());
  assert.ok(
    GAP_SIGNALS.some((re) => re.test(text)),
    `the guide must note any current platform gap (e.g. a platform that does not yet support remote connectors), got: "${text}"`,
  );
});

test("tells the person what to do instead when a platform cannot use a remote connector", () => {
  const text = faceText(render());
  assert.ok(
    ALTERNATIVE_SIGNALS.some((re) => re.test(text)),
    `a noted gap must come with what to do instead (e.g. create an access key), got: "${text}"`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Design system — colour comes from tokens, never a raw hex literal
// ════════════════════════════════════════════════════════════════════════════════════════

test("the guide uses design tokens, never a raw hex colour", () => {
  for (const address of [CONNECTOR_ADDRESS, OTHER_ADDRESS]) {
    const markup = render(address);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the connect-guide markup, got: ${markup}`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Primary-screen copy discipline — plain words, no protocol/security jargon
//   Scoped to this component's own PROSE (URLs stripped), so the "/mcp" in the connector
//   address a person copies does not read as the screen "saying MCP".
// ════════════════════════════════════════════════════════════════════════════════════════

test("the guide shows no protocol or security jargon in its prose", () => {
  const prose = faceProse(render());
  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(prose),
      `the guide must say what happens in plain words — found jargon "${label}" in: "${prose}"`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Organisation pass — the platform guides are disclosures (a person opens the one for
// their agent instead of scrolling past nine fully expanded guides), and the page title
// uses the house heading style.
// ════════════════════════════════════════════════════════════════════════════════════════

test("each platform guide is a disclosure named for its platform, its steps inside; only the first is open", () => {
  const markup = render();
  const disclosures = [...markup.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/gi)];
  const shown = CONNECT_GROUPS.flatMap((group) => group.platforms);
  assert.equal(disclosures.length, AGENT_PLATFORMS.length, "one disclosure per platform guide");
  assert.equal(shown.length, AGENT_PLATFORMS.length, "every platform is listed in one of the groups");
  disclosures.forEach((d, i) => {
    const platform = shown[i]!;
    const summary = visibleText(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(d[2]!)?.[1] ?? "");
    assert.match(summary, new RegExp(platform.name.replace(/[()]/g, "\\$&")), `disclosure #${i + 1} is named for ${platform.name}`);
    assert.equal(hasBoolAttr(d[1]!, "open"), i === 0, `only the first guide (${shown[0]!.name}) starts open`);
    const steps = orderedLists(d[2]!)[0];
    assert.ok(steps, `the ${platform.name} steps sit inside its disclosure`);
    assert.equal(steps.items.length, platform.steps.length, `every ${platform.name} step is listed`);
  });
});

// newcomer-07 — the common platforms come first, and the ones Warthog has no documented way
// to connect yet sit apart, marked as such, rather than among the ones that work.
test("Claude and ChatGPT come first, and unverified platforms are listed apart and marked", () => {
  const [common, other, unverified] = CONNECT_GROUPS;
  assert.deepEqual(common!.platforms.map((p) => p.name), ["Claude", "ChatGPT"]);
  assert.ok(other!.platforms.every((p) => p.status !== "unverified"));
  assert.deepEqual(unverified!.platforms.map((p) => p.name), ["Dots (OpenAI)", "Instinct"]);
  const text = visibleText(render());
  assert.match(text, /Not verified yet/);
});

// newcomer-07 — the page says what happens next: copy, add it in the agent, approve its
// access, after which it appears in Your agents.
test("the guide says what happens after the address is pasted", () => {
  const text = visibleText(render());
  assert.match(text, /Copy your Warthog address/);
  assert.match(text, /appears in Your agents/);
  assert.match(render(), /href="\/agents\/access-key"/, "the access-key route is offered near the top too");
});

test("the connect page title is the shared heading band", () => {
  const markup = render();
  assert.match(markup, /<header class="wh-page-heading">[\s\S]*?<h1>Connect an agent<\/h1>/);
});

// interaction-07 follow-up — an access key can be replaced or revoked later from the agent's
// Settings, so the access-key route says so (and no longer implies a key is for ever).
test("the access-key route says the key can be replaced or revoked later in the agent's Settings", () => {
  const text = visibleText(render());
  assert.match(text, /replace or revoke (it|the key) later[^.]*Settings/i, `text="${text}"`);
});
