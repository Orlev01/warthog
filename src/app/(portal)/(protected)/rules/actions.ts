import { auditedOwnerChange } from "@/server/activity/owner-change";
// E12-S17 — Rules page actions (the injectable seam the thin rules `page.tsx`
// loader + its server-action wrappers compose).
//
// The Rules screen lets a person read back their rules as the exact plain
// sentences Warthog enforces and build a new one from a template (brief "Rules
// and approvals"; design §8). This factory is the testable core behind the
// controls: load the person's own rules + agents, create a validated rule, and
// update / pause / delete one of the person's OWN rules.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry
// file may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The thin loader renders the
// Rules screen; the testable logic lives here (the convention's
// `createXActions(deps)` pattern, the same shape as `createInboxActions`).
//
// Security (each a reviewer veto; CLAUDE.md member scope + design §5):
//   • Every method takes the person's VERIFIED Session and derives the acting
//     user id from `session.userId` — never a client-supplied value. Every read
//     and write is member-scoped by that id, so a signed-in person can never
//     create under, change or delete another person's rule by id: the rule
//     resolves to no row for them and the call is refused ({ ok: false }), never
//     a silent success and never a 500.
//   • createRule VALIDATES the action + condition against the brief's vocabulary
//     (ask_first/never_allow over the six actions, an optional condition) before a
//     row is written: an unknown action or a malformed/oversized condition is
//     rejected at the boundary with a 4xx HttpError (parseParams), nothing stored.
//     A specific-tool or service rule must also name a REAL tool or service (the MCP
//     tool registry + the connector catalogue, ./rule-targets): a name that matches
//     nothing is refused ({ ok: false, reason: "unknown_tool" | "unknown_service" })
//     before anything is stored, so a typo can never become a rule that protects nothing.
//   • A mis-shaped rule id (not a well-formed uuid — the rules table keys on a
//     uuid, so this is the OBS-049 defence the AC's "positive integer" wording
//     stands in for) is rejected at the boundary with a 4xx for update/pause/
//     delete, never cast at `WHERE id = $1` (INV-102).
//   • Every statement the rules store issues is parameterized, so a SQL-shaped
//     value travels as a BOUND value and cannot alter a query (INV-102).
//   • The actions run purely from their injected seams (db, clock, keyWrapper):
//     they read no `process.env` and hold no secret (INV-103).

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import {
  listAllRules,
  createRule as storeCreateRule,
  updateRule as storeUpdateRule,
  pauseRule as storePauseRule,
  deleteRule as storeDeleteRule,
} from "@/server/db/rules";
import { rulesPageData } from "@/server/rules/page-data";
import { agentNamesForUser, listAgentsForUser } from "@/server/db/agents";
import { getUserById } from "@/server/db/users";
import { getAccountCurrency } from "@/server/db/account-currency";
import {
  type RuleKind,
  type RuleScope,
  type RuleAction,
  type RuleCondition,
  type MessageChannel,
} from "@/domain/rules/rules";
import type { Session } from "@/server/auth/session";
import type { Clock } from "@/server/seams/clock";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Db } from "@/server/db/index";
import type { CatalogueIndex } from "@/server/connectors/catalogue";
import type { RulesViewRule, RulesViewAgent } from "@/components/rules/rules-view";
import type { RuleTargetGroup } from "@/components/rules/rules-organise";
import { catalogueFromDataFiles, ruleTargetsFor } from "./rule-targets";
import {
  RULES_PATH,
  RULES_VIEWS,
  RULE_STATUS_FILTERS,
  type RuleStatusFilter,
  type RulesViewKey,
} from "@/components/rules/rules-organise";
import { firstParam, hrefWith, resolveKey } from "@/lib/href";

// The injected seams — no process.env (INV-103). `clock` is taken for parity with
// the sibling actions factories and future time-stamped rule writes. `catalogue` is the
// connector catalogue the tool and service names are checked against (the page passes the
// process catalogue; without one, the catalogue data files are read).
export interface RulesActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
  readonly catalogue?: CatalogueIndex;
}

// A mutation's result: success, or a refusal naming its reason (a rule that is not
// this person's). Never a silent success. The page maps the reason to plain copy.
export type ActionResult = { ok: true } | { ok: false; reason: string };

