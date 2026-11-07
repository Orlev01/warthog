// E10-S03 — Agent consent decision action, wired into the authorize flow (design
// §6.1; brief "Agent consent screen"; constitution 15/16 — each connected agent gets
// its own revocable credential through the connector standard's consent flow).
//
// This is the injectable, unit-testable seam the thin `/oauth/authorize` consent
// `page.tsx` + its `"use server"` wrappers compose (the convention's
// `createXActions(deps)` factory, as `settings/security/actions.ts` does). A Next
// entry file may export only its framework fields, so the decision logic lives here
// and the entry stays thin (OBS-025).
//
// When the signed-in person APPROVES on the consent screen, Warthog, in one decision:
//   • names the agent and records the connecting platform,
//   • applies the chosen starting permission set (the pure domain contract
//     `@/domain/permissions/templates`) with high-tier / card / sharing honoured only
//     when explicitly opted in,
//   • issues the agent's one-time credential through the already-built `authorize`
//     seam, bound to the ONE server-minted connection id this decision creates,
//   • and records that connection (the agent row + its permission grants).
// When they REFUSE, nothing is created and no credential is issued — the client is
// redirected back with `access_denied` and no code.
//
// Security (each a reviewer veto):
//   • The acting person's user id is ALWAYS `session.userId` — never a value smuggled
//     in the untrusted approval input (CLAUDE.md: every member-scoped write takes the
//     user id from the session). The connection id is server-minted here, never
//     client-supplied.
//   • The approval is validated at the boundary (zod → a 4xx `HttpError`) BEFORE
//     anything is written, so malformed or oversized input writes nothing (INV-102).
//     Every value reaches storage bound as a query parameter (the db seam), so a value
//     shaped like SQL is stored as data and cannot alter a query.
//   • This module reads no `process.env` and holds no secret: config (the issuer)
//     flows in through injected `deps.config` alone (INV-103).

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { authorize } from "../../../server/oauth/authorize";
import { consumePendingAuthorization } from "../../../server/oauth/pending";
import { createAgent } from "../../../server/db/agents";
import {
  upsertPermissions,
  type PermissionGrants,
} from "../../../server/db/agent-permissions";
import { parseParams } from "../../../server/http/validate";
import { permissionTemplate } from "../../../domain/permissions/templates";
import type { Config } from "../../../server/config";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { Db } from "../../../server/db/index";
import type { Session } from "../../../server/auth/session";

// The brief's default per-agent request limit (120 requests per minute); the per-agent
// permissions page lets the person change it later (brief "Per-agent permissions page").
const DEFAULT_RATE_LIMIT = 120;

// Bounds that keep a malformed or oversized approval out of the database. A name must
// be present and reasonably short; the platform label and ticked-service ids are
// likewise bounded so a grossly oversized field is rejected at the boundary.
const MAX_NAME_LENGTH = 200;
const MAX_PLATFORM_LENGTH = 100;
const MAX_SERVICE_LENGTH = 200;
const MAX_SERVICES = 100;

// The person's consent decision, as the consent screen submits it. `template` is the
// chosen starting set (validated to one of the three names below); `tickedServices`
// are the service ids whose read tools Standard/Custom grant. High-tier, card and
// learning-sharing are ALWAYS opt-in — absent/false means off. `card` needs a budget
// when on. `template` is typed as a plain string here (the untrusted form value); the
// validation boundary narrows it.
export interface ConsentApproval {
  readonly name: string;
  readonly platform: string;
  readonly template: string;
  readonly tickedServices?: readonly string[];
  readonly highTier?: boolean;
  readonly card?: boolean;
  readonly cardBudget?: { amount: number; currency: string; period: string } | null;
  readonly learningSharing?: boolean;
}

// The outcome of a decision: a redirect back to the client (carrying the issued code
// on approval, or none on refusal), or a rejection naming the OAuth error.
export type DecisionResult =
  | { readonly ok: true; readonly redirectTo: string }
  | { readonly ok: false; readonly error: string };

// The seams the decision composes: the db (stores), config (the issuer, read through
// the authorize seam), the clock (the agent's connected-at + the credential expiry)
// and the randomness source (the opaque credential).
export interface AuthorizeActionsDeps {
  readonly db: Db;
  readonly config: Config;
  readonly clock: Clock;
  readonly random: Random;
}

