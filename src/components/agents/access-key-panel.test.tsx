// The "Access key" panel on an access-key agent's Settings section
// (`./access-key-panel`; brief "Connect an agent": "lets them revoke or replace the key
// later from that agent's page"; interaction-07 follow-up).
//
// Two seams, as the sibling flows export (AccessKeyFlow + createAccessKeyFlow):
//   • createAccessKeyPanel(deps) — the framework-free controller behind Replace / Revoke /
//     Create a new key: it calls the page's server actions once per confirm, holds a new
//     key for its one showing, and reports every outcome in plain words.
//   • AccessKeyPanel — the client component: the panel, its two confirmations, and the
//     new key shown once with the same Copy control and wording as the creation flow.
// Rendered with react-dom/server (no DOM), asserting on what the markup shows.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AccessKeyPanel, createAccessKeyPanel } from "./access-key-panel";

const NEW_KEY = "wh_ak_NEWKEYzzzzzzzzzzzzzzzzzzzzzzzzzz";
const NAME = "My Grok";

function fake(results: { replace?: unknown; revoke?: unknown } = {}) {
  const calls = { replace: 0, revoke: 0 };
  return {
    calls,
    replace: async () => {
      calls.replace++;
      if (results.replace instanceof Error) throw results.replace;
      return (results.replace ?? { ok: true, key: NEW_KEY }) as { ok: true; key: string };
    },
    revoke: async () => {
      calls.revoke++;
      if (results.revoke instanceof Error) throw results.revoke;
      return (results.revoke ?? { ok: true }) as { ok: true };
    },
  };
}

function controller(initial: "active" | "revoked", actions = fake()) {
  return createAccessKeyPanel({ agentName: NAME, initial, replace: actions.replace, revoke: actions.revoke });
}