// The outcome of the last rule change, as a plain-words notice the Rules page shows
// (in words + an icon, never colour alone): a successful outcome is "done", a problem
// is "problem". The code→copy resolver lives in this testable sibling, not the Next
// `page.tsx` (which may export only its framework fields) — the same seam the
// security/activity screens use. One source of truth: the page renders what this
// returns and holds no copy of its own.
export type RulesNotice = { tone: "done" | "problem"; text: string };

// Every `?notice=` outcome code the rule actions redirect with, mapped to its copy.
const RULES_NOTICES: Record<string, RulesNotice> = {
  created: { tone: "done", text: "Rule added. Warthog applies it from now on; it's in the list below." },
  updated: { tone: "done", text: "Rule updated." },
  // E18-S20 honest-pause copy: the Rules screen offers no Resume control (the rules
  // store has no resume primitive to back one), so the notice must NOT promise
  // resuming — it states the effect plainly instead.
  paused: { tone: "done", text: "Rule paused — Warthog won't enforce it for now." },
  deleted: { tone: "done", text: "Rule deleted." },
  not_found: {
    tone: "problem",
    text: "We couldn't find that rule. It may have already been changed.",
  },
  invalid: { tone: "problem", text: "That rule didn't look right. Please check it and try again." },
  unknown_tool: {
    tone: "problem",
    text: "No rule was added: Warthog has no tool with that name. Choose the tool from the list and try again.",
  },
  unknown_service: {
    tone: "problem",
    text: "No rule was added: Warthog has no service with that name. Choose the service from the list and try again.",
  },
  error: { tone: "problem", text: "We couldn't complete that just now. Please try again." },
};

// Resolve a `?notice=` code to its plain-words notice, or null for an absent or
// unknown code — so the query string can never inject copy the page would render.
export function rulesNotice(code: string | null | undefined): RulesNotice | null {
  if (!code) return null;
  return RULES_NOTICES[code] ?? null;
}

// ─── URL state: which view is open, the status filter, and the last outcome ──────────

// The Rules page's query, validated: `view` against the known in-page views (the rules
// list when absent or unknown), `status` against the two filter values (every rule when
// absent or unknown) and the raw `notice` code (`rulesNotice` resolves it to copy, so an
// unknown code renders nothing). A repeated key takes its first value.
export function rulesPageState(search: Readonly<Record<string, string | string[] | undefined>>): {
  view: RulesViewKey;
  status: RuleStatusFilter | undefined;
  notice: string | undefined;
} {
  const status = firstParam(search.status);
  return {
    view: resolveKey(firstParam(search.view), RULES_VIEWS, "rules"),
    status: status !== undefined && (RULE_STATUS_FILTERS as readonly string[]).includes(status) ? (status as RuleStatusFilter) : undefined,
    notice: firstParam(search.notice),
  };
}

// Where a rule action redirects: the fixed Rules path with the outcome code, the view to
// return to ("new" after adding; the rules list is the default and stays implicit) and the
// status filter a row's form carried. Values arrive from FormData, so anything that is
// not a known key — or not a string at all — is dropped, never echoed into the URL.
export function rulesReturnHref(notice: string, back: { view?: unknown; status?: unknown }): string {
  const view = typeof back.view === "string" ? resolveKey(back.view, RULES_VIEWS, "rules") : "rules";
  const status =
    typeof back.status === "string" && (RULE_STATUS_FILTERS as readonly string[]).includes(back.status)
      ? back.status
      : undefined;
  return hrefWith(RULES_PATH, {}, { notice, status, view: view === "rules" ? undefined : view });
}

// Where adding a rule lands (interaction-23): once added, the rules list the new rule is in;
// refused, the New rule view, so the person can correct it.
export function rulesCreateReturnHref(notice: string): string {
  return rulesReturnHref(notice, { view: notice === "created" ? "rules" : "new" });
}

