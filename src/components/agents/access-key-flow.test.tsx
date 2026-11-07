// E10-S13 — Access-key flow (src/components/agents/access-key-flow.tsx).
//
// RED-first: src/components/agents/access-key-flow.tsx does NOT exist yet, so importing
// `./access-key-flow` throws (ERR_MODULE_NOT_FOUND) and EVERY test here fails until the
// builder adds it. That absence is the entire point of test-first — do NOT implement
// anything to make these pass.
//
// WHY this module exists (brief "Connect an agent" / "For a platform that cannot use the
// standard connector sign-in, 'Create an access key' lets the person name the agent and
// set its permissions on the same screen as the consent screen, shows the key once with a
// copy button, and lets them revoke or replace the key later"; design §6.1; constitution
// 16 — each agent has its own revocable credential, a per-agent access key where a
// platform cannot use the connector flow). The `/agents/access-key` page mounts this flow
// over the already-built, already-tested `createAccessKeyActions` seam (the sibling
// `access-key/actions.ts`, pinned by `access-key/actions.test.ts` — NOT re-proved here):
// the person names the agent and chooses its permissions on ONE screen, creates it, and
// the raw key is shown ONCE with a Copy button and plain instructions.
//
// This file pins the TWO seams `access-key-flow.tsx` exports, exactly mirroring the repo's
// established split for a screen that is both render-testable AND interactive (SignupView +
// createSignupFlow; AddCardFlow + createAddCardFlow; HighTierFlow + createHighTierFlow):
//
//   1. AccessKeyFlow — the Client Component the page mounts. Its create surface names the
//      agent and offers the three starting sets; its live "Create" control runs the flow;
//      once a key is issued it shows that key ONCE with a live Copy control, plain
//      instructions for pasting it in, and a warning that it won't be shown again. It is
//      render-tested here with `react-dom/server` (no DOM — React component / E2E testing
//      is a per-job ADR), exactly like every other component render test in the repo.
//
//   2. createAccessKeyFlow(deps) — the framework-free, injectable controller behind the
//      live "Create". Its interactive behaviour — collect the name / platform / starting
//      set, call the page's `create` action, hold the issued key for its one showing, and
//      report a refusal in plain words — is tested by DRIVING THE CONTROLLER with a fake
//      `create` action and asserting what it DOES, never the source text.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the control RENDERS for its props, and what the controller
//     DOES for its inputs (the input it hands `create`, the key it then exposes, the plain
//     error it reports) — never the source text of access-key-flow.tsx. A behaviour-
//     preserving refactor (reworded-but-still-plain copy, different wrappers, extra
//     classes, a different icon, a <Link> vs an <a>) stays green.
//   * The server-side contract (the agent is named under the SESSION user, permissions are
//     applied, the key is stored only hashed and verifies at /mcp, revoke stops it, a
//     SQLi probe is bound as data, malformed/oversized input is a 4xx) is already pinned
//     by access-key/actions.test.ts and the bearer / route / pipeline suites — these tests
//     do NOT re-prove it. They prove the flow CALLS `create` with the person's choices and
//     shows the ONE returned key.
//   * Absence checks are scoped to the EXACT unit under test — the create input this flow
//     sends, and the one panel it renders (e.g. "no `wh_ak_` key is shown before one is
//     issued" keys on the exact access-key prefix, which legitimately appears only once a
//     key exists).
//
// ─── the contract this task introduces (documented here as the cross-task contract) ───
//
//   createAccessKeyFlow(deps: {
//     create: (input: {                       // the page's "use server" wrapper over
//       name: string; platform: string;       //   createAccessKeyActions.create — the only
//       template: "minimal"|"standard"|"custom";
//       tickedServices?: readonly string[];   //   callable a server page hands the client
//       highTier?: boolean; card?: boolean;
//       cardBudget?: { amount: number; currency: string; period: string } | null;
//       learningSharing?: boolean;
//     }) => Promise<{ ok: true; agentId: string; key: string } | { ok: false; reason: string }>;
//     defaultName?: string;                   // the proposed agent name (page-supplied)
//     defaultPlatform?: string;               // the platform the key is for (page-supplied)
//     onChange?: () => void;                  // re-render notifier (the component wires it)
//     onCreated?: () => void;                 // called once a key is issued (list refresh)
//   }): AccessKeyController
//
//   AccessKeyController = {
//     getState(): AccessKeyFlowState;         // a snapshot the component renders from
//     setName(v: string): void;
//     setPlatform(v: string): void;
//     setTemplate(v: "minimal"|"standard"|"custom"): void;
//     submit(): Promise<void>;               // call create → hold the issued key / report
//   }
//
//   AccessKeyFlowState = {
//     name: string; platform: string; template: "minimal"|"standard"|"custom";
//     status: "idle" | "working" | "created" | "error";
//     key?: string;        // the RAW key, present only in "created" — shown once
//     agentId?: string;    // the created agent's id, present only in "created"
//     error?: string;      // a plain-English refusal, present only in "error"
//   }
//
//   AccessKeyFlow(props: {
//     create: (...) => Promise<CreateResult>;          // as above
//     defaultName?: string; defaultPlatform?: string;
//     services?: readonly { id: string; name: string; ticked?: boolean }[];
//     initialKey?: string; initialAgentId?: string;    // seed the issued panel for a
//                                                      //   preview / render test (the
//                                                      //   production flow reaches it via
//                                                      //   submit — the sibling `initialOpen`
//                                                      //   idiom of AddCardFlow / HighTierFlow)
//     onCreated?: () => void;
//   }): JSX.Element

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AccessKeyFlow, createAccessKeyFlow } from "./access-key-flow";

