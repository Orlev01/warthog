// E03-S04 — Rule model, conditions and ruleSentence (design §8).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// Rules are enforced in code and must read back as the exact English sentence,
// so the renderer is a pure function here. The policy engine (design §8) and the
// approval inbox both consume condition evaluation and recipient resolution, so
// those primitives live here, pure, built before their consumers.
//
// The vocabulary is exactly the brief's ("Rules and approvals"): a rule is an
// `ask_first` or `never_allow` kind, over any agent or a chosen agent, on one of
// the brief's actions, with an optional "[when <condition>]" part.

/** Whether the rule asks the person first, or forbids the action outright. */
export type RuleKind = "ask_first" | "never_allow";

/**
 * Which agent(s) the rule covers. `any_agent` renders "any agent"; a chosen
 * agent renders its `name`.
 */
export type RuleScope =
  | { type: "any_agent" }
  | { type: "agent"; agentId: string; name: string };

/** The message channels the send-message action can cover. */
export type MessageChannel = "email" | "chat" | "post";

/**
 * The action a rule governs — exactly the brief's action vocabulary: a tool that
 * sends a message, a specific tool, any tool of a chosen service, any
 * change-making tool, a card request, or a protected-detail request. Only the
 * `send_message` wording is pinned by this task's acceptance criteria.
 */
export type RuleAction =
  | { type: "send_message"; channel: MessageChannel }
  | { type: "specific_tool"; tool: string }
  | { type: "service_tool"; service: string }
  | { type: "any_change" }
  | { type: "card_request" }
  | { type: "high_tier_request" };

/**
 * The optional condition on a rule — recipient equals an address or belongs to a
 * domain (for actions with recipients), amount is over a figure (for actions with
 * an amount), or merchant is / is not in a list (for card requests).
 */
export type RuleCondition =
  | { type: "recipient_is"; address: string }
  | { type: "recipient_in_domain"; domain: string }
  | { type: "amount_over"; amount: number }
  | { type: "merchant_in"; merchants: readonly string[] }
  | { type: "merchant_not_in"; merchants: readonly string[] };

/** One plain-language rule. The condition is optional. */
export interface Rule {
  kind: RuleKind;
  scope: RuleScope;
  action: RuleAction;
  condition?: RuleCondition;
}

/**
 * The context a condition is evaluated against. Recipients are a list (an email
 * may have several); a recipient condition matches when ANY recipient matches.
 * Amount/merchant carry the figure/merchant of a card request. The amount is
 * already in the rule's currency — cross-currency conversion is the policy
 * engine's job, never this pure comparison's.
 */
export interface MatchContext {
  recipients?: string | readonly string[] | null;
  amount?: number;
  merchant?: string;
}

/**
 * How a PERSON reads the tools and services a rule names (the Rules page, the rule
 * builder's preview, an agent's workspace): each resolver returns the display label for
 * an id — a tool's title, a service's catalogue name — or undefined when it does not
 * know the id, which is then shown as it is. Agent-facing sentences (the MCP pipeline,
 * `get_context`) pass none, so they keep the exact ids the engine matches on. Pure: the
 * resolvers are injected, so this module still reads no registry or catalogue.
 */
