// E03-S13 — Policy engine `evaluate()` (design §8).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now —
// time enters only as the injected `ctx.now: Date` and the daily reference rate
// only as the injected `ctx.rate`. The engine is checked in code on every agent
// request before any connector call or release is offered, and is deterministic:
// the same inputs always give the same `{ decision, reason, ruleId? }`.
//
// It COMPOSES the sibling pure modules built before it rather than re-deriving
// their logic: the rule vocabulary and `conditionMatches` from `../rules/rules`,
// `evaluateBudget` / `budgetAllowsCard` from `../budget/budget`, and `convert`
// from `../currency/convert`.

import {
  conditionMatches,
  merchantInList,
  type MatchContext,
  type Rule,
  type RuleAction,
  type RuleScope,
} from "../rules/rules";
import {
  budgetAllowsCard,
  evaluateBudget,
  type Budget,
  type Release,
} from "../budget/budget";
import { convert, type ReferenceRate } from "../currency/convert";

/** The three decisions the engine can reach. */
export type Decision = "allow" | "ask" | "deny";

/** The deterministic outcome of a policy check. `ruleId` is set only when a rule decided. */
export interface PolicyResult {
  decision: Decision;
  reason: string;
  ruleId?: string;
}

/** A rule carrying the id the engine reports when it fires. */
export type IdentifiedRule = Rule & { id: string };

/**
 * What the agent is asking to do. A connector tool names its `connector`; a core
 * request (card / high-tier) has `connector: null` and is discriminated by
 * `request`. `makesChange` is the tool class (false = a read).
 */
export interface PolicyCall {
  connector: string | null;
  tool: string;
  makesChange: boolean;
  messageChannel?: "email" | "chat" | "post";
  request?: "card" | "high_tier";
  amount?: number;
  currency?: string;
  merchant?: string;
  recipients?: string | readonly string[] | null;
  /**
   * The tool always asks the person first, whatever the agent may do alone (a LinkedIn post:
   * docs/adr/linkedin-connector.md). Its effect is known, so rules match it as written; a
   * denial or a never-allow rule still refuses it, and approving the ask lets it run.
   */
  alwaysAsk?: boolean;
}

/** The agent's permission for a connector tool (design §8 step 2). */
export interface Permission {
  connectorGranted: boolean;
  grantedTools: readonly string[];
  readsAllowed: boolean;
  changes: "off" | "allow" | "ask_first";
  highTierAllowed: boolean;
}

/**
 * This member's limit and the shared household budget, in the household currency. A leg
 * the owner has not set is absent and imposes no cap. `rate` converts a request made in
 * another currency into the household currency, for when the household currency differs
 * from the account currency (otherwise the account-currency amount is used as is).
 */
export interface HouseholdPolicy {
  periodUnavailable?: boolean;
  currency: string;
  totalsUnavailable?: boolean;
  budget?: Budget;
  budgetReleases: readonly Release[];
  memberLimit?: Budget;
  memberReleases: readonly Release[];
  rate?: ReferenceRate | null;
}

/** The person's card settings (design §8 step 4). Budgets are in the account currency. */
export interface CardPolicy {
  access: boolean;
  totalsUnavailable?: boolean;
  budget: Budget;
  releases: readonly Release[];
  perPurchaseLimit?: number;
  merchantAllow?: readonly string[];
  merchantBlock?: readonly string[];
  household?: HouseholdPolicy;
}

/** The person's configured state for one agent request. */
export interface PolicyContext {
  connectionActive: boolean;
  agentId: string;
  permission: Permission;
  rules: readonly IdentifiedRule[];
  accountCurrency: string;
  /** Rule thresholds use the owner's account currency, independently of an agent budget. */
  ruleCurrency?: string;
  ruleRate?: ReferenceRate | null;
  card: CardPolicy;
  rate?: ReferenceRate | null;
  now: Date;
}

// --- result helpers --------------------------------------------------------

function deny(reason: string, ruleId?: string): PolicyResult {
  return ruleId === undefined ? { decision: "deny", reason } : { decision: "deny", reason, ruleId };
}
function ask(reason: string, ruleId?: string): PolicyResult {
  return ruleId === undefined ? { decision: "ask", reason } : { decision: "ask", reason, ruleId };
}
function allow(reason: string): PolicyResult {
  return { decision: "allow", reason };
}

