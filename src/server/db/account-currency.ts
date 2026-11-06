// The account-currency aggregate's data access (brief "Currency": "the person sets
// their account currency in Settings (default AUD), and their own agent budgets and
// limits are in that currency"; a new household's currency defaults to the owner's
// account currency). One person's account currency lives in exactly one place here
// (constitution: one-source-of-truth): the budget/limit maths and a new household's
// currency read it as a plain ISO 4217 code.
//
// A person's account currency is PLAINTEXT METADATA (a short scalar — a known ISO 4217
// code) — so, like the notification preferences and unlike vault fields, cards or
// released values, it is NOT DEK-encrypted and this module holds no key and reads no
// `process.env` (config flows from `src/server/config.ts` alone, INV-103).
//
// Every statement is parameterized through the `Db` seam (INV-102): the user id and the
// chosen code travel as BOUND values, never concatenated into the SQL text, so a value
// shaped like SQL is stored as data and cannot alter the query. Every read and write is
// member-scoped by the `userId` the caller passes — the session's id, never a client
// value — so one person can never read or change another's account currency.

import type { Db } from "./index";

// What setAccountCurrency takes: the person (the SESSION's id, never a client value)
// and the chosen ISO 4217 code. A code not in the known set is rejected.
export interface SetAccountCurrencyInput {
  readonly userId: string;
  readonly currency: string;
}

// The outcome of a set: the persisted code, or a refusal because the code is not a
// known ISO 4217 currency (unknown OR malformed), in which case NOTHING was written.
export type SetAccountCurrencyResult =
  | { ok: true; currency: string }
  | { ok: false; reason: "unknown_currency" };

// The brief's default for a person who has set nothing. Assembled in code within the
// queried person's scope, never read from a column default.
const DEFAULT_CURRENCY = "AUD";

// The known set of ISO 4217 currency codes a person may choose as their account
// currency — the world's circulating national and regional currencies. A code not in
// this set is rejected: an unknown-but-well-formed code ("ZZZ"), or a malformed one
// (wrong length, non-letters, empty) — membership in the set IS the validation, so
// every such value is refused without a separate shape check. This set is the ONE
// source of truth for which codes are valid; the migration's shape CHECK is only a
// schema-level backstop.
const KNOWN_CURRENCY_CODES: ReadonlySet<string> = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD",
  "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK",
  "DJF", "DKK", "DOP", "DZD",
  "EGP", "ERN", "ETB", "EUR",
  "FJD", "FKP",
  "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD",
  "HKD", "HNL", "HTG", "HUF",
  "IDR", "ILS", "INR", "IQD", "IRR", "ISK",
  "JMD", "JOD", "JPY",
  "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
  "LAK", "LBP", "LKR", "LRD", "LSL", "LYD",
  "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR",
  "MWK", "MXN", "MYR", "MZN",
  "NAD", "NGN", "NIO", "NOK", "NPR", "NZD",
  "OMR",
  "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG",
  "QAR",
  "RON", "RSD", "RUB", "RWF",
  "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD",
  "SSP", "STN", "SVC", "SYP", "SZL",
  "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS",
  "UAH", "UGX", "USD", "UYU", "UZS",
  "VED", "VES", "VND", "VUV",
  "WST",
  "XAF", "XCD", "XOF", "XPF",
  "YER",
  "ZAR", "ZMW", "ZWG",
]);

// Read the account currency for the person with this id (member-scoped: user_id bound
// as a parameter). When the person has set none, returns the brief's default ("AUD")
// assembled in code — never another person's currency.
export async function getAccountCurrency(db: Db, userId: string): Promise<string> {
  const result = await db.query(
    "SELECT currency FROM account_currency WHERE user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (!row) return DEFAULT_CURRENCY;
  return row.currency as string;
}

// Write the ONE account-currency row for input.userId, INSERTing it or UPDATEing the
// one already there — keyed on user_id, so a second set overwrites in place and never
// duplicates. Member-scoped: the user id is bound, so a set writes the caller's OWN row
// and leaves every other person's untouched.
//
// REFUSES (returns { ok: false, reason: "unknown_currency" }, never silently) when the
// code is not in the known ISO 4217 set — the check runs BEFORE any query, so a refused
// set writes no row (the previously stored value, or the default, is left untouched and
// is NOT cleared). On success returns { ok: true, currency } assembled from the input
// (it does not depend on a RETURNING read).
export async function setAccountCurrency(
  db: Db,
  input: SetAccountCurrencyInput,
): Promise<SetAccountCurrencyResult> {
  if (!KNOWN_CURRENCY_CODES.has(input.currency)) {
    return { ok: false, reason: "unknown_currency" };
  }

  await db.query(
    `INSERT INTO account_currency (user_id, currency)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET currency = EXCLUDED.currency`,
    [input.userId, input.currency],
  );

  return { ok: true, currency: input.currency };
}
