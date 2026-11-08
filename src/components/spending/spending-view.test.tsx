// E15-S10 — Spending view component (src/components/spending/spending-view.tsx).
//
// RED-first: src/components/spending/spending-view.tsx does NOT exist yet, so importing
// `./spending-view` throws and every test here fails (and `tsc --noEmit` reddens on the
// missing module) until the builder writes the minimum component to pass. That absence IS
// the entire point of test-first — do NOT implement anything to make these pass; the builder
// writes spending-view.tsx afterwards.
//
// WHY this component exists (brief "Spending view" + "Household sharing"; design §8 step 4 /
// §9; constitution principle 14 "Warthog … labels agent-submitted summaries as reported by
// that agent, never treats an agent report as the source of truth"). The Spending screen must
// show, DISTINCTLY:
//   - the person's OWN agents' spending in detail: per agent, its card budget and the approved
//     card releases this period (merchant + the APPROVED amount — the only amount counted),
//     and any amount the agent later REPORTED for a release, surfaced ONLY with its label
//     "Reported by <agent>" (never counted);
//   - the HOUSEHOLD totals section: per-member total against that member's limit plus the
//     household total against the shared budget — and NEVER another member's merchants or
//     individual release entries;
//   - an account-currency selector so the person can set their account currency;
//   - every money figure WITH its currency (a multi-currency app: a bare "$" does not say
//     which dollar, so an amount is shown with its ISO code or an unambiguous symbol).
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app). The real
// plumbing — persisting the chosen account currency, following a release's activity link — is
// wired by a later task / sibling modules. Like the sibling cards / identity / rules / consent
// views, the view renders ENTIRELY from its props, so a render test pins each behaviour
// without a DOM or clicking anything (React component / E2E testing is a per-job ADR). We
// render with `react-dom/server` and read the emitted markup, exactly as the sibling
// component tests do.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given — never the
// source text of spending-view.tsx. A behaviour-preserving refactor (different wrapper
// elements, reworded-but-still-plain copy, extra classes, a different icon, a <select> vs a
// radio group for the currency picker) stays green. Absence checks are scoped to the exact
// unit under test: "no other member's merchant/entry" is asserted INSIDE the household
// section only (the same merchant string legitimately appears in the OWN section elsewhere in
// the output).
//
// Colour comes from the design tokens (globals.css) — never a raw hex.
//
// ---------------------------------------------------------------------------
// THE CONTRACT the builder implements (test-first spec; the component conforms to it). The
// prop shapes mirror the already-built reads (own-read `OwnSpending`, household-read
// `HouseholdSpendingReport`) but are declared LOCALLY so the component test never couples to
// the server db modules. Extra OPTIONAL props are fine as long as these render calls work.
//
//   SpendingView({ own, household, accountCurrency, currencyOptions }):
//     • own              — the person's own agents' spending detail ({ agents: [...] }). Each
//                          agent renders its card budget and its approved releases this period:
//                          per release the MERCHANT + the APPROVED amount (with currency), and,
//                          when the agent reported an amount for that release, a "Reported by
//                          <agent>" label carrying the reported amount (never the counted one).
//     • household        — the household totals report, or null when the person is in no
//                          household. Renders a DISTINCT household section: per member a total
//                          against that member's limit, plus the household total against the
//                          shared budget — TOTALS ONLY, never a merchant or a release entry.
//     • accountCurrency  — the person's current account currency (an ISO 4217 code). The
//                          account-currency selector shows this as the selected choice.
//     • currencyOptions  — the selectable account currencies (ISO 4217 codes) offered by the
//                          account-currency selector.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SpendingView } from "./spending-view";

// --- the prop shapes this task renders (the contract; declared locally) ------------

type PeriodKind = "day" | "week" | "month";

type CardBudget = {
  amount: number;
  currency: string;
  period: PeriodKind;
};

type OwnRelease = {
  id: string;
  merchant: string;
  amount: number | string;
  currency: string;
  reportedAmount: number | string | null;
  activityLink: string;
};

type OwnAgent = {
  agentId: string;
  displayName: string;
  budget: CardBudget | null;
  approvedTotal: number | string;
  releases: OwnRelease[];
};

type OwnSpending = {
  agents: OwnAgent[];
};

type HouseholdMember = {
  userId: string;
  monthlyLimit: number | null;
  spendToDate: number;
};

