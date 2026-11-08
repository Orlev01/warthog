// E07-S09 — Agent policy-context loader (design §6.1 pipeline, §8 policy engine).
//
// The agent-call pipeline (E07-S10) passes ONE context object to the PURE policy
// engine `evaluate(call, ctx)` (E03-S13). Assembling that object in one place —
// a connection's permission grants (E07-S05), the rules applicable to it
// (E07-S06) and its approved-release spend for the current budget period
// (E07-S07) — keeps the engine pure and testable.
//
// This is a SERVER module: it reads through the injected `Db` seam, resolves the
// person's data key through the injected `KeyWrapper` seam (to decrypt rule
// conditions, the totp-store idiom) and reads the current instant through the
// injected `Clock` seam (for the budget-period key). It reads no `process.env`
// and holds no secret (INV-103): all configuration flows in as injected seams.
//
// Every read is member-scoped by the connection's OWNING user id — never a value
// from the client (INV-102; project rule: every member-scoped read takes userId
// from the session/connection). Each underlying store binds its ids and values as
// parameters, so an id shaped like SQL travels as data and cannot alter a query.

import {
  getConnectionPermissions,
  type ConnectionPermissions,
  type PeriodKind,
} from "../db/agent-permissions";
import { periodKeyFor, sumForConnectionPeriod } from "../db/card-spend-ledger";
import { getRate } from "../db/exchange-rates";
import type { Db } from "../db/index";
import { listRules, type StoredRule } from "../db/rules";
import { getUserById } from "../db/users";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Clock } from "../seams/clock";
import { timeZoneFor } from "../spending/time-zone";
import {
  resolveCardRequestContext,
  type CardRequest,
  type CardRequestContext,
} from "../spending/household-context";
import type { Budget } from "../../domain/budget/budget";
import type { ReferenceRate } from "../../domain/currency/convert";
import type { CardPolicy, HouseholdPolicy } from "../../domain/policy/evaluate";

// The default account currency when no budget currency is set (brief: amounts
// default to AUD).
const DEFAULT_CURRENCY = "AUD";
// The budget period to sum spend over when the connection has no card budget.
const DEFAULT_PERIOD: PeriodKind = "month";

// The resolved connection the loader reads for. `userId` is the OWNING person
// (member scope) — from the session/connection, NEVER a client value.
export interface AgentConnection {
  readonly userId: string;
  readonly connectionId: string;
  readonly agentId: string;
  readonly active: boolean;
}

// The injected seams — no process.env.
export interface LoadAgentContextDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
}

// The assembled context the pipeline hands the pure engine. For a CARD request the
// loader additionally carries the resolved household + currency context (the member's
// account currency, the converted amount with its rate date, the per-member monthly
// limit and the shared household monthly budget with spend-to-date) — the fields the
// pure engine enforces (design §8 step 4). Absent when the call is not a card request.
export interface AgentContext {
  readonly permissions: ConnectionPermissions;
  readonly rules: StoredRule[];
  readonly spend: number;
  readonly accountCurrency: string;
  readonly cardRequest?: CardRequestContext;
  readonly cardChecks?: CardChecks;
}

// What a CARD request adds to the engine's inputs, ready for the pure engine: the daily
// reference rate converting the request into the agent budget's currency (`accountCurrency`;
// null when none is needed or none is on file — the engine then refuses a foreign amount
// rather than guess), and the household policy (null outside a household) — this member's
// limit and the shared budget in the household currency, each with its spend so far.
export interface CardChecks {
  readonly rate: ReferenceRate | null;
  readonly household: HouseholdPolicy | null;
}

// The card fields of an agent call, or undefined when it is not a card request with an
// amount and currency (the registry requires both on request_card).
export function cardRequestOf(call: {
  readonly request?: string;
  readonly amount?: number;
  readonly currency?: string;
}): CardRequest | undefined {
  if (call.request !== "card" || call.amount === undefined || call.currency === undefined) {
    return undefined;
  }
  return { amount: call.amount, currency: call.currency };
}

// The fallback when no card budget is set: a zero budget, which `budgetAllowsCard`
// treats as "no budget" so a card request is denied before it can ask.
const NO_BUDGET: Budget = { amount: 0, period: "month" };

// The card settings the policy engine checks (design §8 step 4). The already-spent
// total for the current budget period comes pre-summed from the loader; the engine
// sums releases inside the window, so it is handed back as one synthetic release at
// the current instant (which falls inside the window). For a card request the
// household policy (member limit + shared budget) rides along when the person is in a
// household.
export function cardPolicyFor(context: AgentContext, now: Date): CardPolicy {
  const { permissions, spend } = context;
  const budget: Budget = permissions.cardBudget
    ? { amount: permissions.cardBudget.amount, period: permissions.cardBudget.period }
    : NO_BUDGET;
  const card: CardPolicy = {
    access: permissions.cardAccess,
    budget,
    releases: spend > 0 ? [{ amount: spend, at: now }] : [],
  };
  const household = context.cardChecks?.household;
  return household ? { ...card, household } : card;
}

// One spend-so-far figure as the engine's release list: a single synthetic release at
// `now` (inside the current window), or none.
function spentSoFar(amount: number, now: Date): { amount: number; at: Date }[] {
  return amount > 0 ? [{ amount, at: now }] : [];
}

