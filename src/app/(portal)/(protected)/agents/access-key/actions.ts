// E10-S06 — Per-agent access key creation (design §6.1; brief "Connect an agent" —
// "For a platform that cannot use the standard connector sign-in, 'Create an access
// key' lets the person name the agent and set its permissions on the same screen as
// the consent screen, shows the key once with a copy button, and lets them revoke or
// replace the key later"; constitution 16 — each agent has its own revocable
// credential, a per-agent access key where a platform cannot use the connector flow).
//
// This is the injectable, unit-testable seam the thin access-key `page.tsx` + its
// `"use server"` wrappers compose (the convention's `createXActions(deps)` factory,
// as `oauth/authorize/actions.ts` and `settings/security/actions.ts` do). A Next
// entry file may export only its framework fields, so the flow logic lives here and
// the entry stays thin (OBS-025).
//
// The access-key flow is the consent flow's twin: instead of issuing an OAuth code,
// it mints a static `wh_ak_` bearer. Everything else is the same per-agent,
// per-connection model. `create` names ONE agent for the session user, applies the
// chosen starting permission set to a server-minted connection, and issues the
// agent's one-time access key through the already-built `issueAccessKey` seam.
// `revoke` / `replace` resolve the agent by (session.userId, agentId) FIRST, so
// another person's agent id matches nothing and the call is refused.
//
// Security (each a reviewer veto):
//   • The acting person's user id is ALWAYS `session.userId` — never a value smuggled
//     in the untrusted input (CLAUDE.md: every member-scoped write takes the user id
//     from the session). The connection id is server-minted here, never client-supplied.
//   • Input is validated at the boundary (zod → a 4xx `HttpError`) BEFORE anything is
//     written, so malformed or oversized input writes nothing (INV-102). A malformed
//     agent id is rejected as a 4xx before it can reach `WHERE id = $1` as a cast
//     (OBS-049). Every value reaches storage bound as a query parameter (the db seam),
//     so a value shaped like SQL is stored as data and cannot alter a query.
//   • This module reads no `process.env` and holds no secret: the key is minted from
//     the injected randomness seam alone (INV-103).

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { issueAccessKey, replaceAccessKey, revokeAccessKey } from "../../../../../server/oauth/access-key";
import { createAgent, getAgentById } from "../../../../../server/db/agents";
import {
  upsertPermissions,
  type PermissionGrants,
} from "../../../../../server/db/agent-permissions";
import { parseParams } from "../../../../../server/http/validate";
import { permissionTemplate } from "../../../../../domain/permissions/templates";
import type { Clock } from "../../../../../server/seams/clock";
import type { Random } from "../../../../../server/seams/random";
import type { Db } from "../../../../../server/db/index";
import type { Session } from "../../../../../server/auth/session";

// The brief's default per-agent request limit (120 requests per minute); the per-agent
// permissions page lets the person change it later (brief "Per-agent permissions page").
const DEFAULT_RATE_LIMIT = 120;

// Bounds that keep a malformed or oversized create out of the database. A name must be
// present and reasonably short; the platform label and ticked-service ids are likewise
// bounded so a grossly oversized field is rejected at the boundary.
const MAX_NAME_LENGTH = 200;
const MAX_PLATFORM_LENGTH = 100;
const MAX_SERVICE_LENGTH = 200;
const MAX_SERVICES = 100;

// The access-key create input, as the access-key screen submits it — the SAME shape
// the consent screen submits ("set permissions on the same screen as the consent
// screen"). `template` is the chosen starting set (validated to one of the three names
// below); `tickedServices` are the service ids whose read tools Standard/Custom grant.
// High-tier, card and learning-sharing are ALWAYS opt-in — absent/false means off.
// `card` needs a budget when on. `template` is typed as a plain string here (the
// untrusted form value); the validation boundary narrows it.
export interface AccessKeyInput {
  readonly name: string;
  readonly platform: string;
  readonly template: string;
  readonly tickedServices?: readonly string[];
  readonly highTier?: boolean;
  readonly card?: boolean;
  readonly cardBudget?: { amount: number; currency: string; period: string } | null;
  readonly learningSharing?: boolean;
}

// The outcome of a create: the created agent's id and the RAW key shown ONCE, or a
// refusal naming its reason. Never a silent success.
export type CreateResult =
  | { readonly ok: true; readonly agentId: string; readonly key: string }
  | { readonly ok: false; readonly reason: string };

// The outcome of a revoke: success, or a refusal (the agent is not this person's).
export type RevokeResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// The outcome of a replace: the fresh RAW key shown ONCE, or a refusal (the agent is
// not this person's).
export type ReplaceResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: string };

// The seams the flow composes: the db (stores), the clock (the agent's connected-at)
// and the randomness source (the opaque access key). No config — no OAuth issuer here.
export interface AccessKeyActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
}

// The access-key actions the access-key screen drives.
export interface AccessKeyActions {
  create(session: Session, input: AccessKeyInput): Promise<CreateResult>;
  revoke(session: Session, agentId: string): Promise<RevokeResult>;
  replace(session: Session, agentId: string): Promise<ReplaceResult>;
}

