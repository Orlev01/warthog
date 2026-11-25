// The Bills tab (docs/adr/life-admin-profile.md, "The Bills tab"; founder, 25 Nov 2026): one place
// for everything the person pays on repeat, across categories — what it is, how much and how often,
// when the next payment is, the card or account it comes out of and the address it's registered
// to — grouped by date by default, with a switch to group by account. Nothing is filed under
// Bills: the rows are the records already on file (the bills rule is pinned in
// domain/life-admin/bills.test.ts), each with its Details and Edit, so the person fills in Paid with
// and Next payment right here. Every link stays inside Life admin: what an agent read from email
// (Paid with, the account's email) is shown as text, never as a link.
//
// These render the whole Life admin view, as the page does (the payment sources come from every
// tab's records), and read the Bills panel's markup.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";
import { billsHref, billsPrompt } from "./record-groups";
import { BUILT_IN } from "@/domain/life-admin/catalogue";
import { phased } from "./phase-fixture";
import type { CategoryStateView } from "./record-view-types";

// FIXTURE_NOW is 23 Nov 2026, midday in Sydney.
const TODAY = "2026-11-23";
const ZONE = "Australia/Sydney";
const noop = () => {};

function rec(id: string, type: string, fields: Record<string, string>, over: Partial<LifeAdminRecordView> = {}): LifeAdminRecordView {
  return phased({ id, kind: "item", type, fields, dueDate: null, status: "active", reminderOffsets: [], ...over });
}

// The person's cards and accounts: an open card with an annual fee, a closed one, an account.
const ALTITUDE = rec("altitude", "banking.card", { provider: "Westpac", card_product: "Altitude Black", last4: "2460", annual_fee: "250" }, { dueDate: "2027-02-25" });
const AMEX = rec("amex", "banking.card", { provider: "American Express", card_product: "Platinum", last4: "1005" }, { status: "cancelled" });
const CHOICE = rec("choice", "banking.account", { provider: "Westpac", name: "Westpac Choice", last4: "2478", account_kind: "everyday" });
// Bills, one of each shape.
const NETFLIX = rec("netflix", "subscriptions.service", { name: "Netflix", amount: "25.99", currency: "AUD", cycle: "monthly", paid_with: "Westpac card ending 2460", account_email: "oren@example.test" }, { dueDate: "2026-12-05" });
const MEDIBANK = rec("medibank", "health.insurance", { provider: "Medibank", amount: "148.25", cycle: "monthly", paid_with: "Amex ••1005" }, { dueDate: "2026-03-01" });
const REGO = rec("rego", "vehicles.registration", { plate: "BX12AB", provider: "Transport for NSW", amount: "412.50", term: "12 months" }, { dueDate: "2026-11-10" });
const RENT = rec("rent", "home.lease", { provider: "Ray White", amount: "650", cycle: "weekly", paid_with: "https://evil.example/pay?bsb=1" }, { dueDate: "2027-06-30" });
const GITHUB = rec("github", "subscriptions.service", { name: "GitHub", amount: "48", currency: "USD", cycle: "yearly", next_payment: "2027-01-15" });
const COFFEE = rec("coffee", "subscriptions.service", { name: "Coffee club" }, { reviewState: "suggested" });
const MOBILE = rec("mobile", "utilities.phone", { provider: "Boost", amount: "45", next_payment: "2026-09-01" });
// Not bills: income, and something finished.
const CENTRELINK = rec("centrelink", "government.payment", { payment_kind: "JobSeeker", amount: "780", cycle: "fortnightly" }, { dueDate: "2026-12-01" });
const STAN = rec("stan", "subscriptions.service", { name: "Stan", amount: "12", cycle: "monthly" }, { dueDate: "2025-03-28", status: "cancelled" });

const ALL = [ALTITUDE, AMEX, CHOICE, NETFLIX, MEDIBANK, REGO, RENT, GITHUB, COFFEE, MOBILE, CENTRELINK, STAN];

function render(over: Partial<LifeAdminViewProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminView
      today={TODAY}
      zone={ZONE}
      records={ALL}
      initialTab="bills"
      addRecordAction={noop}
      editRecordAction={noop}
      deleteRecordAction={noop}
      {...over}
    />,
  );
}