type HouseholdReport = {
  householdId: string;
  currency: string;
  monthlyBudget: number | null;
  budgetSpendToDate: number;
  members: HouseholdMember[];
};

type SpendingViewProps = {
  own: OwnSpending;
  household: HouseholdReport | null;
  accountCurrency: string;
  currencyOptions: readonly string[];
};

// --- fixtures ---------------------------------------------------------------------
//
// Distinctive, non-colliding amounts so every "this figure is shown" assertion is honest —
// a number can only be the figure under test. No trailing-zero decimals (a naive `${40.1}`
// would drop a trailing zero), and the integers are matched with an optional ".00".
//
//   own:   budget 300, approvedTotal 65.63, release amounts 40.17 / 25.53, reported 42.89
//   house: budget 500, total 137.84 (= 90.27 + 47.57), limits 250 / 150

const OWNER = "user-abc";
const OTHER_MEMBER = "user-xyz";

const AGENT_SHOP: OwnAgent = {
  agentId: "agent-shop",
  displayName: "Shopping Assistant",
  budget: { amount: 300, currency: "AUD", period: "month" },
  approvedTotal: 65.63,
  releases: [
    {
      // An AUD release the agent later REPORTED a (higher) amount for.
      id: "rel-1",
      merchant: "Bunnings Warehouse",
      amount: 40.17,
      currency: "AUD",
      reportedAmount: 42.89,
      activityLink: "/activity?release=rel-1",
    },
    {
      // A USD release with NO reported amount — proves per-release currency and that a
      // null reported amount shows no "Reported by" label.
      id: "rel-2",
      merchant: "Jetstar Airways",
      amount: 25.53,
      currency: "USD",
      reportedAmount: null,
      activityLink: "/activity?release=rel-2",
    },
  ],
};

// An agent with no card budget and no releases — must render without inventing a budget
// figure or a release, and without crashing on the null budget.
const AGENT_MAIL: OwnAgent = {
  agentId: "agent-mail",
  displayName: "Mail Helper",
  budget: null,
  approvedTotal: 0,
  releases: [],
};

const HOUSEHOLD: HouseholdReport = {
  householdId: "hh-1",
  currency: "AUD",
  monthlyBudget: 500,
  budgetSpendToDate: 137.84,
  members: [
    { userId: OWNER, monthlyLimit: 250, spendToDate: 90.27 },
    { userId: OTHER_MEMBER, monthlyLimit: 150, spendToDate: 47.57 },
  ],
};

// accountCurrency is deliberately NOT the first option, so the component must EXPLICITLY mark
// it selected (not merely rely on the browser's default-first-option behaviour).
const ACCOUNT_CURRENCY = "AUD";
const CURRENCY_OPTIONS = ["USD", "AUD", "EUR", "GBP"] as const;

function base(overrides: Partial<SpendingViewProps> = {}): SpendingViewProps {
  return {
    own: { agents: [AGENT_SHOP, AGENT_MAIL] },
    household: HOUSEHOLD,
    accountCurrency: ACCOUNT_CURRENCY,
    currencyOptions: CURRENCY_OPTIONS,
    ...overrides,
  };
}

function render(props: SpendingViewProps): string {
  return renderToStaticMarkup(<SpendingView {...props} />);
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

// Visible text of an HTML fragment: the words a sighted reader sees, tags stripped and
// entities decoded (an attribute value like an href is NOT visible text — the tag is
// stripped whole).
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

// A boolean/valueless attribute present as its own token — ` selected`, ` selected=""` or
// ` selected="selected"` — but never the word inside another attribute's value.
function hasBoolAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}

function findAll(markup: string, tag: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1], inner: m[2] });
  }
  return out;
}

// Does `re` appear in the visible text within `window` chars either side of the first
// occurrence of `needle`? Proves two things are rendered TOGETHER without pinning the exact
// layout.
function nearInText(markup: string, needle: string, re: RegExp, window = 240): boolean {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return false;
  const lo = Math.max(0, i - window);
  const hi = Math.min(vt.length, i + needle.length + window);
  return re.test(vt.slice(lo, hi));
}

