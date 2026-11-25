// What the person pays on repeat (./bills.ts): what counts as a bill, what it costs a month, when
// the next payment is (rolled on its cycle and marked estimated), and which card or account it
// comes out of. The fixture is the founder's own Life admin on 25 Nov 2026 (dogfood).

import { test } from "node:test";
import assert from "node:assert/strict";

import { BUILT_IN } from "./catalogue";
import {
  addMonthsClamped,
  billCost,
  billOf,
  billsMonthlyCost,
  billsView,
  intervalOf,
  intervalWords,
  nextOnCycle,
  paymentSources,
  resolvePaidFrom,
  type BillRecord,
} from "./bills";

const TODAY = "2026-11-25";
type Row = BillRecord & { readonly type: string };
const typeOf = (record: BillRecord) => BUILT_IN.type((record as Row).type) ?? null;
let n = 0;
const row = (type: string, fields: Record<string, unknown>, extra: Partial<Row> = {}): Row => ({ id: `r${++n}`, type, fields, dueDate: null, status: "active", ...extra });

test("dates move on by whole months from the anchor, on the same day or the month's last", () => {
  assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsClamped("2026-01-31", 2), "2026-03-31");
  assert.equal(addMonthsClamped("2026-01-31", 3), "2026-04-30");
  assert.equal(addMonthsClamped("2028-02-29", 12), "2029-02-28");
  assert.equal(addMonthsClamped("2028-02-29", 48), "2032-02-29");
  assert.equal(addMonthsClamped("2026-03-15", -3), "2025-12-15");
});

test("the next payment on a cycle is the first on or after today, forwards or backwards", () => {
  const month = { unit: "month", count: 1 } as const;
  assert.deepEqual(nextOnCycle("2026-11-16", month, TODAY), { date: "2026-12-16", estimated: true }, "GitHub's receipt of 16 Nov");
  assert.deepEqual(nextOnCycle("2026-05-03", month, TODAY), { date: "2026-12-03", estimated: true }, "rent from 3 May");
  assert.deepEqual(nextOnCycle("2026-11-25", month, TODAY), { date: "2026-11-25", estimated: false }, "today is the anchor");
  assert.deepEqual(nextOnCycle("2027-04-01", month, TODAY), { date: "2026-12-01", estimated: true }, "back from a yearly renewal paid monthly");
  assert.deepEqual(nextOnCycle("2026-01-31", month, TODAY), { date: "2026-11-30", estimated: true }, "a 31st doesn't drift");
  assert.deepEqual(nextOnCycle("2026-10-28", { unit: "week", count: 1 }, TODAY), { date: "2026-11-25", estimated: true });
  assert.deepEqual(nextOnCycle("2026-11-11", { unit: "week", count: 2 }, TODAY), { date: "2026-11-25", estimated: true });
  assert.deepEqual(nextOnCycle("2026-11-12", { unit: "week", count: 2 }, TODAY), { date: "2026-11-26", estimated: true });
  assert.deepEqual(nextOnCycle("2027-02-25", { unit: "month", count: 12 }, TODAY), { date: "2027-02-25", estimated: false });
});

test("how often: cycle words, and a rego's term when it has no cycle", () => {
  assert.deepEqual(intervalOf("monthly"), { unit: "month", count: 1 });
  assert.deepEqual(intervalOf("Annual"), { unit: "month", count: 12 });
  assert.deepEqual(intervalOf(undefined, "6 months"), { unit: "month", count: 6 });
  assert.equal(intervalOf("one_off"), null);
  assert.equal(intervalWords({ unit: "week", count: 2 }), "a fortnight");
  assert.equal(intervalWords({ unit: "month", count: 6 }), "every 6 months");
  assert.equal(intervalWords({ unit: "month", count: 12 }), "a year");
});

