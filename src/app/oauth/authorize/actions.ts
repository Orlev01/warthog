import { auditedOwnerChange } from "@/server/activity/owner-change";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
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

import { getAgentDefaults } from "@/server/db/agent-defaults";
import { randomUUID } from "node:crypto";

import { z } from "zod";
import { getAccountCurrency, isKnownCurrency } from "@/server/db/account-currency";

import { authorize, validatedRedirectUri } from "../../../server/oauth/authorize";
import type { ClientResolver } from "../../../server/oauth/clients";
import { consumePendingAuthorization, isConsentRequestTag } from "../../../server/oauth/pending";
import { requireStepUp } from "../../../server/auth/step-up";
import { createAgent } from "../../../server/db/agents";
import { defaultAccountsForAgents, listConnectionsForUser } from "../../../server/db/connections";
import {
  upsertPermissions,
  type PermissionGrants,
} from "../../../server/db/agent-permissions";
import { parseParams } from "../../../server/http/validate";
import { alertNewAgentConnection, type AlertDeps } from "../../../server/auth/alerts";
import { initialGrants } from "../../../server/agents/initial-grants";
import type { Config } from "../../../server/config";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { Db } from "../../../server/db/index";
import type { Session } from "../../../server/auth/session";

// The brief's default per-agent request limit (120 requests per minute); the per-agent
// permissions page lets the person change it later (brief "Per-agent permissions page").

// Bounds that keep a malformed or oversized approval out of the database. A name must
// be present and reasonably short; the platform label and ticked-service ids are
// likewise bounded so a grossly oversized field is rejected at the boundary.
const MAX_NAME_LENGTH = 200;
const MAX_PLATFORM_LENGTH = 100;
const MAX_SERVICE_LENGTH = 200;
const MAX_SERVICES = 100;

