// E12-S12 — Approval inbox view component (src/components/inbox/inbox-view.tsx).
//
// RED-first: src/components/inbox/inbox-view.tsx does NOT exist yet, so importing
// `./inbox-view` throws and EVERY test in this file fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// WHY this component exists (brief "Approval inbox" / "Agents wait safely"; design §6;
// constitution 17 "no readable card numbers or security codes on Warthog's side" + 18
// "approvals only inside the signed-in app"): the inbox is where a person decides, in a
// glance, the requests agents are waiting on. For a card / high-tier RELEASE the value
// must be decrypted ON THE DEVICE and posted to the release endpoint — never exposed to
// the server as plaintext at rest (design §4.2; only ciphertext at rest server-side).
//
// This file pins TWO exported seams of inbox-view.tsx, exactly mirroring the repo's two
// established patterns for a screen that is both render-testable AND interactive
// (DeviceView + createDeviceFlow, SignupView + createSignupFlow):
//
//   1. InboxView — the PURE, prop-driven view (like ActivityView / ConnectorsView /
//      DeviceView). It renders the pending list and the history from already-formatted
//      props: it reaches for no clock, locale, DB or config. The page loader (E12-S13)
//      stays thin and feeds it. Decision controls (Approve for a non-release held call,
//      Deny, Ask for more detail) are BOUND to the server actions the page passes
//      (createInboxActions, E12-S10), exactly as ActivityView binds Dispute/Undo.
//
//   2. createReleaseFlow(deps) — the framework-free, injectable controller behind the
//      card/high-tier Approve path (like createDeviceFlow / createSignupFlow). React
//      component / E2E testing is a per-job ADR and there is no jsdom here, so the
//      interactive device hand-over (unlock → decrypt → post) is tested by DRIVING THE
//      CONTROLLER with fake vault seams and asserting what it DOES, never the source
//      text of the module.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the view RENDERS for its props, and what the controller
//     DOES for its inputs — never the source text of inbox-view.tsx. A later
//     behaviour-preserving refactor (reworded-but-still-plain copy, different wrappers,
//     extra classes, a different icon, composing a UI primitive) stays green.
//   * The view is rendered with `react-dom/server` (no DOM/jsdom), reading the emitted
//     markup, exactly like every other component render test in this repo.
//   * Absence checks ("a routine held call shows no explainer", "a high-tier release has
//     no security-code field", "a decided request offers no decision controls") are
//     scoped to the EXACT unit under test — a single request rendered alone, or a
//     history-only inbox — never a whole-output text scan, because the same word can
//     legitimately appear elsewhere.
//
// The prop / controller shapes below are the cross-task contract this task introduces
// (documented here exactly as dashboard-view.test.tsx / signup-flow.test.tsx do). The
// view renders already-formatted strings (a plain `sentence`, pre-formatted detail
// values, a pre-formatted `timeLeft`, a display-ready `outcome`); the controller takes
// the opaque unlock material, the stored ciphertext and the freshly-entered security
// code and performs the device hand-over.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  InboxView,
  createReleaseFlow,
  focusApprovalElement,
  type HistorySummary,
  type InboxViewProps as LiveInboxViewProps,
} from "./inbox-view";
import { ReleaseRejectedError } from "@/client/vault/release";

// ─── the prop shapes this task introduces (described here as the contract) ───────────

// Whether a pending request is a one-time RELEASE of a sensitive value: "card" and
// "high_tier" take the device unlock-decrypt-release Approve path; `null` is a routine
// held call whose Approve is a plain server-verified decision.
type ReleaseKind = "card" | "high_tier";

// One already-formatted detail line under a request (the exact recipient / amount /
// field the brief names). Both strings are display-ready and already redacted.
type RequestDetail = { label: string; value: string };

// A pending request awaiting the person's decision, as the view renders it.
type PendingRequestView = {
  id: string;
  agent: string; // the requesting agent's display name
  sentence: string; // the one-sentence request (plain language, already redacted)
  details: readonly RequestDetail[]; // recipient / amount / field requested
  reason: string; // the agent's stated reason
  rule: string; // the triggering rule (e.g. an "Ask me first" rule)
  timeLeft: string; // pre-formatted time left before expiry, e.g. "four minutes left"
  release: ReleaseKind | null; // non-null ⇒ a card / high-tier release (special Approve path)
};

// A past decision in the history: approved / denied / expired / more_detail.
type DecidedRequestView = {
  id: string;
  agent: string;
  sentence: string;
  status: "approved" | "denied" | "expired" | "more_detail";
  outcome: string; // display-ready outcome label, e.g. "Approved", "Expired"
  decidedAt: string; // pre-formatted time label
  question?: string; // the question asked, for a more_detail request
};

// One of the person's saved cards offered in a card release's picker. The server stores
// only the device-decryptable `ciphertext`; the view shows the display `label` (brand +
// last four — constitution 17), never a readable card number.
type SavedCardView = {
  id: string;
  label: string;
  ciphertext: string;
};

type InboxViewProps = {
  pending: readonly PendingRequestView[];
  history: readonly DecidedRequestView[];
  // Decision controls BOUND to the server actions the page passes (createInboxActions,
  // E12-S10). OPTIONAL: when an action is not supplied its control renders DISABLED with
  // a one-line reason rather than a live button over a missing action (constitution: no
  // dead controls — disable it and say why), exactly as ActivityView treats Dispute/Undo.
  // `approveAction` is for a NON-release held call; a card/high-tier release Approve runs
  // the on-device hand-over in the mounted <ReleaseApprove> control the view itself mounts
  // (E11-S17) — a server page cannot hand a client a callback, so a release is LIVE BY
  // CONSTRUCTION, never gated on a page-passed `onRelease` prop.
  approveAction?: (formData: FormData) => void | Promise<void>;
  denyAction?: (formData: FormData) => void | Promise<void>;
  moreDetailAction?: (formData: FormData) => void | Promise<void>;
  // The person's saved cards, offered in a card release's on-device picker.
  savedCards?: readonly SavedCardView[];
};

// ─── fixtures ────────────────────────────────────────────────────────────────────────
//
// Hex-free content (so the raw-hex scan can only catch a hard-coded colour) with
// distinct marker phrases per field (so a presence / order / absence assertion can only
// be satisfied by the field it targets). No fixture copy contains a sensitive-moment
// explainer phrase, nor a decision-control word ("approve"/"deny"/"release"/"confirm"/…)
// anywhere a <p> could spoof a control-face match.

// A card release — takes the device unlock-decrypt-release Approve path.
const PENDING_CARD: PendingRequestView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agent: "Claude",
  sentence: "wants to use a card to pay the ferry fare",
  details: [
    { label: "To", value: "Harbour Ferries" },
    { label: "Amount", value: "forty-two dollars" },
    { label: "Using", value: "a saved card" },
  ],
  reason: "the weekend ferry pass is due now",
  rule: "Ask me when an agent wants a card",
  timeLeft: "four minutes left",
  release: "card",
};

// A routine held tool call — NOT a release; its Approve is a plain server-verified
// decision bound to approveAction.
const PENDING_HELD: PendingRequestView = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  agent: "ChatGPT",
  sentence: "wants to send a note to your mailing list",
  details: [
    { label: "To", value: "the book club" },
    { label: "Message", value: "a reminder about Tuesday" },
  ],
  reason: "you asked it to keep the club posted",
  rule: "Ask me when it messages a group",
  timeLeft: "an hour left",
  release: null,
};

// A high-tier identity release — takes the device Approve path, but has NO card picker
// and NO security code ("where relevant" means cards only).
const PENDING_HIGH: PendingRequestView = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  agent: "Claude",
  sentence: "wants to share your passport number",
  details: [
    { label: "Field", value: "passport number" },
    { label: "To", value: "the travel agent" },
  ],
  reason: "booking your overseas trip",
  rule: "Ask me when an agent wants a high-tier detail",
  timeLeft: "two minutes left",
  release: "high_tier",
};

const SAVED_CARDS: readonly SavedCardView[] = [
  { id: "card-visa", label: "Visa ending 4242", ciphertext: "v1:visaCipherFerry" },
  { id: "card-amex", label: "Amex ending 1005", ciphertext: "v1:amexCipherFerry" },
];

// History: one of each decided status, each with a distinct sentence marker and a
// display-ready outcome label the loader hands in.
const HIST_APPROVED: DecidedRequestView = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  agent: "Claude",
  sentence: "handed your card to the airline",
  status: "approved",
  outcome: "Approved",
  decidedAt: "yesterday",
};
const HIST_DENIED: DecidedRequestView = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  agent: "ChatGPT",
  sentence: "wanted to post to the forum",
  status: "denied",
  outcome: "Denied",
  decidedAt: "this morning",
};
const HIST_EXPIRED: DecidedRequestView = {
  id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  agent: "Claude",
  sentence: "wanted to rename a folder",
  status: "expired",
  outcome: "Expired",
  decidedAt: "last week",
};
const HIST_MORE_DETAIL: DecidedRequestView = {
  id: "99999999-9999-4999-8999-999999999999",
  agent: "Claude",
  sentence: "wanted to book a table",
  status: "more_detail",
  outcome: "You asked for more",
  decidedAt: "an hour ago",
  question: "which restaurant did you mean",
};