test("what counts: bill kinds and the person's own costs on a cycle; never income, balances or one-offs", () => {
  const cost = (type: string, fields: Record<string, unknown>) => billCost(BUILT_IN.type(type)!, fields);
  assert.equal(cost("subscriptions.service", { amount: "12.99", cycle: "monthly" })?.monthly, 12.99);
  assert.equal(cost("subscriptions.service", { name: "Microsoft 365" })?.amount, null, "a bill with no cost yet is still a bill");
  assert.equal(cost("government.payment", { amount: "850", cycle: "fortnightly" }), null, "a government payment is income");
  assert.equal(cost("investing.pension", { amount: "1200", cycle: "monthly" }), null);
  assert.equal(cost("work.job", { amount: "9000", cycle: "monthly" }), null);
  assert.equal(cost("government.help", { amount: "21000" }), null, "a balance");
  assert.equal(cost("belongings.receipt", { amount: "1578.70", cycle: "one_off" }), null);
  assert.equal(cost("other.item", { amount: "30", cycle: "quarterly" })?.monthly, 10, "Other counts with a cost on a cycle");
  assert.equal(cost("other.item", { amount: "30" }), null);
  const rego = cost("vehicles.registration", { amount: "91", term: "12 months" });
  assert.deepEqual(rego?.interval, { unit: "month", count: 12 });
  assert.equal(cost("subscriptions.service", { amount: "1,250.50", currency: "usd", cycle: "yearly" })?.currency, "USD");
});

test("a card's bill is its annual fee, never also its amount; a fee of 0 isn't a bill", () => {
  const card = BUILT_IN.type("banking.card")!;
  assert.deepEqual(billCost(card, { annual_fee: "295", amount: "50", cycle: "monthly" }), { amount: 295, currency: "AUD", interval: { unit: "month", count: 12 }, monthly: 295 / 12 });
  assert.equal(billCost(card, { annual_fee: "0" }), null);
  assert.equal(billCost(card, {}), null, "a card with no fee known yet is just a card");
  assert.equal(billCost(card, { amount: "9", cycle: "monthly" })?.monthly, 9, "a monthly card fee");
});

test("paused, cancelled and finished records aren't bills; unchecked ones are, and say so", () => {
  const type = BUILT_IN.type("subscriptions.service")!;
  const fields = { amount: "10", cycle: "monthly" };
  assert.equal(billOf(type, row("subscriptions.service", fields, { status: "paused" }), TODAY), null);
  assert.equal(billOf(type, row("subscriptions.service", fields, { status: "cancelled" }), TODAY), null);
  assert.equal(billOf(type, row("subscriptions.service", fields, { phase: { live: false, bucket: "finished" } }), TODAY), null);
  assert.equal(billOf(type, row("subscriptions.service", fields, { reviewState: "suggested" }), TODAY)?.notChecked, true);
});

test("a bill paid by hand stays overdue for 30 days; one that charges itself moves on its cycle", () => {
  const rego = billOf(BUILT_IN.type("vehicles.registration")!, row("vehicles.registration", { amount: "91", term: "12 months" }, { dueDate: "2026-11-24" }), TODAY)!;
  assert.deepEqual([rego.next, rego.overdue], [{ date: "2026-11-24", estimated: false }, true]);
  const old = billOf(BUILT_IN.type("vehicles.registration")!, row("vehicles.registration", { amount: "91", term: "12 months" }, { dueDate: "2025-09-01" }), TODAY)!;
  assert.deepEqual([old.next, old.overdue], [{ date: "2027-09-01", estimated: true }, false], "long past: rolled on");
  const sub = billOf(BUILT_IN.type("subscriptions.service")!, row("subscriptions.service", { amount: "5", cycle: "monthly" }, { dueDate: "2026-11-20" }), TODAY)!;
  assert.deepEqual([sub.next, sub.overdue], [{ date: "2026-12-20", estimated: true }, false]);
  const domain = billOf(BUILT_IN.type("business.domain")!, row("business.domain", { amount: "11.50" }, { dueDate: "2026-07-24" }), TODAY)!;
  assert.deepEqual([domain.next, domain.lastKnown], [null, "2026-07-24"], "no cycle, long past: date not known, last known kept");
});

test("a lease's own date is when it ends, so only next_payment dates its rent", () => {
  const lease = BUILT_IN.type("home.lease")!;
  assert.equal(billOf(lease, row("home.lease", { amount: "4766.68", cycle: "monthly" }, { dueDate: "2027-05-02" }), TODAY)?.next, null);
  assert.deepEqual(billOf(lease, row("home.lease", { amount: "4766.68", cycle: "monthly", next_payment: "2026-05-03" }), TODAY)?.next, { date: "2026-12-03", estimated: true });
  assert.ok(lease.fields.some((field) => field.key === "next_payment"));
});

