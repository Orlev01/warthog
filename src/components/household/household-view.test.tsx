// E15-S13 — Household view component (src/components/household/household-view.tsx).
//
// RED-first: src/components/household/household-view.tsx does NOT exist yet, so importing
// `./household-view` throws at module load and every test here fails (ERR_MODULE_NOT_FOUND)
// until the builder writes the minimum component to pass. (The project's `tsc --noEmit`
// EXCLUDES `*.test.tsx`, so the missing module reddens `npm test`, not the typecheck gate.)
// That absence IS the point of test-first — do NOT implement anything to make these pass; the
// builder writes household-view.tsx afterwards.
//
// WHY this component exists (brief "Household sharing"; design §4.1 / §8). The Household
// screen must let an OWNER manage members, the shared monthly household budget, each member's
// monthly limit, the household currency and the shared address, and let ANY member edit the
// shared address and choose "use the household address" — while NEVER exposing another
// member's private data and NEVER leaving a dead control. Concretely (brief lines 390-402):
//   - the owner invites members by email, sets the shared household budget and a per-member
//     limit (both in the household currency the owner sets), sets the household currency,
//     removes a member, transfers ownership (the new owner must accept) and closes the
//     household;
//   - any member edits the one shared address and chooses "use the household address" (their
//     vault postal address then follows the shared one) or keeps their own;
//   - a non-owner member can leave;
//   - every member sees the member list and the household budget total — TOTALS ONLY, never
//     another member's merchants or individual entries.
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app). The real
// plumbing — persisting a budget/limit/currency/address change, issuing an invite, removing a
// member, transferring ownership, closing the household, following the shared address — is
// wired by a LATER task (the page + its sibling actions module); THIS component renders the
// screen entirely from its props (the `HouseholdPageData` the already-built list-all read
// hands back, plus the caller's `currentUserId` and the server actions the page binds) so a
// render test pins each behaviour without a browser, a session or any server plumbing. The
// bound controls are native forms whose `action` is a server action the page passes — exactly
// the seam the sibling agent-list / activity / rules views set.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given (the roster
// it shows, which controls are LIVE for the owner vs a non-owner, the pre-filled address, the
// reflected follow choice, the budget total with its currency) — never the source text of
// household-view.tsx. A later behaviour-preserving refactor (different wrapper elements,
// reworded-but-still-plain copy, radios vs a <select>, extra classes, a different icon) stays
// green. Absence checks are scoped to the exact unit under test (an owner-only control is
// asserted NOT LIVE for a non-owner — absent or disabled — never "this string appears nowhere
// in the whole output"). We render with `react-dom/server` and read the emitted markup, as the
// sibling component tests do (React component / E2E testing is a per-job ADR).
//
// Colour comes from the design tokens (globals.css) — never a raw hex.
//
// ---------------------------------------------------------------------------
// THE CONTRACT the builder implements (test-first spec; the component conforms to it). The
// prop shapes mirror the already-built list-all read (`HouseholdPageData`, E15-S12) but are
// declared LOCALLY so the component test never couples to the server db modules. Extra
// OPTIONAL props are fine as long as these render calls work.
//
//   HouseholdView({ household, currentUserId, currencyOptions?, ...actions? }):
//     • household       — the member-scoped, shared-items-only report the page read returns:
//                         { householdId, ownerId, currency, monthlyBudget, members[{userId,
//                         role}], sharedAddress, followChoice, ownLimit, pendingTransfer,
//                         pendingInvites }. A bare roster (userId + role) — the read strips
//                         every other member's private figure, so there is none to render.
//     • currentUserId   — the SESSION's user id (never a client value). The caller is the
//                         owner iff currentUserId === household.ownerId; the owner-only
//                         controls key off this.
//     • currencyOptions — the selectable household currencies (ISO 4217 codes) the owner's
//                         currency control offers.
//     • <actions>       — the server actions the page binds (invite / edit-address /
//                         follow-choice / budget / limit / currency / remove-member / leave /
//                         transfer / close). OPTIONAL so the view renders without a session; a
//                         control with no bound action renders disabled with a reason (no dead
//                         control), so these tests PASS the actions to exercise the live path.
//
// Behaviours asserted below:
//   - the member list renders an entry for every member (each identified by its userId — the
//     one stable per-member datum the read provides — or "you" for the caller), marking the
//     owner.
//   - the shared-address editor is a LIVE control pre-filled with the current shared address,
//     for the owner AND a non-owner member; a household with no shared address still renders a
//     live editor (no null placeholder).
//   - the "use the household address" follow choice renders for every member and reflects the
//     caller's current choice (checked/selected iff household.followChoice).
//   - the invite control is the OWNER's alone; the leave control is a non-owner member's alone.
//   - the household-budget, per-member-limit, household-currency, remove-member,
//     transfer-ownership and close-household controls are the OWNER's alone — a non-owner gets
//     none of them LIVE (absent, or disabled with a stated reason).
//   - the household budget TOTAL is shown with its currency, and the roster carries no other
//     member's money figure (totals only — no merchants or entries).
//   - owner management controls are bound to their server actions (no dead control); no raw
//     hex colour anywhere.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { HouseholdView } from "./household-view";