// The Bills tab's panel (Records, Add, Upcoming, Bills, History).
function billsPanel(markup: string): string {
  const starts = [...markup.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map((m) => m.index!);
  return markup.slice(starts[3], starts[4]);
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function headings(markup: string, level: number): string[] {
  return [...markup.matchAll(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, "g"))].map((m) => text(m[1]!));
}

// One bill's row on Bills: from its `data-record` to the next row's (or the end).
function rowOf(markup: string, id: string): string {
  const start = markup.indexOf(`data-record="${id}"`);
  assert.ok(start >= 0, `${id} has a row on Bills`);
  const next = markup.indexOf("data-record=", start + 1);
  return markup.slice(start, next < 0 ? undefined : next);
}

// The muted line under a row's name, and the one under that (before its Details).
function rowLines(row: string): string {
  return text(row.slice(0, row.search(/<details\b/)));
}

// The ListGroup whose heading has this id, up to the end of its section.
function groupOf(markup: string, id: string): string {
  const start = markup.indexOf(`<section aria-labelledby="${id}-heading"`);
  assert.ok(start >= 0, `a ${id} group renders`);
  const next = markup.indexOf('<section aria-labelledby="bills-', start + 1);
  return markup.slice(start, next < 0 ? undefined : next);
}

const rowIds = (markup: string) => [...markup.matchAll(/data-record="([^"]+)"/g)].map((m) => m[1]);

// ─── by date ─────────────────────────────────────────────────────────────────────────

test("by date: Overdue, Next 30 days, Later and Date not known yet, in that order, each in date order (the unknown dearest first)", () => {
  const bills = billsPanel(render());
  assert.deepEqual(headings(bills, 2), ["Bills"]);
  assert.deepEqual(headings(bills, 3), ["Overdue", "Next 30 days", "Later", "Date not known yet"]);
  assert.deepEqual(rowIds(groupOf(bills, "bills-overdue")), ["rego"], "rego is paid by hand: past its date, it's overdue");
  assert.deepEqual(rowIds(groupOf(bills, "bills-soon")), ["medibank", "netflix"]);
  assert.deepEqual(rowIds(groupOf(bills, "bills-later")), ["github", "altitude"], "a card's annual fee is a bill");
  assert.deepEqual(rowIds(groupOf(bills, "bills-unknown")), ["rent", "mobile", "coffee"]);
  for (const id of ["centrelink", "stan", "amex", "choice"]) assert.ok(!rowIds(bills).includes(id), `${id} isn't a bill`);
});

test("each row says when the next payment is in the kind's words, what it costs and its category; an estimate says so", () => {
  const bills = billsPanel(render());
  assert.match(rowLines(rowOf(bills, "netflix")), /Netflix Due soon Renews 5 Dec 2026 · AUD 25\.99 a month · Subscriptions and memberships/);
  assert.match(rowLines(rowOf(bills, "medibank")), /Next payment about 1 Dec 2026 \(estimated\) · AUD 148\.25 a month · Health/, "worked out from the cycle");
  assert.match(rowLines(rowOf(bills, "rego")), /Was due 10 Nov 2026 · AUD 412\.50 a year · Vehicles/, "rego's term is how often");
  assert.match(rowLines(rowOf(bills, "github")), /Next payment 15 Jan 2027 · USD 48\.00 a year/, "the record's own Next payment");
  assert.match(rowLines(rowOf(bills, "altitude")), /Annual fee 25 Feb 2027 · AUD 250\.00 a year · Banking/, "the card's own date, in its words");
  assert.match(rowLines(rowOf(bills, "mobile")), /Last known 1 Sept 2026 · AUD 45\.00 · How often not known yet/);
  assert.match(rowLines(rowOf(bills, "coffee")), /Not checked yet Cost not known yet · How often not known yet/);
  assert.match(rowLines(rowOf(bills, "rent")), /Ray White Current AUD 650\.00 a week · Home/, "a lease's date is when it ends, not a payment");
  assert.match(text(bills), /An estimated date is Warthog's working-out from the last date and how often\. If it's wrong, set Next payment in Edit\./);
});

test("each row says what it comes out of: the matched card or account as a link to its page, else Paid with as written, and the address it's registered to as text", () => {
  const bills = billsPanel(render());
  const netflix = rowOf(bills, "netflix");
  assert.match(rowLines(netflix), /From Westpac ending 2460 · Registered to oren@example\.test/);
  assert.match(netflix, /From <a href="\/life-admin\/items\/altitude"[^>]*>Westpac ending 2460<\/a>/);
  assert.match(rowLines(rowOf(bills, "altitude")), /Charged to this card/, "a card's fee comes out of the card itself");
  assert.match(rowLines(rowOf(bills, "medibank")), /From American Express ending 1005 \(closed\)/);
  assert.match(rowLines(rowOf(bills, "rent")), /Paid with: https:\/\/evil\.example\/pay\?bsb=1/);
  assert.match(rowLines(rowOf(bills, "rego")), /Paid with: not known yet/);
});

test("the cost line: what the bills come to a month, each currency apart, and what isn't counted or checked yet", () => {
  const words = text(billsPanel(render()));
  assert.match(words, /You pay about AUD 3,046\.12 and USD 4\.00 a month for 6 bills\./, "never added across currencies; income and finished things left out");
  assert.match(words, /2 not counted yet \(no cost or how often\) · 1 not checked yet/);
  // Founder, 25 Nov 2026: "what the hell is about AUD 5,060.48 a month!? Is this a mistake?" (it was rent).
  assert.match(words, /Ray White is AUD 2,816\.67 of that · 2 not counted yet/, "when one bill is most of the total, the line says so");
  const tidy = text(billsPanel(render({ records: [ALTITUDE, NETFLIX] })));
  assert.match(tidy, /You pay about AUD 46\.82 a month for 2 bills\./);
  assert.doesNotMatch(tidy, /not counted yet|not checked yet/);
});

test("By date and By account are links that reload the page, the current one marked", () => {
  assert.equal(billsHref("date"), "/life-admin?tab=bills");
  assert.equal(billsHref("account"), "/life-admin?tab=bills&bills=account");
  const nav = (markup: string) => /<nav\b[^>]*aria-label="Group bills"[^>]*>([\s\S]*?)<\/nav>/.exec(billsPanel(markup))![1]!;
  const links = (markup: string) => [...nav(markup).matchAll(/<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => [text(m[3]!), m[1]!.replace(/&amp;/g, "&"), /aria-current="page"/.test(m[2]!)]);
  assert.deepEqual(links(render()), [["By date", "/life-admin?tab=bills", true], ["By account", "/life-admin?tab=bills&bills=account", false]]);
  assert.deepEqual(links(render({ billsGroup: "account" })), [["By date", "/life-admin?tab=bills", false], ["By account", "/life-admin?tab=bills&bills=account", true]]);
});

// ─── by account ──────────────────────────────────────────────────────────────────────

test("by account: each card or account with what it comes to a month, then Paid with as written, then not known yet", () => {
  const bills = billsPanel(render({ billsGroup: "account" }));
  assert.deepEqual(headings(bills, 3), ["Westpac ending 2460", "American Express ending 1005", "https://evil.example/pay?bsb=1", "Paid with not known yet"]);
  const groups = [...bills.matchAll(/<section aria-labelledby="(bills-account-\d+)-heading"/g)].map((m) => groupOf(bills, m[1]!));
  assert.deepEqual(groups.map(rowIds), [["netflix", "altitude"], ["medibank"], ["rent"], ["rego", "github", "mobile", "coffee"]]);
  assert.deepEqual(
    groups.map((group) => text(/<p class="wh-list-group-summary">([\s\S]*?)<\/p>/.exec(group)![1]!)),
    ["About AUD 46.82 a month; Netflix is AUD 25.99 of it", "About AUD 148.25 a month", "About AUD 2,816.67 a month", "About AUD 34.38 and USD 4.00 a month"],
    "subtotals per currency, never added together",
  );
  assert.match(groups[0]!, /<h3 id="bills-account-0-heading"><a href="\/life-admin\/items\/altitude"[^>]*>Westpac ending 2460<\/a><\/h3>/, "a card's group links to its page");
  assert.doesNotMatch(groups[2]!, /<h3[^>]*><a\b/, "what Paid with says is text");
  assert.match(rowLines(rowOf(bills, "netflix")), /Registered to oren@example\.test/);
  assert.doesNotMatch(rowLines(rowOf(bills, "netflix")), /From Westpac/, "the group already says what it comes out of");
  assert.match(rowLines(rowOf(bills, "coffee")), /Date not known yet · Cost not known yet/);
});

test("a closed card's group warns that bills still point to it", () => {
  const bills = billsPanel(render({ billsGroup: "account" }));
  const warning = bills.indexOf("This card is closed");
  assert.ok(warning > 0);
  assert.ok(warning < bills.indexOf('aria-labelledby="bills-account-1-heading"') && warning > bills.indexOf('aria-labelledby="bills-account-0-heading"'), "just before the closed card's group");
  assert.match(text(bills), /This card is closed: 1 bill still points to it\. Change Paid with on each to what it comes out of now\./);
  assert.match(bills, /data-tone="warning"[^>]*><svg[\s\S]*?<\/svg><div[^>]*>This card is closed/, "a warning notice, with its icon");
  const two = rec("amazon", "subscriptions.service", { name: "Prime", amount: "9.99", cycle: "monthly", paid_with: "Amex ending 1005" });
  assert.match(text(billsPanel(render({ records: [...ALL, two], billsGroup: "account" }))), /This card is closed: 2 bills still point to it\./);
  const oldAccount = rec("oldsaver", "banking.account", { provider: "ING", name: "ING Savings", last4: "7777" }, { status: "cancelled" });
  const water = rec("water", "utilities.water", { provider: "Sydney Water", amount: "90", cycle: "quarterly", paid_with: "ING account 7777" });
  assert.match(text(billsPanel(render({ records: [oldAccount, water], billsGroup: "account" }))), /This account is closed: 1 bill still points to it\./);
  assert.doesNotMatch(text(billsPanel(render())), /is closed:/, "by date, the row says (closed)");
});

// ─── rows, links and forms ───────────────────────────────────────────────────────────

test("rows carry data-record, never a second record anchor, and keep Details with Edit, which comes back to Bills", () => {
  const markup = render({ billsGroup: "account" });
  const bills = billsPanel(markup);
  assert.doesNotMatch(bills, /id="record-/, "the anchor stays with the row on Records");
  for (const record of ALL) assert.ok((markup.match(new RegExp(`id="record-${record.id}"`, "g")) ?? []).length <= 1, `${record.id}: one anchor on the page`);
  const rent = rowOf(bills, "rent");
  assert.match(bills, /<li data-record="rent" tabindex="-1"/);
  assert.doesNotMatch(rent.slice(0, rent.search(/<details\b/)), /<div class="min-w-0 text-sm text-fg-muted[^"]*"><\/div>/, "no empty line when there's nothing more to say");
  assert.match(text(rent), /Details/);
  assert.match(rent, /name="field:next_payment"/, "a lease's Next payment can be filled in here");
  assert.match(rent, /name="field:paid_with"/);
  const forms = [...bills.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]!);
  assert.ok(forms.length > 0);
  for (const form of forms) {
    assert.match(form, /<input type="hidden" name="returnTab" value="bills"\/><input type="hidden" name="returnBills" value="account"\/>/, "an action on a bill comes back to Bills, grouped the same way");
  }
});

test("every link on Bills stays inside Life admin: Paid with and the account's email are text, never a link or mailto:", () => {
  for (const markup of [render(), render({ billsGroup: "account" })]) {
    const bills = billsPanel(markup);
    const hrefs = [...bills.matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1]!);
    assert.ok(hrefs.length > 5);
    for (const href of hrefs) assert.match(href, /^\/life-admin(\/|\?)/, `an internal link only; found href="${href}"`);
    assert.doesNotMatch(bills, /mailto:/);
    assert.ok(text(bills).includes("https://evil.example/pay?bsb=1"), "the value is shown as written");
    assert.ok(text(bills).includes("oren@example.test"));
    for (const href of [...markup.matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1]!)) {
      assert.doesNotMatch(href, /evil\.example|example\.test|^mailto:/, "nowhere on the page");
    }
  }
});