// A card spending budget on the create, validated to the brief's three periods.
const cardBudgetSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().min(1).max(8),
  period: z.enum(["day", "week", "month"]),
});

// The create's validated shape. Unknown keys (e.g. a rogue `userId` smuggled into an
// untrusted form body) are stripped by zod's object parse — the flow never reads a
// user id from the input. `card` on REQUIRES a budget: that cross-field rule is
// enforced here so the refusal is a 4xx at the boundary, never the store's throw.
const inputSchema = z
  .object({
    name: z.string().min(1).max(MAX_NAME_LENGTH),
    platform: z.string().min(1).max(MAX_PLATFORM_LENGTH),
    template: z.enum(["minimal", "standard", "custom"]),
    tickedServices: z.array(z.string().max(MAX_SERVICE_LENGTH)).max(MAX_SERVICES).optional(),
    highTier: z.boolean().optional(),
    card: z.boolean().optional(),
    cardBudget: cardBudgetSchema.nullable().optional(),
    learningSharing: z.boolean().optional(),
  })
  .refine((a) => a.card !== true || a.cardBudget != null, {
    message: "card access requires a budget",
  });

type ValidInput = z.infer<typeof inputSchema>;

// A well-formed uuid: the only shape an agent id handle may take. A malformed value is
// rejected at the validation boundary (parseParams throws a 4xx HttpError) before it
// can reach `WHERE id = $1` as a cast (OBS-049), so a SQL-shaped id is refused here
// before any query runs.
const uuidSchema = z.uuid();

// Translate the chosen starting set (template + ticked services, plus the explicit
// opt-ins) into the one connection's stored grants, member-scoped to `userId`. The
// template is the one-source-of-truth domain contract; high-tier, card and sharing are
// off in every template and switch on only when the input opted in. A card budget is
// recorded only when card access is on. (The consent flow's `grantsFor` twin.)
function grantsFor(userId: string, connectionId: string, input: ValidInput): PermissionGrants {
  const set = permissionTemplate(input.template, input.tickedServices ?? []);
  const cardAccess = input.card === true;
  return {
    userId,
    connectionId,
    grantedConnectors: set.services.map((s) => s.service),
    readTools: set.services.length > 0,
    changeTools: set.services.length > 0 ? "ask_first" : "off",
    identityAccess: set.lowTierProfile,
    highTierAccess: input.highTier === true,
    cardAccess,
    cardBudget: cardAccess ? input.cardBudget ?? null : null,
    skillsScope: [],
    memoryRead: set.sharedMemoryRead,
    sharing: input.learningSharing === true,
    rulesScope: [],
    rateLimit: DEFAULT_RATE_LIMIT,
    // Tasks and life-admin records are their own grants (review fix A2): Standard and
    // Custom include them, Minimal does not — independent of any ticked service.
    tasksAccess: set.tasks,
    recordsAccess: set.lifeAdmin,
  };
}

export function createAccessKeyActions(deps: AccessKeyActionsDeps): AccessKeyActions {
  const { db, clock, random } = deps;

  // Create: validate the untrusted input FIRST (a 4xx before any write), mint the
  // connection id server-side, name the agent and upsert its chosen permissions, then
  // issue the access key bound to that one connection. The acting user id is the
  // session's, never a value smuggled in the input. The raw key is returned ONCE — only
  // its hash is stored.
  async function create(session: Session, input: AccessKeyInput): Promise<CreateResult> {
    const valid = parseParams(inputSchema, input);
    const connectionId = randomUUID();

    const agent = await createAgent(
      db,
      {
        userId: session.userId,
        connectionId,
        displayName: valid.name,
        platform: valid.platform,
        status: "connected",
      },
      clock,
    );

    await upsertPermissions(db, grantsFor(session.userId, connectionId, valid));

    const { key } = await issueAccessKey(db, { connectionId }, { random });

    return { ok: true, agentId: agent.id, key };
  }

  // Revoke: validate the agent id shape at the boundary first (a malformed id throws a
  // 4xx), resolve the agent by (session.userId, agentId) — so another person's id
  // matches nothing — then revoke the connection's key so it no longer verifies. An id
  // that is not this person's revokes nothing ({ ok: false }, never a silent success).
  async function revoke(session: Session, agentId: string): Promise<RevokeResult> {
    const id = parseParams(uuidSchema, agentId);
    const agent = await getAgentById(db, session.userId, id);
    if (agent == null) return { ok: false, reason: "not_found" };
    await revokeAccessKey(db, { connectionId: agent.connectionId });
    return { ok: true };
  }

  // Replace: same discipline — validate the id shape, resolve the agent member-scoped,
  // then retire the old key and issue a fresh one bound to the SAME connection (so the
  // old key stops verifying and the agent keeps working under the new key). An id that
  // is not this person's issues nothing and leaves the original key working.
  async function replace(session: Session, agentId: string): Promise<ReplaceResult> {
    const id = parseParams(uuidSchema, agentId);
    const agent = await getAgentById(db, session.userId, id);
    if (agent == null) return { ok: false, reason: "not_found" };
    const { key } = await replaceAccessKey(db, { connectionId: agent.connectionId }, { random });
    return { ok: true, key };
  }

  return { create, revoke, replace };
}