// --- the prop shapes this task renders (the contract; declared locally) ------------

type HouseholdRole = "owner" | "member";

type HouseholdMemberView = {
  userId: string;
  role: HouseholdRole;
};

type SharedAddress = {
  householdId: string;
  current: string;
  upcoming: string | null;
  movingOn: Date | string | null;
};

type PendingTransferView = {
  toUserId: string;
};

type PendingInvite = {
  email: string;
  expiresAt: Date | string;
};

type HouseholdPageData = {
  householdId: string;
  ownerId: string;
  currency: string;
  monthlyBudget: number | null;
  members: HouseholdMemberView[];
  sharedAddress: SharedAddress | null;
  followChoice: boolean;
  ownLimit: number | null;
  pendingTransfer: PendingTransferView | null;
  pendingInvites: PendingInvite[];
};

type FormAction = (formData: FormData) => void | Promise<void>;

type HouseholdViewProps = {
  household: HouseholdPageData;
  currentUserId: string;
  currencyOptions?: readonly string[];
  inviteAction?: FormAction;
  editAddressAction?: FormAction;
  followChoiceAction?: FormAction;
  budgetAction?: FormAction;
  limitAction?: FormAction;
  currencyAction?: FormAction;
  removeMemberAction?: FormAction;
  leaveAction?: FormAction;
  transferAction?: FormAction;
  closeAction?: FormAction;
};

// --- fixtures ---------------------------------------------------------------------
//
// userIds are deliberately word-and-digit-free of role words ("owner"/"member") and of digits,
// so (a) marking the owner "Owner" is a real badge, not the substring of an id, and (b) a
// "money figure beside this member" check is never fooled by a digit inside an id.
//
// Distinctive, non-colliding money figures so every "this figure is shown" assertion is honest:
//   household budget 842, the caller's own limit 173 — neither a substring of the other, of a
//   date, or of a currency code.

const OWNER_ID = "uid-alpha";
const PARTNER_ID = "uid-bravo";
const KID_ID = "uid-charlie";

const MEMBERS: HouseholdMemberView[] = [
  { userId: OWNER_ID, role: "owner" },
  { userId: PARTNER_ID, role: "member" },
  { userId: KID_ID, role: "member" },
];

const CURRENT_ADDRESS = "12 Wallaby Way, Sydney";
const UPCOMING_ADDRESS = "99 Platypus Pde, Hobart";

const SHARED_ADDRESS: SharedAddress = {
  householdId: "hh-1",
  current: CURRENT_ADDRESS,
  upcoming: UPCOMING_ADDRESS,
  movingOn: "2026-12-24",
};

const PENDING_INVITE_EMAIL = "newmember@example.com";
const PENDING_INVITES: PendingInvite[] = [{ email: PENDING_INVITE_EMAIL, expiresAt: "2026-11-14" }];

const CURRENCY = "AUD";
// AUD is deliberately NOT the first option, so the currency control must EXPLICITLY mark it
// selected (not merely rely on the browser's default-first-option behaviour).
const CURRENCY_OPTIONS = ["USD", "AUD", "EUR", "GBP"] as const;

const HOUSEHOLD_BUDGET = 842;
const OWN_LIMIT = 173;

const NOOP: FormAction = async (_formData: FormData): Promise<void> => {};

function baseData(overrides: Partial<HouseholdPageData> = {}): HouseholdPageData {
  return {
    householdId: "hh-1",
    ownerId: OWNER_ID,
    currency: CURRENCY,
    monthlyBudget: HOUSEHOLD_BUDGET,
    members: MEMBERS,
    sharedAddress: SHARED_ADDRESS,
    followChoice: false,
    ownLimit: OWN_LIMIT,
    pendingTransfer: null,
    pendingInvites: PENDING_INVITES,
    ...overrides,
  };
}

// Every action bound, so controls that a role is allowed to use render LIVE (not disabled over
// a missing action). The role gate — owner vs non-owner — is what these tests probe, not the
// presence of an action.
function props(currentUserId: string, dataOverrides: Partial<HouseholdPageData> = {}): HouseholdViewProps {
  return {
    household: baseData(dataOverrides),
    currentUserId,
    currencyOptions: CURRENCY_OPTIONS,
    inviteAction: NOOP,
    editAddressAction: NOOP,
    followChoiceAction: NOOP,
    budgetAction: NOOP,
    limitAction: NOOP,
    currencyAction: NOOP,
    removeMemberAction: NOOP,
    leaveAction: NOOP,
    transferAction: NOOP,
    closeAction: NOOP,
  };
}

