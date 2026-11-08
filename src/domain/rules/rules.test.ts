// E03-S04 — Rule model, conditions and ruleSentence (`src/domain/rules/rules.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (the string `ruleSentence` returns, the boolean
// `conditionMatches` returns, the list `resolveRecipients` returns), never the
// source text of the module, so a later rename that keeps behaviour leaves them
// untouched.
//
// This is a pure domain module (conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now). Rules are enforced in code and must read
// back as the exact English sentence; the policy engine (design §8) and the
// approval inbox both consume condition evaluation and recipient resolution, which
// is why those primitives live here, pure, built before their consumers.
//
// The vocabulary is EXACTLY the brief's (brief.yaml "Rules and approvals"):
//   kind      : "ask_first"  ("Ask me before <agent> …")
//               "never_allow" ("Never allow <agent> to …")
//   scope     : any agent, or a chosen (named) agent
//   action    : a specific tool · any tool of a chosen service · any change-making
//               tool · any tool that sends a message (email/chat/post) · a card
//               request · a high-tier identity request
//   condition : recipient equals an address · recipient belongs to a domain ·
//               amount is over a figure · merchant is in a list · merchant is not
//               in a list     (the "[when <condition>]" part is OPTIONAL)
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
// The sentence family is anchored by the brief's own worked example — verbatim —
// "Ask me before any agent sends email to manager@example.com"; the other rendered
// forms below are one self-consistent rendering of that same template (same verb,
// same word order), so a single renderer satisfies them all:
//
//   type RuleKind = "ask_first" | "never_allow";
//
//   // Which agent(s) the rule covers. `any_agent` renders "any agent"; a named
//   // agent renders its `name`.
//   type RuleScope =
//     | { type: "any_agent" }
//     | { type: "agent"; name: string; /* + agentId etc. — builder's choice */ };
//
//   // Only the `send_message` action is exercised by the sentence tests (the one
//   // the AC example names). The others exist in the model but their rendered
//   // wording is NOT pinned here — this task's AC names a single example sentence,
//   // so inventing wording for card/high-tier/tool/service actions would lock the
//   // builder into choices the AC never made. Condition EVALUATION below covers
//   // the amount/merchant/recipient families instead.
//   type RuleAction =
//     | { type: "send_message"; channel: "email" | "chat" | "post" }
//     | /* a specific tool · a whole service · any change · card · high-tier */ ...;
//
//   type RuleCondition =
//     | { type: "recipient_is"; address: string }
//     | { type: "recipient_in_domain"; domain: string }
//     | { type: "amount_over"; amount: number }
//     | { type: "merchant_in"; merchants: readonly string[] }
//     | { type: "merchant_not_in"; merchants: readonly string[] };
//
//   interface Rule { kind; scope; action; condition?; /* optional */ }
//
//   // ruleSentence(rule): the pure renderer. Named explicitly in design §8.
//   function ruleSentence(rule: Rule): string;
//
//   // The context a condition is evaluated against. Recipients are a LIST (an
//   // email may have several); a recipient condition matches when ANY recipient
//   // matches. Amount/merchant carry the figure/merchant of a card request. The
//   // amount is already in the rule's currency — cross-currency conversion is the
//   // policy engine's job, never this pure comparison's.
//   interface MatchContext { recipients?; amount?; merchant?; }
//
//   // conditionMatches(condition, ctx): does the request satisfy the condition?
//   function conditionMatches(condition: RuleCondition, ctx: MatchContext): boolean;
//
//   // resolveRecipients(value): the shared recipient-resolution primitive — turn a
//   // single address or a list of addresses into a trimmed, blanks-removed list.
//   // Case is NOT altered here (the approval inbox shows recipients verbatim);
//   // case-insensitive COMPARISON is conditionMatches' job, asserted below.
//   function resolveRecipients(value: string | readonly string[] | null | undefined): string[];
//
// These tests build Rule / condition / context objects as plain literals (typed
// loosely, like the hash-chain suite's local fixtures) and assert only on what the
// three functions RETURN — never on how the module is written.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ruleSentence, conditionMatches, resolveRecipients, normaliseMerchant } from "./rules";