// The person's consent decision, as the consent screen submits it. `template` is the
// chosen starting set (validated to one of the three names below); `tickedServices`
// are the service ids whose read tools are granted (kept only when the person has
// actually connected that service). High-tier, card and learning-sharing are ALWAYS
// opt-in — absent/false means off. `card` needs a budget when on. `template` is typed
// as a plain string here (the untrusted form value); the validation boundary narrows it.
//
// Review fix A2 — `identity`, `memoryRead`, `tasks` and `records` are the screen's own
// toggles (basic profile, shared memory, tasks, life-admin records). When given they
// OVERRIDE the starting set, so what the person sees ticked is exactly what is stored;
// when absent the starting set decides.
export interface ConsentApproval {
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

// The outcome of a decision: a redirect back to the client (carrying the issued code
// on approval, or none on refusal), or a rejection naming the OAuth error.
// `request_changed`: the form was for a different request than the one the handle cookie now
// names (nothing is consumed; the person reviews the current one). `step_up_required`: the
// person must confirm it's them first (nothing is consumed; they can approve straight after).
export type DecisionResult =
  | { readonly ok: true; readonly redirectTo: string }
  | { readonly ok: false; readonly error: string };

// The seams the decision composes: the db (stores), config (the issuer, read through
// the authorize seam), the clock (the agent's connected-at + the credential expiry),
// the randomness source (the opaque credential), the client resolver (review fix
// A1: both decisions re-check the client and its registered redirect URI, so neither
// ever redirects to an unvalidated URI) and the alert senders (review fix A6: the
// "new agent connection" security email).
export interface AuthorizeActionsDeps {
  readonly keyWrapper: KeyWrapper;
  readonly db: Db;
  readonly config: Config;
  readonly clock: Clock;
  readonly random: Random;
  readonly resolveClient: ClientResolver;
  readonly alerts: AlertDeps;
}

// The consent-decision actions the consent screen drives. Each takes an opaque
// `handle` to the pending authorize request held SERVER-SIDE (E10-S12): the decision
// resolves and CONSUMES it through the pending store, never trusting the OAuth query
// from a form/URL field. A tampered (unknown) or replayed (already-consumed) handle
// resolves to nothing, so the decision creates nothing.
//
// Review 2026-11-23 (the consent swap): each also takes `requestTag`, the tag of the handle
// the screen was rendered for (`consentRequestTag`), and decides only when the cookie's handle
// is still that request. Approving also needs a fresh "confirm it's you" (step-up), as
// making an access key does: either way the agent gets lasting access.
export interface AuthorizeActions {
  approve(session: Session, handle: string, approval: ConsentApproval, requestTag: string): Promise<DecisionResult>;
  refuse(session: Session, handle: string, requestTag: string): Promise<DecisionResult>;
}

// A card spending budget on the approval, validated to the brief's three periods.
const cardBudgetSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().min(1).max(8).transform(value => value === "A$" ? "AUD" : value.trim().toUpperCase()).refine(isKnownCurrency),
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

type ValidApproval = z.infer<typeof approvalSchema>;

// The configured issuer: the public base URL with any trailing slash stripped (the
// same derivation the authorize seam and the metadata endpoints use, design §6.1).
function issuer(config: Config): string {
  return config.publicBaseUrl.replace(/\/$/, "");
}

// Translate the person's choices into the one connection's stored grants,
// member-scoped to `userId`. The starting set (the one-source-of-truth domain contract)
// supplies every grant the approval does not state; each toggle the screen submits
// overrides it (review fix A2), so the stored grants match the visible toggles.
// High-tier, card and sharing are off in every template and switch on only when opted
// in; a card budget is recorded only when card access is on. `connectedServices` is the
// person's OWN connected service ids: a ticked service is granted only when it is one of
// them (never trusting the form for this), with its read tools on and its changes set to
// "ask me first". Tasks and records are their own grants, not the connector tool classes.
export function createAuthorizeActions(deps: AuthorizeActionsDeps): AuthorizeActions {
  const { db, config, clock, random, resolveClient, alerts } = deps;

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
    requestTag: string,
  ): Promise<DecisionResult> {
    const valid = parseParams(approvalSchema, approval);

    // The screen the person approved on must be for the request the cookie names now; and a
    // connection needs a fresh confirmation. Neither refusal consumes the request.
    if (!isConsentRequestTag(handle, requestTag)) return { ok: false, error: "request_changed" };
    if (!requireStepUp(session, { clock })) return { ok: false, error: "step_up_required" };

    // Only the person who started the request can decide it: another signed-in person's
    // handle resolves to nothing (and is left for its owner).
    const pending = consumePendingAuthorization(handle, session.userId);
    if (pending == null) return { ok: false, error: "invalid_request" };

    const connectionId = randomUUID();

    // Resolve before opening the transaction: this resolver can read the root DB
    // or fetch client metadata. Reuse that snapshot for the validated request only.
    const clientId = pending.params.get("client_id");
    const client = clientId ? await resolveClient(clientId) : null;
    const issued = await auditedOwnerChange(deps, session.userId, async (tx, record) => {
      const result = await authorize(
        { params: pending.params, session, connectionId },
        { db: tx, config, clock, random, resolveClient: async id => id === clientId ? client : null },
      );
      if (!result.ok) return result;

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

      // The person's own connected services (member-scoped by the session's user id): the
      // only ones a ticked service can grant.
      const connected = new Set(
        (await listConnectionsForUser(tx, session.userId)).map((c) => c.connectorId),
      );
      // A ticked service with an account on for new agents is set to that account
      // (docs/adr/default-services.md).
      const defaultAccounts = await defaultAccountsForAgents(tx, session.userId);
      const grants = await upsertPermissions(tx, {
        ...initialGrants(session.userId, connectionId, valid, [...new Set(valid.tickedServices ?? [])].filter(id => connected.has(id)), defaultAccounts),
        rateLimit: (await getAgentDefaults(tx, session.userId)).rateLimit,
      });

      await record("agent_connected", { credentialKind: "oauth", clientId, grants }, agent.id);
      return result;
    });
    if (!issued.ok) return { ok: false, error: issued.error };

    // Tell the person a new agent connected (design: an email alert for each new agent
    // connection; the alerts module addresses it to the session's own person and scrubs
    // the agent's name through redaction). The connection is already complete, so a send
    // failure must not strand the agent mid-handshake: it is logged — with no personal
    // content — and the approval goes ahead.
    try {
      await alertNewAgentConnection(db, { userId: session.userId, agentName: valid.name }, alerts);
    } catch {
      console.error("[warthog oauth] the new-agent-connection alert could not be sent");
    }

    return { ok: true, redirectTo: issued.redirectTo };
  }

  // Refuse: create no agent, upsert no permissions and issue no credential. Resolve and
  // CONSUME the pending request from its server-side handle (a tampered or replayed
  // handle resolves to nothing, so there is no client to redirect and nothing is
  // created). Re-check the client and its registered redirect URI (review fix A1) — a
  // redirect that fails is never followed, so Refuse can't be turned into an open
  // redirect or a `javascript:` navigation. Redirect back to the client with
  // `access_denied` (the echoed state and the configured issuer), carrying no code.
  async function refuse(session: Session, handle: string, requestTag: string): Promise<DecisionResult> {
    if (!isConsentRequestTag(handle, requestTag)) return { ok: false, error: "request_changed" };
    const pending = consumePendingAuthorization(handle, session.userId);
    if (pending == null) return { ok: false, error: "invalid_request" };

    const validated = await validatedRedirectUri(pending.params, resolveClient);
    if (!validated.ok) return { ok: false, error: validated.error };
    const redirect = new URL(validated.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    const state = pending.params.get("state");
    if (state != null) redirect.searchParams.set("state", state);
    redirect.searchParams.set("iss", issuer(config));
    return { ok: true, redirectTo: redirect.toString() };
  }

  return { approve, refuse };
}