function render(p: HouseholdViewProps): string {
  return renderToStaticMarkup(<HouseholdView {...p} />);
}

function renderOwner(dataOverrides: Partial<HouseholdPageData> = {}): string {
  return render(props(OWNER_ID, dataOverrides));
}

function renderMember(dataOverrides: Partial<HouseholdPageData> = {}): string {
  return render(props(PARTNER_ID, dataOverrides));
}

// --- markup helpers (no DOM), mirrored from the sibling component tests -----------

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

// Visible text of an HTML fragment: the words a sighted reader sees, tags stripped and entities
// decoded. <script>/<style> BLOCKS are dropped WHOLE first: React encodes a bound server-action
// form as `action="javascript:throw new Error('React form unexpectedly submitted.')"` plus a
// progressive-enhancement <script> whose JS text ("null!=f", …) is NOT visible copy and must
// never leak into a visible-text / no-"null" assertion.
function visibleText(markup: string): string {
  const withoutScripts = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return decode(withoutScripts.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

// A boolean/valueless attribute present as its own token — ` disabled`, ` disabled=""`,
// ` checked`, ` selected="selected"` — but never the word inside another attribute's value.
function hasBoolAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}

// id → the visible text of the <label for=id> that targets it.
function labelTextById(markup: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const l of findAll(markup, "label")) {
    const f = attr(l.attrs, "for");
    if (f) map[f] = visibleText(l.inner);
  }
  return map;
}

// The accessible name of a control: its visible text PLUS any aria-label / title that voices it
// (so an icon-only control named by aria-label still counts).
function controlFace(el: El): string {
  const parts = [visibleText(el.inner)];
  const al = attr(el.attrs, "aria-label");
  if (al) parts.push(decode(al));
  const ti = attr(el.attrs, "title");
  if (ti) parts.push(decode(ti));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function inputAttrs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) out.push(m[1]!);
  return out;
}

// Names of every actionable (not-disabled) control: a live <button>, a non-disabled
// checkbox/radio input (by label / aria-label / value), a wrapping-label input, or an <option>.
// Reads RENDERED, LIVE affordances — never dead static text.
function selectableNames(markup: string): string[] {
  const labels = labelTextById(markup);
  const out: string[] = [];
  for (const b of findAll(markup, "button")) {
    if (hasBoolAttr(b.attrs, "disabled")) continue;
    out.push(controlFace(b));
  }
  for (const a of inputAttrs(markup)) {
    if (hasBoolAttr(a, "disabled")) continue;
    const id = attr(a, "id");
    out.push(((id && labels[id]) || attr(a, "aria-label") || attr(a, "value") || "").trim());
  }
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im || hasBoolAttr(im[1]!, "disabled")) continue;
    out.push(visibleText(l.inner));
  }
  for (const o of findAll(markup, "option")) out.push(visibleText(o.inner));
  return out.filter((n) => n.length > 0);
}

// Whether a form control (input / select / textarea) whose NAME matches `nameRe` is present and
// LIVE (not disabled) — the behaviour a FormData-reading server action depends on, pinned by the
// field's name rather than its element kind or label copy (a refactor may swap a <select> for
// radios, or reword a label, and stay green).
function liveNamedControl(markup: string, nameRe: RegExp): boolean {
  for (const m of markup.matchAll(/<(?:input|select|textarea)\b([^>]*)>/gi)) {
    const attrs = m[1]!;
    const name = attr(attrs, "name");
    if (!name || !nameRe.test(name)) continue;
    if (hasBoolAttr(attrs, "disabled")) continue;
    return true;
  }
  return false;
}

