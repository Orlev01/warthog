// E07-S16 — Agent call pipeline: gatekeeping and the allow/deny decision
// (design §6.1 pipeline, §8 policy engine; constitution principle 14 "Warthog
// writes the record", 15 "agents reach services only through Warthog").
//
// `handleAgentCall` is the one gate every agent tool call passes through. In
// order (design §6.1): it refuses a call on a disconnected/revoked connection;
// applies the per-connection rate limit (a burst over the limit is refused and
// recorded as ONE summarising entry, not one per refused call); loads the
// member-scoped policy context (E07-S09); evaluates the pure policy engine
// (E03-S13); and then — on ALLOW executes the tool and records the activity
// entry BEFORE the result returns; on DENY refuses and records; on ASK HOLDS the
// call (its args DEK-encrypted) behind a fresh PENDING approval, records the held
// call, and returns `pending_approval` without executing (E07-S17).
//
// This is a SERVER module built purely from its INJECTED seams (db, keyWrapper,
// clock, rateLimiter, recorder, executeTool, rate): it reads no `process.env` and
// holds no secret (INV-103). The caller's identity is ALWAYS the resolved
// connection's `userId` (the session's), never a value from the call body
// (INV-101/INV-102): every member-scoped read goes through `loadAgentContext`,
// which binds the ids as parameters.
//
// WHY a factory: "a burst over the rate limit is recorded as ONE summarising
// entry, not one per refused call" needs state that spans calls — the pipeline
// must know a refusal continues the current over-limit streak rather than
// starting a fresh one. The factory closes over that per-connection burst state;
// the production root memoizes one pipeline per process.

import {
  evaluate,
  type CardPolicy,
  type IdentifiedRule,
  type Permission,
  type PolicyCall,
  type PolicyContext,
} from "../../domain/policy/evaluate";
import type { Budget } from "../../domain/budget/budget";
import type { ReferenceRate } from "../../domain/currency/convert";
import { loadAgentContext, type AgentConnection, type AgentContext } from "./context";
import { createApproval } from "../db/approvals";
import { createHeldRequest } from "../db/held-requests";
import { getUserById } from "../db/users";
import type { RateLimiter } from "./rate-limit";
import type { ActivityRecorder } from "../activity/recorder";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

// What the agent is asking to do. The policy-relevant fields are exactly the
// engine's `PolicyCall`, plus the tool `params` (executed + recorded, redacted)
// and an optional agent `reason`.
export interface AgentCall {
  readonly connector: string | null;
  readonly tool: string;
  readonly makesChange: boolean;
  readonly request?: "card" | "high_tier";
  readonly amount?: number;
  readonly currency?: string;
  readonly merchant?: string;
  readonly recipients?: string | readonly string[] | null;
  readonly messageChannel?: "email" | "chat" | "post";
  readonly params?: unknown;
  readonly reason?: string;
}

// The injected seams — no process.env (INV-103).
export interface PipelineDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
  readonly rateLimiter: RateLimiter;
  readonly recorder: ActivityRecorder;
  readonly executeTool: (call: AgentCall, connection: AgentConnection) => Promise<unknown>;
  readonly rate?: ReferenceRate | null;
}

// A discriminated union on `status` (the repo idiom).
export type AgentCallResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string }
  | { status: "pending_approval"; approval_id: string; expires_at: Date };

export interface AgentCallPipeline {
  handleAgentCall(connection: AgentConnection, call: AgentCall): Promise<AgentCallResult>;
}

// The fallback when no card budget is set: a zero budget, which `budgetAllowsCard`
// treats as "no budget" so a card request is denied before it can ask.
const NO_BUDGET: Budget = { amount: 0, period: "month" };

// The permission the policy engine checks (design §8 step 2). The stored grants
// grant whole CONNECTORS plus read/change tool CLASSES — there is no per-tool
// allowlist column — so a tool is permitted when its connector is granted AND its
// class (read / change) is allowed. `grantedTools` therefore names exactly the
// called tool, leaving the connector grant + class to gate it.
function toPermission(call: AgentCall, context: AgentContext): Permission {
  const { permissions } = context;
  return {
    connectorGranted: call.connector !== null && permissions.grantedConnectors.includes(call.connector),
    grantedTools: [call.tool],
    readsAllowed: permissions.readTools,
    changes: permissions.changeTools,
    highTierAllowed: permissions.highTierAccess,
  };
}

// The card settings the policy engine checks (design §8 step 4). The already-spent
// total for the current budget period comes pre-summed from the loader; the engine
// sums releases inside the window, so it is handed back as one synthetic release at
// the current instant (which falls inside the window).
function toCardPolicy(context: AgentContext, now: Date): CardPolicy {
  const { permissions, spend } = context;
  const budget: Budget = permissions.cardBudget
    ? { amount: permissions.cardBudget.amount, period: permissions.cardBudget.period }
    : NO_BUDGET;
  return {
    access: permissions.cardAccess,
    budget,
    releases: spend > 0 ? [{ amount: spend, at: now }] : [],
  };
}