function decode(s: string): string {
  return s.replace(/&#x27;|&#39;/g, "'").replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function visibleText(markup: string): string {
  return decode(markup.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function buttons(markup: string): Array<{ attrs: string; text: string }> {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((m) => ({ attrs: m[1]!, text: visibleText(m[2]!) }));
}
function dialogs(markup: string): string[] {
  return [...markup.matchAll(/<dialog\b[^>]*>([\s\S]*?)<\/dialog>/gi)].map((m) => m[1]!);
}
function withoutDialogs(markup: string): string {
  return markup.replace(/<dialog\b[\s\S]*?<\/dialog>/gi, "");
}
function render(props: Partial<React.ComponentProps<typeof AccessKeyPanel>> = {}): string {
  const actions = fake();
  return renderToStaticMarkup(
    <AccessKeyPanel agentName={NAME} state="active" replace={actions.replace} revoke={actions.revoke} {...props} />,
  );
}

const JARGON = [/\boauth\b/i, /\bbearer\b/i, /\btoken\b/i, /\b401\b/, /_/];
function assertPlain(text: string | undefined, ctx: string): void {
  assert.ok(text && text.length > 10 && /\s/.test(text), `${ctx}: a sentence, got ${JSON.stringify(text)}`);
  for (const re of JARGON) assert.doesNotMatch(text!, re, `${ctx}: no jargon or raw reason in "${text}"`);
}

// ─── the controller ───────────────────────────────────────────────────────────────────

test("constructing the panel calls nothing and holds no key", () => {
  const actions = fake();
  const panel = controller("active", actions);
  assert.deepEqual(actions.calls, { replace: 0, revoke: 0 });
  assert.equal(panel.getState().key, "active");
  assert.equal(panel.getState().issuedKey, undefined);
});

test("replacing hands back the new key for one showing; the agent keeps a working key", async () => {
  const actions = fake();
  const panel = controller("active", actions);
  await panel.replace();
  assert.equal(actions.calls.replace, 1);
  const state = panel.getState();
  assert.equal(state.issuedKey, NEW_KEY);
  assert.equal(state.key, "active");
  assert.equal(state.replacedOldKey, true, "the old key is the one that stopped working");
  assert.equal(state.working, null);
});

test("a second confirm while one is running is ignored (exactly one new key)", async () => {
  const actions = fake();
  const panel = controller("active", actions);
  await Promise.all([panel.replace(), panel.replace(), panel.revoke()]);
  assert.deepEqual(actions.calls, { replace: 1, revoke: 0 });
});

test("dismissing the new key forgets it, so it is never shown again", async () => {
  const panel = controller("active");
  await panel.replace();
  panel.dismissKey();
  assert.equal(panel.getState().issuedKey, undefined);
  assert.equal(panel.getState().key, "active");
});

test("revoking leaves the agent without a key and says it can't use Warthog until a new one", async () => {
  const actions = fake();
  const panel = controller("active", actions);
  await panel.revoke();
  assert.equal(actions.calls.revoke, 1);
  const state = panel.getState();
  assert.equal(state.key, "revoked");
  assert.equal(state.notice?.tone, "success");
  assert.match(state.notice!.text, new RegExp(`${NAME} can.t use Warthog until you create a new key`));
});

test("a key that was already revoked reads as revoked, with nothing changed", async () => {
  const panel = controller("active", fake({ revoke: { ok: false, reason: "no_key" } }));
  await panel.revoke();
  assert.equal(panel.getState().key, "revoked");
  assert.equal(panel.getState().notice?.tone, "info");
  assertPlain(panel.getState().notice?.text, "no_key");
});

test("after a revoke, creating a new key shows it once without claiming an old key stopped", async () => {
  const panel = controller("revoked");
  await panel.replace();
  assert.equal(panel.getState().issuedKey, NEW_KEY);
  assert.equal(panel.getState().key, "active");
  assert.equal(panel.getState().replacedOldKey, false);
});

test("refusals and failures are plain words, never the raw reason, and show no key", async () => {
  for (const [label, result] of [
    ["replace refused", { replace: { ok: false, reason: "not_access_key" } }],
    ["replace disconnected", { replace: { ok: false, reason: "not_connected" } }],
    ["replace threw", { replace: new Error("network") }],
  ] as const) {
    const panel = controller("active", fake(result));
    await panel.replace();
    assert.equal(panel.getState().issuedKey, undefined, label);
    assert.equal(panel.getState().notice?.tone, "error", label);
    assertPlain(panel.getState().notice?.text, label);
    assert.equal(panel.getState().working, null, `${label}: the controls are usable again`);
  }
  for (const [label, result] of [
    ["revoke disconnected", { revoke: { ok: false, reason: "not_connected" } }],
    ["revoke threw", { revoke: new Error("network") }],
  ] as const) {
    const panel = controller("active", fake(result));
    await panel.revoke();
    assert.equal(panel.getState().key, "active", `${label}: not claimed as revoked`);
    assert.equal(panel.getState().notice?.tone, "error", label);
    assertPlain(panel.getState().notice?.text, label);
  }
});

// ─── the component ───────────────────────────────────────────────────────────────────

test("an agent with a working key offers Replace key and a danger Revoke key", () => {
  const markup = render();
  const text = visibleText(withoutDialogs(markup));
  assert.match(markup, /<h2[^>]*>Access key<\/h2>/);
  assert.match(text, new RegExp(`${NAME} connects to Warthog with an access key`));
  const live = buttons(withoutDialogs(markup));
  const replace = live.find((b) => b.text === "Replace key");
  const revoke = live.find((b) => b.text === "Revoke key");
  assert.ok(replace && revoke, `buttons=${JSON.stringify(live.map((b) => b.text))}`);
  assert.match(revoke!.attrs, /danger/, "Revoke is the entry to a destructive step");
  assert.doesNotMatch(markup, /wh_ak_/, "no key is ever shown before one is issued");
});

test("Replace asks first: the new key is shown once and the old one stops working straight away", () => {
  const dialog = dialogs(render()).find((d) => /Replace/.test(d));
  assert.ok(dialog, "a replace confirmation");
  const text = visibleText(dialog!);
  assert.match(text, new RegExp(`Replace ${NAME}’s access key\\?`));
  assert.match(text, /shows it to you once/);
  assert.match(text, /old key stops working straight away/);
  const choices = buttons(dialog!);
  assert.equal(choices[0]?.text, "Keep current key", "the safe choice comes first");
  assert.match(choices[0]!.attrs, /autofocus/i, "and is focused");
  assert.equal(choices.at(-1)?.text, "Replace key");
});

test("Revoke asks first, in danger: the agent loses access until you create a new key", () => {
  const dialog = dialogs(render()).find((d) => /Revoke/.test(d));
  assert.ok(dialog, "a revoke confirmation");
  const text = visibleText(dialog!);
  assert.match(text, new RegExp(`Revoke ${NAME}’s access key\\?`));
  assert.match(text, /stops working straight away/);
  assert.match(text, new RegExp(`${NAME} loses access to Warthog until you create a new key`));
  const choices = buttons(dialog!);
  assert.equal(choices[0]?.text, "Keep key");
  assert.match(choices[0]!.attrs, /autofocus/i);
  assert.equal(choices.at(-1)?.text, "Revoke key");
  assert.match(choices.at(-1)!.attrs, /danger-solid|wh-button--danger-solid|bg-danger/, "the final step is danger-solid");
});

test("an agent whose key was revoked offers to create a new key, not to revoke again", () => {
  const markup = render({ state: "revoked" });
  const text = visibleText(withoutDialogs(markup));
  assert.match(text, new RegExp(`${NAME} has no working access key, so it can.t use Warthog`));
  const live = buttons(withoutDialogs(markup)).map((b) => b.text);
  assert.ok(live.includes("Create a new key"), JSON.stringify(live));
  assert.ok(!live.includes("Revoke key") && !live.includes("Replace key"), JSON.stringify(live));
});

test("a new key is shown once with the creation flow's Copy control and wording", () => {
  const markup = render({ initialKey: NEW_KEY });
  const text = visibleText(withoutDialogs(markup));
  assert.ok(decode(markup).includes(NEW_KEY), "the key verbatim, to copy");
  assert.match(text, /\bCopy access key\b/, "the same Copy control, named for the key");
  assert.match(text, /Copy it now — for your security this key won’t be shown again\./);
  assert.match(text, /old key has stopped working/);
  assert.match(text, new RegExp(`Paste this key into ${NAME} where it asks for an access key`));
  assert.ok(buttons(withoutDialogs(markup)).some((b) => b.text === "Done"), "a way to put the key away");
});

test("the panel uses tokens and plain words (no raw hex, no protocol jargon)", () => {
  for (const markup of [render(), render({ state: "revoked" }), render({ initialKey: NEW_KEY })]) {
    assert.doesNotMatch(markup, /#[0-9a-fA-F]{3,8}\b/);
    const prose = visibleText(markup).replace(NEW_KEY, "");
    for (const re of JARGON.slice(0, 4)) assert.doesNotMatch(prose, re);
  }
});