// The "say-why" surface: visible text PLUS every title / aria-label (an accessible reason — or a
// role badge — may ride on either).
function reasonSurface(markup: string): string {
  const parts = [visibleText(markup)];
  for (const m of markup.matchAll(/(?:title|aria-label)="([^"]*)"/gi)) parts.push(decode(m[1]!));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// --- form-scoped helpers (forms don't nest, so each <form>…</form> pairs with its own close) --

function formsForControl(markup: string, re: RegExp): El[] {
  return findAll(markup, "form").filter((f) => findAll(f.inner, "button").some((b) => re.test(controlFace(b))));
}

// React encodes a FUNCTION form action (a bound server action) as a `javascript:`
// progressive-enhancement placeholder in server-rendered markup; a bare form carries none. So
// "this form is bound to a server action" is observable as its action scheme — behaviour, not
// source text.
function isBoundToAction(form: El): boolean {
  const action = attr(form.attrs, "action");
  return action !== null && /^javascript:/i.test(action);
}

// Whether any field (hidden or otherwise) or <option> inside `form` carries the exact `value` —
// e.g. the member id the action consumes. Robust to the field's NAME, pinning only the behaviour
// that the form identifies WHICH member it targets.
function formTargetsValue(form: El, value: string): boolean {
  if (inputAttrs(form.inner).some((a) => attr(a, "value") === value)) return true;
  if (findAll(form.inner, "option").some((o) => attr(o.attrs, "value") === value)) return true;
  return false;
}

// --- currency-picker helpers (from spending-view.test) ----------------------------
//
// The selectable currency choices — from <option>s (a <select>) or radio inputs — each with its
// value and whether it is pre-selected.
type Choice = { value: string; selected: boolean };
function currencyChoices(markup: string): Choice[] {
  const out: Choice[] = [];
  for (const o of findAll(markup, "option")) {
    out.push({ value: attr(o.attrs, "value") ?? visibleText(o.inner), selected: hasBoolAttr(o.attrs, "selected") });
  }
  for (const a of inputAttrs(markup)) {
    if ((attr(a, "type") ?? "").toLowerCase() !== "radio") continue;
    out.push({ value: attr(a, "value") ?? "", selected: hasBoolAttr(a, "checked") });
  }
  return out;
}

// --- the "use the household address" follow-choice toggle -------------------------
//
// The binary follow choice may be a checkbox, a radio, or a <select> option. This finds the
// "use the household address" choice (never the "keep my own" one — only the former mentions
// "household address") and returns whether it is pre-selected and whether it is disabled.
function householdAddressChoice(markup: string): { selected: boolean; disabled: boolean } | null {
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im) continue;
    const a = im[1]!;
    const type = (attr(a, "type") ?? "").toLowerCase();
    if (type !== "checkbox" && type !== "radio") continue;
    if (/household address/i.test(visibleText(l.inner))) {
      return { selected: hasBoolAttr(a, "checked"), disabled: hasBoolAttr(a, "disabled") };
    }
  }
  const labels = labelTextById(markup);
  for (const a of inputAttrs(markup)) {
    const type = (attr(a, "type") ?? "").toLowerCase();
    if (type !== "checkbox" && type !== "radio") continue;
    const id = attr(a, "id");
    const text = (id && labels[id]) || attr(a, "aria-label") || "";
    if (/household address/i.test(text)) {
      return { selected: hasBoolAttr(a, "checked"), disabled: hasBoolAttr(a, "disabled") };
    }
  }
  for (const s of findAll(markup, "select")) {
    for (const o of findAll(s.inner, "option")) {
      if (/household address/i.test(visibleText(o.inner))) {
        return { selected: hasBoolAttr(o.attrs, "selected"), disabled: hasBoolAttr(s.attrs, "disabled") };
      }
    }
  }
  return null;
}

// A live editable control (text input or textarea) pre-filled with `value`.
function liveEntryHasValue(markup: string, value: string): boolean {
  for (const t of findAll(markup, "textarea")) {
    if (hasBoolAttr(t.attrs, "disabled")) continue;
    if (decode(t.inner).includes(value)) return true;
  }
  for (const a of inputAttrs(markup)) {
    if (hasBoolAttr(a, "disabled")) continue;
    if ((attr(a, "value") ?? "") === value) return true;
  }
  return false;
}

// A live free-text entry control exists at all (for the empty-address editor case).
function hasLiveTextEntry(markup: string): boolean {
  if (findAll(markup, "textarea").some((t) => !hasBoolAttr(t.attrs, "disabled"))) return true;
  for (const a of inputAttrs(markup)) {
    if (hasBoolAttr(a, "disabled")) continue;
    const type = (attr(a, "type") ?? "text").toLowerCase();
    if (type === "text" || type === "search" || type === "url" || type === "") return true;
  }
  return false;
}