// ─── fixtures ────────────────────────────────────────────────────────────────────────

// The access-key prefix (design §6.1: `wh_ak_` + 32 base62 bytes). The issued raw key is
// shown verbatim so the person can copy the REAL credential — distinctive so its presence
// (or absence before issue) is unambiguous. Its suffix is plain base62 (no jargon words).
const ISSUED_KEY = "wh_ak_KQ7mZ2TestOnlyAccessKeyValue9xQ8wP1a";
// The created agent's id handed back alongside the key (uuid-shaped).
const ISSUED_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type CreateInput = {
  name: string;
  platform: string;
  template: "minimal" | "standard" | "custom";
  tickedServices?: readonly string[];
  highTier?: boolean;
  card?: boolean;
  cardBudget?: { amount: number; currency: string; period: string } | null;
  learningSharing?: boolean;
};
type CreateResult =
  | { ok: true; agentId: string; key: string }
  | { ok: false; reason: string };

// A recording fake `create` action: records every input it is handed and returns a fixed
// result (an issued key by default). `throws` makes it reject (the boundary-4xx / transport
// fault the flow must catch and report, never let escape).
function makeCreate(opts: { result?: CreateResult; throws?: boolean } = {}) {
  const inputs: CreateInput[] = [];
  const result: CreateResult =
    opts.result ?? { ok: true, agentId: ISSUED_AGENT_ID, key: ISSUED_KEY };
  const fn = async (input: CreateInput): Promise<CreateResult> => {
    inputs.push(input);
    if (opts.throws) throw new Error("boundary rejected the request (4xx)");
    return result;
  };
  return {
    fn,
    get inputs() {
      return inputs;
    },
    get count() {
      return inputs.length;
    },
  };
}

type Create = ReturnType<typeof makeCreate>;

function makeFlow(opts: {
  create: Create;
  defaultName?: string;
  defaultPlatform?: string;
}) {
  const changes: true[] = [];
  const created: true[] = [];
  const flow = createAccessKeyFlow({
    create: opts.create.fn,
    defaultName: opts.defaultName,
    defaultPlatform: opts.defaultPlatform,
    onChange: () => changes.push(true),
    onCreated: () => created.push(true),
  });
  return {
    flow,
    get changeCount() {
      return changes.length;
    },
    get createdCount() {
      return created.length;
    },
  };
}