// A stand-in bound server action (what makes a decision control LIVE).
const noopAction = async (_formData: FormData): Promise<void> => {};

// A fully-populated inbox: pending newest-first (the order the loader hands in), a full
// history, saved cards, and every decision action wired (the page's live wiring). A
// card/high-tier release is live by construction (the view mounts the on-device control
// itself — E11-S17), so no release trigger is passed in. Each test overrides exactly the
// slice it probes.
function base(overrides: Partial<InboxViewProps> = {}): InboxViewProps {
  return {
    pending: [PENDING_CARD, PENDING_HELD, PENDING_HIGH],
    history: [HIST_APPROVED, HIST_DENIED, HIST_EXPIRED, HIST_MORE_DETAIL],
    approveAction: noopAction,
    denyAction: noopAction,
    moreDetailAction: noopAction,
    savedCards: SAVED_CARDS,
    ...overrides,
  };
}

// ─── tiny markup helpers (no DOM), mirrored from the sibling component tests ─────────

function render(props: InboxViewProps): string {
  return renderToStaticMarkup(<InboxView {...props} />);
}

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

// Visible text with tags stripped and entities decoded — the words a sighted reader
// sees (an <svg> icon contributes none).
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}

// The accessible name of a control: its visible text PLUS any aria-label / title.
function controlFace(el: El): string {
  const parts = [visibleText(el.inner)];
  const al = attr(el.attrs, "aria-label");
  if (al) parts.push(decode(al));
  const ti = attr(el.attrs, "title");
  if (ti) parts.push(decode(ti));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Unavailable means the native attribute or aria-disabled — not the shared Button's
// Tailwind `disabled:` class variants, which every button carries.
function isDisabled(el: El): boolean {
  return /\sdisabled=""|aria-disabled="true"/i.test(el.attrs);
}

// Every <button> whose accessible name matches `re` (disabled ones included).
function buttonsMatching(markup: string, re: RegExp): El[] {
  return findAll(markup, "button").filter((b) => re.test(controlFace(b)));
}

// Every CONTROL whose accessible name matches `re`, counting both <button>s and the
// <summary> of a disclosure (a release's Approve affordance may be a <details> summary,
// not a <button>) — so an "offers Approve" check never bets on the exact element.
function controlsMatching(markup: string, re: RegExp): El[] {
  return [...findAll(markup, "button"), ...findAll(markup, "summary")].filter((c) =>
    re.test(controlFace(c)),
  );
}

// Attribute strings of every <input>.
function inputAttrs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) out.push(m[1]!);
  return out;
}

// The "label-ish" text of a region: every <label>/<legend> visible text, plus the
// aria-label / name / placeholder that name a control, plus <select> names. Used to find
// a named field (e.g. a security-code input) without betting on the element kind.
function controlLabelText(markup: string): string {
  const parts: string[] = [];
  for (const l of findAll(markup, "label")) parts.push(visibleText(l.inner));
  for (const l of findAll(markup, "legend")) parts.push(visibleText(l.inner));
  for (const m of markup.matchAll(/aria-label="([^"]*)"/gi)) parts.push(decode(m[1]!));
  for (const a of inputAttrs(markup)) {
    for (const n of ["name", "placeholder"]) {
      const v = attr(a, n);
      if (v) parts.push(decode(v));
    }
  }
  for (const s of findAll(markup, "select")) {
    const n = attr(s.attrs, "name");
    if (n) parts.push(n);
  }
  return parts.join(" | ");
}

// React encodes a FUNCTION form action (a bound server action) as a `javascript:`
// progressive-enhancement placeholder in server-rendered markup; a client form (an
// `onSubmit` handler, like the release form) carries no `action`. So "this form is bound
// to a server action" is observable as its action scheme — behaviour, not source text.
function isBoundToAction(form: El): boolean {
  const action = attr(form.attrs, "action");
  return action !== null && /^javascript:/i.test(action);
}

// The value of a hidden field named `name` inside `form` (e.g. the request id the bound
// action consumes), or null if absent.
function hiddenValue(form: El, name: string): string | null {
  for (const a of inputAttrs(form.inner)) {
    if (attr(a, "name") === name) return attr(a, "value");
  }
  return null;
}

// Whether `markup` carries a free-text entry field (a <textarea>, or an <input> of a
// free-text type) — the "say why" field an Ask-for-more-detail form offers.
const FREE_TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", ""]);
function hasFreeTextField(markup: string): boolean {
  if (findAll(markup, "textarea").length > 0) return true;
  return inputAttrs(markup).some((a) => FREE_TEXT_TYPES.has((attr(a, "type") ?? "").toLowerCase()));
}

// Whether `form` carries the id the bound action needs under SOME hidden field. The
// field name is the builder's choice (id / approvalId / …); the test reads whichever
// hidden field carries the request id, so it never pins the name.
function formCarriesId(form: El, id: string): boolean {
  for (const a of inputAttrs(form.inner)) {
    if (attr(a, "type") === "hidden" && attr(a, "value") === id) return true;
  }
  return false;
}