// ---------------------------------------------------------------------------
// Local structural fixtures — loosely typed so they stay assignable to whatever
// (reasonable) shape the implementation gives the model.
// ---------------------------------------------------------------------------

type Scope = { type: "any_agent" } | { type: "agent"; agentId: string; name: string };
type Condition =
  | { type: "recipient_is"; address: string }
  | { type: "recipient_in_domain"; domain: string }
  | { type: "amount_over"; amount: number }
  | { type: "merchant_in"; merchants: string[] }
  | { type: "merchant_not_in"; merchants: string[] };

interface Rule {
  kind: "ask_first" | "never_allow";
  scope: Scope;
  action: { type: string; [k: string]: unknown };
  condition?: Condition;
}

const ANY_AGENT: Scope = { type: "any_agent" };
const CLAUDE: Scope = { type: "agent", agentId: "agt_claude", name: "Claude" };

const SENDS_EMAIL = { type: "send_message", channel: "email" } as const;

const MANAGER = "manager@example.com";

// Build the AC's worked rule, parameterised by kind / scope / whether the optional
// recipient condition is present.
function emailRule(
  kind: Rule["kind"],
  scope: Scope,
  condition?: Condition,
): Rule {
  return { kind, scope, action: { ...SENDS_EMAIL }, condition };
}

// ===========================================================================
// ruleSentence — AC1: a rule renders to its exact sentence.
// ===========================================================================

test("ruleSentence renders the brief's worked example verbatim", () => {
  // The anchor of the whole sentence family — brief.yaml gives this one word for
  // word: an ask-first rule, for any agent, on the email-sending action, with a
  // recipient-equals condition.
  const rule = emailRule("ask_first", ANY_AGENT, { type: "recipient_is", address: MANAGER });
  assert.equal(
    ruleSentence(rule),
    "Ask me before any agent sends email to manager@example.com",
    "the ask-first email-to-an-address rule reads back as the brief's exact sentence",
  );
});

test("ruleSentence renders a never-allow rule with the 'Never allow … to …' template", () => {
  const rule = emailRule("never_allow", ANY_AGENT, { type: "recipient_is", address: MANAGER });
  assert.equal(
    ruleSentence(rule),
    "Never allow any agent to send email to manager@example.com",
    "a never-allow rule reads back with the brief's second template and the infinitive verb",
  );
});

test("ruleSentence names a chosen agent instead of 'any agent'", () => {
  const rule = emailRule("ask_first", CLAUDE, { type: "recipient_is", address: MANAGER });
  assert.equal(
    ruleSentence(rule),
    "Ask me before Claude sends email to manager@example.com",
    "a rule scoped to one agent renders that agent's name as the subject",
  );
});

test("ruleSentence omits the condition clause when the rule has no condition", () => {
  // The "[when <condition>]" part is optional; without it the sentence stops after
  // the action and carries no dangling "to"/"when".
  const rule = emailRule("ask_first", ANY_AGENT, undefined);
  assert.equal(
    ruleSentence(rule),
    "Ask me before any agent sends email",
    "an unconditional rule renders just the subject and action, with no trailing clause",
  );
});

// ===========================================================================
// conditionMatches — AC2: recipient (exact + domain), amount-over, and merchant
// in/not-in conditions evaluate correctly.
// ===========================================================================

// --- recipient equals an exact address -------------------------------------

test("recipient_is matches when a recipient equals the address", () => {
  assert.equal(
    conditionMatches({ type: "recipient_is", address: MANAGER }, { recipients: [MANAGER] }),
    true,
    "the sole recipient equals the condition address",
  );
});

test("recipient_is does not match a different address", () => {
  assert.equal(
    conditionMatches({ type: "recipient_is", address: MANAGER }, {
      recipients: ["someone-else@example.com"],
    }),
    false,
    "a recipient at the same domain but a different address does not satisfy an exact-address rule",
  );
});

