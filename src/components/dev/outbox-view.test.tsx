// E17-S08 — Dev outbox viewer VIEW (src/components/dev/outbox-view.tsx).
//
// RED-first: src/components/dev/outbox-view.tsx does NOT exist yet, so importing
// `./outbox-view` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// Why this view exists (task E17-S08): driving the primary journey end-to-end over
// HTTP needs a way to see the notifications and single-use links that would
// otherwise go to a real device. The dev outbox (`src/server/notify/outbox.ts`)
// captures every push / email / SMS a sender was handed; this render-testable view
// lists what it captured — recipient, body and, where present, the single-use
// approval / sign-in LINK as a real, clickable anchor — so a developer can click
// through the journey. The `page.tsx` loader (tested in the sibling page test) reads
// `outbox.list()` and feeds it to this view; the view itself is a plain, prop-driven,
// synchronously-renderable component (the render-test target) with no data access of
// its own and no interactive machinery.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the view RENDERS for a given list of captured
//     messages — never the source text of outbox-view.tsx. A later behaviour-
//     preserving refactor (different wrappers, reworded labels, composing a UI
//     primitive) stays green as long as the captured messages still render with
//     their channel, recipient, body and a live link.
//   * They render with `react-dom/server` (no DOM/jsdom — React component / E2E
//     testing is a per-job ADR) and read the emitted markup, mirroring the other
//     view render tests in this repo.
//   * Absence checks (no dead controls) are scoped to the rendered controls
//     themselves (an anchor's `href`, a button's `disabled`), never a whole-output
//     text scan — the view legitimately renders link URLs as text/anchors.
//
// The contract the builder implements (exactly this):
//
//   OutboxView({ messages }: { messages: readonly SentMessage[] })
//     • A plain presentation component rendered from `messages` ALONE — the exact
//       shape `outbox.list()` returns (channel, recipient, body, optional link).
//     • Lists every captured message, showing its channel (push / email / SMS),
//       recipient and body.
//     • Where a message carries a `link`, renders it as a real, clickable anchor
//       whose `href` is that link (the single-use approval / sign-in link).
//     • A message with no link produces NO dead/empty link control.
//     • With no messages, renders an empty state (never crashes, no dead controls).
//     • No dead controls anywhere: every anchor has a live href; no inert/disabled
//       button. (Design tokens from globals.css; never a raw hex colour.)

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { OutboxView } from "./outbox-view";
// Documentary type anchor — the exact shape the loader passes in. Erased at runtime
// (a rename cannot redden these), so the runtime assertions below are the real gate.
import type { SentMessage } from "@/server/notify/outbox";

// --- tiny markup helpers (no DOM) ------------------------------------------

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

// Visible text of an HTML fragment with tags stripped and entities decoded — the
// words a sighted reader sees (an <svg> icon contributes none).
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// All human-facing text: the visible copy PLUS the words announced from the
// attributes that carry them (aria-label, title). The channel-label scan runs over
// this, so a channel shown only via an aria-label still counts.
function faceText(markup: string): string {
  const parts = [visibleText(markup)];
  for (const re of [/aria-label="([^"]*)"/gi, /\btitle="([^"]*)"/gi]) {
    for (const m of markup.matchAll(re)) parts.push(decode(m[1]));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1], inner: m[2] });
  }
  return out;
}

// Every rendered anchor with its (decoded) href and visible text.
function anchors(markup: string): { href: string | null; text: string }[] {
  return findAll(markup, "a").map((a) => {
    const href = attr(a.attrs, "href");
    return { href: href === null ? null : decode(href), text: visibleText(a.inner) };
  });
}

// A "dead" link is one that goes nowhere: no href, empty, "#", or a leaked
// undefined/null. A live view never renders one (no dead controls).
function isDeadHref(href: string | null): boolean {
  if (href === null) return true;
  const h = href.trim();
  return h === "" || h === "#" || h === "undefined" || h === "null";
}

