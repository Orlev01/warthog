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
  createRule as storeCreateRule,
  updateRule as storeUpdateRule,
  pauseRule as storePauseRule,
  deleteRule as storeDeleteRule,
} from "@/server/db/rules";
import { rulesPageData } from "@/server/rules/page-data";
import { listAgentsForUser } from "@/server/db/agents";
import { getUserById } from "@/server/db/users";
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
import type { RulesViewRule, RulesViewAgent } from "@/components/rules/rules-view";

// The injected seams — no process.env (INV-103). `clock` is taken for parity with
// the sibling actions factories and future time-stamped rule writes.
export interface RulesActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
}

// A mutation's result: success, or a refusal naming its reason (a rule that is not
// this person's). Never a silent success. The page maps the reason to plain copy.
export type ActionResult = { ok: true } | { ok: false; reason: string };

// The content of a rule, as the create form's FormData maps to it and the store
// writes it (the member scope — the userId — is bound separately from the session).
export interface RuleInput {
  readonly kind: RuleKind;
  readonly scope: RuleScope;
  readonly action: RuleAction;
  readonly condition?: RuleCondition;
}

// The data slice of <RulesView>'s props the loader returns: the person's OWN rules
// (active AND paused), each read back as its exact plain sentence + lifecycle
// status, plus the person's own agents (offered as the "chosen agents" scope). The
// page adds the bound server actions when it renders.
export interface RulesLoadData {
  readonly rules: RulesViewRule[];
  readonly agents: RulesViewAgent[];
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
    const rules: RulesViewRule[] = await rulesPageData(db, session.userId, dek);

    const agents: RulesViewAgent[] = (await listAgentsForUser(db, session.userId)).map((agent) => ({
      // The connection id is what the policy engine matches a rule's chosen-agent
      // scope on (src/server/mcp/context.ts), so it is the id a scope choice posts.
      id: agent.connectionId,
      name: agent.displayName,
    }));

    return { rules, agents };
  }

  async function createRule(session: Session, input: unknown): Promise<ActionResult> {
    const content = parseParams(ruleContentSchema, input);
    const dek = await dataKeyFor(session.userId);
    await storeCreateRule(db, { userId: session.userId, ...content }, dek);
    return { ok: true };
  }

  async function updateRule(session: Session, id: string, input: unknown): Promise<ActionResult> {
    const ruleId = parseParams(uuidSchema, id);
    const content = parseParams(ruleContentSchema, input);
    const dek = await dataKeyFor(session.userId);
    try {
      await storeUpdateRule(db, session.userId, ruleId, content, dek);
      return { ok: true };
    } catch {
      return { ok: false, reason: NOT_FOUND };
    }
  }

  async function pauseRule(session: Session, id: string): Promise<ActionResult> {
    const ruleId = parseParams(uuidSchema, id);
    try {
      await storePauseRule(db, session.userId, ruleId);
      return { ok: true };
    } catch {
      return { ok: false, reason: NOT_FOUND };
    }
  }

  async function deleteRule(session: Session, id: string): Promise<ActionResult> {
    const ruleId = parseParams(uuidSchema, id);
    const removed = await storeDeleteRule(db, session.userId, ruleId);
    return removed ? { ok: true } : { ok: false, reason: NOT_FOUND };
  }

  return { load, createRule, updateRule, pauseRule, deleteRule };
}