test("Paid with suggests the person's open cards and accounts, never a closed one, in Edit and Add", () => {
  const listFor = (form: string) => {
    const input = /<input\b[^>]*name="field:paid_with"[^>]*>/.exec(form);
    assert.ok(input, "a Paid with field");
    const list = /\blist="([^"]+)"/.exec(input![0]!)![1]!;
    const datalist = new RegExp(`<datalist id="${list}">([\\s\\S]*?)</datalist>`).exec(form)!;
    return [...datalist[1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  };
  const edit = rowOf(billsPanel(render()), "netflix");
  assert.deepEqual(listFor(edit), ["Westpac ending 2460", "Westpac Choice ending 2478"]);
  const add = render({ initialTab: "add", addType: "subscriptions.service" });
  const form = /<form\b[^>]*aria-label="Add a subscription"[^>]*>([\s\S]*?)<\/form>/.exec(add)![1]!;
  assert.deepEqual(listFor(form), ["Westpac ending 2460", "Westpac Choice ending 2478"]);
  assert.doesNotMatch(add, /<option value="American Express ending 1005"/);
  const none = render({ records: [NETFLIX] });
  assert.doesNotMatch(rowOf(billsPanel(none), "netflix").match(/<input\b[^>]*name="field:paid_with"[^>]*>/)![0]!, /\blist=/, "no cards or accounts, no suggestions");
});

