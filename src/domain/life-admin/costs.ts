// What the person's recurring records cost a month (docs/adr/life-admin-profile.md): the figure
// agents get from list_records and the Records tab shows, worked out here once rather than by an
// agent or the page. "What do I pay?" cuts across categories (subscriptions, utilities, insurance,
// a health fund), so it is a figure over records, not a category of its own.
//
// A record counts when it has a numeric amount and a repeating cycle; a one-off, an unknown cycle
// or no amount doesn't. A record with no currency counts as AUD.
//
// Pure domain module: no React, no DB, no clock.

import { MONTHS_PER_CYCLE, type Cycle } from "./record-types";

export interface MonthlyCost {
  readonly currency: string;
  // Rounded to the cent.
  readonly amount: number;
  // How many records make it up.
  readonly records: number;
}

type Repeating = Exclude<Cycle, "one_off">;

/** The monthly figure per currency, in the order the currencies first appear. */
export function monthlyCost(records: readonly { readonly fields: Readonly<Record<string, unknown>> }[]): MonthlyCost[] {
  const items: { currency: string; monthly: number }[] = [];
  for (const record of records) {
    const amount = Number(record.fields.amount);
    const cycle = record.fields.cycle;
    if (!Number.isFinite(amount) || typeof cycle !== "string" || !(cycle in MONTHS_PER_CYCLE)) continue;
    const currency = typeof record.fields.currency === "string" && record.fields.currency ? record.fields.currency : "AUD";
    items.push({ currency, monthly: amount / MONTHS_PER_CYCLE[cycle as Repeating] });
  }
  return monthlyTotals(items);
}

/** Monthly amounts summed per currency (rounded to the cent), in the order currencies first appear. */
export function monthlyTotals(items: readonly { readonly currency: string; readonly monthly: number }[]): MonthlyCost[] {
  const totals = new Map<string, { amount: number; records: number }>();
  for (const item of items) {
    const total = totals.get(item.currency) ?? { amount: 0, records: 0 };
    total.amount += item.monthly;
    total.records += 1;
    totals.set(item.currency, total);
  }
  return [...totals].map(([currency, total]) => ({ currency, amount: Math.round(total.amount * 100) / 100, records: total.records }));
}