// --- money / currency matchers ----------------------------------------------------
//
// A money amount, tolerant of formatting: an integer may carry an optional ".00"; a decimal
// is matched exactly (the fixtures avoid trailing-zero decimals). Bounded so "150" is never
// matched inside "1500" and "300" never inside "4.300".
function amountRe(n: number): RegExp {
  if (Number.isInteger(n)) {
    return new RegExp(`(?<![\\d.])${n}(?:\\.00)?(?!\\d)`);
  }
  return new RegExp(`(?<![\\d.])${n.toFixed(2).replace(".", "\\.")}(?!\\d)`);
}

// "money is shown with ITS currency": the ISO 4217 code, OR an UNAMBIGUOUS symbol for it. A
// bare "$" is deliberately NOT accepted — in a multi-currency view it does not say whether an
// amount is AUD or USD.
const CURRENCY_ALT: Record<string, string> = {
  AUD: "A\\$",
  USD: "US\\$|\\$US",
  NZD: "NZ\\$",
  EUR: "€",
  GBP: "£",
};
function amountFrag(n: number): string {
  return Number.isInteger(n) ? `${n}(?:\\.00)?` : n.toFixed(2).replace(".", "\\.");
}
function currencyFrag(code: string): string {
  const alt = CURRENCY_ALT[code];
  return alt ? `(?:\\b${code}\\b|${alt})` : `\\b${code}\\b`;
}
// A money token that binds a currency DIRECTLY to its amount — the code/symbol immediately
// before or after the digits (allowing only whitespace / a bracket / a separator between).
// This is what "money shown WITH its currency" means: the currency must sit on the figure,
// not merely appear somewhere else on the screen (e.g. in the currency selector's option
// list). The amount is bounded so "150" is never matched inside "1500".
function moneyRe(amount: number, currency: string): RegExp {
  const a = `(?<![\\d.])${amountFrag(amount)}(?!\\d)`;
  const c = currencyFrag(currency);
  const sep = `[\\s().,·/|-]{0,3}`;
  return new RegExp(`(?:${c}${sep}${a})|(?:${a}${sep}${c})`);
}

// Assert the `amount` is shown by its `anchor` (association, within `window` chars) AND that
// that amount carries its `currency` right on the figure (money always shown with its
// currency). Binding currency to the specific amount means a far-away currency label (the
// selector) cannot satisfy it.
function assertMoney(
  markup: string,
  anchor: string,
  amount: number,
  currency: string,
  window = 200,
): void {
  const vt = visibleText(markup);
  assert.ok(
    nearInText(markup, anchor, amountRe(amount), window),
    `the amount ${amount} must be shown near "${anchor}"; text="${vt}"`,
  );
  assert.ok(
    moneyRe(amount, currency).test(vt),
    `the amount ${amount} must be shown WITH its currency (${currency}), on the figure itself; text="${vt}"`,
  );
}

// --- section-by-heading slice (for the household-section scoping) -----------------
//
// The AC requires own-agent detail and household totals to be shown DISTINCTLY, so the
// household totals live under their own heading. This extracts the raw markup of the section
// a heading introduces: from just after the first heading whose text matches `re`, up to the
// next heading of the same-or-higher level (so deeper sub-headings inside the section do not
// cut it short), or the end of the document.
type Heading = { level: number; start: number; end: number; text: string };
function headings(markup: string): Heading[] {
  const out: Heading[] = [];
  for (const m of markup.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    out.push({
      level: Number(m[1]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      text: visibleText(m[2]),
    });
  }
  return out;
}
function sectionByHeading(markup: string, re: RegExp): string | null {
  const hs = headings(markup);
  const idx = hs.findIndex((h) => re.test(h.text));
  if (idx < 0) return null;
  const h = hs[idx];
  let endPos = markup.length;
  for (let i = idx + 1; i < hs.length; i++) {
    if (hs[i].level <= h.level) {
      endPos = hs[i].start;
      break;
    }
  }
  return markup.slice(h.end, endPos);
}

// --- currency-picker helpers ------------------------------------------------------
//
// The selectable choices the account-currency selector offers — from <option>s (a <select>)
// or radio inputs — each with its value and whether it is pre-selected (`selected`/`checked`).
type Choice = { value: string; selected: boolean };
function currencyChoices(markup: string): Choice[] {
  const out: Choice[] = [];
  for (const o of findAll(markup, "option")) {
    out.push({
      value: attr(o.attrs, "value") ?? visibleText(o.inner),
      selected: hasBoolAttr(o.attrs, "selected"),
    });
  }
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    if ((attr(attrs, "type") ?? "").toLowerCase() !== "radio") continue;
    out.push({ value: attr(attrs, "value") ?? "", selected: hasBoolAttr(attrs, "checked") });
  }
  return out;
}