// ─── empty, and asking an agent ──────────────────────────────────────────────────────

test("with no bills, Bills says so and offers a prompt to copy into an agent", () => {
  for (const records of [[], [CHOICE, CENTRELINK, STAN]]) {
    const bills = billsPanel(render({ records }));
    const words = text(bills);
    assert.match(words, /No bills yet/);
    assert.match(words, /Subscriptions, utilities, rent, insurance, rego and card fees show here once they're in Life admin/);
    assert.ok(words.includes(billsPrompt()), "the prompt, readable before it's copied");
    assert.match(bills, /<button\b[^>]*>[\s\S]*?Copy<span class="sr-only"> prompt for your agent<\/span><\/button>/);
    assert.doesNotMatch(bills, /aria-label="Group bills"|You pay about/, "nothing to group or add up");
  }
  assert.match(billsPrompt(), /list_records view "bills"/);
  assert.match(billsPrompt(), /paid_with, last 4 only/);
  assert.match(billsPrompt(), /Read Warthog's "Life admin records" skill first\.$/);
});

test("with bills missing a date, a cost or Paid with, a smaller prompt asks the agent to fill them in; with nothing missing, none", () => {
  const words = text(billsPanel(render()));
  assert.match(words, /Ask your agent to fill these in 5 bills have no date, cost or Paid with yet\./);
  assert.ok(words.includes(billsPrompt()));
  const complete = text(billsPanel(render({ records: [ALTITUDE, NETFLIX] })));
  assert.doesNotMatch(complete, /Ask your agent/);
});

test("a bill in a category the person said is not for them isn't listed, though its card still matches", () => {
  const states: CategoryStateView[] = BUILT_IN.categories.map((category) => ({
    id: category.id,
    visibility: category.id === "banking" ? "not_for_me" : "shown",
    records: ALL.filter((record) => BUILT_IN.typeOfRecord(record.kind, record.type ?? null).category === category.id).length,
  }));
  const bills = billsPanel(render({ categories: states }));
  assert.ok(!rowIds(bills).includes("altitude"), "the card's fee is hidden with its category");
  assert.match(rowLines(rowOf(bills, "netflix")), /From Westpac ending 2460/);
});

test("Bills uses tokens, never raw hex", () => {
  assert.doesNotMatch(billsPanel(render()), /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(billsPanel(render({ billsGroup: "account" })), /#[0-9a-fA-F]{3,8}\b/);
});