// Assemble the pure engine's context from the resolved connection and the loaded
// member-scoped context. The rule scope is matched on the connection id (the same
// id space the loader filters applicable rules by).
function toPolicyContext(
  connection: AgentConnection,
  context: AgentContext,
  call: AgentCall,
  now: Date,
  rate: ReferenceRate | null,
): PolicyContext {
  return {
    connectionActive: connection.active,
    agentId: connection.connectionId,
    permission: toPermission(call, context),
    rules: context.rules as readonly IdentifiedRule[],
    accountCurrency: context.accountCurrency,
    card: toCardPolicy(context, now),
    rate,
    now,
  };
}

// The call's policy-relevant fields, in the engine's shape.
function toPolicyCall(call: AgentCall): PolicyCall {
  return {
    connector: call.connector,
    tool: call.tool,
    makesChange: call.makesChange,
    messageChannel: call.messageChannel,
    request: call.request,
    amount: call.amount,
    currency: call.currency,
    merchant: call.merchant,
    recipients: call.recipients,
  };
}

// The approval `detail` the person reviews in their inbox: a summary of WHAT the
// held call will do (recipient / amount / field), stored DEK-encrypted by the
// approvals store. The raw tool arguments live on the linked held request.
function toApprovalDetail(call: AgentCall): Record<string, unknown> {
  return {
    tool: call.tool,
    connector: call.connector,
    request: call.request,
    amount: call.amount,
    currency: call.currency,
    merchant: call.merchant,
    recipients: call.recipients,
    reason: call.reason,
  };
}

export function createAgentCallPipeline(deps: PipelineDeps): AgentCallPipeline {
  const { db, keyWrapper, clock, rateLimiter, recorder, executeTool } = deps;
  const rate = deps.rate ?? null;

  // Per-connection burst state: true once the CURRENT over-limit streak has been
  // summarised with one activity entry. A call allowed through the limiter ends
  // the streak, so a later burst records a fresh entry.
  const burstSummarised = new Map<string, boolean>();

  // Record one activity entry FOR the call. Warthog writes it itself (`source:
  // "warthog"`); the recorder runs the payload through redaction before storing.
  async function record(
    connection: AgentConnection,
    call: AgentCall,
    outcome: string,
  ): Promise<void> {
    await recorder.record({
      userId: connection.userId,
      kind: "tool_call",
      source: "warthog",
      agentId: connection.agentId,
      connectorId: call.connector ?? undefined,
      tool: call.tool,
      outcome,
      merchant: call.merchant,
      payload: { params: call.params, reason: call.reason },
    });
  }

  // Resolve the person's unwrapped DEK (to encrypt the held call's args and the
  // approval detail). Read the wrapped DEK member-scoped by `userId` (the session's,
  // never a client value) and unwrap it through the KeyWrapper seam. Throws when the
  // person has no row — never fails silently.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("handleAgentCall: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  return {
    async handleAgentCall(connection: AgentConnection, call: AgentCall): Promise<AgentCallResult> {
      // Gate 1 — a disconnected or revoked connection: refuse and record, never
      // execute. (The connection's identity is the session's; no body value.)
      if (!connection.active) {
        const reason = "This agent is not connected.";
        await record(connection, call, "refused");
        return { status: "refused", reason };
      }

      // The member-scoped policy context (binds the ids as parameters). Carries the
      // person's configured per-connection rate limit, used next.
      const context = await loadAgentContext(connection, { db, keyWrapper, clock });

      // Gate 2 — the per-connection rate limit. A burst over the limit is refused
      // and recorded as ONE summarising entry for the streak, not one per call.
      if (!rateLimiter.allow(connection.connectionId, context.permissions.rateLimit)) {
        const reason = "This agent is going too fast — its request rate limit was reached.";
        if (!burstSummarised.get(connection.connectionId)) {
          await record(connection, call, "rate_limited");
          burstSummarised.set(connection.connectionId, true);
        }
        return { status: "refused", reason };
      }
      // Allowed through the limiter: the current over-limit streak (if any) is over.
      burstSummarised.set(connection.connectionId, false);

      // Gates 3 & 4 — the permission check and the policy engine, in design §8 order.
      const decision = evaluate(
        toPolicyCall(call),
        toPolicyContext(connection, context, call, clock.now(), rate),
      );

      // DENY — refuse and record, never execute.
      if (decision.decision === "deny") {
        await record(connection, call, "denied");
        return { status: "refused", reason: decision.reason };
      }

      // ASK — the person is needed. Warthog HOLDS the call: it parks the exact
      // agent call (its args DEK-encrypted) behind a fresh PENDING approval, records
      // one activity entry for the held call, and tells the agent `pending_approval`
      // WITHOUT executing the tool. The person decides it from their inbox; on
      // approval Warthog runs the held call exactly once.
      if (decision.decision === "ask") {
        const dek = await dataKeyFor(connection.userId);
        const approval = await createApproval(
          db,
          {
            userId: connection.userId,
            agentId: connection.agentId,
            detail: toApprovalDetail(call),
          },
          dek,
          clock,
        );
        await createHeldRequest(
          db,
          {
            userId: connection.userId,
            agentId: connection.agentId,
            approvalId: approval.id,
            args: { ...call },
          },
          dek,
          clock,
        );
        await record(connection, call, "pending_approval");
        return { status: "pending_approval", approval_id: approval.id, expires_at: approval.expiresAt };
      }

      // ALLOW — execute the tool, then record the activity entry BEFORE the result
      // is returned to the agent.
      const result = await executeTool(call, connection);
      await record(connection, call, "executed");
      return { status: "executed", result };
    },
  };
}