// --- rule matching (shared by the never-allow and ask-first passes) --------

function scopeMatches(scope: RuleScope, agentId: string): boolean {
  return scope.type === "any_agent" ? true : scope.agentId === agentId;
}

function actionMatches(action: RuleAction, call: PolicyCall): boolean {
  switch (action.type) {
    case "send_message":
      return call.messageChannel === action.channel;
    case "specific_tool":
      return call.tool === action.tool;
    case "service_tool":
      return call.connector === action.service;
    case "any_change":
      return call.makesChange;
    case "card_request":
      return call.request === "card";
    case "high_tier_request":
      return call.request === "high_tier";
  }
}

function matchContext(call: PolicyCall): MatchContext {
  return { recipients: call.recipients, amount: call.amount, merchant: call.merchant };
}

function ruleMatches(rule: IdentifiedRule, call: PolicyCall, ctx: PolicyContext): boolean {
  if (!scopeMatches(rule.scope, ctx.agentId)) return false;
  if (!actionMatches(rule.action, call)) return false;
  if (rule.condition && !conditionMatches(rule.condition, matchContext(call))) return false;
  return true;
}

function firstMatch(
  rules: readonly IdentifiedRule[],
  kind: Rule["kind"],
  call: PolicyCall,
  ctx: PolicyContext,
): IdentifiedRule | undefined {
  for (const rule of rules) {
    if (rule.kind === kind && ruleMatches(rule, call, ctx)) return rule;
  }
  return undefined;
}

// --- step 4: card request checks -------------------------------------------

/**
 * The request amount in the household currency: the account-currency amount when the two
 * currencies match, the requested amount when it was already asked in the household
 * currency, and otherwise a conversion with the household rate (no usable rate refuses).
 */
function householdAmount(
  call: PolicyCall,
  household: HouseholdPolicy,
  ctx: PolicyContext,
  requested: number,
  inAccountCurrency: number,
): { ok: true; amount: number } | { ok: false; reason: string } {
  if (household.currency === ctx.accountCurrency) return { ok: true, amount: inAccountCurrency };
  if ((call.currency ?? ctx.accountCurrency) === household.currency) return { ok: true, amount: requested };
  const converted = convert(requested, household.rate);
  return converted.ok ? { ok: true, amount: converted.converted.amount } : { ok: false, reason: converted.reason };
}

/**
 * Run every card check (design §8 step 4) and return a deny on the first failure,
 * or undefined when the request passes (the caller then asks). The amount is
 * converted into the account/household currency with the injected reference rate;
 * a foreign request with no usable rate denies.
 */
function evaluateCard(call: PolicyCall, ctx: PolicyContext): PolicyResult | undefined {
  const card = ctx.card;

  if (!card.access) return deny("Card access is turned off for this agent.");
  if (!budgetAllowsCard(card.budget)) return deny("No card budget is set for this agent.");
  if (card.totalsUnavailable) return deny("A reference rate is missing for earlier agent spending. The budget cannot be checked yet.");

  const requested = call.amount ?? 0;
  let amount = requested;
  if (call.currency !== undefined && call.currency !== ctx.accountCurrency) {
    const converted = convert(requested, ctx.rate);
    if (!converted.ok) return deny(converted.reason);
    amount = converted.converted.amount;
  }

  if (card.perPurchaseLimit !== undefined && amount > card.perPurchaseLimit) {
    return deny("This amount is over the per-purchase limit.");
  }

  if (evaluateBudget(card.budget, card.releases, amount, ctx.now).overBudget) {
    return deny("This would put the agent over its card budget.");
  }

  const household = card.household;
  if (household) {
    if (household.periodUnavailable) return deny("Earlier household release dates need checking before this budget can be confirmed.");
    if (household.totalsUnavailable) return deny("A reference rate is missing for earlier household spending. The budget cannot be checked yet.");
    const inHousehold = householdAmount(call, household, ctx, requested, amount);
    if (!inHousehold.ok) return deny(inHousehold.reason);
    if (
      household.memberLimit &&
      evaluateBudget(household.memberLimit, household.memberReleases, inHousehold.amount, ctx.now).overBudget
    ) {
      return deny("This would put you over your household spending limit.");
    }
    if (
      household.budget &&
      evaluateBudget(household.budget, household.budgetReleases, inHousehold.amount, ctx.now).overBudget
    ) {
      return deny("This would put the household over its shared budget.");
    }
  }

  if (card.merchantBlock && call.merchant !== undefined && merchantInList(call.merchant, card.merchantBlock)) {
    return deny("This merchant is on your block list.");
  }
  if (card.merchantAllow && !(call.merchant !== undefined && merchantInList(call.merchant, card.merchantAllow))) {
    return deny("This merchant is not on your allow list.");
  }

  return undefined;
}

