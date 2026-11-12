import { auditedOwnerChange } from "@/server/activity/owner-change";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
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
// another person's agent id matches nothing and the call is refused. The agent's Settings
// section drives them (its "Access key" panel). They refuse what would mislead, writing
// nothing: any change to a disconnected agent (its key went with the disconnect), a
// revoke when no key is left, and a key for an agent that connected over OAuth. Under the
// connection's credential lock they re-check that the agent is still connected, so a
// disconnect that lands first wins and no working key is left behind.
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

import { listConnectionsForUser } from "@/server/db/connections";
import { getAgentDefaults } from "@/server/db/agent-defaults";
import { randomUUID } from "node:crypto";

import { z } from "zod";
import { getAccountCurrency, isKnownCurrency } from "@/server/db/account-currency";

import { issueAccessKey, replaceAccessKey, revokeAccessKey } from "../../../../../server/oauth/access-key";
import { lockOAuthConnection } from "../../../../../server/oauth/connection-lock";
import { createAgent, getAgentById } from "../../../../../server/db/agents";
import { getUserById } from "../../../../../server/db/users";
import { connectedWithAccessKey, hasAccessKey } from "../../../../../server/agents/access-key-state";
import {
  upsertPermissions,
  type PermissionGrants,
} from "../../../../../server/db/agent-permissions";
import { parseParams } from "../../../../../server/http/validate";
import { initialGrants } from "../../../../../server/agents/initial-grants";
import type { Clock } from "../../../../../server/seams/clock";
import type { Random } from "../../../../../server/seams/random";
import type { Db } from "../../../../../server/db/index";
import type { Session } from "../../../../../server/auth/session";

// The brief's default per-agent request limit (120 requests per minute); the per-agent
// permissions page lets the person change it later (brief "Per-agent permissions page").

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
  readonly identity?: boolean;
  readonly memoryRead?: boolean;
  readonly memoryWrite?: boolean;
  readonly tasks?: boolean;
  readonly records?: boolean;
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

// The outcome of a revoke: success, or a refusal: `not_found` (the agent is not this
// person's), `not_connected` (it is disconnected) or `no_key` (there is no key to revoke).
export type RevokeResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// The outcome of a replace: the fresh RAW key shown ONCE, or a refusal: `not_found`,
// `not_connected` or `not_access_key` (the agent connected over OAuth, so it has no key).
export type ReplaceResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: string };

// The seams the flow composes: the db (stores), the clock (the agent's connected-at)
// and the randomness source (the opaque access key). No config — no OAuth issuer here.
export interface AccessKeyActionsDeps {
  readonly keyWrapper: KeyWrapper;
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
  currency: z.string().min(1).max(8).transform(value => value === "A$" ? "AUD" : value.trim().toUpperCase()).refine(isKnownCurrency),
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
    identity: z.boolean().optional(),
    memoryRead: z.boolean().optional(),
    memoryWrite: z.boolean().optional(),
    tasks: z.boolean().optional(),
    records: z.boolean().optional(),
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

export function createAccessKeyActions(deps: AccessKeyActionsDeps): AccessKeyActions {
  const { db, clock, random } = deps;

  // Create: validate the untrusted input FIRST (a 4xx before any write), mint the
  // connection id server-side, name the agent and upsert its chosen permissions, then
  // issue the access key bound to that one connection. The acting user id is the
  // session's, never a value smuggled in the input. The raw key is returned ONCE — only
  // its hash is stored.
  async function create(session: Session, input: AccessKeyInput): Promise<CreateResult> {
    const valid = parseParams(inputSchema, input);
    return auditedOwnerChange(deps, session.userId, async (tx, record) => {
      const connected = new Set((await listConnectionsForUser(tx, session.userId)).map(c => c.connectorId));
      valid.tickedServices = valid.tickedServices?.filter(id => connected.has(id));
      const connectionId = randomUUID();

      const agent = await createAgent(
        tx,
        {
          userId: session.userId,
          connectionId,
          displayName: valid.name,
          platform: valid.platform,
          status: "connected",
        },
        clock,
      );

      const grants = await upsertPermissions(tx, {
        ...initialGrants(session.userId, connectionId, valid),
        rateLimit: (await getAgentDefaults(tx, session.userId)).rateLimit,
      });

      const { key } = await issueAccessKey(tx, { connectionId }, { random });

      await record("agent_connected", { credentialKind: "access_key", grants }, agent.id);
      return { ok: true as const, agentId: agent.id, key };
    });
  }

  // Revoke: validate the agent id shape at the boundary first (a malformed id throws a
  // 4xx), resolve the agent by (session.userId, agentId) — so another person's id
  // matches nothing — then revoke the connection's key so it no longer verifies. An id
  // that is not this person's revokes nothing ({ ok: false }, never a silent success).
  // A disconnected agent, or one with no key left (already revoked, or an OAuth agent that
  // never had one), revokes nothing and records nothing.
  async function revoke(session: Session, agentId: string): Promise<RevokeResult> {
    const id = parseParams(uuidSchema, agentId);
    const agent = await getAgentById(db, session.userId, id);
    if (agent == null) return { ok: false, reason: "not_found" };
    if (agent.status !== "connected") return { ok: false, reason: "not_connected" };
    return auditedOwnerChange(deps, session.userId, async (tx, record): Promise<RevokeResult> => {
      await lockOAuthConnection(tx, agent.connectionId);
      if ((await getAgentById(tx, session.userId, id))?.status !== "connected") return { ok: false, reason: "not_connected" };
      if (!(await hasAccessKey(tx, agent.connectionId))) return { ok: false, reason: "no_key" };
      await revokeAccessKey(tx, { connectionId: agent.connectionId });
      await record("agent_key_revoked", {}, agent.id);
      return { ok: true };
    });
  }

  // Replace: same discipline — validate the id shape, resolve the agent member-scoped,
  // then retire the old key and issue a fresh one bound to the SAME connection (so the
  // old key stops verifying and the agent keeps working under the new key). An id that
  // is not this person's issues nothing and leaves the original key working.
  //
  // After a revoke there is no old key: replace then issues the agent's new key, so the
  // person can let it back in without connecting it from the start. Only an agent that
  // connected with an access key gets one (a working key now, or the record of its
  // access-key connection); an OAuth agent is never handed a static key. A disconnected
  // agent gets nothing — reconnecting means going through consent again (brief).
  async function replace(session: Session, agentId: string): Promise<ReplaceResult> {
    const id = parseParams(uuidSchema, agentId);
    const agent = await getAgentById(db, session.userId, id);
    if (agent == null) return { ok: false, reason: "not_found" };
    if (agent.status !== "connected") return { ok: false, reason: "not_connected" };
    if (!(await hasAccessKey(db, agent.connectionId)) && !(await connectedWithAccessKey(db, session.userId, agent.id, await dataKey(session.userId)))) {
      return { ok: false, reason: "not_access_key" };
    }
    return auditedOwnerChange(deps, session.userId, async (tx, record): Promise<ReplaceResult> => {
      await lockOAuthConnection(tx, agent.connectionId);
      if ((await getAgentById(tx, session.userId, id))?.status !== "connected") return { ok: false, reason: "not_connected" };
      const { key } = await replaceAccessKey(tx, { connectionId: agent.connectionId }, { random });
      await record("agent_key_replaced", {}, agent.id);
      return { ok: true, key };
    });
  }

  // The session person's data key, to read how their agent connected (that record is
  // encrypted). Only a replace with no working key needs it.
  async function dataKey(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) throw new Error("Account unavailable");
    return deps.keyWrapper.unwrap(user.wrappedDek);
  }

  return { create, revoke, replace };
}