export interface RuleDisplayLabels {
  readonly toolTitle?: (tool: string) => string | undefined;
  readonly serviceName?: (service: string) => string | undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

// --- ruleSentence ----------------------------------------------------------

/** An id's display label from `resolve`, or the id itself when none is known (or it is blank). */
function displayed(id: string, resolve: ((id: string) => string | undefined) | undefined): string {
  const label = resolve?.(id)?.trim();
  return label ? label : id;
}

/**
 * The infinitive form of an action's verb phrase ("send email", "use <tool>",
 * "request a card"). The finite form ("sends email") is derived from it, so the
 * two never drift apart. A tool or service is named through `labels` when given.
 */
function actionInfinitive(action: RuleAction, labels: RuleDisplayLabels | undefined): string {
  switch (action.type) {
    case "send_message": {
      const noun =
        action.channel === "email"
          ? "email"
          : action.channel === "chat"
            ? "a chat message"
            : "a post";
      return `send ${noun}`;
    }
    case "specific_tool":
      return `use ${displayed(action.tool, labels?.toolTitle)}`;
    case "service_tool":
      return `use any ${displayed(action.service, labels?.serviceName)} tool`;
    case "any_change":
      return "make any change";
    case "card_request":
      return "request a card";
    case "high_tier_request":
      return "request a protected detail";
    default:
      return assertNever(action);
  }
}

/** "send email" → "sends email": the finite third-person form of a verb phrase. */
function toFinite(infinitive: string): string {
  const space = infinitive.indexOf(" ");
  if (space === -1) return `${infinitive}s`;
  return `${infinitive.slice(0, space)}s${infinitive.slice(space)}`;
}

/**
 * The trailing clause for a condition. A recipient condition reads naturally as
 * "to <address>"; the amount/merchant families read as "when …". Only the
 * recipient-equals form is pinned by the acceptance criteria.
 */
function conditionClause(condition: RuleCondition): string {
  switch (condition.type) {
    case "recipient_is":
      return ` to ${condition.address}`;
    case "recipient_in_domain":
      return ` to anyone at ${condition.domain}`;
    case "amount_over":
      return ` when the amount is over ${condition.amount}`;
    case "merchant_in":
      return ` when the merchant is in ${condition.merchants.join(", ")}`;
    case "merchant_not_in":
      return ` when the merchant is not in ${condition.merchants.join(", ")}`;
    default:
      return assertNever(condition);
  }
}

/**
 * Render a rule to the exact English sentence it reads back as, for example
 * "Ask me before any agent sends email to manager@example.com". Pure: the same
 * rule (and labels) always renders the same string.
 *
 * Without `labels` a tool or service is named by its exact id ("Ask me before any agent
 * uses create_task") — the form agents read. With them a person reads its title or
 * catalogue name ("Ask me before any agent uses Create a task", "… uses any Gmail tool");
 * an id the labels don't know falls back to the id.
 */
export function ruleSentence(rule: Rule, labels?: RuleDisplayLabels): string {
  const subject = rule.scope.type === "any_agent" ? "any agent" : rule.scope.name;
  const infinitive = actionInfinitive(rule.action, labels);
  const clause = rule.condition ? conditionClause(rule.condition) : "";
  if (rule.kind === "never_allow") {
    return `Never allow ${subject} to ${infinitive}${clause}`;
  }
  return `Ask me before ${subject} ${toFinite(infinitive)}${clause}`;
}

// --- recipient resolution --------------------------------------------------

/**
 * Turn a single address or a list of addresses into a trimmed, blanks-removed
 * list. Case is NOT altered — the approval inbox shows recipients verbatim;
 * case-insensitive comparison is `conditionMatches`' job.
 */
export function resolveRecipients(
  value: string | readonly string[] | null | undefined,
): string[] {
  if (value === null || value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  const out: string[] = [];
  for (const item of list) {
    const trimmed = item.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** The domain part of an address (after the last "@"), lower-cased for comparison. */
function recipientDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

// --- merchant normalisation ------------------------------------------------

/**
 * The comparable form of a merchant name. The merchant is free text the agent supplies,
 * so every merchant comparison (rule conditions, block and allow lists) folds Unicode
 * compatibility forms (NFKC), case, surrounding whitespace and runs of inner whitespace —
 * "AMAZON ", "amazon" and the full-width "ＡＭＡＺＯＮ" are all the same merchant.
 */
export function normaliseMerchant(merchant: string): string {
  return merchant.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Is `merchant` one of `list`, comparing normalised forms? */
export function merchantInList(merchant: string, list: readonly string[]): boolean {
  const target = normaliseMerchant(merchant);
  return list.some((entry) => normaliseMerchant(entry) === target);
}

// --- conditionMatches ------------------------------------------------------

/**
 * Does the request described by `ctx` satisfy the condition? Recipient matching
 * is case-insensitive and succeeds when ANY recipient matches; amount-over is
 * strictly greater; merchant in/not-in test membership of a present merchant,
 * comparing normalised names. A condition with no datum to test in context never
 * matches.
 */
export function conditionMatches(condition: RuleCondition, ctx: MatchContext): boolean {
  switch (condition.type) {
    case "recipient_is": {
      const target = condition.address.trim().toLowerCase();
      return resolveRecipients(ctx.recipients).some((r) => r.toLowerCase() === target);
    }
    case "recipient_in_domain": {
      const target = condition.domain.trim().toLowerCase();
      return resolveRecipients(ctx.recipients).some((r) => recipientDomain(r) === target);
    }
    case "amount_over":
      return ctx.amount !== undefined && ctx.amount > condition.amount;
    case "merchant_in":
      return ctx.merchant !== undefined && merchantInList(ctx.merchant, condition.merchants);
    case "merchant_not_in":
      return ctx.merchant !== undefined && !merchantInList(ctx.merchant, condition.merchants);
    default:
      return assertNever(condition);
  }
}