// The consent-decision actions the consent screen drives. Each takes an opaque
// `handle` to the pending authorize request held SERVER-SIDE (E10-S12): the decision
// resolves and CONSUMES it through the pending store, never trusting the OAuth query
// from a form/URL field. A tampered (unknown) or replayed (already-consumed) handle
// resolves to nothing, so the decision creates nothing.
export interface AuthorizeActions {
  approve(session: Session, handle: string, approval: ConsentApproval): Promise<DecisionResult>;
  refuse(session: Session, handle: string): Promise<DecisionResult>;
}

// A card spending budget on the approval, validated to the brief's three periods.
const cardBudgetSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().min(1).max(8),
  period: z.enum(["day", "week", "month"]),
});

// The approval's validated shape. Unknown keys (e.g. a rogue `userId` smuggled into
// an untrusted form body) are stripped by zod's object parse — the decision never
// reads a user id from the input. `card` on REQUIRES a budget: that cross-field rule
// is enforced here so the refusal is a 4xx at the boundary, never the store's throw.
const approvalSchema = z
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

type ValidApproval = z.infer<typeof approvalSchema>;

// The configured issuer: the public base URL with any trailing slash stripped (the
// same derivation the authorize seam and the metadata endpoints use, design §6.1).
function issuer(config: Config): string {
  return config.publicBaseUrl.replace(/\/$/, "");
}

// Translate the chosen starting set (template + ticked services, plus the explicit
// opt-ins) into the one connection's stored grants, member-scoped to `userId`. The
// template is the one-source-of-truth domain contract; high-tier, card and sharing
// are off in every template and switch on only when the approval opted in. A card
// budget is recorded only when card access is on.
function grantsFor(
  userId: string,
  connectionId: string,
  approval: ValidApproval,
): PermissionGrants {
  const set = permissionTemplate(approval.template, approval.tickedServices ?? []);
  const cardAccess = approval.card === true;
  return {
    userId,
    connectionId,
    grantedConnectors: set.services.map((s) => s.service),
    readTools: set.services.length > 0,
    changeTools: set.services.length > 0 ? "ask_first" : "off",
    identityAccess: set.lowTierProfile,
    highTierAccess: approval.highTier === true,
    cardAccess,
    cardBudget: cardAccess ? approval.cardBudget ?? null : null,
    skillsScope: [],
    memoryRead: set.sharedMemoryRead,
    sharing: approval.learningSharing === true,
    rulesScope: [],
    rateLimit: DEFAULT_RATE_LIMIT,
  };
}

export function createAuthorizeActions(deps: AuthorizeActionsDeps): AuthorizeActions {
  const { db, config, clock, random } = deps;

  // Approve: validate the untrusted input FIRST (a 4xx before any write), resolve and
  // CONSUME the pending authorize request from its server-side handle (a tampered or
  // replayed handle resolves to nothing, so nothing is created), mint the connection id
  // server-side, issue the credential through the authorize flow bound to that
  // connection, then name the agent and upsert its chosen permissions. The authorize
  // seam enforces the OAuth rules (signed in, PKCE S256, matching resource) and writes
  // nothing on rejection, so an invalid request never leaves an orphan agent behind.
  async function approve(
    session: Session,
    handle: string,
    approval: ConsentApproval,
  ): Promise<DecisionResult> {
    const valid = parseParams(approvalSchema, approval);

    const pending = consumePendingAuthorization(handle);
    if (pending == null) return { ok: false, error: "invalid_request" };

    const connectionId = randomUUID();

    const issued = await authorize(
      { params: pending.params, session, connectionId },
      { db, config, clock, random },
    );
    if (!issued.ok) return { ok: false, error: issued.error };

    await createAgent(
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

    return { ok: true, redirectTo: issued.redirectTo };
  }

  // Refuse: create no agent, upsert no permissions and issue no credential. Resolve and
  // CONSUME the pending request from its server-side handle (a tampered or replayed
  // handle resolves to nothing, so there is no client to redirect and nothing is
  // created). Redirect back to the client with `access_denied` (the echoed state and the
  // configured issuer), carrying no code.
  async function refuse(_session: Session, handle: string): Promise<DecisionResult> {
    const pending = consumePendingAuthorization(handle);
    if (pending == null) return { ok: false, error: "invalid_request" };

    const redirectUri = pending.params.get("redirect_uri");
    if (redirectUri == null || redirectUri === "") {
      return { ok: false, error: "invalid_request" };
    }
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("error", "access_denied");
    const state = pending.params.get("state");
    if (state != null) redirect.searchParams.set("state", state);
    redirect.searchParams.set("iss", issuer(config));
    return { ok: true, redirectTo: redirect.toString() };
  }

  return { approve, refuse };
}