test("recipient_is matches when ANY of several recipients equals the address", () => {
  assert.equal(
    conditionMatches({ type: "recipient_is", address: MANAGER }, {
      recipients: ["a@other.com", MANAGER, "b@other.com"],
    }),
    true,
    "an email to several people satisfies the rule if one of them is the named address",
  );
});

test("recipient_is matches case-insensitively (recipient resolution)", () => {
  // Resolving a recipient for comparison ignores case — manager@example.com and
  // Manager@Example.com are the same mailbox for rule purposes.
  assert.equal(
    conditionMatches({ type: "recipient_is", address: MANAGER }, {
      recipients: ["Manager@Example.com"],
    }),
    true,
    "address comparison is case-insensitive",
  );
});

test("recipient_is does not match when there are no recipients", () => {
  assert.equal(
    conditionMatches({ type: "recipient_is", address: MANAGER }, { recipients: [] }),
    false,
    "an empty recipient list satisfies no recipient condition",
  );
});

// --- recipient belongs to a domain -----------------------------------------

test("recipient_in_domain matches when a recipient's domain equals the domain", () => {
  assert.equal(
    conditionMatches({ type: "recipient_in_domain", domain: "example.com" }, {
      recipients: ["sam@example.com"],
    }),
    true,
    "a recipient whose host is the named domain belongs to it",
  );
});

test("recipient_in_domain does not match a recipient at another domain", () => {
  assert.equal(
    conditionMatches({ type: "recipient_in_domain", domain: "example.com" }, {
      recipients: ["sam@other.com"],
    }),
    false,
    "a recipient at a different domain is not a member",
  );
});

test("recipient_in_domain matches when ANY recipient is in the domain", () => {
  assert.equal(
    conditionMatches({ type: "recipient_in_domain", domain: "example.com" }, {
      recipients: ["outsider@other.com", "insider@example.com"],
    }),
    true,
    "one recipient in the domain is enough to satisfy the condition",
  );
});

test("recipient_in_domain matches the domain case-insensitively", () => {
  assert.equal(
    conditionMatches({ type: "recipient_in_domain", domain: "example.com" }, {
      recipients: ["Sam@EXAMPLE.COM"],
    }),
    true,
    "domain comparison is case-insensitive",
  );
});

test("recipient_in_domain does not match when there are no recipients", () => {
  assert.equal(
    conditionMatches({ type: "recipient_in_domain", domain: "example.com" }, { recipients: [] }),
    false,
    "an empty recipient list belongs to no domain",
  );
});

// --- amount is over a figure -----------------------------------------------

test("amount_over matches an amount strictly above the figure", () => {
  assert.equal(
    conditionMatches({ type: "amount_over", amount: 50 }, { amount: 100 }),
    true,
    "100 is over 50",
  );
});

test("amount_over does not match an amount equal to the figure", () => {
  // "over" is strictly greater — the threshold itself is not over the threshold.
  assert.equal(
    conditionMatches({ type: "amount_over", amount: 50 }, { amount: 50 }),
    false,
    "an amount exactly equal to the figure is not over it",
  );
});

test("amount_over does not match an amount below the figure", () => {
  assert.equal(
    conditionMatches({ type: "amount_over", amount: 50 }, { amount: 20 }),
    false,
    "20 is not over 50",
  );
});

test("amount_over does not match when the request carries no amount", () => {
  assert.equal(
    conditionMatches({ type: "amount_over", amount: 50 }, {}),
    false,
    "with no amount in context there is nothing over the figure",
  );
});

// --- merchant is / is not in a list ----------------------------------------

test("merchant_in matches a merchant that is in the list", () => {
  assert.equal(
    conditionMatches({ type: "merchant_in", merchants: ["BoxCo", "Acme"] }, { merchant: "BoxCo" }),
    true,
    "the request's merchant is a member of the list",
  );
});