// Native <button>s carrying the disabled attribute (React renders a truthy boolean
// `disabled` prop as `disabled=""`). A read-only viewer should render none.
function disabledButtons(markup: string): El[] {
  return findAll(markup, "button").filter((b) => /\bdisabled\b/i.test(b.attrs));
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

// --- channel-label matchers -------------------------------------------------
// Each captured message is stamped with its channel ("push" | "email" | "sms").
// AC: the view "lists the push, email and SMS captured". We accept any sensible
// developer-facing label for each channel, not one exact spelling.
const CHANNEL_LABEL: Record<SentMessage["channel"], RegExp> = {
  push: /push|notification/i,
  email: /e-?mail/i,
  sms: /\bsms\b|text/i,
};

// One captured message per channel: push (bodies-only, no link), email + SMS each
// carrying a single-use link (an approval link, a sign-in link). Hex-free content so
// the raw-hex scan cannot be fooled by caller data.
const PUSH: SentMessage = {
  channel: "push",
  recipient: "push-sub-alpha",
  body: "An agent is waiting for your approval.",
};
const EMAIL: SentMessage = {
  channel: "email",
  recipient: "sam@example.com",
  body: "Open the approval to continue.",
  link: "https://warthog.com.au/a/approval-token-email",
};
const SMS: SentMessage = {
  channel: "sms",
  recipient: "+61400111222",
  body: "Warthog: confirm the request that is waiting.",
  link: "https://warthog.com.au/signin/link-token-sms",
};
const ALL: readonly SentMessage[] = [PUSH, EMAIL, SMS];

// ===========================================================================

// AC1 — the view lists every captured message's recipient and body.
test("OutboxView lists every captured message's recipient and body", () => {
  const text = visibleText(render(<OutboxView messages={ALL} />));
  for (const m of ALL) {
    assert.ok(
      text.includes(m.recipient),
      `the recipient "${m.recipient}" must be shown, got: "${text}"`,
    );
    assert.ok(
      text.includes(m.body),
      `the body "${m.body}" must be shown, got: "${text}"`,
    );
  }
});

// AC1 — the view distinguishes the three channels (push, email and SMS), so a
// developer can tell which device each message would have gone to.
test("OutboxView labels each of the push, email and SMS channels", () => {
  const text = faceText(render(<OutboxView messages={ALL} />));
  for (const m of ALL) {
    assert.match(
      text,
      CHANNEL_LABEL[m.channel],
      `the view must label the "${m.channel}" channel, got: "${text}"`,
    );
  }
});

// AC1 — a message's single-use link (approval / sign-in) renders as a real,
// clickable anchor pointing at that exact link, so the journey can be followed.
test("OutboxView renders each single-use link as a clickable anchor to that link", () => {
  const found = anchors(render(<OutboxView messages={ALL} />));
  for (const m of [EMAIL, SMS]) {
    assert.ok(
      found.some((a) => a.href === m.link),
      `the link "${m.link}" must render as an anchor with that href, got hrefs: ${JSON.stringify(
        found.map((a) => a.href),
      )}`,
    );
  }
});

// AC3 (no dead controls) — a message with NO link does not fabricate a link
// control. Rendered on its own, the linkless push lists its content and produces no
// anchor at all (nothing dead, nothing invented).
test("OutboxView fabricates no link for a message that has no link", () => {
  const markup = render(<OutboxView messages={[PUSH]} />);
  const text = visibleText(markup);
  assert.ok(text.includes(PUSH.recipient), "the linkless push message is still listed");
  assert.ok(text.includes(PUSH.body), "the linkless push body is still listed");
  assert.equal(
    anchors(markup).length,
    0,
    "a message with no link must produce no link control, got anchors: " +
      JSON.stringify(anchors(markup)),
  );
});

// AC3 (no dead controls) — across a populated render, every anchor is live and no
// button is inert.
test("OutboxView has no dead controls (live hrefs, no disabled buttons)", () => {
  const markup = render(<OutboxView messages={ALL} />);
  for (const a of anchors(markup)) {
    assert.ok(!isDeadHref(a.href), `anchor must have a live href, got: ${JSON.stringify(a.href)}`);
  }
  assert.equal(
    disabledButtons(markup).length,
    0,
    "a read-only viewer must render no disabled/inert button",
  );
});

// AC3 — the view renders FROM the contents passed to it, not a hardcoded list: two
// different inputs produce correspondingly different output. The absence check is
// scoped to the unique recipient that only the other input could contribute.
test("OutboxView renders from the messages passed in, not a fixed list", () => {
  const a: SentMessage = { channel: "email", recipient: "alice-canary@example.com", body: "First." };
  const b: SentMessage = { channel: "sms", recipient: "+61400999888", body: "Second." };

  const markupA = render(<OutboxView messages={[a]} />);
  const markupB = render(<OutboxView messages={[b]} />);

  assert.ok(visibleText(markupA).includes(a.recipient), "list A shows A's recipient");
  assert.ok(
    !visibleText(markupA).includes(b.recipient),
    `list A must not show B's recipient "${b.recipient}" — the view reflects its own input`,
  );
  assert.ok(visibleText(markupB).includes(b.recipient), "list B shows B's recipient");
  assert.ok(
    !visibleText(markupB).includes(a.recipient),
    `list B must not show A's recipient "${a.recipient}"`,
  );
});

// AC3 — with nothing captured, the view renders an empty state: it does not crash,
// it shows some words, and it has no dead controls.
test("OutboxView renders an empty state for no captured messages", () => {
  let markup: string;
  try {
    markup = render(<OutboxView messages={[]} />);
  } catch (err) {
    assert.fail(
      "OutboxView must render an empty state for an empty outbox, not crash: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 3,
    `the empty state must say something, got: "${visibleText(markup)}"`,
  );
  for (const a of anchors(markup)) {
    assert.ok(!isDeadHref(a.href), "the empty state renders no dead link");
  }
  assert.equal(disabledButtons(markup).length, 0, "the empty state renders no disabled button");
});

// Design system — colour comes from tokens, never a raw hex literal. The caller
// content carries no "#", so any `#rrggbb` in the output could only be a hard-coded
// colour.
test("OutboxView uses design tokens, never a raw hex colour", () => {
  const markup = render(<OutboxView messages={ALL} />);
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the OutboxView markup, got: ${markup}`,
  );
});