// --- money matchers (from spending-view.test) -------------------------------------
function amountFrag(n: number): string {
  return Number.isInteger(n) ? `${n}(?:\\.00)?` : n.toFixed(2).replace(".", "\\.");
}
const CURRENCY_ALT: Record<string, string> = {
  AUD: "A\\$",
  USD: "US\\$|\\$US",
  NZD: "NZ\\$",
  EUR: "€",
  GBP: "£",
};
function currencyFrag(code: string): string {
  const alt = CURRENCY_ALT[code];
  return alt ? `(?:\\b${code}\\b|${alt})` : `\\b${code}\\b`;
}
// A money token that binds a currency DIRECTLY to its amount — the code/symbol immediately
// before or after the digits. A bare "$" is deliberately NOT accepted: in a multi-currency app
// it does not say which dollar. The amount is bounded so "173" is never matched inside "1730".
function moneyRe(amount: number, currency: string): RegExp {
  const a = `(?<![\\d.])${amountFrag(amount)}(?!\\d)`;
  const c = currencyFrag(currency);
  const sep = `[\\s().,·/|-]{0,3}`;
  return new RegExp(`(?:${c}${sep}${a})|(?:${a}${sep}${c})`);
}
// Every currency-bound money amount in `text` (the numeric part of each token that carries a
// currency code/symbol). Used to prove the screen shows ONLY household totals — no other
// member's individual figure. Layout-independent, so it does not break when a budget section
// simply follows the roster.
function moneyAmountsIn(text: string): number[] {
  const re =
    /(?:AUD|USD|EUR|GBP|NZD|A\$|US\$|\$US|NZ\$|€|£)[\s().,·/|-]{0,3}(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)[\s().,·/|-]{0,3}(?:AUD|USD|EUR|GBP|NZD|A\$|US\$|\$US|NZ\$|€|£)/gi;
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    const n = Number((m[1] ?? m[2] ?? "").replace(/,/g, ""));
    if (!Number.isNaN(n)) out.push(n);
  }
  return out;
}

// --- owner-only control detectors (each returns whether a LIVE such control exists) ------------
//
// Identify each owner-only control by the behaviour it must expose, generously over the plausible
// field name / button copy, so a refactor that renames a field or reworders a label stays green:
//   invite   — a live email field (name mentions email/invite, or an <input type=email>);
//   budget   — a live control whose name contains "budget";
//   limit    — a live control whose name contains "limit";
//   currency — a live control whose name contains "currenc";
//   remove   — a live "Remove…" control whose form targets a specific member id (never the
//              address editor's "remove upcoming address", which targets no member);
//   transfer — a live "Transfer…" control;
//   close    — a live "Close…household" control.

function inviteLive(markup: string): boolean {
  for (const a of inputAttrs(markup)) {
    if (hasBoolAttr(a, "disabled")) continue;
    const name = attr(a, "name") ?? "";
    const type = (attr(a, "type") ?? "").toLowerCase();
    if (/email|invite/i.test(name) || type === "email") return true;
  }
  return false;
}
function budgetLive(markup: string): boolean {
  return liveNamedControl(markup, /budget/i);
}
function limitLive(markup: string): boolean {
  return liveNamedControl(markup, /limit/i);
}
function currencyLive(markup: string): boolean {
  return liveNamedControl(markup, /currenc/i);
}
function removeMemberForms(markup: string): El[] {
  return formsForControl(markup, /remove/i).filter((f) =>
    [OWNER_ID, PARTNER_ID, KID_ID].some((id) => formTargetsValue(f, id)),
  );
}
function removeLive(markup: string): boolean {
  return removeMemberForms(markup).some((f) => !hasBoolAttr(f.attrs, "disabled"));
}
function transferLive(markup: string): boolean {
  return selectableNames(markup).some((n) => /transfer/i.test(n));
}
function closeLive(markup: string): boolean {
  return selectableNames(markup).some((n) => /close/i.test(n) && /household/i.test(n));
}
function leaveLive(markup: string): boolean {
  return selectableNames(markup).some((n) => /leave/i.test(n) && /household/i.test(n));
}

const OWNER_ONLY: Array<{ label: string; live: (m: string) => boolean }> = [
  { label: "invite", live: inviteLive },
  { label: "household budget", live: budgetLive },
  { label: "per-member limit", live: limitLive },
  { label: "household currency", live: currencyLive },
  { label: "remove member", live: removeLive },
  { label: "transfer ownership", live: transferLive },
  { label: "close household", live: closeLive },
];

// ================================================================================
// AC1 — the member list: an entry for every member, marking the owner.
// ================================================================================

test("renders an entry for every member and marks the owner", () => {
  // Rendered to a NON-owner (the caller is PARTNER): a non-owner has no member-targeting owner
  // controls, so a member id appearing in the markup can only come from the roster display — not
  // from a hidden form field. The one member who is neither the owner nor the caller (KID) can be
  // identified ONLY by its id, so its id must render; the owner is marked "Owner" (or carries an
  // owner badge voiced by aria-label); the caller may read by id or "you".
  const markup = renderMember();

  assert.ok(
    markup.includes(KID_ID),
    `every member must appear in the roster — the non-owner, non-caller member (${KID_ID}) is ` +
      `identifiable only by its id; markup=${markup}`,
  );
  assert.ok(
    markup.includes(OWNER_ID) || /\bowner\b/i.test(reasonSurface(markup)),
    `the owner must be shown in the roster (by id or an "Owner" marker); surface="${reasonSurface(markup)}"`,
  );
  assert.ok(
    markup.includes(PARTNER_ID) || /\byou\b/i.test(visibleText(markup)),
    `the caller must be identified in the roster (by id or "you"); text="${visibleText(markup)}"`,
  );
  assert.ok(
    /\bowner\b/i.test(reasonSurface(markup)),
    `the owner must be MARKED as the owner; surface="${reasonSurface(markup)}"`,
  );
});