// A refusal message must read as plain Australian English — a real sentence, never a raw
// machine code (snake_case) or protocol jargon — and never the raw `reason` (brief
// design_ux.copy; constitution INV-22). The same discipline the sibling flows assert.
const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "bearer", re: /\bbearer\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "JWT", re: /\bjwt\b/i },
  { label: "SAML", re: /\bsaml\b/i },
  { label: "401", re: /\b401\b/ },
];

function assertPlainFailure(message: unknown, ctx: string): asserts message is string {
  assert.equal(typeof message, "string", `${ctx}: expected plain-English failure copy, got ${typeof message}`);
  const text = (message as string).trim();
  assert.ok(text.length >= 8, `${ctx}: failure copy must be a real message, got: "${text}"`);
  assert.ok(/\s/.test(text), `${ctx}: failure copy must read as words, not a single token, got: "${text}"`);
  assert.ok(!/_/.test(text), `${ctx}: failure copy must not be a raw machine code (snake_case), got: "${text}"`);
  for (const { label, re } of JARGON) {
    assert.ok(!re.test(text), `${ctx}: failure copy must avoid jargon "${label}", got: "${text}"`);
  }
}

// ═══ construction does nothing ════════════════════════════════════════════════════════

test("constructing the flow calls create nothing and shows no key", () => {
  const create = makeCreate();
  const ctx = makeFlow({ create, defaultName: "My Grok", defaultPlatform: "grok" });

  assert.equal(create.count, 0, "nothing is created until the person confirms");
  const state = ctx.flow.getState();
  assert.equal(state.status, "idle", "the flow starts idle");
  assert.equal(state.key, undefined, "no key exists before one is created");
  assert.equal(ctx.createdCount, 0, "no success is signalled on construction");
});

// ═══ AC1 — creating names the agent, applies its set, and hands back the ONE key ═══════

test("AC1 — create hands the page-supplied name/platform and chosen set to the create action, then exposes the issued key once", async () => {
  const create = makeCreate();
  const ctx = makeFlow({ create, defaultName: "My Grok", defaultPlatform: "grok" });

  // The person keeps the proposed name, picks the Standard starting set and confirms.
  ctx.flow.setTemplate("standard");
  await ctx.flow.submit();

  // It called the create action exactly once, carrying the person's choices.
  assert.equal(create.count, 1, "confirming creates the access key exactly once");
  const input = create.inputs[0]!;
  assert.equal(input.name, "My Grok", "the chosen agent name is submitted to create");
  assert.equal(input.platform, "grok", "the platform the key is for is submitted to create");
  assert.equal(input.template, "standard", "the chosen starting set is submitted to create");
  // The acting person's identity is the SESSION's (the server's job) — the flow never
  // invents a user id in the untrusted input (constitution: member scope from the session).
  assert.ok(
    !("userId" in (input as Record<string, unknown>)),
    `the create input must never carry a user id; input=${JSON.stringify(input)}`,
  );

  // The ONE issued key is now exposed for its single showing, with the created agent's id.
  const state = ctx.flow.getState();
  assert.equal(state.status, "created", "a completed create moves the flow to its created state");
  assert.equal(state.key, ISSUED_KEY, "the raw key handed back by create is exposed verbatim to be copied");
  assert.equal(state.agentId, ISSUED_AGENT_ID, "the created agent's id is exposed alongside the key");
  assert.equal(state.error, undefined, "a completed create carries no error");
  assert.equal(ctx.createdCount, 1, "a completed create signals success exactly once (the list refreshes)");
});

