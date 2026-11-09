import type { Db } from "../db/index";
import type { CardBudget } from "../db/agent-permissions";
import { sumByCurrencyForConnectionPeriod, periodKeyFor } from "../db/card-spend-ledger";
import { getRate } from "../db/exchange-rates";
import { convert } from "../../domain/currency/convert";

export interface UnconvertedAgentSpend { readonly currency: string; readonly amount: number }

// A budget can change currency without rewriting earlier releases. Every budget
// reader and the locked release check must count those releases in the CURRENT
// budget currency, never silently sum unlike units or treat a missing rate as zero.
export async function readAgentSpending(
  db: Db, userId: string, connectionId: string, budget: CardBudget,
  now: Date, timeZone?: string,
) {
  const subtotals = await sumByCurrencyForConnectionPeriod(db, userId, connectionId,
    budget.period, periodKeyFor(budget.period, now, timeZone));
  let total = 0;
  const unconverted: UnconvertedAgentSpend[] = [];
  for (const { currency, total: amount } of subtotals) {
    if (currency === budget.currency) { total += amount; continue; }
    const rate = await getRate(db, { on: periodKeyFor("day", now, timeZone),
      baseCurrency: currency, quoteCurrency: budget.currency });
    const result = convert(amount, rate.found
      ? { from: currency, to: budget.currency, rate: rate.rate, date: rate.rateDate } : null);
    if (result.ok && Number.isFinite(result.converted.amount)) total += result.converted.amount;
    else unconverted.push({ currency, amount });
  }
  return { total, unconverted };
}