// Map a mutation outcome (or a thrown error) to a stable notice code the page turns into
// plain words. A refusal names its reason (a rule that isn't the person's; a tool or service
// that doesn't exist); a 4xx from the validation boundary is shown as "invalid"; anything
// else is a generic problem.
const REFUSAL_NOTICES = new Set(["not_found", "unknown_tool", "unknown_service"]);
export function rulesMutationNotice(outcome: ActionResult | unknown, doneCode: string): string {
  if (outcome && typeof outcome === "object" && "ok" in outcome) {
    const result = outcome as ActionResult;
    if (result.ok) return doneCode;
    return REFUSAL_NOTICES.has(result.reason) ? result.reason : "error";
  }
  if (outcome && typeof outcome === "object" && "status" in outcome) {
    const status = (outcome as { status: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) return "invalid";
  }
  return "error";
}

// The content of a rule, as the create form's FormData maps to it and the store
// writes it (the member scope — the userId — is bound separately from the session).
export interface RuleInput {
  readonly kind: RuleKind;
  readonly scope: RuleScope;
  readonly action: RuleAction;
  readonly condition?: RuleCondition;
}

// The data slice of <RulesView>'s props the loader returns: the person's OWN rules
// (active AND paused), each read back as its exact plain sentence + kind + lifecycle
// status, plus the person's own agents (offered as the "chosen agents" scope, and
// linked to their workspace for budgets). The page adds the bound server actions.
export interface RulesLoadData {
  readonly currency: string;
  readonly rules: RulesViewRule[];
  readonly agents: RulesViewAgent[];
  // The real tools and services a new rule may name, grouped for the builder's choices.
  readonly toolChoices: RuleTargetGroup[];
  readonly serviceChoices: RuleTargetGroup[];
}

export interface RulesActions {
  // Turn the verified session into the view's data: the session person's OWN rules
  // (member-scoped by `session.userId`, never a client value) — active and paused —
  // each as its exact sentence + status, and the person's own agents. READ-ONLY.
  load(session: Session): Promise<RulesLoadData>;
  // Validate the content against the brief's vocabulary (4xx on anything unknown or
  // oversized) and store an active rule under the SESSION user.
  createRule(session: Session, input: unknown): Promise<ActionResult>;
  // Validate the id (4xx when mis-shaped) and the content, then replace the content
  // of the person's OWN rule; refuse when the id is not theirs.
  updateRule(session: Session, id: string, input: unknown): Promise<ActionResult>;
  // Validate the id (4xx when mis-shaped) and pause the person's OWN rule; refuse
  // when the id is not theirs.
  pauseRule(session: Session, id: string): Promise<ActionResult>;
  // Validate the id (4xx when mis-shaped) and delete the person's OWN rule; refuse
  // when the id is not theirs.
  deleteRule(session: Session, id: string): Promise<ActionResult>;
}

// The refusal reason code (mapped to copy by the page) when a rule id is not this
// person's — the same vocabulary the sibling inbox/security actions use.
const NOT_FOUND = "not_found";
// The refusal reasons when a rule names a tool or service that does not exist.
const UNKNOWN_TOOL = "unknown_tool";
const UNKNOWN_SERVICE = "unknown_service";

// A well-formed uuid: the only shape a rule id may take. A malformed value is
// rejected at the validation boundary (parseParams throws a 4xx HttpError) before it
// can reach `WHERE id = $1` as a cast (OBS-049).
const uuidSchema = z.uuid();

// The longest a free-text rule field (a tool/service name, an address/domain, a
// merchant) may be: a name, not a payload. A grossly oversized value is rejected at
// the boundary with a 4xx rather than stored.
const MAX_TEXT = 256;
const MAX_MERCHANTS = 100;
const nameSchema = z.string().min(1).max(MAX_TEXT);

// The brief's vocabulary as a validation boundary (design §8 / the pure domain
// model in @/domain/rules/rules). An action or condition outside it — or an
// oversized name — fails to parse and is rejected with a 4xx before a row is
// written, so nothing malformed is ever stored.
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_message"), channel: z.enum(["email", "chat", "post"]) }),
  z.object({ type: z.literal("specific_tool"), tool: nameSchema }),
  z.object({ type: z.literal("service_tool"), service: nameSchema }),
  z.object({ type: z.literal("any_change") }),
  z.object({ type: z.literal("card_request") }),
  z.object({ type: z.literal("high_tier_request") }),
]);

const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recipient_is"), address: nameSchema }),
  z.object({ type: z.literal("recipient_in_domain"), domain: nameSchema }),
  z.object({ type: z.literal("amount_over"), amount: z.number() }),
  z.object({ type: z.literal("merchant_in"), merchants: z.array(nameSchema).min(1).max(MAX_MERCHANTS) }),
  z.object({ type: z.literal("merchant_not_in"), merchants: z.array(nameSchema).min(1).max(MAX_MERCHANTS) }),
]);

const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("any_agent") }),
  z.object({ type: z.literal("agent"), agentId: nameSchema, name: nameSchema }),
]);

