// E03-S13 — Policy engine `evaluate()` (`src/domain/policy/evaluate.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (the `{ decision, reason, ruleId? }` the function
// RETURNS for a given call + context), never the source text of the module, so a
// later rename that keeps behaviour leaves them untouched.
//
// This is a pure domain module (CLAUDE.md / conventions: `src/domain/**` has no
// React, no DB, no fetch, no process.env, no Date.now — "take a clock"). The
// policy engine is checked in code on every agent request before any connector
// call or release (design §6 pipeline, §8). It COMPOSES the sibling pure modules
// built before it — rules (`conditionMatches`, the rule vocabulary), budgets
// (`evaluateBudget`, `budgetAllowsCard`) and currency (`convert`) — and must be
// deterministic: the same inputs always give the same output. Time enters only as
// an injected `now: Date`; the daily reference rate enters only as an injected
// value.
//
// The ordered algorithm is design §8, verbatim:
//   1. agent connection active            else deny "disconnected"
//   2. permission: connector granted, tool granted, tool class allowed
//                                          else deny (missing permission)
//   3. a matching NEVER-ALLOW rule         deny, carrying that rule's id
//   4. for a CARD request: card access on + budget set; per-purchase limit;
//      the agent's budget for its period; member limit + household budget (in the
//      household currency); merchant allow/block lists; currency converted with
//      the injected reference rate — no rate → deny. Any failure → deny (plain reason)
//   5. a HIGH-TIER or CARD request         always ask (needs the person)
//   6. a matching ASK-FIRST rule, or the change-tool class default "ask me first"
//                                          ask (a rule match carries its id)
//   7. otherwise                           allow
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
// `evaluate(call, ctx)` takes the request being made and the person's configured
// state, and returns a deterministic decision. Field names are camelCase to match
// every other `src/domain` interface (`readTools`, `rateDate`, `budgetAllowsCard`,
// …); the design doc's prose `rule_id` is rendered here as `ruleId`.
//
//   type Decision = "allow" | "ask" | "deny";
//
//   interface PolicyResult { decision: Decision; reason: string; ruleId?: string; }
//
//   // A rule carrying the id the engine reports when the rule fires. The rule
//   // shape is EXACTLY the rules module's `Rule` (kind/scope/action/condition).
//   type IdentifiedRule = Rule & { id: string };
//
//   // What the agent is asking to do. A connector tool names its `connector`;
//   // a core request (card / high-tier) has `connector: null` and is discriminated
//   // by `request`. `makesChange` is the tool class (false = reads). A message-
//   // sending tool sets `messageChannel`. Card requests carry amount/currency/
//   // merchant; `recipients` feeds recipient rule conditions.
//   interface PolicyCall {
//     connector: string | null;
//     tool: string;
//     makesChange: boolean;
//     messageChannel?: "email" | "chat" | "post";
//     request?: "card" | "high_tier";
//     amount?: number;
//     currency?: string;
//     merchant?: string;
//     recipients?: string | readonly string[] | null;
//   }
//
//   // The agent's permission for a connector tool (design §8 step 2). A core
//   // request (connector === null) skips these connector checks: a card request is
//   // gated by step 4, a high-tier request by `highTierAllowed`.
//   interface Permission {
//     connectorGranted: boolean;
//     grantedTools: readonly string[];        // the tool must be in here
//     readsAllowed: boolean;                  // the read tool class is allowed
//     changes: "off" | "allow" | "ask_first"; // the change tool class setting
//     highTierAllowed: boolean;
//   }
//
//   // The person's card settings (design §8 step 4). `budget` is the agent's card
//   // budget in the account currency; `releases` are that agent's approved
//   // releases. `household` is present only when the person is in a household and
//   // carries that member's limit and the shared household budget, both in the
//   // household currency.
//   interface CardPolicy {
//     access: boolean;
//     budget: Budget;                         // { amount, period } from budget.ts
//     releases: readonly Release[];           // { amount, at } from budget.ts
//     perPurchaseLimit?: number;
//     merchantAllow?: readonly string[];      // if set, the merchant must be in it
//     merchantBlock?: readonly string[];      // the merchant must not be in it
//     household?: HouseholdPolicy;
//   }
//   interface HouseholdPolicy {
//     currency: string;
//     budget: Budget;                         // the shared household budget
//     budgetReleases: readonly Release[];     // household-wide releases
//     memberLimit: Budget;                    // this member's limit
//     memberReleases: readonly Release[];     // this member's releases
//   }
//
//   // The person's configured state. `agentId` is the calling connection's agent
//   // (so an agent-scoped rule can target it). `rate` converts a foreign-currency
//   // card request into the account/household currency (`rate.from` = the request
//   // currency, `rate.to` = the account/household currency); a missing rate for a
//   // foreign request denies.
//   interface PolicyContext {
//     connectionActive: boolean;
//     agentId: string;
//     permission: Permission;
//     rules: readonly IdentifiedRule[];
//     accountCurrency: string;
//     card: CardPolicy;
//     rate?: ReferenceRate | null;            // from currency/convert.ts
//     now: Date;
//   }
//
//   function evaluate(call: PolicyCall, ctx: PolicyContext): PolicyResult;
//
// Reason assertions below are deliberately loose (a decision + a generous keyword,
// never exact prose): the AC requires "a plain reason" that names the cause, but
// the wording is the builder's. The precise behaviours — which decision, which
// rule id, and the ORDER in which checks win — are what the tests pin exactly.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  type PolicyCall,
  type PolicyContext,
  type PolicyResult,
  type Permission,
  type CardPolicy,
  type HouseholdPolicy,
  type IdentifiedRule,
} from "./evaluate";

