// The public front door's explanatory diagrams (src/components/public/landing-diagrams.tsx),
// added at the founder's request on 14 November 2026: "diagrams are a good way to illustrate
// the point and purpose of how the tool works". Each diagram must tell its story from the
// server markup alone (motion is decoration), draw the numbers it claims, stay an
// illustration (no logos, controls or live data) and sit in the section it explains.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AskFirstFlow, ConnectOnceDiagrams, SharedMemoryFlow } from "./landing-diagrams";
import { Landing } from "./landing";

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function figures(markup: string): string[] {
  return markup.match(/<figure\b[\s\S]*?<\/figure>/g) ?? [];
}

function section(markup: string, id: string): string {
  const match = markup.match(new RegExp(`<section\\b[^>]*id="${id}"[\\s\\S]*?</section>`));
  assert.ok(match, `the landing has a section #${id}`);
  return match[0];
}

const AGENTS = ["Claude", "ChatGPT", "Gemini", "Grok", "Llama"];
const SERVICES = ["Outlook", "Gmail", "Notion", "Drive", "Calendar"];

test("the connect-once pictures draw the numbers they claim: 25 lines without Warthog, 10 with it", () => {
  const [without, withWarthog] = figures(renderToStaticMarkup(<ConnectOnceDiagrams />));
  assert.ok(without && withWarthog, "two pictures, side by side");

  assert.match(visibleText(without), /Without Warthog.*25 separate connections/);
  assert.equal((without.match(/data-wire=""/g) ?? []).length, 25);
  assert.match(without, /<svg[^>]*role="img"[^>]*aria-label="[^"]*25 crossing lines/);

  assert.match(visibleText(withWarthog), /With Warthog.*10 connections, one place/);
  assert.equal((withWarthog.match(/data-wire=""/g) ?? []).length, 10);
  assert.match(withWarthog, /<svg[^>]*role="img"[^>]*aria-label="[^"]*10 lines/);
});

test("both pictures name the same agents and services in words, never logos", () => {
  for (const figure of figures(renderToStaticMarkup(<ConnectOnceDiagrams />))) {
    const text = visibleText(figure);
    for (const name of [...AGENTS, ...SERVICES]) assert.ok(text.includes(name), `${name} is labelled`);
    assert.doesNotMatch(figure, /<img\b|<image\b|href=/, "no logos or remote media");
  }
});

test("the ask-first flow is an ordered story: agent asks, rules, your phone, the service, the record", () => {
  const markup = renderToStaticMarkup(<AskFirstFlow />);
  const steps = (markup.match(/<li\b[\s\S]*?<\/li>/g) ?? []).map(visibleText);
  assert.match(markup, /<ol\b/);
  assert.equal(steps.length, 5);
  assert.match(steps[0]!, /Claude asks/);
  assert.match(steps[1]!, /checks your rules/i);
  assert.match(steps[2]!, /phone/i);
  assert.match(steps[2]!, /You approved/);
  assert.match(steps[3]!, /adds the event/i);
  assert.match(steps[4]!, /record/i);
});

test("the shared-memory flow shows one agent's memory reaching another, and only agents you allow", () => {
  const markup = renderToStaticMarkup(<SharedMemoryFlow />);
  const steps = (markup.match(/<li\b[\s\S]*?<\/li>/g) ?? []).map(visibleText);
  assert.equal(steps.length, 3);
  assert.match(steps[0]!, /Claude/);
  assert.match(steps[1]!, /Saved by Claude · shared/);
  assert.match(steps[2]!, /ChatGPT/);
  assert.match(visibleText(markup), /haven’t allowed to read shared memory never sees it/);
});

test("every diagram is a labelled illustration with no controls, links or hidden content", () => {
  const markup = renderToStaticMarkup(<Landing />);
  const diagrams = figures(markup).filter((figure) => /class="wh-(?:diagram|flow)\b/.test(figure));
  assert.equal(diagrams.length, 4, "two connect-once pictures and two flows");
  for (const figure of diagrams) {
    assert.doesNotMatch(figure, /<(?:button|input|select|textarea|a)\b/, "illustrations do not pretend to be controls");
    assert.doesNotMatch(figure, /<(?:figure|h3|ol|li|p)\b[^>]*(?:\bhidden\b|aria-hidden)/, "no step or caption is hidden");
    assert.match(figure, /data-motion-surface/, "motion pauses when the picture is out of view");
  }
  // The flows say they are examples; the connect-once pair says so under the pictures.
  assert.match(visibleText(section(markup, "one-home")), /Illustration · example agents and services/);
  for (const id of ["ask-first", "shared-memory"]) {
    assert.match(markup, new RegExp(`aria-labelledby="${id}-title"[\\s\\S]*?Illustration · example`));
  }
});

test("each diagram sits in the section it explains", () => {
  const markup = renderToStaticMarkup(<Landing />);
  const home = section(markup, "one-home");
  assert.match(home, /Without Warthog/);
  assert.match(home, /With Warthog/);
  assert.ok(markup.indexOf('id="one-home"') < markup.indexOf('id="your-control"'), "the why comes before the controls");
  assert.match(section(markup, "your-control"), /Ask me first, step by step/);
  assert.match(section(markup, "your-context"), /Saved by Claude · shared/);
});

test("the still picture needs no animation: pulses carry no words and the page starts with motion off", () => {
  const markup = renderToStaticMarkup(<Landing />);
  assert.match(markup, /data-motion="off"/);
  for (const pulse of markup.match(/<path[^>]*class="wh-diagram-pulse"[^>]*>/g) ?? []) {
    assert.match(pulse, /pathLength="100"/);
  }
  assert.equal((markup.match(/class="wh-diagram-pulse"/g) ?? []).length, 35, "one pulse per drawn line");
});