const ruleContentSchema = z.object({
  kind: z.enum(["ask_first", "never_allow"]),
  scope: scopeSchema,
  action: actionSchema,
  condition: conditionSchema.optional(),
});

// ─── the pure FormData → rule mapping (the create form's server action runs it
// before createRule; no I/O, so it is unit-tested directly) ───────────────────────

// A FormData string field, trimmed, or "" when absent or a File.
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// A comma-separated list field → its non-empty, trimmed entries.
function listField(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// The action the form describes, reading the NAMED fields the rule form carries: the
// message `rule-channel` for a send-message, the `rule-target` (a tool or service
// name) for a specific-tool / service action. Best-effort shaping only — createRule
// validates the result against the vocabulary.
function actionFromForm(formData: FormData): RuleAction {
  const type = field(formData, "rule-action");
  switch (type) {
    case "specific_tool":
      return { type: "specific_tool", tool: field(formData, "rule-target") };
    case "service_tool":
      return { type: "service_tool", service: field(formData, "rule-target") };
    case "any_change":
      return { type: "any_change" };
    case "card_request":
      return { type: "card_request" };
    case "high_tier_request":
      return { type: "high_tier_request" };
    case "send_message":
    default:
      return { type: "send_message", channel: field(formData, "rule-channel") as MessageChannel };
  }
}

// The optional condition the form describes, reading its figure/address/merchants
// from the `rule-condition-detail` field. "none" (or absent) → no condition.
function conditionFromForm(formData: FormData): RuleCondition | undefined {
  const type = field(formData, "rule-condition");
  const detail = field(formData, "rule-condition-detail");
  switch (type) {
    case "recipient_is":
      return { type: "recipient_is", address: detail };
    case "recipient_in_domain":
      return { type: "recipient_in_domain", domain: detail };
    case "amount_over":
      return { type: "amount_over", amount: Number(detail) };
    case "merchant_in":
      return { type: "merchant_in", merchants: listField(detail) };
    case "merchant_not_in":
      return { type: "merchant_not_in", merchants: listField(detail) };
    default:
      return undefined;
  }
}

// The scope the form describes: "any_agent" → all agents; any other value is a
// chosen agent's id (the value the scope control posts).
function scopeFromForm(formData: FormData): RuleScope {
  const value = field(formData, "rule-scope");
  if (value === "" || value === "any_agent") return { type: "any_agent" };
  return { type: "agent", agentId: value, name: value };
}

// Map a real create-form FormData to a rule input (the brief's field vocabulary).
// Pure: no I/O, so it is driven directly by a test. The result is validated by
// createRule before anything is stored.
export function ruleInputFromForm(formData: FormData): RuleInput {
  return {
    kind: field(formData, "rule-template") as RuleKind,
    scope: scopeFromForm(formData),
    action: actionFromForm(formData),
    condition: conditionFromForm(formData),
  };
}

export function createRulesActions(deps: RulesActionsDeps): RulesActions {
  const { db, keyWrapper } = deps;
  const catalogue = (): CatalogueIndex => deps.catalogue ?? catalogueFromDataFiles();

  // Resolve the acting person's unwrapped DEK (to encrypt/decrypt a rule's
  // condition). Read the wrapped DEK member-scoped by `userId` (the session's,
  // never a client value) and unwrap it through the KeyWrapper seam. Throws when
  // the person has no row — never fails silently.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("rules actions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  async function load(session: Session): Promise<RulesLoadData> {
    const dek = await dataKeyFor(session.userId);
    // Compose the dependency's tested owner-scoped list-all read (E12-S15,
    // `rulesPageData`) rather than re-running `listAllRules` + `ruleSentence` here —
    // the Rules page read lives in exactly one place (one-source-of-truth): every rule
    // the person has written, active AND paused, already rendered as its exact plain
    // sentence with its scope and lifecycle status, member-scoped by the session id.
    // Each chosen-agent scope is named by the agent's CURRENT name from the person's OWN
    // agents (member-scoped), never a raw connection id stored with an older rule, and each
    // tool or service by its title or catalogue name — the labels the builder's choices
    // carry, so a new rule reads on the list exactly as its preview did.
    const targets = await ruleTargetsFor(db, catalogue(), session.userId, dek);
    const rules: RulesViewRule[] = await rulesPageData(
      db,
      session.userId,
      dek,
      await agentNamesForUser(db, session.userId),
      targets.labels,
    );

    const agents: RulesViewAgent[] = (await listAgentsForUser(db, session.userId))
      .map((agent) => ({
        // The connection id is what the policy engine matches a rule's chosen-agent
        // scope on (src/server/mcp/context.ts), so it is the id a scope choice posts.
        id: agent.connectionId,
        name: agent.displayName,
        // The agent's own id keys its workspace (/agents/<id>), where its card budget is set.
        workspaceId: agent.id,
      }))
      // Name order (then id), so the scope choices and budget links never shuffle.
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return {
      rules,
      agents,
      currency: await getAccountCurrency(db, session.userId),
      toolChoices: targets.tools,
      serviceChoices: targets.services,
    };
  }

  // A specific-tool or service rule must name a real tool or service, or it would match
  // nothing and silently protect nothing. Null when the content's names are all real.
  async function unknownTarget(userId: string, dek: Uint8Array, action: RuleAction): Promise<string | null> {
    if (action.type !== "specific_tool" && action.type !== "service_tool") return null;
    const targets = await ruleTargetsFor(db, catalogue(), userId, dek);
    if (action.type === "specific_tool") return targets.isTool(action.tool) ? null : UNKNOWN_TOOL;
    return targets.isService(action.service) ? null : UNKNOWN_SERVICE;
  }

  // Resolve a chosen-agent scope's display NAME from the person's OWN agent record
  // (member-scoped by the session user id, so a client-forged name is never trusted)
  // so the rule reads back naming the agent rather than the raw connection id the
  // scope control posts (E18-S20). An all-agents scope passes through unchanged.
  async function resolveScopeName(userId: string, scope: RuleScope): Promise<RuleScope> {
    if (scope.type !== "agent") return scope;
    const agents = await listAgentsForUser(db, userId);
    const match = agents.find((agent) => agent.connectionId === scope.agentId);
    return { type: "agent", agentId: scope.agentId, name: match ? match.displayName : scope.name };
  }

  async function createRule(session: Session, input: unknown): Promise<ActionResult> {
    const content = parseParams(ruleContentSchema, input);
    const scope = await resolveScopeName(session.userId, content.scope);
    const dek = await dataKeyFor(session.userId);
    const unknown = await unknownTarget(session.userId, dek, content.action);
    if (unknown) return { ok: false, reason: unknown };
    await auditedOwnerChange(deps, session.userId, async (tx, record) => {
      const rule = await storeCreateRule(tx, { userId: session.userId, ...content, scope }, dek);
      await record("rule_created", { ruleId: rule.id, after: { ...content, scope } });
    });
    return { ok: true };
  }

  async function updateRule(session: Session, id: string, input: unknown): Promise<ActionResult> {
    const ruleId = parseParams(uuidSchema, id);
    const content = parseParams(ruleContentSchema, input);
    const scope = await resolveScopeName(session.userId, content.scope);
    const dek = await dataKeyFor(session.userId);
    const unknown = await unknownTarget(session.userId, dek, content.action);
    if (unknown) return { ok: false, reason: unknown };
    try {
      await auditedOwnerChange(deps, session.userId, async (tx, record) => {
        const before = (await listAllRules(tx, session.userId, dek)).find(rule => rule.id === ruleId);
        await storeUpdateRule(tx, session.userId, ruleId, { ...content, scope }, dek);
        await record("rule_updated", { ruleId, before, after: { ...content, scope } });
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: NOT_FOUND };
    }
  }

  async function pauseRule(session: Session, id: string): Promise<ActionResult> {
    const ruleId = parseParams(uuidSchema, id);
    try {
      await auditedOwnerChange(deps, session.userId, async (tx, record) => {
        await storePauseRule(tx, session.userId, ruleId);
        await record("rule_paused", { ruleId });
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: NOT_FOUND };
    }
  }

  async function deleteRule(session: Session, id: string): Promise<ActionResult> {
    const ruleId = parseParams(uuidSchema, id);
    const dek = await dataKeyFor(session.userId);
    const removed = await auditedOwnerChange(deps, session.userId, async (tx, record) => {
      const before = (await listAllRules(tx, session.userId, dek)).find(rule => rule.id === ruleId);
      const deleted = await storeDeleteRule(tx, session.userId, ruleId);
      if (deleted) await record("rule_deleted", { ruleId, before });
      return deleted;
    });
    return removed ? { ok: true } : { ok: false, reason: NOT_FOUND };
  }

  return { load, createRule, updateRule, pauseRule, deleteRule };
}