test("renders from the members given, not a fixed roster", () => {
  // A two-person household: only the owner + one member render; the absent fixture ids do not.
  const markup = render(
    props(OWNER_ID, {
      members: [
        { userId: OWNER_ID, role: "owner" },
        { userId: PARTNER_ID, role: "member" },
      ],
    }),
  );
  assert.ok(
    markup.includes(PARTNER_ID),
    `the one other member (${PARTNER_ID}) must render; markup=${markup}`,
  );
  assert.ok(
    !markup.includes(KID_ID),
    `a member not in the household (${KID_ID}) must not be invented; markup=${markup}`,
  );
});

// ================================================================================
// AC1 — the shared-address editor: a live control for the owner AND any member, pre-filled.
// ================================================================================

test("renders a live shared-address editor pre-filled with the current shared address — for the owner and a non-owner member", () => {
  for (const [who, markup] of [["owner", renderOwner()], ["member", renderMember()]] as const) {
    assert.ok(
      markup.includes(CURRENT_ADDRESS),
      `the current shared address must be shown to the ${who}; markup=${markup}`,
    );
    assert.ok(
      liveEntryHasValue(markup, CURRENT_ADDRESS),
      `the ${who} must get a LIVE editor pre-filled with the current shared address (any member may edit it); markup=${markup}`,
    );
  }
});

test("a household with no shared address still renders a live address editor, without a null placeholder", () => {
  const markup = renderMember({ sharedAddress: null });
  assert.ok(
    hasLiveTextEntry(markup),
    `the address editor must render (empty, live) even when no shared address is set yet; markup=${markup}`,
  );
  assert.ok(
    !/\b(null|undefined|NaN)\b/i.test(visibleText(markup)),
    `an unset shared address must render as an empty editor, never "null"; text="${visibleText(markup)}"`,
  );
});

// ================================================================================
// AC1 — the "use the household address" follow choice: for every member, reflecting the caller's
// current choice.
// ================================================================================

test("renders the 'use the household address' follow choice for every member", () => {
  for (const [who, markup] of [["owner", renderOwner()], ["member", renderMember()]] as const) {
    const choice = householdAddressChoice(markup);
    assert.ok(
      choice !== null,
      `the ${who} must get a "use the household address" follow choice; markup=${markup}`,
    );
    assert.ok(
      !(choice as { disabled: boolean }).disabled,
      `the ${who}'s follow choice must be LIVE (every member sets their own); markup=${markup}`,
    );
  }
});

test("the follow choice reflects the caller's current choice", () => {
  const on = householdAddressChoice(renderMember({ followChoice: true }));
  assert.ok(on !== null && on.selected === true, `followChoice=true must render the choice SELECTED; got ${JSON.stringify(on)}`);

  const off = householdAddressChoice(renderMember({ followChoice: false }));
  assert.ok(
    off !== null && off.selected === false,
    `followChoice=false must render the "use the household address" choice UNSELECTED; got ${JSON.stringify(off)}`,
  );
});

// ================================================================================
// AC2 — the invite control is the owner's alone; the leave control is a non-owner member's alone.
// ================================================================================

test("offers an invite control to the owner alone", () => {
  assert.ok(inviteLive(renderOwner()), `the owner must get a live invite control (invite a member by email)`);
  const member = renderMember();
  assert.ok(
    !inviteLive(member) && !selectableNames(member).some((n) => /\binvite\b/i.test(n)),
    `a non-owner must not get a live invite control; controls=${JSON.stringify(selectableNames(member))}`,
  );
});

test("offers a leave control to a non-owner member, never to the owner", () => {
  assert.ok(leaveLive(renderMember()), `a non-owner member must get a live Leave control`);
  assert.ok(!leaveLive(renderOwner()), `the owner must NOT get a Leave control (the owner transfers or closes instead)`);
});

test("the leave control is bound to its server action (no dead control)", () => {
  const forms = formsForControl(renderMember(), /leave/i);
  assert.ok(
    forms.some((f) => isBoundToAction(f)),
    `the non-owner member's Leave control must submit to a bound server action, not sit dead`,
  );
});

