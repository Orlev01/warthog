// E15-S11 — Spending page loader + currency action (the injectable, unit-testable seam
// the thin `page.tsx` composes — the convention's `createXActions(deps)` factory, the
// same shape as the already-built life-admin / notifications / activity / home actions).
// A Next `page.tsx` entry file may export only its framework fields, so the Spending
// triad logic lives here and the entry stays thin (OBS-025).
//
// The Spending triad is the "Spending view" + "Household sharing" surface (brief;
// design §8 step 4 / §9) and is where a person sets the account currency their own
// budgets and limits are expressed in (brief "Currency", default AUD). `load` reads the
// SESSION person's OWN-agent spending detail (content decrypted under their own DEK) and
// — when they are in a household — the household TOTALS, plus their account currency and
// the selectable currency options, shaped into the props the already-render-tested
// <SpendingView/> (E15-S10) is mounted over. `setAccountCurrency` persists a chosen ISO
// 4217 code for the session person.
//
// Security (each a reviewer veto; CLAUDE.md member scope + design §5):
//   • Both methods take the person's VERIFIED Session and derive the acting user id from
//     `session.userId` — NEVER a client-supplied value. There is no userId on any input,
//     so a signed-in person reads only THEIR OWN spending (own-read + household-read both
//     resolve FROM the session id; no household id is ever taken from the client) and can
//     set only THEIR OWN account currency. Another member's merchants / release entries,
//     and any spending of a user outside their household, are never surfaced.
//   • setAccountCurrency validates the input at the boundary (INV-102): a mis-typed or
//     grossly oversized currency is rejected with a 4xx `HttpError` (parseParams) BEFORE
//     any query, so nothing is written. The chosen code is then checked against the known
//     ISO 4217 set by the account-currency store (its one-source-of-truth membership
//     check runs before any write), which refuses an unknown/malformed code with
//     { ok: false } and writes nothing. Every value reaches storage BOUND as a query
//     parameter, so a value shaped like SQL (a DROP-TABLE probe) is stored as data and
//     cannot alter a query — and, being unknown, is refused before any write at all.
//   • This module reads no `process.env` and holds no secret (INV-103): db, clock and
//     keyWrapper are INJECTED seams, so no ambient env value can surface in the loaded
//     screen or a stored row.

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import { getUserById } from "@/server/db/users";
import {
  getAccountCurrency,
  setAccountCurrency as setAccountCurrencyRow,
} from "@/server/db/account-currency";
import { readOwnSpending, type OwnSpending } from "@/server/spending/own-read";
import {
  readHouseholdSpending,
  type HouseholdSpendingReport,
} from "@/server/spending/household-read";
import type { Session } from "@/server/auth/session";
import type { Clock } from "@/server/seams/clock";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Db } from "@/server/db/index";

// The injected seams — no process.env, no secret (INV-103). `db` is the parameterizing
// database seam; `clock` supplies the period bucket to the spending reads (never SQL
// now()); `keyWrapper` unwraps the session person's own DEK so their own-agent activity
// decrypts for the own-spending detail.
export interface SpendingActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
}

// What `load` returns — the SESSION person's own-agent spending detail, the household
// totals (null when they are in no household), their current account currency and the
// selectable currency options. Its shape is assignable to <SpendingView/>'s props, so
// the page mounts the view directly with it.
export interface SpendingData {
  readonly own: OwnSpending;
  readonly household: HouseholdSpendingReport | null;
  readonly accountCurrency: string;
  readonly currencyOptions: readonly string[];
}

// The outcome of a currency set: the persisted code, or a refusal naming its reason (an
// unknown/malformed code). Never a silent success — the page maps a refusal to a 4xx
// notice.
export type SetCurrencyResult = { ok: true; currency?: string } | { ok: false; reason: string };

export interface SetAccountCurrencyInput {
  readonly currency: string;
}

export interface SpendingActions {
  // Turn the verified session into the view's data: ONLY the session person's own
  // spending + their household totals + their account currency + the options
  // (member-scoped by `session.userId`, never a client value). READ-ONLY.
  load(session: Session): Promise<SpendingData>;
  // Persist a chosen ISO 4217 code for the session person only.
  setAccountCurrency(session: Session, input: SetAccountCurrencyInput): Promise<SetCurrencyResult>;
}

// The currencies the account-currency selector offers. Each is a circulating ISO 4217
// code the account-currency store's known set accepts, so there is NO DEAD OPTION — every
// offered code is one `setAccountCurrency` actually persists. The default (AUD) and USD
// are always present; the current account currency is folded in by `optionsFor` so the
// selector can always show the person's own choice.
const CURRENCY_OPTIONS: readonly string[] = [
  "AUD", "USD", "EUR", "GBP", "NZD", "CAD", "JPY", "SGD", "HKD", "CHF", "CNY", "INR",
];

// The offered options for a person on `current`: the curated list, with the person's
// current currency folded in first when it is not already offered (a stored currency has
// already passed the store's known-set check, so it is settable — never a dead option).
function optionsFor(current: string): readonly string[] {
  return CURRENCY_OPTIONS.includes(current) ? CURRENCY_OPTIONS : [current, ...CURRENCY_OPTIONS];
}

// Validate the untrusted currency at the boundary (INV-102): a value that is not a
// bounded string is rejected with a 4xx before any query. Membership in the known ISO
// 4217 set is the account-currency store's one-source-of-truth check (a well-formed but
// unknown code is refused there), so the boundary only guards shape and size here.
const MAX_CURRENCY_LEN = 64;
const setCurrencySchema = z.object({ currency: z.string().max(MAX_CURRENCY_LEN) });

export function createSpendingActions(deps: SpendingActionsDeps): SpendingActions {
  const { db, clock, keyWrapper } = deps;

  // Resolve the session person's unwrapped 256-bit DEK: read their wrapped DEK
  // (member-scoped by `userId`, the session's — never a client value) and unwrap it
  // through the injected KeyWrapper. Throws when the person has no row — never fails
  // silently (the page-data idiom shared with the siblings).
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("createSpendingActions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Read ONLY the session person's own-agent spending detail (decrypted under their own
  // DEK) and, when they are in a household, the household TOTALS — both resolved from
  // `session.userId` alone, so another member's merchants/entries and any spending of a
  // user outside their household are never returned — plus their account currency and the
  // selectable options.
  async function load(session: Session): Promise<SpendingData> {
    const userId = session.userId;
    const dek = await dataKeyFor(userId);
    const own = await readOwnSpending(db, userId, dek, clock);
    const household = await readHouseholdSpending(userId, { db, clock });
    const accountCurrency = await getAccountCurrency(db, userId);
    return { own, household, accountCurrency, currencyOptions: optionsFor(accountCurrency) };
  }

  // Persist a chosen account currency for the session person only. Validate the input at
  // the boundary first (a mis-typed/oversized value is a 4xx before any query), then write
  // through the account-currency store member-scoped by `session.userId` (the user id and
  // the code travel as BOUND values). The store refuses an unknown/malformed code with
  // { ok: false } and writes nothing — a previously stored value survives.
  async function setAccountCurrency(
    session: Session,
    input: SetAccountCurrencyInput,
  ): Promise<SetCurrencyResult> {
    const valid = parseParams(setCurrencySchema, input);
    return setAccountCurrencyRow(db, { userId: session.userId, currency: valid.currency });
  }

  return { load, setAccountCurrency };
}