// The household policy for a resolved card request: only the legs the owner has set (an
// unset limit or budget is no cap, never "deny everything"), in the household currency,
// with the resolver's conversion of the request into that currency as its rate.
function householdPolicyFor(
  resolved: CardRequestContext,
  request: CardRequest,
  now: Date,
): HouseholdPolicy | null {
  const household = resolved.household;
  if (!household) return null;
  const policy: HouseholdPolicy = {
    currency: household.currency,
    budgetReleases: spentSoFar(household.budgetSpendToDate, now),
    memberReleases: spentSoFar(household.memberSpendToDate, now),
    rate: resolved.converted
      ? {
          from: request.currency,
          to: resolved.converted.currency,
          rate: resolved.converted.rate,
          date: resolved.converted.rateDate,
        }
      : null,
  };
  if (household.monthlyBudget !== null) {
    policy.budget = { amount: household.monthlyBudget, period: "month" };
  }
  if (household.memberLimit !== null) {
    policy.memberLimit = { amount: household.memberLimit, period: "month" };
  }
  return policy;
}

// The latest daily reference rate converting the request into the agent budget's
// currency: none needed when they match; the resolver's own conversion when it already
// targeted that currency; otherwise a lookup of the latest rate on or before today.
async function budgetRateFor(
  db: Db,
  request: CardRequest,
  budgetCurrency: string,
  resolved: CardRequestContext,
  now: Date,
): Promise<ReferenceRate | null> {
  if (request.currency === budgetCurrency) return null;
  if (resolved.converted && resolved.converted.currency === budgetCurrency) {
    return {
      from: request.currency,
      to: budgetCurrency,
      rate: resolved.converted.rate,
      date: resolved.converted.rateDate,
    };
  }
  const lookup = await getRate(db, {
    on: periodKeyFor("day", now),
    baseCurrency: request.currency,
    quoteCurrency: budgetCurrency,
  });
  return lookup.found
    ? { from: request.currency, to: budgetCurrency, rate: lookup.rate, date: lookup.rateDate }
    : null;
}

// The current budget-period bucket key is derived by `periodKeyFor` in the
// card-spend-ledger store — the one source of truth for the ledger's bucket keys —
// in the person's own time zone (`timeZoneFor`), so this loader and the spending
// read can never drift from how releases were bucketed when they were written.

// Is this rule's scope applicable to the given connection? An all-agents rule
// covers every connection; a chosen-agent rule covers only its own agent (the
// same id space as the connection/agent id). The per-call action match is the
// pure engine's job, not the loader's.
function appliesTo(rule: StoredRule, connection: AgentConnection): boolean {
  return (
    rule.scope.type === "any_agent" ||
    (rule.scope.type === "agent" && rule.scope.agentId === connection.connectionId)
  );
}

// Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK (bound by
// userId through the users store) and unwrap it through the KeyWrapper seam.
// Throws when the person has no row (never fails silently).
async function dataKeyFor(
  db: Db,
  keyWrapper: KeyWrapper,
  userId: string,
): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("loadAgentContext: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// Assemble the policy context for `connection`: its granted permissions, the
// active rules applicable to it (conditions decrypted) and its approved-release
// spend for the current budget period, every read member-scoped by
// `connection.userId`. Amounts default to AUD when no budget currency is set.
export async function loadAgentContext(
  connection: AgentConnection,
  deps: LoadAgentContextDeps,
  cardRequest?: CardRequest,
): Promise<AgentContext> {
  const { db, keyWrapper, clock } = deps;

  // Resolve the person's data key first (the member-scoped reads below need it to
  // decrypt rule conditions).
  const dek = await dataKeyFor(db, keyWrapper, connection.userId);

  const permissions = await getConnectionPermissions(db, connection.userId, connection.connectionId);
  if (!permissions) {
    throw new Error("loadAgentContext: no permissions for this connection");
  }

  // The active rules for this person, conditions decrypted, narrowed to those
  // whose scope covers this connection.
  const allRules = await listRules(db, connection.userId, dek);
  const rules = allRules.filter((rule) => appliesTo(rule, connection));

  // The current budget-period spend for THIS connection: the budget's period, or
  // the month bucket when no budget is set — in the person's own time zone (review fix
  // W4.3), the same local bucket the release handler writes.
  const timeZone = await timeZoneFor(db, connection.userId, dek);
  const budget = permissions.cardBudget;
  const period = budget?.period ?? DEFAULT_PERIOD;
  const spend = await sumForConnectionPeriod(
    db,
    connection.userId,
    connection.connectionId,
    period,
    periodKeyFor(period, clock.now(), timeZone),
  );

  const accountCurrency = budget?.currency ?? DEFAULT_CURRENCY;

  // A card request additionally resolves the household + currency context for the
  // connection's OWNING user (never a client value), delegating to the household-context
  // resolver so the pure engine can enforce the member limit and the household budget.
  if (cardRequest) {
    const resolved = await resolveCardRequestContext(connection.userId, cardRequest, { db, clock, timeZone });
    const now = clock.now();
    const cardChecks: CardChecks = {
      rate: await budgetRateFor(db, cardRequest, accountCurrency, resolved, now),
      household: householdPolicyFor(resolved, cardRequest, now),
    };
    return { permissions, rules, spend, accountCurrency, cardRequest: resolved, cardChecks };
  }

  return { permissions, rules, spend, accountCurrency };
}