// The "say-why" surface of the markup: visible text PLUS every title / aria-label. A
// disabled control that says why carries MORE of this than the same control live.
function reasonSurface(markup: string): string {
  const parts = [visibleText(markup)];
  for (const m of markup.matchAll(/(?:title|aria-label)="([^"]*)"/gi)) parts.push(decode(m[1]!));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whether the markup lets the person CHOOSE among the given saved cards: a <select>
// whose options cover every label, OR a radio per card, OR a button per card label.
// Robust to whichever chooser the builder renders.
function hasCardChooser(markup: string, cards: readonly SavedCardView[]): boolean {
  for (const s of findAll(markup, "select")) {
    const opts = findAll(s.inner, "option").map((o) => visibleText(o.inner));
    if (cards.every((c) => opts.some((o) => o.includes(c.label)))) return true;
  }
  const radios = inputAttrs(markup).filter((a) => (attr(a, "type") ?? "").toLowerCase() === "radio");
  if (radios.length >= cards.length) return true;
  const byButton = cards.every(
    (c) => controlsMatching(markup, new RegExp(escapeRegExp(c.label), "i")).length >= 1,
  );
  return byButton;
}

// The decision-control regexes (accessible-name matchers). Deny/Ask copy is the
// builder's to word, so each matcher is generous over the plausible plain wordings.
const APPROVE_RE = /approve|allow|release|hand over/i;
const DENY_RE = /deny|turn down|decline|refuse|reject|say no/i;
const ASK_RE = /ask (for|the)|more detail|more info/i;
// The release proceed/confirm control that runs the device hand-over.
const RELEASE_RE = /release|hand over|hand it|share|confirm|continue/i;
// The sensitive-moment explainer copy (SensitiveNotice-style). Several phrasings so a
// reworded explainer stays matched, but all strong "slow down for this one moment"
// signals unlikely in generic inbox chrome — so the "a held call shows no explainer"
// absence check can only fail on a real explainer, never on shared page chrome. Kept out
// of every fixture's own copy.
const EXPLAINER_RE =
  /sensitive|take a moment|moment before|before it goes ahead|check the details|double.?check|one[- ]?time|slow down/i;
// A security-code field, named with Warthog's vocabulary ("security code").
const SECURITY_CODE_RE = /security code|security number|\bcvc\b|\bcvv\b|card code|code on (?:the )?(?:back|front)|[34].?digit code/i;

// ═══ AC1 — the pending list, newest-first, each a one-sentence request with details, ══
//          reason, triggering rule and time left, offering Approve / Deny / Ask.

test("renders pending approvals in the order given — newest at the top — when one agent is asking", () => {
  // The loader hands pending newest-first; the view must preserve that order (never
  // reverse it). Markers: ferry (newest) → mailing → passport (oldest). One agent asks
  // for all three, so they stay one list. History is emptied so only the pending markers
  // can appear.
  const sameAgent = [PENDING_CARD, { ...PENDING_HELD, agent: "Claude" }, PENDING_HIGH];
  const text = visibleText(render(base({ pending: sameAgent, history: [] })));
  const iFerry = text.indexOf("ferry");
  const iMailing = text.indexOf("mailing");
  const iPassport = text.indexOf("passport");
  assert.ok(
    iFerry >= 0 && iMailing >= 0 && iPassport >= 0,
    `every pending request must render, got: "${text}"`,
  );
  assert.ok(
    iFerry < iMailing && iMailing < iPassport,
    `pending must render newest-first (ferry, then mailing, then passport), got indices ${iFerry}/${iMailing}/${iPassport}`,
  );
});

test("renders a pending request's one-sentence request, details, reason, triggering rule, time left and agent", () => {
  // One request alone so each value can only come from it.
  const text = visibleText(render(base({ pending: [PENDING_CARD], history: [] })));
  const expected = [
    PENDING_CARD.agent, // "Claude"
    "ferry fare", // the one-sentence request
    "Harbour Ferries", // a detail (recipient)
    "forty-two dollars", // a detail (amount)
    "a saved card", // a detail (field)
    "weekend ferry pass", // the reason
    "when an agent wants a card", // the triggering rule
    "four minutes left", // the time left
  ];
  for (const e of expected) {
    assert.ok(text.includes(e), `the pending request must show "${e}", got: "${text}"`);
  }
});

test("renders from the pending list given, not a fixed list", () => {
  const onlyA: PendingRequestView = {
    ...PENDING_HELD,
    id: "11111111-1111-4111-8111-111111111111",
    sentence: "wants to renew your parking permit",
  };
  const onlyB: PendingRequestView = {
    ...PENDING_HELD,
    id: "22222222-2222-4222-8222-222222222222",
    sentence: "wants to top up your transport card",
  };
  const textA = visibleText(render(base({ pending: [onlyA], history: [] })));
  const textB = visibleText(render(base({ pending: [onlyB], history: [] })));
  assert.ok(textA.includes("parking permit"), "list A shows A's request");
  assert.ok(!textA.includes("transport"), "list A must not show B's request");
  assert.ok(textB.includes("transport"), "list B shows B's request");
  assert.ok(!textB.includes("parking permit"), "list B must not show A's request");
});

test("offers Approve, Deny and Ask-for-more-detail on every pending request (release and non-release alike)", () => {
  for (const request of [PENDING_CARD, PENDING_HELD, PENDING_HIGH]) {
    const markup = render(base({ pending: [request], history: [] }));
    assert.ok(
      controlsMatching(markup, APPROVE_RE).length >= 1,
      `request ${request.id} must offer an Approve control`,
    );
    assert.ok(
      controlsMatching(markup, DENY_RE).length >= 1,
      `request ${request.id} must offer a Deny control`,
    );
    assert.ok(
      controlsMatching(markup, ASK_RE).length >= 1,
      `request ${request.id} must offer an Ask-for-more-detail control`,
    );
  }
});

test("a non-release Approve is bound to approveAction and carries the request id", () => {
  // Rendered alone so the one Approve form can only be this held call's. A release's
  // Approve runs the device flow instead, so this is proven on the NON-release request.
  const markup = render(base({ pending: [PENDING_HELD], history: [] }));
  const approveForms = findAll(markup, "form").filter((f) =>
    findAll(f.inner, "button").some((b) => APPROVE_RE.test(controlFace(b))),
  );
  assert.ok(approveForms.length >= 1, "the non-release Approve must be a real form control");
  const form = approveForms[0]!;
  assert.ok(
    isBoundToAction(form),
    "the Approve form is BOUND to the approveAction server action, not a dead button",
  );
  assert.ok(
    formCarriesId(form, PENDING_HELD.id),
    "the Approve form carries the request id the action consumes",
  );
});

test("Deny is bound to denyAction and carries the request id", () => {
  const markup = render(base({ pending: [PENDING_HELD], history: [] }));
  const denyForms = findAll(markup, "form").filter((f) =>
    findAll(f.inner, "button").some((b) => DENY_RE.test(controlFace(b))),
  );
  assert.ok(denyForms.length >= 1, "Deny must be a real form control");
  const form = denyForms[0]!;
  assert.ok(isBoundToAction(form), "the Deny form is BOUND to the denyAction server action");
  assert.ok(formCarriesId(form, PENDING_HELD.id), "the Deny form carries the request id");
});

test("Ask-for-more-detail is bound to moreDetailAction, carries the id and offers a free-text question", () => {
  // askForMoreDetail(question) needs a question, so the form must offer a free-text
  // field. The ask form is the bound form carrying a free-text field (Approve/Deny carry
  // only a hidden id), so it is identified without betting on the button wording.
  const markup = render(base({ pending: [PENDING_HELD], history: [] }));
  const askForms = findAll(markup, "form").filter(
    (f) => isBoundToAction(f) && hasFreeTextField(f.inner),
  );
  assert.equal(askForms.length, 1, "exactly one bound form offers a free-text question (Ask for more detail)");
  const form = askForms[0]!;
  assert.ok(formCarriesId(form, PENDING_HELD.id), "the Ask form carries the request id");
  assert.ok(
    findAll(form.inner, "button").some((b) => ASK_RE.test(controlFace(b))),
    "the Ask form's submit reads as asking for more detail",
  );
});

test("a decision control with no bound action is disabled with a reason (no dead controls)", () => {
  // The same held request with denyAction wired (live) vs omitted (not configured). With
  // no denyAction the Deny control is DISABLED and says WHY — never a live/dead button
  // over a missing action (constitution: disable the control and say why).
  const live = render(base({ pending: [PENDING_HELD], history: [], denyAction: noopAction }));
  const dead = render(base({ pending: [PENDING_HELD], history: [], denyAction: undefined }));

  const denyButtons = buttonsMatching(dead, DENY_RE);
  assert.ok(denyButtons.length >= 1, "a Deny affordance still appears when the action is absent");
  assert.ok(
    denyButtons.every(isDisabled),
    "with no denyAction every Deny button is DISABLED",
  );
  assert.equal(
    findAll(dead, "form").filter((f) => isBoundToAction(f) && DENY_RE.test(visibleText(f.inner))).length,
    0,
    "the disabled Deny is not a bound live server-action form",
  );
  assert.ok(
    reasonSurface(dead).length > reasonSurface(live).length,
    "the disabled Deny says WHY it is unavailable — a one-line reason the live control does not carry",
  );
});

// ═══ AC2 — the card / high-tier Approve path: the sensitive-moment explainer, the saved- ═
//          card picker + security code (where relevant), and the device release control.

test("a card release shows the sensitive-moment explainer; a routine held call does not", () => {
  // Rendered alone under the same (empty) history, so the explainer words can only come
  // from the release path — not shared page chrome. The release shows it; the held call
  // (a routine decision) does not.
  const card = visibleText(render(base({ pending: [PENDING_CARD], history: [] })));
  const held = visibleText(render(base({ pending: [PENDING_HELD], history: [] })));
  assert.match(card, EXPLAINER_RE, `a card release must show the sensitive-moment explainer, got: "${card}"`);
  assert.ok(
    !EXPLAINER_RE.test(held),
    `a routine held call must NOT show the sensitive-moment explainer, got: "${held}"`,
  );
});

test("a card release lets the person choose a saved card and enter a security code, with a live release control", () => {
  const markup = render(base({ pending: [PENDING_CARD], history: [], savedCards: SAVED_CARDS }));
  const text = visibleText(markup);

  // Every saved card is shown by its display label (brand + last four) and choosable.
  for (const card of SAVED_CARDS) {
    assert.ok(text.includes(card.label), `the card picker must offer "${card.label}", got: "${text}"`);
  }
  assert.ok(
    hasCardChooser(markup, SAVED_CARDS),
    "the saved cards must be offered through a real chooser (a select, radios or per-card buttons)",
  );

  // A security-code field is offered (cards carry a code — "where relevant").
  assert.match(
    controlLabelText(markup),
    SECURITY_CODE_RE,
    `a card release must offer a security-code field, got control labels: "${controlLabelText(markup)}"`,
  );

  // A live control runs the device unlock-decrypt-and-release.
  const proceed = controlsMatching(markup, RELEASE_RE).filter((c) => !isDisabled(c));
  assert.ok(
    proceed.length >= 1,
    `a card release must offer a live control to run the release, got controls: ${JSON.stringify(
      [...findAll(markup, "button"), ...findAll(markup, "summary")].map((c) => controlFace(c)),
    )}`,
  );
});

test("a high-tier release shows the explainer and a live release control, with no card picker and no security code", () => {
  // High-tier is a release (device Approve path) but has no card and no security code.
  const markup = render(base({ pending: [PENDING_HIGH], history: [], savedCards: SAVED_CARDS }));
  const text = visibleText(markup);

  assert.match(text, EXPLAINER_RE, `a high-tier release must show the sensitive-moment explainer, got: "${text}"`);
  const proceed = controlsMatching(markup, RELEASE_RE).filter((c) => !isDisabled(c));
  assert.ok(proceed.length >= 1, "a high-tier release must offer a live control to run the release");

  // No card picker: the saved-card labels must not appear on a high-tier release.
  for (const card of SAVED_CARDS) {
    assert.ok(
      !text.includes(card.label),
      `a high-tier release must not show the card picker ("${card.label}"), got: "${text}"`,
    );
  }
  // No security code: a passport release has no code to enter.
  assert.ok(
    !SECURITY_CODE_RE.test(controlLabelText(markup)),
    `a high-tier release must not offer a security-code field, got control labels: "${controlLabelText(markup)}"`,
  );
});

// ═══ AC2 — the history section lists decided, denied, expired and more-detail requests ══

test("renders a history section listing decided, denied, expired and more-detail requests", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // A distinct history heading/section exists.
  const headings = ["h1", "h2", "h3"].flatMap((t) => findAll(markup, t).map((h) => visibleText(h.inner)));
  assert.ok(
    headings.some((h) => /history|decided|past|earlier|previous|recent|done|finished|handled|settled|resolved/i.test(h)),
    `a history section heading must exist, got headings: ${JSON.stringify(headings)}`,
  );

  // Every decided request renders its sentence and its display-ready outcome label.
  for (const entry of [HIST_APPROVED, HIST_DENIED, HIST_EXPIRED, HIST_MORE_DETAIL]) {
    assert.ok(text.includes(entry.sentence), `history must show "${entry.sentence}"`);
    assert.ok(text.includes(entry.outcome), `history must show the outcome "${entry.outcome}"`);
  }
});