// ================================================================================
// AC1 — own agents: budget + approved releases this period (merchant + approved amount),
// each money figure WITH its currency.
// ================================================================================

test("renders each own agent's card budget and its approved total for the period, with currency", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // The agent is named, and its budget (300 AUD / month) and approved total (65.63) are shown
  // with it — "this period against budget".
  assert.ok(text.includes("Shopping Assistant"), `the agent name must be shown; text="${text}"`);
  assertMoney(markup, "Shopping Assistant", 300, "AUD", 200);
  assertMoney(markup, "Shopping Assistant", 65.63, "AUD", 200);
  assert.ok(
    nearInText(markup, "Shopping Assistant", /month/i, 200),
    `the agent's budget period (month) must be shown; text="${text}"`,
  );
});

test("renders every approved release as merchant + approved amount, with its currency", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // Each release shows its merchant and the APPROVED amount with that release's currency.
  assert.ok(text.includes("Bunnings Warehouse"), `the merchant must be shown; text="${text}"`);
  assertMoney(markup, "Bunnings Warehouse", 40.17, "AUD");

  assert.ok(text.includes("Jetstar Airways"), `the merchant must be shown; text="${text}"`);
  // The USD release must be shown WITH "USD" (not a bare "$"): in a multi-currency view the
  // currency must be unambiguous.
  assertMoney(markup, "Jetstar Airways", 25.53, "USD");
});

test("an agent with no card budget renders without inventing a budget or a release", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // The budget-less agent is still listed...
  assert.ok(text.includes("Mail Helper"), `the budget-less agent must still be listed; text="${text}"`);
  // ...and the view never prints a null/NaN placeholder for its missing budget/total.
  assert.ok(
    !/\b(null|undefined|NaN)\b/i.test(text),
    `the view must not print null/undefined/NaN; text="${text}"`,
  );
});

// ================================================================================
// AC1 — the agent-reported amount is surfaced ONLY with its "Reported by <agent>" label, and
// ONLY for a release the agent actually reported (never for a release with none).
// ================================================================================

test("surfaces a reported amount prefixed 'Reported by <agent>', carrying the reported figure", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // Near the reported release, the label names the agent and carries the REPORTED amount
  // (42.89), distinct from the approved amount (40.17).
  assert.ok(
    nearInText(markup, "Bunnings Warehouse", /reported by\s+shopping assistant/i, 220),
    `the reported amount must be labelled "Reported by Shopping Assistant"; text="${text}"`,
  );
  assert.ok(
    nearInText(markup, "Bunnings Warehouse", amountRe(42.89), 220),
    `the reported amount (42.89) must be shown with its label; text="${text}"`,
  );
  // The reported amount is money too — shown with its currency.
  assert.ok(
    moneyRe(42.89, "AUD").test(text),
    `the reported amount (42.89) must be shown with its currency (AUD); text="${text}"`,
  );
});

test("a release with no reported amount shows no 'Reported by' label", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // Only the one reported release carries the agent's "Reported by <agent>" label — the
  // null-reported release (Jetstar) must not. Both releases belong to "Shopping Assistant",
  // so the specific label can appear AT MOST once.
  const count = (text.match(/reported by\s+shopping assistant/gi) ?? []).length;
  assert.equal(
    count,
    1,
    `exactly one release was reported, so "Reported by Shopping Assistant" must appear once, not ${count}; text="${text}"`,
  );
});

// ================================================================================
// AC1 — the household section: per-member total against limit, plus the household total
// against the shared budget. Every figure WITH its currency.
// ================================================================================