test("AC1 — the name the person types overrides the proposed name, and the chosen set is carried", async () => {
  const create = makeCreate();
  const ctx = makeFlow({ create, defaultName: "Proposed", defaultPlatform: "llama" });

  ctx.flow.setName("My Llama agent");
  ctx.flow.setTemplate("minimal");
  await ctx.flow.submit();

  assert.equal(create.count, 1, "create is called once");
  const input = create.inputs[0]!;
  assert.equal(input.name, "My Llama agent", "the edited name (not the proposed one) is submitted");
  assert.equal(input.platform, "llama", "the platform is carried through");
  assert.equal(input.template, "minimal", "the Minimal starting set is submitted when chosen");
});

test("AC1 — the issued key is stable for its one showing (reading state again returns the same key)", async () => {
  const create = makeCreate();
  const ctx = makeFlow({ create, defaultName: "My Grok", defaultPlatform: "grok" });

  await ctx.flow.submit();
  const first = ctx.flow.getState().key;
  const second = ctx.flow.getState().key;
  assert.equal(first, ISSUED_KEY, "the issued key is the one create returned");
  assert.equal(second, first, "the issued key is held stably for its single showing");
});

test("editing a field notifies onChange so the screen re-renders", () => {
  const create = makeCreate();
  const ctx = makeFlow({ create, defaultName: "", defaultPlatform: "grok" });

  const before = ctx.changeCount;
  ctx.flow.setName("My Grok");
  ctx.flow.setTemplate("custom");
  assert.ok(ctx.changeCount > before, "editing the name / set notifies onChange");
});

// ═══ a refusal is reported in plain words, with no key ════════════════════════════════

test("a refused create reports a plain-English error and exposes no key", async () => {
  // The create action refuses with a raw machine reason; the flow must not surface it raw.
  const create = makeCreate({ result: { ok: false, reason: "card_needs_budget" } });
  const ctx = makeFlow({ create, defaultName: "My Grok", defaultPlatform: "grok" });

  await ctx.flow.submit();

  assert.equal(create.count, 1, "the create was attempted");
  const state = ctx.flow.getState();
  assert.equal(state.status, "error", "a refused create shows an error state");
  assert.equal(state.key, undefined, "a refused create exposes no key");
  assert.equal(ctx.createdCount, 0, "a refused create signals no success");
  assertPlainFailure(state.error, "refused create");
  assert.ok(
    !(state.error ?? "").includes("card_needs_budget"),
    `the raw machine reason must not be surfaced; error="${state.error}"`,
  );
});

test("a create that throws at the boundary (4xx) is caught and reported in plain words", async () => {
  const create = makeCreate({ throws: true });
  const ctx = makeFlow({ create, defaultName: "My Grok", defaultPlatform: "grok" });

  await ctx.flow.submit();

  assert.equal(create.count, 1, "the create was attempted");
  const state = ctx.flow.getState();
  assert.equal(state.status, "error", "a thrown create lands in an error state, never a silent failure");
  assert.equal(state.key, undefined, "a thrown create exposes no key");
  assert.equal(ctx.createdCount, 0, "a thrown create signals no success");
  assertPlainFailure(state.error, "thrown create");
});

// ═══ the AccessKeyFlow component renders the right surface (create, then key-shown) ════
//
// Rendered with react-dom/server (no DOM), reading the emitted markup — the same approach
// as every other component render test in the repo. Mounted with its data props (the
// `create` action is defaulted to a no-op for the static render; the initial create surface
// calls nothing).