// ---------------------------------------------------------------------------
// Fixtures — a permissive baseline that ALLOWS, with factory overrides per test.
// NOW sits inside the March 2026 UTC month, so releases dated in March count
// toward a monthly window and the budget arithmetic is easy to read.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-15T12:00:00.000Z");
const march = (day: number): Date => new Date(`2026-03-${String(day).padStart(2, "0")}T10:00:00.000Z`);

function makePermission(overrides: Partial<Permission> = {}): Permission {
  return {
    connectorGranted: true,
    grantedTools: ["gmail__read", "gmail__send"],
    readsAllowed: true,
    changes: "allow",
    highTierAllowed: true,
    ...overrides,
  };
}

function makeHousehold(overrides: Partial<HouseholdPolicy> = {}): HouseholdPolicy {
  return {
    currency: "AUD",
    budget: { amount: 500, period: "month" },
    budgetReleases: [],
    memberLimit: { amount: 200, period: "month" },
    memberReleases: [],
    ...overrides,
  };
}

function makeCard(overrides: Partial<CardPolicy> = {}): CardPolicy {
  return {
    access: true,
    budget: { amount: 200, period: "month" },
    releases: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    connectionActive: true,
    agentId: "agent-1",
    permission: makePermission(),
    rules: [],
    accountCurrency: "AUD",
    card: makeCard(),
    rate: null,
    now: NOW,
    ...overrides,
  };
}

// Call factories. A read tool allows by default; a change tool allows by default
// (changes: "allow"); a card / high-tier request has connector === null.
function readCall(overrides: Partial<PolicyCall> = {}): PolicyCall {
  return { connector: "gmail", tool: "gmail__read", makesChange: false, ...overrides };
}
function changeCall(overrides: Partial<PolicyCall> = {}): PolicyCall {
  return { connector: "gmail", tool: "gmail__send", makesChange: true, ...overrides };
}
function cardCall(overrides: Partial<PolicyCall> = {}): PolicyCall {
  return {
    connector: null,
    tool: "request_card",
    makesChange: false,
    request: "card",
    amount: 42,
    currency: "AUD",
    merchant: "BoxCo",
    ...overrides,
  };
}
function highTierCall(overrides: Partial<PolicyCall> = {}): PolicyCall {
  return { connector: null, tool: "request_identity_detail", makesChange: false, request: "high_tier", ...overrides };
}

const DECISIONS = new Set(["allow", "ask", "deny"]);
function assertShape(r: PolicyResult): void {
  assert.ok(DECISIONS.has(r.decision), `decision is one of allow/ask/deny (got ${r.decision})`);
  assert.equal(typeof r.reason, "string", "reason is a string");
  assert.ok(r.reason.length > 0, "reason is non-empty — every decision explains itself");
}

// ===========================================================================
// AC1 — evaluates IN ORDER: inactive connection, then missing permission, then
// a matching never-allow rule.
// ===========================================================================

test("an inactive connection denies with a disconnected reason", () => {
  const r = evaluate(readCall(), makeCtx({ connectionActive: false }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /disconnect|not connected/i, "the reason explains the connection is not active");
});

test("the disconnected check wins over every later check (step 1 is first)", () => {
  // Connection inactive AND the connector is not granted AND a never-allow rule
  // matches — the earliest failing step (disconnected) still decides.
  const never: IdentifiedRule = {
    id: "nv",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "specific_tool", tool: "gmail__read" },
  };
  const r = evaluate(
    readCall(),
    makeCtx({ connectionActive: false, permission: makePermission({ connectorGranted: false }), rules: [never] }),
  );
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /disconnect|not connected/i, "disconnected is reported, not the permission or the rule");
  assert.equal(r.ruleId, undefined, "a step-1 deny carries no rule id");
});

