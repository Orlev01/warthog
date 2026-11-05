// E10-S08 — Per-agent permissions page loader + save action (design §7 connector
// engine, §8 policy step 2; brief "Per-agent permissions page" — "Each agent's reach
// is shaped on one screen … card access cannot be switched on without a budget …
// changes take effect on the agent's next request"; CLAUDE.md — the permissions object
// is saved server-side against the owning connection and is read by the pipeline on
// every call).
//
// This is the injectable, unit-testable seam the thin `[id]/page.tsx` loader + its
// `"use server"` save wrapper compose (the convention's `createXActions(deps)` factory,
// as `access-key/actions.ts`, `settings/security/actions.ts` and `home/actions.ts` do).
// A Next entry file may export only its framework fields, so the flow logic lives here
// and the entry stays thin (OBS-025).
//
// The per-agent permissions page is the consent screen's twin: it reads and writes the
// SAME per-connection grants the access-key create flow seeds, through the already-built
// agents store (getAgentById) and agent-permissions store (getConnectionPermissions /
// upsertPermissions) the policy pipeline reads on every call.
//
// Security (each a reviewer veto):
//   • The acting person's user id is ALWAYS `session.userId` — never a value smuggled in
//     the untrusted input (CLAUDE.md: every member-scoped read/write takes the user id
//     from the session). Both load and save resolve the agent by (session.userId,
//     agentId) FIRST, so another person's agent id matches nothing — the loader reads
//     nothing (null) and the save is refused, the other person's grants untouched.
//   • Input is validated at the boundary (zod → a 4xx `HttpError`) BEFORE anything is
//     written, so malformed or oversized input writes nothing (INV-102). A malformed
//     agent id is rejected as a 4xx before it can reach `WHERE id = $1` as a cast
//     (OBS-049). Every value reaches storage bound as a query parameter (the db seam),
//     so a value shaped like SQL is stored as data and cannot alter a query.
//   • A partial edit keeps the connection's stored values for the fields it does not
//     touch (the OBS-022 shared-state invariant): a previously-set budget survives
//     toggling card access off then on, and card-access-without-budget is never persisted.
//   • This module reads no `process.env` and holds no secret (INV-103): config flows from
//     `src/server/config.ts` alone, so no ambient env value can leak into the permissions
//     it persists or the screen it loads.

import { z } from "zod";

import { getAgentById } from "../../../../../server/db/agents";
import {
  getConnectionPermissions,
  upsertPermissions,
  type PermissionGrants,
} from "../../../../../server/db/agent-permissions";
import { parseParams } from "../../../../../server/http/validate";
import { budgetAllowsCard } from "../../../../../domain/budget/budget";
import type { PermissionsViewProps } from "../../../../../components/agents/permissions-view";
import type { Db } from "../../../../../server/db/index";
import type { Session } from "../../../../../server/auth/session";

// The person's default currency label on the card-budget field, used when a connection
// has no budget stored yet (the view defaults to "A$").
const DEFAULT_CURRENCY = "A$";

// A grossly oversized currency label is rejected at the boundary before any write; the
// twin access-key create flow caps it the same way.
const MAX_CURRENCY_LENGTH = 8;

// A well-formed uuid: the only shape an agent id handle may take (agents.id is a uuid,
// db/migrations/0020_agents.sql). A malformed value is rejected at the validation
// boundary (parseParams throws a 4xx HttpError) before it can reach `WHERE id = $1` as a
// cast (OBS-049), so a SQL-shaped id is refused here before any query runs. A bare
// integer, a negative, a decimal and the empty string are all rejected as a special case.
const uuidSchema = z.uuid();

// A card spending budget on the save, validated to the brief's three periods. `amount` is
// a number (not concatenated into SQL — bound as a parameter by the store); whether the
// amount actually ALLOWS card access is the domain rule budgetAllowsCard, enforced after
// the merge so a zero/negative budget is a reported refusal, not a shape error.
const cardBudgetSchema = z.object({
  amount: z.number(),
  currency: z.string().min(1).max(MAX_CURRENCY_LENGTH),
  period: z.enum(["day", "week", "month"]),
});

// The save's validated shape: a PARTIAL edit of the connection's grants — every field is
// optional and an absent field keeps its stored value (OBS-022). Unknown keys (e.g. a
// rogue `userId` smuggled into an untrusted form body) are stripped by zod's object parse,
// so the flow never reads a user id from the input. The opt-in names mirror the consent /
// access-key create input (`card`, `cardBudget`, `learningSharing`, `requestLimit`).
const inputSchema = z.object({
  card: z.boolean().optional(),
  cardBudget: cardBudgetSchema.nullable().optional(),
  learningSharing: z.boolean().optional(),
  requestLimit: z.number().int().positive().optional(),
});