// Founder, 25 Nov 2026: Medibank renews yearly but debits monthly (9 Nov), so every bill has
// Next payment; when it's set it wins over the kind's own date.
test("a yearly renewal paid monthly counts on from its last debit, not its renewal date", () => {
  const health = BUILT_IN.type("health.insurance")!;
  assert.ok(health.fields.some((field) => field.key === "next_payment"));
  const medibank = billOf(health, row("health.insurance", { amount: "148.25", cycle: "monthly", next_payment: "2026-11-09" }, { dueDate: "2027-04-01" }), TODAY)!;
  assert.deepEqual(medibank.next, { date: "2026-12-09", estimated: true });
  const renewal = billOf(health, row("health.insurance", { amount: "1779", cycle: "yearly" }, { dueDate: "2027-04-01" }), TODAY)!;
  assert.deepEqual(renewal.next, { date: "2027-04-01", estimated: false }, "without Next payment, the renewal is the payment");
});

const ACCOUNTS: Row[] = [
  row("banking.account", { name: "ANZ Access Basic", provider: "ANZ", last4: "9045", card_last4: "6004" }),
  row("banking.account", { name: "Macquarie Transaction Account", provider: "Macquarie", last4: "2460" }),
  row("banking.account", { name: "Macquarie Savings Account", provider: "Macquarie", last4: "2478" }),
  row("banking.account", { name: "Westpac Choice", provider: "Westpac", last4: "2902" }),
  row("banking.account", { name: "Westpac eSaver", provider: "Westpac" }),
  row("banking.card", { name: "Westpac Altitude Qantas Black World Mastercard", provider: "Westpac", card_product: "Altitude Qantas Black World Mastercard", annual_fee: "295" }, { dueDate: "2027-06-22" }),
  row("banking.card", { name: "NAB Qantas Rewards Signature card", provider: "NAB", last4: "2686" }),
  row("banking.card", { name: "Qantas American Express Ultimate Card", provider: "American Express", last4: "1000" }, { status: "cancelled" }),
];
const SOURCES = paymentSources(ACCOUNTS, typeOf);
const label = (said: string | null) => resolvePaidFrom(said, SOURCES)?.label ?? null;

test("Paid with is matched to one of the person's accounts or cards only when exactly one fits", () => {
  assert.equal(label("Visa ending 2686"), "NAB Qantas Rewards Signature card ending 2686");
  assert.equal(label("Visa (4*** **** **** 6004)"), "ANZ Access Basic ending 9045", "an account's debit card names the account");
  assert.equal(label("Mastercard ••••2686"), "NAB Qantas Rewards Signature card ending 2686", "a masked full number");
  assert.equal(label("Direct debit from Macquarie account ending 2478"), "Macquarie Savings Account ending 2478");
  assert.equal(label("NAB card ending 1234"), null, "digits that match nothing never fall back to words");
  assert.equal(label("Westpac"), null, "three Westpac accounts and cards: no guess");
  assert.equal(label("Westpac card"), "Westpac Altitude Qantas Black World Mastercard");
  assert.equal(label("Altitude card ending 497"), "Westpac Altitude Qantas Black World Mastercard", "3 digits, matched by words among those with no last 4");
  assert.equal(label("westpac choice"), "Westpac Choice ending 2902");
  assert.equal(label("Macquarie savings"), "Macquarie Savings Account ending 2478");
  assert.equal(label("NAB Visa"), "NAB Qantas Rewards Signature card ending 2686", "the bank alone, with one card there");
  assert.equal(label("Amex ending 1000"), "Qantas American Express Ultimate Card ending 1000");
  assert.equal(resolvePaidFrom("Amex ending 1000", SOURCES)?.closed, true, "a closed card is still found, and says so");
  assert.equal(label("PayPal"), null);
  assert.equal(label(null), null);
});

