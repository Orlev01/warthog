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

import { InboxView, createReleaseFlow } from "./inbox-view";

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
  // the device flow instead (see createReleaseFlow).
  approveAction?: (formData: FormData) => void | Promise<void>;
  denyAction?: (formData: FormData) => void | Promise<void>;
  moreDetailAction?: (formData: FormData) => void | Promise<void>;
  // The person's saved cards, offered in a card release's picker.
  savedCards?: readonly SavedCardView[];
  // Runs the device unlock-decrypt-and-release for a card/high-tier request (the client
  // binding gathers the chosen card + entered code from the release form and drives
  // createReleaseFlow). Present so the release control is live.
  onRelease?: (request: PendingRequestView) => void | Promise<void>;
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
  outcome: "Turned down",
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
// A stand-in client release trigger (what makes the release control live).
const noopRelease = async (_request: PendingRequestView): Promise<void> => {};

// A fully-populated inbox: pending newest-first (the order the loader hands in), a full
// history, saved cards, and every action/release trigger wired (the page's live wiring).
// Each test overrides exactly the slice it probes.
function base(overrides: Partial<InboxViewProps> = {}): InboxViewProps {
  return {
    pending: [PENDING_CARD, PENDING_HELD, PENDING_HIGH],
    history: [HIST_APPROVED, HIST_DENIED, HIST_EXPIRED, HIST_MORE_DETAIL],
    approveAction: noopAction,
    denyAction: noopAction,
    moreDetailAction: noopAction,
    savedCards: SAVED_CARDS,
    onRelease: noopRelease,
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

function isDisabled(el: El): boolean {
  return /\bdisabled\b/i.test(el.attrs);
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

test("renders pending approvals in the order given — newest at the top", () => {
  // The loader hands pending newest-first; the view must preserve that order (never
  // reverse it). Markers: ferry (newest) → mailing → passport (oldest). History is
  // emptied so only the pending markers can appear.
  const text = visibleText(render(base({ history: [] })));
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
  // ("Approved", "Turned down", "You asked for more") are plain text, not controls.
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