// The save input, as the permissions screen submits it (a partial edit).
export type PermissionsSaveInput = z.infer<typeof inputSchema>;

// The outcome of a save: success, or a refusal naming its reason (the agent is not this
// person's, or card access was asked for without a budget that allows it). Never a silent
// success.
export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// The seams the flow composes: just the database seam (the agents + agent-permissions
// stores). No config, no clock — editing permissions needs neither.
export interface PermissionsActionsDeps {
  readonly db: Db;
}

// The per-agent permissions actions the thin loader + save wrapper drive.
export interface PermissionsActions {
  // Assemble the screen's props for the session user's own agent, or null when the agent
  // id is not this person's (member-scoped — never a client value).
  load(session: Session, agentId: string): Promise<PermissionsViewProps | null>;
  // Persist a partial edit of the connection's permissions for the session user's own
  // agent, or refuse (the agent is not this person's, or card-without-budget).
  save(session: Session, agentId: string, input: PermissionsSaveInput): Promise<SaveResult>;
}

// Build the screen's props from the agent and its stored grants. The policy-relevant
// state the person edits — card access + its budget, the identity/high-tier/memory/
// sharing toggles and the request limit — is reflected from storage. The catalogue-
// dependent lists (connector names/tools, skill names, rule objects) are assembled by
// their own screens and are out of this task's scope, so they render empty here.
function toViewProps(agentName: string, grants: PermissionGrants): PermissionsViewProps {
  return {
    agentName,
    connectors: [],
    lowTierRead: grants.identityAccess,
    highTierRequest: grants.highTierAccess,
    cardAccess: grants.cardAccess,
    budget: grants.cardBudget
      ? { amount: grants.cardBudget.amount, period: grants.cardBudget.period }
      : null,
    skills: [],
    sharedMemoryRead: grants.memoryRead,
    learningSharing: grants.sharing,
    rules: [],
    requestLimit: grants.rateLimit,
    currency: grants.cardBudget?.currency ?? DEFAULT_CURRENCY,
  };
}

// Apply the partial edit to the stored grants: a field the input touches is overwritten,
// every other field keeps its stored value — including the card budget, which is RETAINED
// when card access is toggled off (so it survives a later re-enable, OBS-022). The acting
// user id and the resolved connection id are fixed server-side, never taken from the input.
function mergeGrants(
  stored: PermissionGrants,
  input: PermissionsSaveInput,
  userId: string,
  connectionId: string,
): PermissionGrants {
  return {
    ...stored,
    userId,
    connectionId,
    cardAccess: input.card !== undefined ? input.card : stored.cardAccess,
    cardBudget: input.cardBudget !== undefined ? input.cardBudget : stored.cardBudget,
    sharing: input.learningSharing !== undefined ? input.learningSharing : stored.sharing,
    rateLimit: input.requestLimit !== undefined ? input.requestLimit : stored.rateLimit,
  };
}

export function createPermissionsActions(deps: PermissionsActionsDeps): PermissionsActions {
  const { db } = deps;

  // Load: resolve the agent by (session.userId, agentId) FIRST — another person's id (or a
  // malformed one) matches nothing and reads null, never their permissions — then read its
  // stored grants and assemble the screen's props.
  async function load(session: Session, agentId: string): Promise<PermissionsViewProps | null> {
    const id = uuidSchema.safeParse(agentId);
    if (!id.success) return null;
    const agent = await getAgentById(db, session.userId, id.data);
    if (agent == null) return null;
    const grants = await getConnectionPermissions(db, session.userId, agent.connectionId);
    if (grants == null) return null;
    return toViewProps(agent.displayName, grants);
  }

  // Save: validate the agent id shape and the input at the boundary FIRST (a 4xx before any
  // query, so malformed/oversized input writes nothing), resolve the agent member-scoped —
  // another person's id matches nothing and the save is refused — merge the partial edit
  // onto the stored grants, refuse card access without a budget that allows it, then upsert
  // so the change takes effect on the agent's next request.
  async function save(
    session: Session,
    agentId: string,
    input: PermissionsSaveInput,
  ): Promise<SaveResult> {
    const id = parseParams(uuidSchema, agentId);
    const valid = parseParams(inputSchema, input);

    const agent = await getAgentById(db, session.userId, id);
    if (agent == null) return { ok: false, reason: "not_found" };

    const stored = await getConnectionPermissions(db, session.userId, agent.connectionId);
    if (stored == null) return { ok: false, reason: "not_found" };

    const next = mergeGrants(stored, valid, session.userId, agent.connectionId);
    if (next.cardAccess && (next.cardBudget == null || !budgetAllowsCard(next.cardBudget))) {
      return { ok: false, reason: "card_needs_budget" };
    }

    await upsertPermissions(db, next);
    return { ok: true };
  }

  return { load, save };
}