// ================================================================================
// AC1 — each of budget / per-member-limit / currency / remove / transfer / close is the OWNER's
// alone: live for the owner, NOT live for a non-owner (absent or disabled).
// ================================================================================

test("the household-budget control belongs to the owner alone", () => {
  const owner = renderOwner();
  assert.ok(budgetLive(owner), `the owner must get a live household-budget control`);
  assert.ok(
    owner.includes(String(HOUSEHOLD_BUDGET)),
    `the owner's budget control must be pre-filled with the current household budget (${HOUSEHOLD_BUDGET}); markup=${owner}`,
  );
  assert.ok(!budgetLive(renderMember()), `a non-owner must not get a live household-budget control`);
});

test("the per-member-limit control belongs to the owner alone", () => {
  assert.ok(limitLive(renderOwner()), `the owner must get a live per-member-limit control`);
  assert.ok(!limitLive(renderMember()), `a non-owner must not get a live per-member-limit control`);
});

test("the household-currency control belongs to the owner alone, with the current currency selected", () => {
  const owner = renderOwner();
  assert.ok(currencyLive(owner), `the owner must get a live household-currency control`);

  const choices = currencyChoices(owner).filter((c) => (CURRENCY_OPTIONS as readonly string[]).includes(c.value));
  const values = new Set(choices.map((c) => c.value));
  for (const code of CURRENCY_OPTIONS) {
    assert.ok(values.has(code), `the currency control must offer ${code}; choices=${JSON.stringify(choices)}`);
  }
  const selected = choices.filter((c) => c.selected).map((c) => c.value);
  assert.deepEqual(
    selected,
    [CURRENCY],
    `only the current household currency (${CURRENCY}) must be pre-selected; selected=${JSON.stringify(selected)}`,
  );

  assert.ok(!currencyLive(renderMember()), `a non-owner must not get a live household-currency control`);
});

test("the remove-member control belongs to the owner alone and targets a specific member", () => {
  const owner = renderOwner();
  assert.ok(removeLive(owner), `the owner must get a live remove-member control`);

  // The remove control identifies WHICH member it removes, and is bound to its action.
  const removeForms = removeMemberForms(owner);
  assert.ok(
    removeForms.some((f) => isBoundToAction(f) && (formTargetsValue(f, PARTNER_ID) || formTargetsValue(f, KID_ID))),
    `a remove-member control must submit a non-owner member's id to a bound server action; markup=${owner}`,
  );

  assert.ok(!removeLive(renderMember()), `a non-owner must not get a live remove-member control`);
});

test("the transfer-ownership control belongs to the owner alone", () => {
  assert.ok(transferLive(renderOwner()), `the owner must get a live transfer-ownership control`);
  assert.ok(!transferLive(renderMember()), `a non-owner must not get a live transfer-ownership control`);
});

test("the close-household control belongs to the owner alone", () => {
  assert.ok(closeLive(renderOwner()), `the owner must get a live close-household control`);
  assert.ok(!closeLive(renderMember()), `a non-owner must not get a live close-household control`);
});

// ================================================================================
// AC1 — the consolidated guarantee: a non-owner is left NO live owner-only control, and any
// owner-only control that IS shown to them is disabled with a stated reason (never a dead
// control). Both halves of "absent OR disabled with a stated reason" are honoured.
// ================================================================================

test("a non-owner gets no live owner-only control, and any shown owner-only control is disabled with a reason", () => {
  const markup = renderMember();

  for (const ctrl of OWNER_ONLY) {
    assert.ok(
      !ctrl.live(markup),
      `a non-owner must not get a LIVE ${ctrl.label} control (it is the owner's alone); ` +
        `controls=${JSON.stringify(selectableNames(markup))}`,
    );
  }

  // If the view SHOWS any owner-only control to the non-owner (disabled) rather than omitting it,
  // it must say WHY — the reason surface names the owner (constitution: no dead controls — disable
  // and say why). When the view instead OMITS them, there is nothing to explain and this is moot.
  const verb = /invite|budget|limit|currency|remove|transfer|close/i;
  const disabledButton = findAll(markup, "button").some(
    (b) => hasBoolAttr(b.attrs, "disabled") && verb.test(controlFace(b)),
  );
  const disabledField = [...markup.matchAll(/<(?:input|select|textarea)\b([^>]*)>/gi)].some((m) => {
    const attrs = m[1]!;
    const name = attr(attrs, "name") ?? "";
    return /budget|limit|currenc|email/i.test(name) && hasBoolAttr(attrs, "disabled");
  });
  if (disabledButton || disabledField) {
    assert.ok(
      /owner/i.test(reasonSurface(markup)),
      `a disabled owner-only control shown to a non-owner must state the reason (that only the owner ` +
        `manages it); surface="${reasonSurface(markup)}"`,
    );
  }
});