test("renders per-member totals against each member's limit", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // Member one: total 90.27 shown against limit 250, both with the household currency.
  assert.ok(text.includes("90.27"), `member one's total must be shown; text="${text}"`);
  assert.ok(
    nearInText(markup, "90.27", amountRe(250), 160),
    `member one's total (90.27) must be shown against their limit (250); text="${text}"`,
  );
  assert.ok(moneyRe(90.27, "AUD").test(text), `member one's total must carry its currency (AUD); text="${text}"`);
  assert.ok(moneyRe(250, "AUD").test(text), `member one's limit must carry its currency (AUD); text="${text}"`);

  // Member two: total 47.57 against limit 150.
  assert.ok(text.includes("47.57"), `member two's total must be shown; text="${text}"`);
  assert.ok(
    nearInText(markup, "47.57", amountRe(150), 160),
    `member two's total (47.57) must be shown against their limit (150); text="${text}"`,
  );
  assert.ok(moneyRe(47.57, "AUD").test(text), `member two's total must carry its currency (AUD); text="${text}"`);
  assert.ok(moneyRe(150, "AUD").test(text), `member two's limit must carry its currency (AUD); text="${text}"`);
});

test("renders the household total against the shared household budget, with currency", () => {
  const markup = render(base());
  const text = visibleText(markup);

  assert.ok(text.includes("137.84"), `the household total must be shown; text="${text}"`);
  assert.ok(
    nearInText(markup, "137.84", amountRe(500), 160),
    `the household total (137.84) must be shown against the shared budget (500); text="${text}"`,
  );
  assert.ok(moneyRe(137.84, "AUD").test(text), `the household total must carry its currency (AUD); text="${text}"`);
  assert.ok(moneyRe(500, "AUD").test(text), `the shared budget must carry its currency (AUD); text="${text}"`);
});

// ================================================================================
// AC1 — the household section shows TOTALS ONLY: never another member's merchant or an
// individual release entry. Scoped to the household section so a merchant that legitimately
// appears in the OWN section elsewhere in the output is not mistaken for a leak.
// ================================================================================

test("the household section shows no merchants and no release entries", () => {
  const markup = render(base());

  // Own-agent detail renders its merchants somewhere in the output (the own section).
  assert.ok(
    markup.includes("Bunnings Warehouse") && markup.includes("Jetstar Airways"),
    `own-agent merchants must be rendered in the own section; markup=${markup}`,
  );

  // The household totals live under their own heading, DISTINCT from own-agent detail.
  const section = sectionByHeading(markup, /household/i);
  assert.ok(
    section !== null,
    `the household totals must live under a distinct "Household" heading; markup=${markup}`,
  );
  const slice = section as string;
  const sliceText = visibleText(slice);

  // The household figures ARE in this section...
  for (const figure of ["137.84", "90.27", "47.57"]) {
    assert.ok(sliceText.includes(figure), `the household section must show ${figure}; section="${sliceText}"`);
  }

  // ...but NONE of the own merchants, release ids, or activity-entry links leak into it.
  for (const merchant of ["Bunnings Warehouse", "Jetstar Airways"]) {
    assert.ok(
      !slice.includes(merchant),
      `no member's merchant ("${merchant}") may appear in the household section; section=${slice}`,
    );
  }
  for (const releaseId of ["rel-1", "rel-2"]) {
    assert.ok(
      !slice.includes(releaseId),
      `no individual release entry ("${releaseId}") may appear in the household section; section=${slice}`,
    );
  }
  assert.ok(
    !/\/activity\?release=/.test(slice),
    `no release activity-entry link may appear in the household section; section=${slice}`,
  );
});

// ================================================================================
// AC2 — an account-currency selector is present: it offers the account currencies and shows
// the person's current account currency as the selected choice.
// ================================================================================

test("offers an account-currency selector over the account currencies", () => {
  const markup = render(base());
  const choices = currencyChoices(markup);
  const values = new Set(choices.map((c) => c.value));

  for (const code of CURRENCY_OPTIONS) {
    assert.ok(
      values.has(code),
      `the account-currency selector must offer ${code}; choices=${JSON.stringify(choices)}`,
    );
  }

  // The selector is labelled as an account-currency control (a visible label or an aria-label
  // mentioning "currency") — not an unlabelled picker.
  const labelTexts = findAll(markup, "label").map((l) => visibleText(l.inner));
  const ariaLabels = [...markup.matchAll(/aria-label="([^"]*)"/gi)].map((m) => decode(m[1]));
  assert.ok(
    [...labelTexts, ...ariaLabels].some((t) => /currency/i.test(t)),
    `the account-currency selector must carry a currency label; labels=${JSON.stringify([...labelTexts, ...ariaLabels])}`,
  );
});