test("a more-detail history entry shows the question that was asked", () => {
  const text = visibleText(render(base({ pending: [], history: [HIST_MORE_DETAIL] })));
  assert.ok(
    text.includes(HIST_MORE_DETAIL.question!),
    `a more-detail entry must show the question asked ("${HIST_MORE_DETAIL.question}"), got: "${text}"`,
  );
});

test("a decided request offers none of the pending decision controls", () => {
  // History only: a decided request is settled — no Approve / Deny / Ask / release
  // control hangs off it (those belong to pending requests). The outcome LABELS
  // ("Approved", "Denied", "You asked for more") are plain text, not controls.
  const markup = render(base({ pending: [] }));
  assert.equal(controlsMatching(markup, APPROVE_RE).length, 0, "no Approve control on decided requests");
  assert.equal(controlsMatching(markup, DENY_RE).length, 0, "no Deny control on decided requests");
  assert.equal(controlsMatching(markup, ASK_RE).length, 0, "no Ask-for-more-detail control on decided requests");
  assert.equal(controlsMatching(markup, RELEASE_RE).length, 0, "no release control on decided requests");
});

test("an empty inbox renders a message and does not crash (no decision controls)", () => {
  let markup: string;
  try {
    markup = render(base({ pending: [], history: [] }));
  } catch (err) {
    assert.fail(
      "InboxView must render an empty inbox, not crash: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(visibleText(markup).length >= 3, `the empty state must say something, got: "${visibleText(markup)}"`);
  assert.equal(controlsMatching(markup, APPROVE_RE).length, 0, "no Approve control on an empty inbox");
  assert.equal(controlsMatching(markup, DENY_RE).length, 0, "no Deny control on an empty inbox");
  assert.equal(controlsMatching(markup, ASK_RE).length, 0, "no Ask control on an empty inbox");
});

// ═══ AC3 — colour comes from design tokens, never a raw hex literal ═══════════════════

test("uses design tokens, never a raw hex colour (full, release-only, history-only and empty)", () => {
  for (const props of [
    base(),
    base({ pending: [PENDING_CARD], history: [] }),
    base({ pending: [], history: [HIST_MORE_DETAIL] }),
    base({ pending: [], history: [] }),
  ]) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the InboxView markup, got: ${markup}`,
    );
  }
});

// ═══ AC2 — createReleaseFlow: the device unlock-decrypt-and-release (the hard part) ════
//
// The contract this task introduces, exported from `./inbox-view` (like createDeviceFlow
// from device-flow.tsx):
//
//   createReleaseFlow(deps: {
//     unlock: (request: UnlockRequest) => Promise<Uint8Array>;      // client/vault unlockVault
//     decrypt: (vaultKey: Uint8Array, ciphertext: string) => Promise<string>; // decryptValue
//     postRelease: (approvalId: string, value: string) => Promise<void>;      // postRelease
//   }): ReleaseFlow
//
//   ReleaseFlow = {
//     // Decide a card/high-tier release on this device: unlock the vault with the given
//     // material, decrypt the stored ciphertext, and post the released value to the
//     // approval's release endpoint. Resolves with a result; NEVER rejects and NEVER
//     // fails silently (constitution: report success or failure).
//     release(input: {
//       approvalId: string;
//       unlockRequest: UnlockRequest; // opaque unlock material (passkey PRF / passphrase / recovery)
//       ciphertext: string;           // the device-decryptable stored value (server holds only this)
//       securityCode?: string;        // the freshly-entered card code (card releases only)
//     }): Promise<{ ok: true } | { ok: false; error: string }>;
//   }

// Distinct, hex-free marker values so an assertion proves the flow carried THROUGH the
// value it was given, not a constant.
const VAULT_KEY = new Uint8Array([9, 8, 7, 6, 5]);
const CARD_CIPHERTEXT = "v1:ferryCardCiphertext";
const CARD_PLAINTEXT = "ferry-card-plaintext-marker";
const HIGH_CIPHERTEXT = "v1:passportCiphertext";
const HIGH_PLAINTEXT = "passport-plaintext-marker";
const SECURITY_CODE = "ferry-security-marker";
const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// A valid-shaped unlock request (a passphrase method); the flow passes it opaquely to
// `unlock`, so the test only checks it travels through unchanged.
const UNLOCK_REQUEST = {
  method: "passphrase" as const,
  material: { wrapped: "v1:wrapped-vault-key", salt: new Uint8Array(16) },
  secret: "correct horse battery staple",
};

// What `decrypt` returns for each stored ciphertext (keyed on the ciphertext, so the
// test proves the RIGHT ciphertext was decrypted).
const PLAINTEXT_FOR: Record<string, string> = {
  [CARD_CIPHERTEXT]: CARD_PLAINTEXT,
  [HIGH_CIPHERTEXT]: HIGH_PLAINTEXT,
};

type FlowFailures = {
  unlock?: () => never;
  decrypt?: () => never;
  post?: () => never;
};

function setupFlow(failures: FlowFailures = {}) {
  const events: string[] = [];
  const unlockCalls: unknown[] = [];
  const decryptCalls: { key: Uint8Array; ciphertext: string }[] = [];
  const postCalls: { approvalId: string; value: string }[] = [];

  const unlock = async (request: unknown): Promise<Uint8Array> => {
    events.push("unlock");
    unlockCalls.push(request);
    if (failures.unlock) failures.unlock();
    return VAULT_KEY;
  };
  const decrypt = async (key: Uint8Array, ciphertext: string): Promise<string> => {
    events.push("decrypt");
    decryptCalls.push({ key, ciphertext });
    if (failures.decrypt) failures.decrypt();
    return PLAINTEXT_FOR[ciphertext] ?? `plaintext-of-${ciphertext}`;
  };
  const postRelease = async (approvalId: string, value: string): Promise<void> => {
    events.push("post");
    postCalls.push({ approvalId, value });
    if (failures.post) failures.post();
  };

  const flow = createReleaseFlow({ unlock, decrypt, postRelease });
  return { flow, events, unlockCalls, decryptCalls, postCalls };
}

// A failure result's copy must read as plain Australian English — a real sentence, never
// a raw machine code or crypto/protocol jargon — and must never contain the released
// value or the security code.
const CRYPTO_JARGON: { label: string; re: RegExp }[] = [
  { label: "ciphertext", re: /ciphertext/i },
  { label: "decrypt", re: /decrypt/i },
  { label: "AES", re: /\baes\b/i },
  { label: "GCM", re: /\bgcm\b/i },
  { label: "vault key", re: /vault key/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "nonce", re: /nonce/i },
  { label: "envelope", re: /envelope/i },
];

function assertPlainFailure(message: unknown, ctx: string): asserts message is string {
  assert.equal(typeof message, "string", `${ctx}: expected plain-English failure copy, got ${typeof message}`);
  const text = (message as string).trim();
  assert.ok(text.length >= 8, `${ctx}: failure copy must be a real message, got: "${text}"`);
  assert.ok(/\s/.test(text), `${ctx}: failure copy must read as words, not a single token, got: "${text}"`);
  assert.ok(!/_/.test(text), `${ctx}: failure copy must not be a raw machine code (snake_case), got: "${text}"`);
  for (const { label, re } of CRYPTO_JARGON) {
    assert.ok(!re.test(text), `${ctx}: failure copy must avoid jargon "${label}", got: "${text}"`);
  }
  for (const secret of [CARD_PLAINTEXT, HIGH_PLAINTEXT, SECURITY_CODE]) {
    assert.ok(!text.includes(secret), `${ctx}: failure copy must never leak a secret value, got: "${text}"`);
  }
}

test("a card release unlocks, decrypts the stored ciphertext, then posts — in that order", async () => {
  const ctx = setupFlow();

  const result = await ctx.flow.release({
    approvalId: APPROVAL_ID,
    unlockRequest: UNLOCK_REQUEST,
    ciphertext: CARD_CIPHERTEXT,
    securityCode: SECURITY_CODE,
  });

  assert.deepEqual(ctx.events, ["unlock", "decrypt", "post"], "the device hand-over runs unlock → decrypt → post, in order");
  assert.deepEqual(ctx.unlockCalls, [UNLOCK_REQUEST], "unlock receives the given unlock material, unchanged");

  assert.equal(ctx.decryptCalls.length, 1, "decrypt runs exactly once");
  assert.deepEqual(
    Array.from(ctx.decryptCalls[0]!.key),
    Array.from(VAULT_KEY),
    "decrypt uses the key unlock returned",
  );
  assert.equal(ctx.decryptCalls[0]!.ciphertext, CARD_CIPHERTEXT, "decrypt decrypts the stored card ciphertext");

  assert.equal(ctx.postCalls.length, 1, "the release is posted exactly once");
  assert.equal(ctx.postCalls[0]!.approvalId, APPROVAL_ID, "the release is posted for the right approval id");
  assert.ok(
    ctx.postCalls[0]!.value.includes(CARD_PLAINTEXT),
    "the posted value carries the decrypted card value (the plaintext reaches the release endpoint)",
  );
  assert.ok(
    ctx.postCalls[0]!.value.includes(SECURITY_CODE),
    "the posted value carries the freshly-entered security code (so the agent can use the card)",
  );

  assert.deepEqual(result, { ok: true }, "a completed release reports success");
  assert.ok(
    !JSON.stringify(result).includes(CARD_PLAINTEXT) && !JSON.stringify(result).includes(SECURITY_CODE),
    "the result never carries the released value or the security code back",
  );
});

test("a high-tier release posts the decrypted value with no security code", async () => {
  const ctx = setupFlow();

  const result = await ctx.flow.release({
    approvalId: APPROVAL_ID,
    unlockRequest: UNLOCK_REQUEST,
    ciphertext: HIGH_CIPHERTEXT,
  });

  assert.deepEqual(ctx.events, ["unlock", "decrypt", "post"], "the device hand-over runs unlock → decrypt → post");
  assert.equal(ctx.decryptCalls[0]!.ciphertext, HIGH_CIPHERTEXT, "decrypt decrypts the stored high-tier ciphertext");
  assert.equal(ctx.postCalls.length, 1, "the release is posted once");
  assert.equal(ctx.postCalls[0]!.approvalId, APPROVAL_ID, "posted for the right approval id");
  assert.ok(
    ctx.postCalls[0]!.value.includes(HIGH_PLAINTEXT),
    "the posted value carries the decrypted high-tier value",
  );
  assert.deepEqual(result, { ok: true }, "a completed high-tier release reports success");
});

test("the released value and the security code never touch browser storage or the console", async () => {
  // Install recording stand-ins for browser storage and the console so a leak is caught.
  const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
  const hadLocal = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const hadSession = Object.prototype.hasOwnProperty.call(g, "sessionStorage");
  const origLocal = g.localStorage;
  const origSession = g.sessionStorage;

  function fakeStorage() {
    const map = new Map<string, string>();
    const writes: { key: string; value: string }[] = [];
    const store: Storage = {
      getItem: (k) => (map.has(k) ? map.get(k)! : null),
      setItem: (k, v) => {
        map.set(k, String(v));
        writes.push({ key: k, value: String(v) });
      },
      removeItem: (k) => void map.delete(k),
      clear: () => map.clear(),
      key: (i) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
    return { store, writes };
  }

  const local = fakeStorage();
  const session = fakeStorage();
  g.localStorage = local.store;
  g.sessionStorage = session.store;

  const consoleOut: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original: Partial<Record<(typeof methods)[number], typeof console.log>> = {};
  for (const m of methods) {
    original[m] = console[m];
    console[m] = (...args: unknown[]) => {
      consoleOut.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }

  try {
    const ctx = setupFlow();
    const result = await ctx.flow.release({
      approvalId: APPROVAL_ID,
      unlockRequest: UNLOCK_REQUEST,
      ciphertext: CARD_CIPHERTEXT,
      securityCode: SECURITY_CODE,
    });
    assert.deepEqual(result, { ok: true }, "the release completes");

    // The secrets DID reach the release endpoint (sanity: the markers are real).
    assert.ok(ctx.postCalls[0]!.value.includes(CARD_PLAINTEXT), "the value reached the release endpoint");
    assert.ok(ctx.postCalls[0]!.value.includes(SECURITY_CODE), "the code reached the release endpoint");

    // ...but never leaked to browser storage.
    for (const w of [...local.writes, ...session.writes]) {
      for (const secret of [CARD_PLAINTEXT, SECURITY_CODE]) {
        assert.ok(
          !String(w.value).includes(secret) && !String(w.key).includes(secret),
          `a released secret must never be written to browser storage, write: ${w.key}=${w.value}`,
        );
      }
    }
    // ...and never leaked to the console.
    for (const line of consoleOut) {
      for (const secret of [CARD_PLAINTEXT, SECURITY_CODE]) {
        assert.ok(!line.includes(secret), `a released secret must never be logged to the console, line: "${line}"`);
      }
    }
  } finally {
    for (const m of methods) console[m] = original[m]!;
    if (hadLocal) g.localStorage = origLocal;
    else delete g.localStorage;
    if (hadSession) g.sessionStorage = origSession;
    else delete g.sessionStorage;
  }
});

test("a failed vault unlock decrypts and posts nothing, and reports a plain-English failure", async () => {
  // The person's secret is wrong (or a tampered envelope): unlock rejects. Nothing is
  // decrypted, nothing is released, and the flow reports a plain failure — never crashes,
  // never leaks.
  const ctx = setupFlow({
    unlock: () => {
      throw new Error("unwrap failed: GCM tag mismatch");
    },
  });

  const result = await ctx.flow.release({
    approvalId: APPROVAL_ID,
    unlockRequest: UNLOCK_REQUEST,
    ciphertext: CARD_CIPHERTEXT,
    securityCode: SECURITY_CODE,
  });

  assert.deepEqual(ctx.events, ["unlock"], "a failed unlock does not reach decrypt or post");
  assert.equal(ctx.decryptCalls.length, 0, "nothing is decrypted after a failed unlock");
  assert.equal(ctx.postCalls.length, 0, "nothing is released after a failed unlock");
  assert.equal(result.ok, false, "a failed unlock reports failure, not silent success");
  if (result.ok === false) assertPlainFailure(result.error, "failed unlock");
});

test("an undecryptable value posts nothing and reports a plain-English failure", async () => {
  // The stored ciphertext does not verify under the recovered key (a tampered blob):
  // decrypt rejects. The value is never released.
  const ctx = setupFlow({
    decrypt: () => {
      throw new Error("decrypt failed: unrecognised vault value envelope version");
    },
  });

  const result = await ctx.flow.release({
    approvalId: APPROVAL_ID,
    unlockRequest: UNLOCK_REQUEST,
    ciphertext: CARD_CIPHERTEXT,
    securityCode: SECURITY_CODE,
  });

  assert.deepEqual(ctx.events, ["unlock", "decrypt"], "a failed decrypt does not reach post");
  assert.equal(ctx.postCalls.length, 0, "nothing is released when the value cannot be decrypted");
  assert.equal(result.ok, false, "a failed decrypt reports failure");
  if (result.ok === false) assertPlainFailure(result.error, "failed decrypt");
});

test("a rejected release reports a plain-English failure that leaks no value", async () => {
  // The server refuses the post (e.g. the step-up lapsed): postRelease rejects. The flow
  // reports a plain failure that never contains the released value or the code.
  const ctx = setupFlow({
    post: () => {
      throw new Error("The release could not be completed (status 403).");
    },
  });

  const result = await ctx.flow.release({
    approvalId: APPROVAL_ID,
    unlockRequest: UNLOCK_REQUEST,
    ciphertext: CARD_CIPHERTEXT,
    securityCode: SECURITY_CODE,
  });

  assert.deepEqual(ctx.events, ["unlock", "decrypt", "post"], "the flow tried the full hand-over");
  assert.equal(result.ok, false, "a rejected release reports failure, not silent success");
  if (result.ok === false) assertPlainFailure(result.error, "rejected release");
});

test("constructing the release flow performs no unlock, decrypt or release", () => {
  const ctx = setupFlow();
  assert.deepEqual(ctx.events, [], "creating the flow touches nothing until a release is decided");
  assert.equal(ctx.postCalls.length, 0, "no release is posted on construction");
});

// ═══ Review fix C7 — a refused release says why, so the person can act on it ═══════════
//
// Every refusal used to collapse into "We couldn't complete the release just now. Please
// try again." — including a lapsed step-up, where trying again can never succeed. The
// flow now reports the server's reason with copy that says what to do next.

test("a release refused for a lapsed step-up reports step_up_required with copy that asks the person to confirm it's them", async () => {
  const ctx = setupFlow({
    post: () => {
      throw new ReleaseRejectedError(403, "step_up_required");
    },
  });
  const result = await ctx.flow.release({ approvalId: APPROVAL_ID, unlockRequest: UNLOCK_REQUEST, ciphertext: CARD_CIPHERTEXT });
  if (result.ok) assert.fail("a refused release must not report success");
  assert.equal(result.reason, "step_up_required", "the reason is passed on");
  assertPlainFailure(result.error, "step-up refusal");
  assert.match(result.error, /confirm it's you/i, "the copy asks the person to confirm it's them");
  assert.doesNotMatch(result.error, /try again/i, "never the generic 'try again'");
});

test("other refusals each get their own plain reason", async () => {
  for (const [code, re] of [
    ["over_budget", /budget/i],
    ["over_member_budget", /household spending limit/i],
    ["over_household_budget", /shared budget/i],
    ["household_rate_unavailable", /reference rate/i],
    ["expired", /expired/i],
    ["already_released", /already/i],
    ["not_releasable", /can no longer/i],
  ] as const) {
    const ctx = setupFlow({
      post: () => {
        throw new ReleaseRejectedError(409, code);
      },
    });
    const result = await ctx.flow.release({ approvalId: APPROVAL_ID, unlockRequest: UNLOCK_REQUEST, ciphertext: CARD_CIPHERTEXT });
    if (result.ok) assert.fail(`${code}: a refused release must not report success`);
    assert.equal(result.reason, code, `${code}: the reason is passed on`);
    assertPlainFailure(result.error, code);
    assert.match(result.error, re, `${code}: the copy says what happened`);
  }
});

// ═══ Review fix C11 — no sideways scrolling at 360px ═════════════════════════════════════
//
// The detail list was `grid-cols-[auto_1fr]` with plain <dd>s: a 1fr track has an auto
// minimum, so one long unbroken value (an email address, a merchant) set the column wider
// than a 360px phone and the approval screen scrolled sideways. The value column may now
// shrink (minmax(0,1fr)) and long values wrap anywhere.

test("a long unbroken detail value can wrap: the value column may shrink and every value wraps anywhere", () => {
  const LONG = "firstname.lastname.someone@department.example.com.au";
  const request: PendingRequestView = {
    ...PENDING_HELD,
    details: [{ label: "To", value: LONG }],
    reason: `reply to ${LONG}`,
  };
  const markup = render(base({ pending: [request], history: [] }));

  const lists = findAll(markup, "dl");
  assert.equal(lists.length, 1, "one detail list");
  const listClass = attr(lists[0]!.attrs, "class") ?? "";
  assert.match(listClass, /minmax\(0,1fr\)/, "the value column may shrink below its content's width");

  const values = findAll(lists[0]!.inner, "dd");
  assert.ok(values.length >= 1, "the details render as <dd> values");
  for (const value of values) {
    const cls = attr(value.attrs, "class") ?? "";
    assert.match(cls, /overflow-wrap:anywhere|wrap-anywhere|break-all/, `every value wraps anywhere, got class "${cls}"`);
    assert.match(cls, /min-w-0/, `every value may shrink, got class "${cls}"`);
  }
});

// ═══ Review fix W4.2 — a notification tap opens straight onto its approval ═════════════
//
// A push notification opens /inbox?approval=<id>. The page hands that id to the view,
// which marks THAT request (in words and an icon, never colour alone) and, once mounted,
// scrolls it into view and moves focus to it. A request that has already been decided,
// or one that is gone, gets a plain notice instead of silently showing the list.

// The <li> that carries a given approval's element id.
function itemFor(markup: string, id: string): El | undefined {
  return findAll(markup, "li").find((li) => attr(li.attrs, "id") === `approval-${id}`);
}

test("W4.2: the approval a notification opened is marked in words and can take focus", () => {
  const markup = render(base({ focusApproval: PENDING_HELD.id }));
  const item = itemFor(markup, PENDING_HELD.id);
  assert.ok(item, "the opened request carries its approval element id");
  assert.equal(attr(item.attrs, "tabindex"), "-1", "it can take focus programmatically");
  assert.match(visibleText(item.inner), /from your notification/i, "it says why it is highlighted, in words");

  const other = itemFor(markup, PENDING_CARD.id);
  assert.ok(other, "every request carries its element id");
  assert.doesNotMatch(visibleText(other.inner), /from your notification/i, "only the opened request is marked");
  assert.equal(attr(other.attrs, "tabindex"), null, "and only it takes focus");
});

test("W4.2: an opened approval that was already decided shows a plain notice", () => {
  const markup = render(base({ focusApproval: HIST_DENIED.id }));
  const text = visibleText(markup);
  assert.match(text, /already been decided/i, `the person is told it was decided; text="${text}"`);
  assert.match(text, /history/i, "and where to find it");
  const item = itemFor(markup, HIST_DENIED.id);
  assert.ok(item && /from your notification/i.test(visibleText(item.inner)), "the decided entry is marked too");
});

test("W4.2: an opened approval that is gone shows a plain notice and never echoes the id", () => {
  const ghost = "12121212-1212-4121-8121-121212121212";
  const markup = render(base({ focusApproval: ghost }));
  const text = visibleText(markup);
  assert.match(text, /couldn.t find that request/i, `the person is told it is gone; text="${text}"`);
  assert.ok(!markup.includes(ghost), "the id from the address bar is never written into the page");
});

test("W4.2: with no opened approval there is no notice and nothing is marked", () => {
  const text = visibleText(render(base()));
  assert.doesNotMatch(text, /from your notification|couldn.t find that request|already been decided/i);
});

test("W4.2: focusApprovalElement scrolls the request into view and moves focus to it", () => {
  const calls: string[] = [];
  const element = {
    scrollIntoView: (options?: ScrollIntoViewOptions) => calls.push(`scroll:${options?.block}`),
    focus: (options?: FocusOptions) => calls.push(`focus:${options?.preventScroll}`),
  };
  const doc = {
    getElementById: (id: string) => (id === `approval-${PENDING_HELD.id}` ? element : null),
  };
  assert.equal(focusApprovalElement(doc, PENDING_HELD.id), true);
  assert.deepEqual(calls, ["scroll:center", "focus:true"]);
  assert.equal(focusApprovalElement(doc, "missing"), false, "a missing element is not an error");
});

// ═══ Review fix W6 — a card release hands over everything a checkout needs ═════════════
//
// The agent used to collect only {number, securityCode}, which cannot complete a checkout.
// A card release now posts {number, securityCode, expiryMonth, expiryYear, cardholderName,
// billingAddress}: the number decrypted on this device, the security code freshly typed
// (never stored), and the card's non-secret details the loader supplied.

const CARD_DETAILS = {
  expiryMonth: 11,
  expiryYear: 2030,
  cardholderName: "A Q Wren",
  billingAddress: "12 Banksia Street, Perth WA 6000",
};

test("W6 — a card release posts the number, security code, expiry, name on card and billing address", async () => {
  const ctx = setupFlow();
  const result = await ctx.flow.release({
    approvalId: APPROVAL_ID,
    unlockRequest: UNLOCK_REQUEST,
    ciphertext: CARD_CIPHERTEXT,
    securityCode: SECURITY_CODE,
    card: CARD_DETAILS,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(ctx.postCalls.length, 1, "posted once");
  assert.deepEqual(
    JSON.parse(ctx.postCalls[0]!.value),
    {
      number: CARD_PLAINTEXT,
      securityCode: SECURITY_CODE,
      expiryMonth: 11,
      expiryYear: 2030,
      cardholderName: "A Q Wren",
      billingAddress: "12 Banksia Street, Perth WA 6000",
    },
    "the released JSON carries the full set of checkout details",
  );
  assert.equal(ctx.decryptCalls[0]!.ciphertext, CARD_CIPHERTEXT, "only the stored number is decrypted");
});

test("W6 — a card release with no known name or address hands those over as null, keeping the shape", async () => {
  const ctx = setupFlow();
  await ctx.flow.release({
    approvalId: APPROVAL_ID,
    unlockRequest: UNLOCK_REQUEST,
    ciphertext: CARD_CIPHERTEXT,
    securityCode: SECURITY_CODE,
    card: { expiryMonth: 7, expiryYear: 2029, cardholderName: null, billingAddress: null },
  });
  const released = JSON.parse(ctx.postCalls[0]!.value) as Record<string, unknown>;
  assert.deepEqual(Object.keys(released).sort(), [
    "billingAddress",
    "cardholderName",
    "expiryMonth",
    "expiryYear",
    "number",
    "securityCode",
  ]);
  assert.equal(released.cardholderName, null);
  assert.equal(released.billingAddress, null);
  assert.equal(released.expiryMonth, 7);
  assert.equal(released.expiryYear, 2029);
});

test("W6 — a high-tier release still posts the bare value, with no card details", async () => {
  const ctx = setupFlow();
  await ctx.flow.release({ approvalId: APPROVAL_ID, unlockRequest: UNLOCK_REQUEST, ciphertext: HIGH_CIPHERTEXT });
  assert.equal(ctx.postCalls[0]!.value, HIGH_PLAINTEXT, "the high-tier value is posted as is");
});

// ═══ Inbox organisation — tabs, grouping and history filters ════════════════════════════
//
// The inbox used to be one long thread: every pending request, then every past decision.
// It is now two tabs — "Waiting on you (n)" and "History (n)" — whose panels both stay
// mounted (an unsent question or a half-entered release survives a tab switch). Pending
// requests from two or more agents are grouped under one heading per agent; the history
// can be narrowed by outcome and agent with plain links that keep the other filter.

const AGENT_CLAUDE = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const AGENT_CHATGPT = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";

function renderLive(props: LiveInboxViewProps): string {
  return renderToStaticMarkup(<InboxView {...props} />);
}

function liveBase(overrides: Partial<LiveInboxViewProps> = {}): LiveInboxViewProps {
  return { ...(base() as LiveInboxViewProps), ...overrides };
}

// The tab buttons, by their visible label.
function tabs(markup: string): { label: string; selected: boolean; controls: string | null }[] {
  return findAll(markup, "button")
    .filter((b) => attr(b.attrs, "role") === "tab")
    .map((b) => ({
      label: visibleText(b.inner),
      selected: attr(b.attrs, "aria-selected") === "true",
      controls: attr(b.attrs, "aria-controls"),
    }));
}

// Whether the tab panel with this id is hidden, and where it opens in the markup.
function panel(markup: string, id: string | null): { hidden: boolean; at: number } {
  for (const m of markup.matchAll(/<div\b([^>]*)>/gi)) {
    if (id !== null && attr(m[1]!, "id") === id) return { hidden: /\bhidden=""/.test(m[1]!), at: m.index! };
  }
  throw new Error(`no panel ${id}`);
}

// The links inside the <nav> named `label`.
function navLinks(markup: string, label: string): { text: string; href: string; current: boolean }[] {
  const nav = findAll(markup, "nav").find((n) => attr(n.attrs, "aria-label") === label);
  assert.ok(nav, `a "${label}" navigation exists`);
  return findAll(nav.inner, "a").map((a) => ({
    text: visibleText(a.inner),
    href: decode(attr(a.attrs, "href") ?? ""),
    current: attr(a.attrs, "aria-current") === "page",
  }));
}

const SUMMARY: HistorySummary = {
  total: 4,
  matching: 4,
  outcomes: [
    { status: "approved", count: 1 },
    { status: "denied", count: 1 },
    { status: "expired", count: 1 },
    { status: "more_detail", count: 1 },
  ],
  allOutcomesCount: 4,
  agents: [
    { id: AGENT_CHATGPT, name: "ChatGPT", count: 1 },
    { id: AGENT_CLAUDE, name: "Claude", count: 3 },
  ],
  allAgentsCount: 4,
};

test("Waiting on you and History are tabs that name their counts; Waiting on you opens first", () => {
  const markup = renderLive(liveBase({ historySummary: { ...SUMMARY, total: 12 } }));
  const found = tabs(markup);
  assert.deepEqual(
    found.map((tab) => [tab.label, tab.selected]),
    [
      ["Waiting on you (3)", true],
      ["History (12)", false],
    ],
    "two tabs: the pending count, then every decision the person has",
  );
  const pendingPanel = panel(markup, found[0]!.controls);
  const historyPanel = panel(markup, found[1]!.controls);
  assert.equal(pendingPanel.hidden, false, "the pending panel shows");
  assert.equal(historyPanel.hidden, true, "the history panel waits behind its tab");
  const iFerry = markup.indexOf("ferry fare");
  const iHistory = markup.indexOf(HIST_DENIED.sentence);
  assert.ok(pendingPanel.at < iFerry && iFerry < historyPanel.at, "pending requests sit in the pending panel");
  assert.ok(historyPanel.at < iHistory, "decisions stay mounted in the history panel, so no draft is lost");
});

test("an explicit view opens that tab", () => {
  const found = tabs(renderLive(liveBase({ initialView: "history" })));
  assert.deepEqual(found.map((tab) => tab.selected), [false, true]);
});

test("a notification for a request that is already decided opens History and says where it is", () => {
  const markup = renderLive(liveBase({ focusApproval: HIST_DENIED.id }));
  assert.deepEqual(tabs(markup).map((tab) => tab.selected), [false, true], "the History tab opens");
  const text = visibleText(markup);
  assert.match(text, /already been decided/i);
  assert.doesNotMatch(text, /below/i, "the notice no longer points down a single long page");
});

test("a decided request opened from a notification is shown and marked even when it is not on the loaded page", () => {
  const older: DecidedRequestView = { ...HIST_APPROVED, id: "45454545-4545-4545-8545-454545454545", sentence: "booked the old ferry" };
  const markup = renderLive(liveBase({ focusApproval: older.id, openedEntry: older }));
  const item = itemFor(markup, older.id);
  assert.ok(item, "the opened decision is rendered");
  assert.match(visibleText(item.inner), /from your notification/i, "and marked in words");
  assert.equal(attr(item.attrs, "tabindex"), "-1", "and it can take focus");
  assert.deepEqual(tabs(markup).map((tab) => tab.selected), [false, true], "in the History tab");
  assert.match(visibleText(markup), /already been decided/i);
});

test("with two or more agents waiting, pending requests are grouped by agent, each group headed with its count", () => {
  const pending = [
    { ...PENDING_CARD, agentId: AGENT_CLAUDE },
    { ...PENDING_HELD, agentId: AGENT_CHATGPT },
    { ...PENDING_HIGH, agentId: AGENT_CLAUDE },
  ];
  const markup = renderLive(liveBase({ pending, history: [] }));
  assert.match(markup, /<h2[^>]*>Claude<\/h2>\s*<span[^>]*>2<\/span>/, "Claude's group names its two requests");
  assert.match(markup, /<h2[^>]*>ChatGPT<\/h2>\s*<span[^>]*>1<\/span>/, "ChatGPT's group names its one request");
  const text = visibleText(markup);
  const order = ["Claude 2", "ferry fare", "passport", "ChatGPT 1", "mailing"].map((marker) => text.indexOf(marker));
  assert.ok(order.every((index) => index >= 0), `every marker renders: ${text}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the group with the newest request leads; newest first within a group");
});

test("one agent's pending requests stay a single list with no agent headings", () => {
  const pending = [PENDING_CARD, PENDING_HIGH].map((request) => ({ ...request, agentId: AGENT_CLAUDE }));
  const markup = renderLive(liveBase({ pending, history: [] }));
  assert.doesNotMatch(markup, /<h2[^>]*>Claude<\/h2>/, "no group heading for a single agent");
});

test("repeated decision controls name the request they decide for screen readers", () => {
  const markup = render(base({ history: [] }));
  // Deny buttons, the Ask disclosures and the Ask submit buttons ("Ask the agent") each
  // repeat per request.
  for (const [tag, re] of [
    ["button", /^Deny\b/],
    ["summary", /^Ask for more detail\b/],
    ["button", /^Ask the agent\b/],
  ] as const) {
    const faces = findAll(markup, tag).map(controlFace).filter((face) => re.test(face));
    assert.equal(faces.length, 3, `one ${tag} ${re} per request, got ${JSON.stringify(faces)}`);
    assert.equal(new Set(faces).size, 3, `each ${tag} ${re} has its own accessible name: ${JSON.stringify(faces)}`);
  }
  const approve = buttonsMatching(markup, /^Approve\b/).map(controlFace);
  assert.ok(approve.some((face) => face.includes("mailing list")), `Approve names its request: ${JSON.stringify(approve)}`);
  assert.match(markup, /<span class="sr-only">/, "the context is read out, not shown");
});

test("history filters offer each outcome and agent as links with counts, marking the current one and keeping the other filter", () => {
  const summary: HistorySummary = {
    ...SUMMARY,
    matching: 3,
    outcomes: [
      { status: "approved", count: 1 },
      { status: "denied", count: 0 },
      { status: "expired", count: 1 },
      { status: "more_detail", count: 1 },
    ],
    allOutcomesCount: 3,
  };
  const markup = renderLive(
    liveBase({ historyFilter: { agent: AGENT_CLAUDE }, historySummary: summary, focusApproval: HIST_APPROVED.id }),
  );
  assert.deepEqual(navLinks(markup, "Filter decisions by outcome"), [
    { text: "All 3", href: `/inbox?agent=${AGENT_CLAUDE}&view=history`, current: true },
    { text: "Approved 1", href: `/inbox?agent=${AGENT_CLAUDE}&outcome=approved&view=history`, current: false },
    { text: "Denied 0", href: `/inbox?agent=${AGENT_CLAUDE}&outcome=denied&view=history`, current: false },
    { text: "Expired 1", href: `/inbox?agent=${AGENT_CLAUDE}&outcome=expired&view=history`, current: false },
    { text: "Asked for more detail 1", href: `/inbox?agent=${AGENT_CLAUDE}&outcome=more_detail&view=history`, current: false },
  ]);
  assert.deepEqual(navLinks(markup, "Filter decisions by agent"), [
    { text: "All agents 4", href: "/inbox?view=history", current: false },
    { text: "ChatGPT 1", href: `/inbox?agent=${AGENT_CHATGPT}&view=history`, current: false },
    { text: "Claude 3", href: `/inbox?agent=${AGENT_CLAUDE}&view=history`, current: true },
  ]);
  assert.ok(!/[?&](approval|notice)=/.test(decode(markup)), "a filter link never carries the notification id or an old notice");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(markup), "filters use design tokens");
});

test("a single agent's history offers no agent filter", () => {
  const markup = renderLive(liveBase({ historySummary: { ...SUMMARY, agents: [SUMMARY.agents[1]!] } }));
  assert.ok(!findAll(markup, "nav").some((n) => attr(n.attrs, "aria-label") === "Filter decisions by agent"));
});

test("applied history filters are removable chips with a way to clear them all", () => {
  const markup = renderLive(
    liveBase({ historyFilter: { outcome: "denied", agent: AGENT_CLAUDE }, historySummary: { ...SUMMARY, matching: 1 }, history: [HIST_DENIED] }),
  );
  const chips = findAll(markup, "a").map((a) => ({ text: visibleText(a.inner), href: decode(attr(a.attrs, "href") ?? "") }));
  assert.ok(chips.some((c) => c.text === "Remove filter Outcome: Denied" && c.href === `/inbox?agent=${AGENT_CLAUDE}&view=history`));
  assert.ok(chips.some((c) => c.text === "Remove filter Agent: Claude" && c.href === "/inbox?outcome=denied&view=history"));
  assert.ok(chips.some((c) => c.text === "Clear all filters" && c.href === "/inbox?view=history"));
});

test("a history filter that matches nothing says so and offers a way back", () => {
  const markup = renderLive(
    liveBase({ history: [], historyFilter: { outcome: "expired" }, historySummary: { ...SUMMARY, matching: 0 } }),
  );
  const text = visibleText(markup);
  assert.match(text, /No decisions match/);
  assert.doesNotMatch(text, /Nothing waiting|Nothing decided yet/, "the person does have decisions; just none that match");
  const clear = findAll(markup, "a").find((a) => visibleText(a.inner) === "Clear filters");
  assert.ok(clear, "a Clear filters link");
  assert.equal(decode(attr(clear.attrs, "href") ?? ""), "/inbox?view=history");
  assert.match(attr(clear.attrs, "class") ?? "", /min-h-11/, "a full-size touch target");
});

test("a history page cut short says how many recent decisions it shows", () => {
  const text = visibleText(renderLive(liveBase({ historySummary: { ...SUMMARY, total: 80, matching: 80 } })));
  assert.match(text, /Showing the 4 most recent of 80/);
});

test("history rows show each outcome in words with an icon, as divider rows", () => {
  const markup = render(base({ pending: [] }));
  const row = itemFor(markup, HIST_DENIED.id);
  assert.ok(row, "the decision renders as a list item");
  assert.match(row.inner, /<svg[^>]*aria-hidden="true"/, "an icon accompanies the words");
  assert.match(visibleText(row.inner), /Denied/, "the outcome reads as words");
  assert.match(attr(row.attrs, "class") ?? "", /border-b/, "a divider row, not a card per decision");
});

test("a decision's outcome notice renders inside the page width", () => {
  const markup = renderLive(liveBase({ notice: { tone: "success", text: "Approved — the agent can go ahead." } }));
  assert.match(markup, /^<div class="wh-page[^"]*">/, "the page container is the outermost element");
  assert.match(markup, /role="status"[^>]*>[\s\S]*Approved — the agent can go ahead\./, "the notice is announced");
  assert.doesNotMatch(markup, /max-w-3xl/, "no narrower wrapper outside the page");
  const error = renderLive(liveBase({ notice: { tone: "error", text: "We couldn't complete that just now." } }));
  assert.match(error, /role="alert"/, "a problem is announced immediately");
});

// ═══ UI/UX pass (lane A) — contained, consistent and explained ══════════════════════════

test("the page title, its purpose and the tabs share one heading band; no text sits on the canvas", () => {
  const markup = renderLive(liveBase());
  assert.match(markup, /^<div class="wh-page">/, "one page container, with no local spacing utilities");
  const band = markup.slice(markup.indexOf('<header class="wh-page-heading"'), markup.indexOf("</header>"));
  assert.match(band, /<h1>Inbox<\/h1>/, "the title is in the heading band");
  assert.match(band, /Requests from your agents that need your decision/, "with a one-line purpose");
  assert.match(band, /role="tablist"/, "and the Waiting on you / History tabs in its nav row");
});

test("pending requests are divider rows of one list group, not a card per request", () => {
  const markup = renderLive(liveBase({ pending: [PENDING_CARD, { ...PENDING_HELD, agent: "Claude" }], history: [] }));
  assert.match(markup, /<h2[^>]*>Requests to decide<\/h2>\s*<span[^>]*>2<\/span>/, "one titled group with its count");
  const item = itemFor(markup, PENDING_HELD.id);
  assert.ok(item, "each request is a list row");
  assert.doesNotMatch(attr(item.attrs, "class") ?? "", /rounded-card|bg-surface\b|\bp-4\b/, "no card chrome on a row");
  assert.match(attr(item.attrs, "class") ?? "", /border-b/, "a divider row");
});

test("the agent's reason is labelled as its words, and a missing one says so", () => {
  const text = visibleText(render(base({ pending: [{ ...PENDING_HELD, reason: "" }], history: [] })));
  assert.match(text, /ChatGPT gave no reason/, "an empty reason reads as not given, never a blank line");
  const given = visibleText(render(base({ pending: [{ ...PENDING_HELD, reason: "Following up Tuesday" }], history: [] })));
  assert.match(given, /ChatGPT says “Following up Tuesday”/, "the reason is the agent's own words, named as such");
  assert.doesNotMatch(text, /\bWhy\b/, "the old 'Why' label is gone");
});

test("the full message under Details keeps its line breaks, as it will be sent", () => {
  const markup = render(base({ pending: [{ ...PENDING_HELD, extras: [{ label: "Full message", value: "Hi Priya,\n\nThe receipts are attached.\n\nSam" }] }], history: [] }));
  const value = findAll(markup, "dd").find((dd) => decode(dd.inner).includes("The receipts are attached."));
  assert.ok(value, "the message is shown under Details");
  assert.match(attr(value!.attrs, "class") ?? "", /\bwhitespace-pre-line\b/);
  assert.match(decode(value!.inner), /Hi Priya,\n\nThe receipts are attached\.\n\nSam/);
});

test("an unavailable control stays reachable and is described by its reason (a11y-18)", () => {
  const dead = render(base({ pending: [PENDING_HELD], history: [], denyAction: undefined }));
  const deny = buttonsMatching(dead, DENY_RE)[0]!;
  assert.equal(attr(deny.attrs, "aria-disabled"), "true", "marked unavailable without leaving the Tab order");
  const reasonId = attr(deny.attrs, "aria-describedby");
  assert.ok(reasonId, "the reason is tied to the control");
  const reason = findAll(dead, "p").find((p) => attr(p.attrs, "id") === reasonId);
  assert.ok(reason && /Denying isn't available/.test(decode(reason.inner)), "and says why");
});

test("decision controls are guarded forms that say what they're doing", () => {
  const markup = render(base({ pending: [PENDING_HELD], history: [] }));
  const approve = buttonsMatching(markup, /^Approve\b/)[0]!;
  assert.equal(attr(approve.attrs, "type"), "submit");
  assert.doesNotMatch(approve.attrs, /\sdisabled=""|aria-disabled="true"/, "live before it is pressed");
  assert.equal(buttonsMatching(markup, /^Approve\b/).length, 1, "one primary decision per request");
});

test("an empty inbox says what will appear and offers the next step", () => {
  const fresh = visibleText(renderLive(liveBase({ pending: [], history: [], historySummary: undefined, hasAgents: false })));
  assert.match(fresh, /Nothing waiting for you/);
  assert.match(fresh, /Once you connect an agent/);
  const freshMarkup = renderLive(liveBase({ pending: [], history: [], historySummary: undefined, hasAgents: false }));
  assert.match(freshMarkup, /href="\/agents\/connect"[^>]*>Connect your first agent/, "a newcomer is pointed at connecting an agent");

  const connected = renderLive(liveBase({ pending: [], history: [], historySummary: undefined, hasAgents: true }));
  assert.match(visibleText(connected), /Nothing waiting for you When an agent asks to do something that needs your approval, you'll see it here\./, "the same words as Home");
  assert.match(connected, /href="\/rules"[^>]*>Choose what needs your approval/, "and a way to choose what needs approval");
});

test("an empty tab is a bounded empty state with a way to the other tab", () => {
  const noPending = renderLive(liveBase({ pending: [], historySummary: SUMMARY }));
  assert.match(noPending, /class="wh-card wh-empty[^"]*"[\s\S]*Nothing waiting for you/, "nothing waiting is a bounded empty state");
  assert.match(noPending, /href="\/inbox\?view=history"[^>]*>See past decisions/);
  const noHistory = renderLive(liveBase({ history: [], historySummary: { ...SUMMARY, total: 0, matching: 0, outcomes: [], agents: [], allOutcomesCount: 0, allAgentsCount: 0 } }));
  assert.match(visibleText(noHistory), /No decisions yet/);
  assert.doesNotMatch(noHistory, /Nothing decided yet/);
});

test("a decision notice sits straight under the heading band, in the tab that opens", () => {
  const markup = renderLive(liveBase({ notice: { tone: "info", text: "That approval link has expired or was already used." } }));
  const bandEnd = markup.indexOf("</header>");
  const noticeAt = markup.indexOf("That approval link has expired");
  const firstRequest = markup.indexOf("ferry fare");
  assert.ok(bandEnd < noticeAt && noticeAt < firstRequest, "after the band, before the requests");
  assert.equal(markup.split("That approval link has expired").length - 1, 1, "shown once, not once per tab");
});

test("each request and past decision shows the requesting agent's mark beside its name", () => {
  // A known agent shows its own brand mark (resolved from its platform, else its name);
  // an agent without a known brand shows a neutral initial tile. Decorative: the name
  // beside it stays the accessible text.
  const markup = render(base({
    pending: [{ ...PENDING_CARD, agent: "Research helper", agentPlatform: "Claude Desktop" }],
    history: [{ id: "d-1", agent: "Helper", sentence: "asked to send a note", status: "approved", outcome: "Approved", decidedAt: "Today" }],
  }));
  assert.match(markup, /<span aria-hidden="true" data-size="xs" class="wh-brand-tile" data-brand="[^"]*"><img src="\/brands\/agent-claude\.svg" alt=""/, "a Claude agent shows Claude's mark from its platform");
  assert.match(markup, /<span aria-hidden="true" data-size="xs" class="wh-brand-tile wh-brand-initial">H<\/span>/, "an unbranded agent shows its initial");
  const text = visibleText(markup);
  assert.ok(text.includes("Research helper"), "the agent's name is still the visible text");
});