// ================================================================================
// AC2 — the household budget TOTAL is shown with its currency, and the roster carries no other
// member's money figure (totals only — never another member's merchants or entries).
// ================================================================================

test("shows the household budget total with its currency", () => {
  // A member sees the shared household budget total (brief: members see household budget totals),
  // shown WITH the household currency — a multi-currency app never leaves a bare figure.
  const markup = renderMember();
  const text = visibleText(markup);
  assert.ok(text.includes(String(HOUSEHOLD_BUDGET)), `the household budget total must be shown; text="${text}"`);
  assert.ok(
    moneyRe(HOUSEHOLD_BUDGET, CURRENCY).test(text),
    `the household budget total (${HOUSEHOLD_BUDGET}) must carry its currency (${CURRENCY}) on the figure; text="${text}"`,
  );
});

test("shows household totals only — no other member's individual figure (no merchants or entries)", () => {
  // The page-data read is a bare roster (userId + role): it exposes NO per-member spend, limit or
  // merchant for anyone but the caller. So the ONLY money figures the screen may show are the
  // shared household budget total and (at most) the caller's own limit — never another member's
  // individual figure. Confirm every currency-bound figure rendered is one of those two.
  const amounts = moneyAmountsIn(visibleText(renderMember()));
  for (const amount of amounts) {
    assert.ok(
      amount === HOUSEHOLD_BUDGET || amount === OWN_LIMIT,
      `every money figure must be a household total or the caller's own limit (${HOUSEHOLD_BUDGET} / ${OWN_LIMIT}) ` +
        `— never another member's figure; saw ${amount} among ${JSON.stringify(amounts)}`,
    );
  }
});

// ================================================================================
// Robustness — unset shared items render without a null/undefined/NaN placeholder.
// ================================================================================

test("unset shared items render without printing null/undefined/NaN (owner and member)", () => {
  const empties: Partial<HouseholdPageData> = {
    sharedAddress: null,
    monthlyBudget: null,
    ownLimit: null,
    followChoice: false,
    pendingInvites: [],
    pendingTransfer: null,
  };
  for (const markup of [renderOwner(empties), renderMember(empties)]) {
    const text = visibleText(markup);
    assert.ok(
      !/\b(null|undefined|NaN)\b/i.test(text),
      `an unset budget / limit / address must render as plain copy, never null/undefined/NaN; text="${text}"`,
    );
  }
});

// ================================================================================
// Design system — colour comes from tokens, never a raw hex literal.
// ================================================================================

test("uses design tokens, never a raw hex colour", () => {
  const variants = [
    renderOwner(),
    renderMember(),
    renderMember({ followChoice: true }),
    renderOwner({ sharedAddress: null, monthlyBudget: null, ownLimit: null, pendingInvites: [], pendingTransfer: null }),
  ];
  for (const markup of variants) {
    // Strip the progressive-enhancement <script> React injects for bound forms before checking.
    const noScript = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(noScript),
      `no raw hex colour may appear in the household-view markup, got: ${noScript}`,
    );
  }
});

// Operator fix (E15-S13 review veto): an action the page has not bound must never render a live
// control that submits nowhere (a bare browser GET would dump the shared address into the URL).
// Every unbound control renders disabled, inside no <form>, with a one-line reason.
test("with no actions bound, no live form is rendered: every control is disabled with a reason", () => {
  const unbound: HouseholdViewProps = { household: baseData(), currentUserId: OWNER_ID, currencyOptions: CURRENCY_OPTIONS };
  const ownerMarkup = render(unbound);
  const memberMarkup = render({ ...unbound, currentUserId: PARTNER_ID });
  for (const [who, markup] of [["owner", ownerMarkup], ["member", memberMarkup]] as const) {
    assert.equal((markup.match(/<form\b/g) ?? []).length, 0, `${who}: no <form> without a bound action`);
    const fieldsets = (markup.match(/<fieldset\b[^>]*\bdisabled\b/g) ?? []).length;
    assert.ok(fieldsets > 0, `${who}: unbound controls sit in a disabled fieldset`);
    const reasons = (decode(markup).match(/isn't available just now/g) ?? []).length;
    assert.equal(reasons, fieldsets, `${who}: every disabled control group states why`);
  }
});

test("a bound action still renders its live form", () => {
  const markup = render({ household: baseData(), currentUserId: OWNER_ID, currencyOptions: CURRENCY_OPTIONS, inviteAction: NOOP });
  assert.equal((markup.match(/<form\b/g) ?? []).length, 1, "exactly the one bound action renders a form");
});