// --- evaluate --------------------------------------------------------------

/**
 * Decide allow / ask / deny for one agent request, in the order of design §8.
 * Pure and deterministic; never mutates its inputs.
 */
export function evaluate(call: PolicyCall, ctx: PolicyContext): PolicyResult {
  const perm = ctx.permission;

  // 1. connection active.
  if (!ctx.connectionActive) return deny("This agent is not connected.");

  // 2. permission: a connector tool is gated by its grants and tool class; a
  //    high-tier request by `highTierAllowed`; a card request by step 4 below.
  if (call.connector !== null) {
    if (!perm.connectorGranted) return deny("This agent is not allowed to use this connector.");
    if (!perm.grantedTools.includes(call.tool)) return deny("This agent is not allowed to use this tool.");
    if (call.makesChange) {
      if (perm.changes === "off") return deny("Making changes with this connector is turned off.");
    } else if (!perm.readsAllowed) {
      return deny("Reading with this connector is turned off.");
    }
  } else if (call.request === "high_tier" && !perm.highTierAllowed) {
    return deny("This agent is not allowed to request high-tier identity details.");
  }

  // Amount conditions use the owner's account currency. Only normalize the rule
  // comparison; card checks below still need the original amount and currency.
  let ruleCall = call;
  const needsAmount = call.amount !== undefined && ctx.rules.some((rule) =>
    rule.condition?.type === "amount_over" && scopeMatches(rule.scope, ctx.agentId) && actionMatches(rule.action, call));
  const ruleCurrency = ctx.ruleCurrency ?? ctx.accountCurrency;
  if (needsAmount && call.amount !== undefined && call.currency !== undefined && call.currency !== ruleCurrency) {
    const rate = ctx.ruleCurrency === undefined ? ctx.rate : ctx.ruleRate;
    if (rate?.from !== call.currency || rate.to !== ruleCurrency) {
      return deny("No reference rate available to check the amount rule.");
    }
    const converted = convert(call.amount, rate);
    if (!converted.ok) return deny(converted.reason);
    ruleCall = { ...call, amount: converted.converted.amount };
  }

  // 3. a matching never-allow rule denies, carrying its id.
  const never = firstMatch(ctx.rules, "never_allow", ruleCall, ctx);
  if (never) return deny("A rule forbids this action.", never.id);

  // 4. card-request checks; any failure denies with a plain reason.
  if (call.request === "card") {
    const cardDeny = evaluateCard(call, ctx);
    if (cardDeny) return cardDeny;
  }

  // 5. a high-tier or card request always asks — the person is needed.
  if (call.request === "high_tier") return ask("A high-tier identity request needs your approval.");
  if (call.request === "card") return ask("A card request needs your approval.");

  // 6. a matching ask-first rule, a tool that always asks, or a change-tool class default of
  //    "ask me first".
  const askRule = firstMatch(ctx.rules, "ask_first", ruleCall, ctx);
  if (askRule) return ask("A rule asks for your approval first.", askRule.id);
  if (call.connector !== null && call.makesChange && call.alwaysAsk) {
    return ask("This always needs your approval first.");
  }
  if (call.connector !== null && call.makesChange && perm.changes === "ask_first") {
    return ask("Changes with this connector need your approval first.");
  }

  // 7. otherwise allow.
  return allow("Allowed.");
}