test("merchant_in does not match a merchant absent from the list", () => {
  assert.equal(
    conditionMatches({ type: "merchant_in", merchants: ["BoxCo", "Acme"] }, {
      merchant: "OtherShop",
    }),
    false,
    "a merchant not in the list fails an allow-list condition",
  );
});

test("merchant_in does not match when the request carries no merchant", () => {
  assert.equal(
    conditionMatches({ type: "merchant_in", merchants: ["BoxCo", "Acme"] }, {}),
    false,
    "with no merchant in context the membership cannot be satisfied",
  );
});

test("merchant_not_in matches a merchant absent from the list", () => {
  assert.equal(
    conditionMatches({ type: "merchant_not_in", merchants: ["BoxCo", "Acme"] }, {
      merchant: "OtherShop",
    }),
    true,
    "a merchant outside the block-list satisfies a not-in condition",
  );
});

test("merchant_not_in does not match a merchant present in the list", () => {
  assert.equal(
    conditionMatches({ type: "merchant_not_in", merchants: ["BoxCo", "Acme"] }, {
      merchant: "Acme",
    }),
    false,
    "a merchant in the block-list fails a not-in condition",
  );
});

// ===========================================================================
// resolveRecipients — the shared recipient-resolution primitive.
// ===========================================================================

test("resolveRecipients wraps a single address in a one-element list", () => {
  assert.deepEqual(
    resolveRecipients(MANAGER),
    [MANAGER],
    "a lone address string resolves to a single-element list",
  );
});

test("resolveRecipients normalises a list of addresses", () => {
  const resolved = resolveRecipients(["a@x.com", "b@y.com"]);
  assert.equal(resolved.length, 2, "both addresses survive resolution");
  assert.ok(resolved.includes("a@x.com"), "the first address is present");
  assert.ok(resolved.includes("b@y.com"), "the second address is present");
});

test("resolveRecipients trims surrounding whitespace", () => {
  assert.deepEqual(
    resolveRecipients("  manager@example.com  "),
    [MANAGER],
    "leading and trailing whitespace is stripped from an address",
  );
});

test("resolveRecipients returns an empty list for no recipients", () => {
  assert.deepEqual(resolveRecipients(undefined), [], "undefined resolves to no recipients");
  assert.deepEqual(resolveRecipients(null), [], "null resolves to no recipients");
  assert.deepEqual(resolveRecipients(""), [], "an empty string resolves to no recipients");
});

// ===========================================================================
// Cross-check: a resolved recipient list feeds condition evaluation cleanly —
// the two primitives compose (what the policy engine and approvals will do).
// ===========================================================================

test("a resolved recipient list satisfies a matching recipient_is condition", () => {
  const recipients = resolveRecipients([" manager@example.com ", "cc@other.com"]);
  assert.equal(
    conditionMatches({ type: "recipient_is", address: MANAGER }, { recipients }),
    true,
    "resolution then evaluation agree: the trimmed address matches the condition",
  );
});

// Review fix D8 — the merchant is free text from the agent, so a merchant condition
// compares normalised forms (Unicode-compatibility folded, case-folded, trimmed, inner
// whitespace collapsed): a "never allow Amazon" rule cannot be dodged with "amazon ".
test("merchant conditions match regardless of case, spacing and compatibility forms", () => {
  const blocked = { type: "merchant_in", merchants: ["Amazon", "Box  Co"] } as const;
  for (const merchant of ["amazon", "Amazon ", " AMAZON", "ＡＭＡＺＯＮ", "box co", "BOX\tCO"]) {
    assert.equal(conditionMatches(blocked, { merchant }), true, `"${merchant}" is in the list`);
  }
  assert.equal(conditionMatches(blocked, { merchant: "Amazonia" }), false, "a different merchant is not");
  const notIn = { type: "merchant_not_in", merchants: ["Amazon"] } as const;
  assert.equal(conditionMatches(notIn, { merchant: " amazon" }), false);
  assert.equal(conditionMatches(notIn, { merchant: "eBay" }), true);
  assert.equal(normaliseMerchant("  Box   CO "), "box co");
});