test("the founder's bills on 25 Nov 2026", () => {
  const records: Row[] = [
    ...ACCOUNTS,
    row("vehicles.registration", { name: "Motorcycle registration", amount: 91, currency: "AUD", term: "12 months" }, { dueDate: "2026-11-24" }),
    row("subscriptions.service", { name: "Chess Gold", amount: 42.99, currency: "AUD", cycle: "yearly", account_email: "levyoren1@gmail.com" }, { dueDate: "2027-02-25" }),
    row("subscriptions.service", { name: "Microsoft 365 Business Premium - NAVA", account_email: "oren@nava-co.com" }, { dueDate: "2027-06-11" }),
    row("subscriptions.service", { name: "Amazon Prime", amount: 12.99, currency: "AUD", cycle: "monthly", paid_with: "Visa ending 2686" }),
    row("subscriptions.service", { name: "Prime Video Ad Free", amount: 2.99, currency: "AUD", cycle: "monthly", paid_with: "Visa ending 2686" }),
    row("subscriptions.service", { name: "Allways Coffee subscription", amount: 21, currency: "AUD", cycle: "weekly" }),
    row("subscriptions.service", { name: "GitHub Team - NAVA", amount: 16, currency: "USD", cycle: "monthly", next_payment: "2026-11-16" }),
    row("health.insurance", { name: "Medibank", amount: 148.25, currency: "AUD", cycle: "monthly", account_email: "levyorenbilling@gmail.com" }),
    row("home.lease", { name: "Lease, Unit 44", amount: "4766.68", currency: "AUD", cycle: "monthly", paid_with: "Westpac Choice", next_payment: "2026-05-03" }),
    row("utilities.energy", { name: "AGL gas", amount: "82.22", currency: "AUD", cycle: "quarterly" }),
    row("government.help", { name: "Study loan (HELP)", amount: "21000" }),
    row("investing.super", { name: "Hostplus" }),
  ];
  const view = billsView(records, typeOf, TODAY, SOURCES);
  const names = (list: readonly { name: string }[]) => list.map((bill) => bill.name);
  assert.deepEqual(names(view.overdue), ["Motorcycle registration"]);
  assert.deepEqual(names(view.soon), ["Lease, Unit 44", "GitHub Team - NAVA"]);
  assert.deepEqual(names(view.later), ["Chess Gold", "Microsoft 365 Business Premium - NAVA", "Westpac Altitude Qantas Black World Mastercard"]);
  assert.deepEqual(names(view.unknown), ["Medibank", "Allways Coffee subscription", "AGL gas", "Amazon Prime", "Prime Video Ad Free"], "by monthly cost");
  assert.equal(view.total, 11, "the NAB card has no fee on file, so it's just a card");
  assert.equal(view.uncounted, 1, "Microsoft 365 has no cost yet");
  assert.deepEqual(view.monthly, [
    { currency: "AUD", amount: Math.round((91 / 12 + 42.99 / 12 + 12.99 + 2.99 + (21 * 52) / 12 + 148.25 + 4766.68 + 82.22 / 3 + 295 / 12) * 100) / 100, records: 9 },
    { currency: "USD", amount: 16, records: 1 },
  ]);
  const groups = view.accounts.map((group) => [group.source?.label ?? group.said ?? group.key, names(group.bills)]);
  assert.deepEqual(groups, [
    ["NAB Qantas Rewards Signature card ending 2686", ["Amazon Prime", "Prime Video Ad Free"]],
    ["Westpac Altitude Qantas Black World Mastercard", ["Westpac Altitude Qantas Black World Mastercard"]],
    ["Westpac Choice ending 2902", ["Lease, Unit 44"]],
    ["unknown", ["Motorcycle registration", "GitHub Team - NAVA", "Chess Gold", "Microsoft 365 Business Premium - NAVA", "Medibank", "Allways Coffee subscription", "AGL gas"]],
  ]);
  assert.deepEqual(billsMonthlyCost(records, typeOf), view.monthly, "the Records line and list_records use the same rule");
});

test("a closed card's group is flagged, after open ones, and what matched nothing is shown as written", () => {
  const view = billsView([
    ...ACCOUNTS,
    row("subscriptions.service", { name: "Old streaming", amount: 10, cycle: "monthly", paid_with: "Amex ending 1000" }),
    row("subscriptions.service", { name: "Gym", amount: 20, cycle: "fortnightly", paid_with: "PayPal" }),
  ], typeOf, TODAY, SOURCES);
  const keys = view.accounts.map((group) => [group.source?.label ?? group.said, group.source?.closed ?? null]);
  assert.deepEqual(keys, [
    ["Westpac Altitude Qantas Black World Mastercard", false],
    ["Qantas American Express Ultimate Card ending 1000", true],
    ["PayPal", null],
  ]);
});