test("a request for a connector that is not granted denies", () => {
  const r = evaluate(readCall(), makeCtx({ permission: makePermission({ connectorGranted: false }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, undefined, "a permission deny is not a rule deny");
});

test("a request for a tool that is not granted denies", () => {
  const r = evaluate(readCall({ tool: "gmail__read" }), makeCtx({ permission: makePermission({ grantedTools: ["gmail__send"] }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
});

test("a read tool denies when the read tool class is not allowed", () => {
  const r = evaluate(readCall(), makeCtx({ permission: makePermission({ readsAllowed: false }) }));
  assert.equal(r.decision, "deny");
});

test("a change tool denies when its tool class is switched off", () => {
  const r = evaluate(changeCall(), makeCtx({ permission: makePermission({ changes: "off" }) }));
  assert.equal(r.decision, "deny");
});

test("a matching never-allow rule denies and carries the rule's id", () => {
  const never: IdentifiedRule = {
    id: "nv-7",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "specific_tool", tool: "gmail__read" },
  };
  const r = evaluate(readCall(), makeCtx({ rules: [never] }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, "nv-7", "the deny reports the id of the rule that forbade it");
});

test("a never-allow rule on 'any change' matches a change-making tool", () => {
  const never: IdentifiedRule = {
    id: "nv-change",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "any_change" },
  };
  const r = evaluate(changeCall(), makeCtx({ rules: [never] }));
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, "nv-change");
});

test("a never-allow send-message rule denies only when its recipient condition matches", () => {
  const never: IdentifiedRule = {
    id: "nv-corp",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "send_message", channel: "email" },
    condition: { type: "recipient_in_domain", domain: "corp.com" },
  };
  const toCorp = evaluate(
    changeCall({ messageChannel: "email", recipients: ["boss@corp.com"] }),
    makeCtx({ rules: [never] }),
  );
  assert.equal(toCorp.decision, "deny", "sending to the forbidden domain is denied");
  assert.equal(toCorp.ruleId, "nv-corp");

  const toElsewhere = evaluate(
    changeCall({ messageChannel: "email", recipients: ["friend@other.com"] }),
    makeCtx({ rules: [never] }),
  );
  assert.equal(toElsewhere.decision, "allow", "the same rule does not fire for a different domain");
});

test("a permission deny wins over a matching never-allow rule (step 2 before step 3)", () => {
  // The connector is not granted AND a never-allow rule matches. Step 2 (a plain
  // permission deny, no rule id) decides before the rule step is reached.
  const never: IdentifiedRule = {
    id: "nv",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "specific_tool", tool: "gmail__read" },
  };
  const r = evaluate(readCall(), makeCtx({ permission: makePermission({ connectorGranted: false }), rules: [never] }));
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, undefined, "the permission deny decides, so no rule id is attached");
});

test("a never-allow rule beats a co-matching ask-first rule regardless of order", () => {
  const ask: IdentifiedRule = {
    id: "af",
    kind: "ask_first",
    scope: { type: "any_agent" },
    action: { type: "specific_tool", tool: "gmail__read" },
  };
  const never: IdentifiedRule = {
    id: "nv",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "specific_tool", tool: "gmail__read" },
  };
  const r = evaluate(readCall(), makeCtx({ rules: [ask, never] }));
  assert.equal(r.decision, "deny", "never-allow (step 3) wins over ask-first (step 6)");
  assert.equal(r.ruleId, "nv");
});

// ===========================================================================
// AC2 — card requests: each failing check denies with a plain reason; a passing
// card request, and every high-tier request, always ASK.
// ===========================================================================

test("a card request with card access switched off denies", () => {
  const r = evaluate(cardCall(), makeCtx({ card: makeCard({ access: false }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /card/i, "the reason names card access");
});

test("a card request with no budget set denies", () => {
  // budgetAllowsCard requires a non-zero budget (brief: card access cannot be on
  // without a budget).
  const r = evaluate(cardCall(), makeCtx({ card: makeCard({ budget: { amount: 0, period: "month" } }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /budget|card/i);
});

test("a card request over the per-purchase limit denies", () => {
  const r = evaluate(cardCall({ amount: 42 }), makeCtx({ card: makeCard({ perPurchaseLimit: 40 }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /limit/i);
});

test("a card request that pushes the agent over its period budget denies", () => {
  // 180 already released this month + 42 proposed = 222 > the 200 monthly budget.
  const r = evaluate(
    cardCall({ amount: 42 }),
    makeCtx({ card: makeCard({ budget: { amount: 200, period: "month" }, releases: [{ amount: 180, at: march(5) }] }) }),
  );
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /budget/i);
});

test("a card request that would exceed the member's household limit denies", () => {
  // Member limit 200; 180 already spent by this member + 42 = 222 > 200. The
  // household budget and agent budget are left with plenty of room.
  const household = makeHousehold({
    budget: { amount: 5000, period: "month" },
    memberLimit: { amount: 200, period: "month" },
    memberReleases: [{ amount: 180, at: march(5) }],
  });
  const r = evaluate(cardCall({ amount: 42 }), makeCtx({ card: makeCard({ household }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /limit|household/i);
});

test("a card request that would exceed the shared household budget denies", () => {
  // Household budget 500; 480 already spent across the household + 42 = 522 > 500.
  // The member limit and agent budget are left with plenty of room.
  const household = makeHousehold({
    budget: { amount: 500, period: "month" },
    budgetReleases: [{ amount: 480, at: march(5) }],
    memberLimit: { amount: 5000, period: "month" },
  });
  const r = evaluate(cardCall({ amount: 42 }), makeCtx({ card: makeCard({ household }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /budget|household/i);
});

test("a card request to a blocked merchant denies", () => {
  const r = evaluate(cardCall({ merchant: "Casino" }), makeCtx({ card: makeCard({ merchantBlock: ["Casino"] }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /merchant/i);
});

test("a card request to a merchant outside an allow-list denies", () => {
  const r = evaluate(cardCall({ merchant: "Other" }), makeCtx({ card: makeCard({ merchantAllow: ["BoxCo"] }) }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /merchant/i);
});

test("a foreign-currency card request with no reference rate denies", () => {
  // USD request, AUD budget, no injected rate → cannot convert → deny (design §8
  // step 4: "no rate → deny").
  const r = evaluate(cardCall({ currency: "USD", amount: 42 }), makeCtx({ accountCurrency: "AUD", rate: null }));
  assertShape(r);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /rate|currenc/i);
});

test("a card request that passes every check asks (cards always need the person)", () => {
  const r = evaluate(cardCall(), makeCtx());
  assertShape(r);
  assert.equal(r.decision, "ask", "a within-limits card request is held for approval, never silently allowed");
});

test("a card request to a merchant inside the allow-list asks", () => {
  const r = evaluate(cardCall({ merchant: "BoxCo" }), makeCtx({ card: makeCard({ merchantAllow: ["BoxCo"] }) }));
  assert.equal(r.decision, "ask");
});

test("a foreign-currency card request within budget once converted asks", () => {
  // EUR 10 at 1 EUR = 1.65 AUD converts well inside the 200 AUD monthly budget, so
  // the request passes the checks and asks.
  const rate = { from: "EUR", to: "AUD", rate: 1.65, date: "2026-03-14" };
  const r = evaluate(cardCall({ currency: "EUR", amount: 10 }), makeCtx({ accountCurrency: "AUD", rate }));
  assertShape(r);
  assert.equal(r.decision, "ask", "a rate is available and the converted amount is within budget");
});

test("a high-tier identity request always asks", () => {
  const r = evaluate(highTierCall(), makeCtx());
  assertShape(r);
  assert.equal(r.decision, "ask");
});

test("a never-allow rule on a card request denies before the always-ask step", () => {
  // Step 3 (never-allow) runs before step 5 (card always asks): the rule wins.
  const never: IdentifiedRule = {
    id: "nv-card",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "card_request" },
  };
  const r = evaluate(cardCall(), makeCtx({ rules: [never] }));
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, "nv-card");
});

test("a never-allow rule on a high-tier request denies before the always-ask step", () => {
  const never: IdentifiedRule = {
    id: "nv-ht",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "high_tier_request" },
  };
  const r = evaluate(highTierCall(), makeCtx({ rules: [never] }));
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, "nv-ht");
});

test("a never-allow card rule with a merchant condition fires only for that merchant", () => {
  const never: IdentifiedRule = {
    id: "nv-casino",
    kind: "never_allow",
    scope: { type: "any_agent" },
    action: { type: "card_request" },
    condition: { type: "merchant_in", merchants: ["Casino"] },
  };
  const atCasino = evaluate(cardCall({ merchant: "Casino" }), makeCtx({ rules: [never] }));
  assert.equal(atCasino.decision, "deny", "the forbidden merchant is denied by the rule");
  assert.equal(atCasino.ruleId, "nv-casino");

  const elsewhere = evaluate(cardCall({ merchant: "BoxCo" }), makeCtx({ rules: [never] }));
  assert.equal(elsewhere.decision, "ask", "a different merchant is not caught by the rule and asks as usual");
});

// ===========================================================================
// AC3 — a matching ask-first rule or a change-tool default asks; otherwise allow;
// and the output is deterministic for the same input.
// ===========================================================================

test("a matching ask-first rule asks and carries the rule's id", () => {
  const ask: IdentifiedRule = {
    id: "af-3",
    kind: "ask_first",
    scope: { type: "any_agent" },
    action: { type: "specific_tool", tool: "gmail__read" },
  };
  const r = evaluate(readCall(), makeCtx({ rules: [ask] }));
  assertShape(r);
  assert.equal(r.decision, "ask");
  assert.equal(r.ruleId, "af-3");
});

test("an ask-first rule on a whole service matches any of that service's tools", () => {
  const ask: IdentifiedRule = {
    id: "af-svc",
    kind: "ask_first",
    scope: { type: "any_agent" },
    action: { type: "service_tool", service: "gmail" },
  };
  const r = evaluate(readCall(), makeCtx({ rules: [ask] }));
  assert.equal(r.decision, "ask");
  assert.equal(r.ruleId, "af-svc");
});

test("an agent-scoped rule fires only for that agent", () => {
  const scoped: IdentifiedRule = {
    id: "af-mine",
    kind: "ask_first",
    scope: { type: "agent", agentId: "agent-1", name: "Claude" },
    action: { type: "specific_tool", tool: "gmail__read" },
  };
  const mine = evaluate(readCall(), makeCtx({ agentId: "agent-1", rules: [scoped] }));
  assert.equal(mine.decision, "ask", "the rule targets the calling agent");
  assert.equal(mine.ruleId, "af-mine");

  const other = evaluate(readCall(), makeCtx({ agentId: "agent-2", rules: [scoped] }));
  assert.equal(other.decision, "allow", "a rule for a different agent does not fire");
});

test("a change-making tool whose class default is 'ask me first' asks, with no rule id", () => {
  const r = evaluate(changeCall(), makeCtx({ permission: makePermission({ changes: "ask_first" }) }));
  assertShape(r);
  assert.equal(r.decision, "ask");
  assert.equal(r.ruleId, undefined, "a class default is not a rule, so no rule id is reported");
});

test("an allowed read tool with no matching rule allows", () => {
  const r = evaluate(readCall(), makeCtx());
  assertShape(r);
  assert.equal(r.decision, "allow");
});

test("a change tool whose class is set to allow, with no matching rule, allows", () => {
  const r = evaluate(changeCall(), makeCtx({ permission: makePermission({ changes: "allow" }) }));
  assertShape(r);
  assert.equal(r.decision, "allow");
});

test("a non-matching rule leaves an otherwise-allowed call allowed", () => {
  const other: IdentifiedRule = {
    id: "af-other",
    kind: "ask_first",
    scope: { type: "any_agent" },
    action: { type: "specific_tool", tool: "gmail__send" }, // not the read call's tool
  };
  const r = evaluate(readCall(), makeCtx({ rules: [other] }));
  assert.equal(r.decision, "allow");
  assert.equal(r.ruleId, undefined);
});

test("evaluate is deterministic — the same inputs give an identical result", () => {
  const allowCall = readCall();
  const allowCtx = makeCtx();
  assert.deepStrictEqual(evaluate(allowCall, allowCtx), evaluate(allowCall, allowCtx), "an allow is stable");

  const denyCall = cardCall({ amount: 42 });
  const denyCtx = makeCtx({ card: makeCard({ perPurchaseLimit: 10 }) });
  assert.deepStrictEqual(evaluate(denyCall, denyCtx), evaluate(denyCall, denyCtx), "a deny is stable");

  const askCall = highTierCall();
  const askCtx = makeCtx();
  assert.deepStrictEqual(evaluate(askCall, askCtx), evaluate(askCall, askCtx), "an ask is stable");
});

test("evaluate does not mutate the injected clock instant", () => {
  const before = NOW.getTime();
  evaluate(cardCall({ amount: 42 }), makeCtx({ card: makeCard({ releases: [{ amount: 180, at: march(5) }] }) }));
  assert.equal(NOW.getTime(), before, "the injected `now` is left untouched (pure, no side effects)");
});