test("the account-currency selector shows the current account currency as selected", () => {
  const markup = render(base());
  const choices = currencyChoices(markup);

  // Among the currency choices, exactly the current account currency is pre-selected (the
  // current currency is reflected even though it is not the first option).
  const selectedCurrencies = choices
    .filter((c) => c.selected && (CURRENCY_OPTIONS as readonly string[]).includes(c.value))
    .map((c) => c.value);
  assert.deepEqual(
    selectedCurrencies,
    [ACCOUNT_CURRENCY],
    `only the current account currency (${ACCOUNT_CURRENCY}) must be pre-selected; selected=${JSON.stringify(selectedCurrencies)}, choices=${JSON.stringify(choices)}`,
  );
});

// ================================================================================
// Robustness — a person in no household, and no own agents, both render sensibly (no crash,
// no fabricated figures); unset budgets/limits print no null/NaN placeholder.
// ================================================================================

test("a person in no household renders the own section but no household totals", () => {
  const markup = render(base({ household: null }));
  const text = visibleText(markup);

  // Own detail still renders.
  assert.ok(text.includes("Shopping Assistant"), `the own section must still render; text="${text}"`);
  // No household totals are fabricated when there is no household.
  assert.ok(
    !text.includes("137.84"),
    `no household total may be shown when the person is in no household; text="${text}"`,
  );
});

test("a person with no agents still renders the household totals", () => {
  const markup = render(base({ own: { agents: [] } }));
  const text = visibleText(markup);

  // The household section still renders...
  assert.ok(text.includes("137.84"), `the household totals must still render; text="${text}"`);
  // ...and no own merchant is invented.
  assert.ok(
    !text.includes("Bunnings Warehouse"),
    `no own-agent merchant may be shown when the person has no agents; text="${text}"`,
  );
});

test("unset budgets and limits render without printing null/NaN/undefined", () => {
  const markup = render(
    base({
      household: {
        householdId: "hh-1",
        currency: "AUD",
        monthlyBudget: null,
        budgetSpendToDate: 0,
        members: [{ userId: OWNER, monthlyLimit: null, spendToDate: 0 }],
      },
    }),
  );
  const text = visibleText(markup);
  assert.ok(
    !/\b(null|undefined|NaN)\b/i.test(text),
    `an unset budget/limit must render as plain copy, never null/undefined/NaN; text="${text}"`,
  );
});

// ================================================================================
// Design system — colour comes from tokens, never a raw hex literal.
// ================================================================================

test("uses design tokens, never a raw hex colour", () => {
  const variants: SpendingViewProps[] = [
    base(),
    base({ household: null }),
    base({ own: { agents: [] } }),
    base({ own: { agents: [] }, household: null }),
  ];
  for (const props of variants) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the spending-view markup, got: ${markup}`,
    );
  }
});

// ================================================================================
// Review fix W4.5 — spend in a currency with no reference rate is FLAGGED in words, never
// shown as part of the totals (it used to be silently counted as 0).
// ================================================================================

test("W4.5: an amount that couldn't be converted is flagged, naming its currency and amount", () => {
  const markup = render(
    base({
      household: {
        ...HOUSEHOLD,
        unconverted: [{ currency: "USD", amount: 25.5 }],
        members: [
          { userId: OWNER, monthlyLimit: 250, spendToDate: 90.27, unconverted: [] },
          { userId: OTHER_MEMBER, monthlyLimit: 150, spendToDate: 47.57, unconverted: [{ currency: "USD", amount: 25.5 }] },
        ],
      },
    }),
  );
  const household = sectionByHeading(markup, /household/i) ?? "";
  const text = visibleText(household);
  assert.match(text, /couldn.t convert/i, `the household section must say what couldn't be converted; text="${text}"`);
  assert.match(text, /no rate for USD/, `and why, naming the currency; text="${text}"`);
  assert.match(text, /USD 25\.50/, `with the amount in its own currency; text="${text}"`);
  assert.match(text, /not (included|counted) in/i, `and say it isn't in the totals; text="${text}"`);
});

test("W4.5: a household with nothing unconverted shows no conversion warning", () => {
  const text = visibleText(sectionByHeading(render(base()), /household/i) ?? "");
  assert.doesNotMatch(text, /couldn.t convert/i);
});