const noopCreate = async (): Promise<CreateResult> => ({
  ok: true,
  agentId: ISSUED_AGENT_ID,
  key: ISSUED_KEY,
});

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
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}
function hasBoolAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}
function findAll(markup: string, tag: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}
function labelTextById(markup: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const l of findAll(markup, "label")) {
    const f = attr(l.attrs, "for");
    if (f) map[f] = visibleText(l.inner);
  }
  return map;
}
// Accessible names of every actionable (not-disabled) <button>: its visible label, else its
// aria-label. Proves a control is a live affordance, never dead static text.
function liveButtons(markup: string): string[] {
  return findAll(markup, "button")
    .filter((b) => !hasBoolAttr(b.attrs, "disabled"))
    .map((b) => (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim())
    .filter((n) => n.length > 0);
}
// Every editable text-ish value control (a non-checkbox/radio/hidden <input> or <textarea>)
// that is neither disabled nor readonly, with its accessible label, value and placeholder.
function editableFields(markup: string): Array<{ label: string; value: string; placeholder: string | null }> {
  const NON_VALUE = new Set(["checkbox", "radio", "hidden", "submit", "button", "reset", "image", "file"]);
  const labels = labelTextById(markup);
  const out: Array<{ label: string; value: string; placeholder: string | null }> = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1]!;
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (NON_VALUE.has(type)) continue;
    if (hasBoolAttr(attrs, "disabled") || hasBoolAttr(attrs, "readonly")) continue;
    const id = attr(attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(),
      value: attr(attrs, "value") ?? "",
      placeholder: attr(attrs, "placeholder"),
    });
  }
  for (const t of findAll(markup, "textarea")) {
    if (hasBoolAttr(t.attrs, "disabled") || hasBoolAttr(t.attrs, "readonly")) continue;
    const id = attr(t.attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(t.attrs, "aria-label") || "").trim(),
      value: visibleText(t.inner),
      placeholder: attr(t.attrs, "placeholder"),
    });
  }
  return out;
}
// Names of every live (not-disabled) selectable control — a button, a checkbox/radio input
// (by label / aria-label / value), a wrapping-label input, or an <option>. Used to prove a
// starting set is a live control, never dead static text.
function selectableNames(markup: string): string[] {
  const labels = labelTextById(markup);
  const out: string[] = [];
  for (const b of findAll(markup, "button")) {
    if (hasBoolAttr(b.attrs, "disabled")) continue;
    out.push((visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim());
  }
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1]!;
    if (hasBoolAttr(attrs, "disabled")) continue;
    const id = attr(attrs, "id");
    out.push(((id && labels[id]) || attr(attrs, "aria-label") || attr(attrs, "value") || "").trim());
  }
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im || hasBoolAttr(im[1]!, "disabled")) continue;
    out.push(visibleText(l.inner));
  }
  for (const o of findAll(markup, "option")) out.push(visibleText(o.inner));
  return out.filter((n) => n.length > 0);
}
function hasSelectable(markup: string, re: RegExp): boolean {
  return selectableNames(markup).some((n) => re.test(n));
}
// Human-facing prose with URLs and the issued key stripped, so neither the pasted key value
// nor a connector URL is mistaken for jargon prose.
function faceProse(markup: string): string {
  return visibleText(markup)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(new RegExp(ISSUED_KEY, "g"), " ")
    .replace(/\bwh_ak_\S*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STARTING_SETS: { name: string; re: RegExp }[] = [
  { name: "Minimal", re: /\bminimal\b/i },
  { name: "Standard", re: /\bstandard\b/i },
  { name: "Custom", re: /\bcustom\b/i },
];

// ─── the create surface (name + starting sets + a live Create) ─────────────────────────

test("the create surface offers an editable, pre-filled agent-name field", () => {
  const markup = renderToStaticMarkup(
    <AccessKeyFlow create={noopCreate} defaultName="My Grok" defaultPlatform="grok" />,
  );
  const named = editableFields(markup).filter((f) => /name/i.test(f.label));
  assert.ok(named.length >= 1, `the create surface must have an editable field labelled for the agent's name; fields=${JSON.stringify(editableFields(markup))}`);
  assert.ok(
    named.some((f) => f.value === "My Grok" || f.placeholder === "My Grok"),
    `the name field must be pre-filled with the proposed name; name fields=${JSON.stringify(named)}`,
  );
});

test("the create surface offers the three starting sets (Minimal, Standard, Custom) as live controls", () => {
  const markup = renderToStaticMarkup(<AccessKeyFlow create={noopCreate} defaultPlatform="grok" />);
  const text = visibleText(markup);
  for (const set of STARTING_SETS) {
    assert.ok(set.re.test(text), `the create surface must name the "${set.name}" starting set; text="${text}"`);
    assert.ok(
      hasSelectable(markup, set.re),
      `the "${set.name}" starting set must be a selectable (live) control, not dead static text`,
    );
  }
});

test("the create surface offers a live Create control", () => {
  const markup = renderToStaticMarkup(<AccessKeyFlow create={noopCreate} defaultPlatform="grok" />);
  assert.ok(
    liveButtons(markup).some((n) => /create|generate|issue|make/i.test(n)),
    `the create surface must offer a live control to create the access key; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

test("the create surface shows no key before one is issued", () => {
  const markup = renderToStaticMarkup(<AccessKeyFlow create={noopCreate} defaultPlatform="grok" />);
  assert.ok(
    !decode(markup).includes("wh_ak_"),
    `no access key may be shown before one is created; markup=${decode(markup)}`,
  );
});

// ─── the key-shown surface (the key once, a Copy control, plain instructions, a warning) ─
//
// Seeded into its created state with `initialKey` (the preview/test seam, the sibling
// `initialOpen` idiom) so the one-time key panel can be render-tested without a click.

function renderIssued(): string {
  return renderToStaticMarkup(
    <AccessKeyFlow
      create={noopCreate}
      defaultPlatform="grok"
      initialKey={ISSUED_KEY}
      initialAgentId={ISSUED_AGENT_ID}
    />,
  );
}

test("AC1 — the issued panel shows the raw key verbatim (for the person to copy)", () => {
  const markup = renderIssued();
  assert.ok(
    decode(markup).includes(ISSUED_KEY),
    `the issued panel must show the raw access key verbatim so the person can copy it; markup=${decode(markup)}`,
  );
});

test("AC1 — the issued panel offers a live Copy control", () => {
  const markup = renderIssued();
  assert.ok(
    liveButtons(markup).some((n) => /\bcopy\b/i.test(n)),
    `the issued panel must offer a live Copy control for the key; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

test("AC1 — the issued panel gives plain instructions for using the key", () => {
  const text = visibleText(renderIssued());
  assert.match(
    text,
    /\b(paste|enter|add|give|put)\b/i,
    `the issued panel must tell the person in plain words what to do with the key (paste / enter / add it in their agent); text="${text}"`,
  );
});

test("AC1 — the issued panel warns the key is shown only once", () => {
  const text = visibleText(renderIssued());
  assert.match(
    text,
    /won['’]?t see|only.*once|just once|shown once|copy it now|save it now|can['’]?t show|cannot show|won['’]?t be shown/i,
    `the issued panel must warn the key is shown only this once (so copy/save it now); text="${text}"`,
  );
});

// ─── design system + plain-copy discipline ─────────────────────────────────────────────

test("uses design tokens, never a raw hex colour (create surface + issued panel)", () => {
  for (const markup of [
    renderToStaticMarkup(<AccessKeyFlow create={noopCreate} defaultName="My Grok" defaultPlatform="grok" />),
    renderIssued(),
  ]) {
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the AccessKeyFlow markup, got: ${markup}`,
    );
  }
});

test("shows no protocol or security jargon in its prose (create surface + issued panel)", () => {
  for (const markup of [
    renderToStaticMarkup(<AccessKeyFlow create={noopCreate} defaultName="My Grok" defaultPlatform="grok" />),
    renderIssued(),
  ]) {
    const prose = faceProse(markup);
    for (const { label, re } of JARGON) {
      assert.ok(!re.test(prose), `the flow must speak plainly — found jargon "${label}" in: "${prose}"`);
    }
  }
});
