import { highTierRequestAllowed } from "../agents/resource-access";
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
  type IdentifiedRule,
  type Permission,
  type PolicyCall,
  type PolicyContext,
} from "../../domain/policy/evaluate";
import { convert, type ReferenceRate } from "../../domain/currency/convert";
import { ruleSentence } from "../../domain/rules/rules";
import { requestSentence } from "../../domain/approvals/request-sentence";
import {
  cardPolicyFor,
  cardRequestOf,
  loadAgentContext,
  type AgentConnection,
  type AgentContext,
} from "./context";
import { createApproval, getApproval } from "../db/approvals";
import {
  createHeldRequest,
  getByApproval,
  markExecuted,
  recordOutcome,
  HeldRequestAlreadyExecutedError,
  type HeldOutcome,
  type StoredHeldRequest,
} from "../db/held-requests";
import { countAgentRequest, getAgentById } from "../db/agents";
import { getUserById } from "../db/users";
import { isReleaseRequest } from "../../domain/approvals/release-kind";
import type { RateLimiter } from "./rate-limit";
import type { ActivityRecorder } from "../activity/recorder";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Clock } from "../seams/clock";
import { withTransaction, type Db } from "../db/index";

// What the agent is asking to do. The policy-relevant fields are exactly the
// engine's `PolicyCall`, plus the tool `params` (executed + recorded, redacted)
// and an optional agent `reason`.
export interface AgentCall {
  readonly requiresApproval?: boolean;
  readonly connector: string | null;
  readonly connectorAccountId?: string;
  readonly connectorAccountLabel?: string;
  readonly tool: string;
  readonly makesChange: boolean;
  readonly request?: "card" | "high_tier";
  readonly amount?: number;
  readonly currency?: string;
  readonly merchant?: string;
  readonly recipients?: string | readonly string[] | null;
  readonly messageChannel?: "email" | "chat" | "post";
  // A high-tier request's field (e.g. "passport") and the agent's stated purpose,
  // shown to the person on the approval (brief "High-tier release").
  readonly field?: string;
  readonly purpose?: string;
  readonly params?: unknown;
  readonly reason?: string;
}

// The side effect fired on approval creation (E12-S07): a push to every registered
// device plus a scheduled fallback job, keyed to the just-created approval. The
// pipeline takes it as an OPTIONAL injected seam — a function of the created approval
// ({ userId, approvalId, createdAt, dek }) — so a pipeline built WITHOUT it behaves
// exactly as before (every earlier ask pin stays intact), while the production root
// wires the real notifier over the configured push sender.
export type NotifyApprovalCreatedSeam = (input: {
  readonly userId: string;
  readonly approvalId: string;
  readonly createdAt: Date;
  readonly dek: Uint8Array;
}) => Promise<void>;

// The request-metrics recorder seam (task E17-S03) — an OPTIONAL injected function whose
// shape mirrors E17-S02's RecordMetricInput (a metric name + a finite numeric value + an
// OPTIONAL open map of non-personal dimensions). The production root wires it to the guarded
// recorder (`recordMetric: (input) => recordMetricEvent(db, clock, input)`); a pipeline built
// WITHOUT it records no metrics, so every behaviour that predates this seam is unchanged.
export type RecordMetricSeam = (input: {
  readonly name: string;
  readonly value: number;
  readonly dimensions?: Record<string, unknown>;
}) => Promise<void>;

// The injected seams — no process.env (INV-103).
export interface PipelineDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
  readonly rateLimiter: RateLimiter;
  readonly recorder: ActivityRecorder;
  readonly prepareCall?: (call: AgentCall, connection: AgentConnection) => Promise<AgentCall | null>;
  readonly executeTool: (call: AgentCall, connection: AgentConnection) => Promise<unknown>;
  readonly rate?: ReferenceRate | null;
  readonly notifyApprovalCreated?: NotifyApprovalCreatedSeam;
  readonly recordMetric?: RecordMetricSeam;
}

// A discriminated union on `status` (the repo idiom).
export type AgentCallResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string }
  | { status: "pending_approval"; approval_id: string; expires_at: Date };

// The two request metrics the pipeline records for EVERY handled agent call (task E17-S03):
// one count increment and one latency reading. Request volumes, latencies and error rates
// are core operational numbers, and the pipeline is the one place that sees every call, its
// outcome and its timing (brief "Operations readiness").
const REQUEST_COUNT_METRIC = "agent.request";
const REQUEST_LATENCY_METRIC = "agent.request.latency_ms";

// The outcome label a thrown tool executor records — there is no AgentCallResult to read a
// status from. It is a failure, so it also carries an error category.
const EXECUTOR_FAILURE_OUTCOME = "error";

// Short error-category labels — a safe identifier naming the failure CLASS, so distinct
// classes (a disconnected agent, a rate-limited burst, a policy denial, a thrown tool) are
// told apart in the metrics. Never free text, an identity value or message content.
const CATEGORY_DISCONNECTED = "disconnected";
const CATEGORY_RATE_LIMITED = "rate_limited";
const CATEGORY_DENIED = "denied";
const CATEGORY_TOOL_ERROR = "tool_error";
const CATEGORY_TOOL_REFUSED = "tool_refused";

// The pipeline's internal classification of a handled call: the public result plus — on a
// refusal — the short error-category label the request metrics carry. The outcome dimension
// is the result's own status.
interface DecidedCall {
  readonly result: AgentCallResult;
  readonly errorCategory?: string;
}

// The result of running an approved held call: the held tool ran exactly once and
// returned its result, or the call was refused (not approved / expired / a release /
// its agent disconnected — the tool left un-run — or the tool body itself refused).
// Once a hold has run, its stored outcome is handed back however often it is asked
// for. `in_progress` means another caller has claimed the hold and is running it
// right now (ask again shortly).
export type ApprovedHoldResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string }
  | { status: "in_progress" };

// The plain reasons executeApprovedHold refuses with.
const HOLD_NOT_CONNECTED = "This agent is no longer connected, so its request was not carried out.";
const HOLD_IS_RELEASE =
  "This request is a one-time release: the agent collects it with collect_release once you hand it over.";
const HOLD_FAILED = "The approved request could not be completed.";

// Whether a tool body's result is its own plain refusal (`{status:"refused", reason}`
// — e.g. "This agent does not have permission to use memories."). Such a call did not
// do anything, so it is recorded and returned as refused, never as executed.
function asToolRefusal(result: unknown): { status: "refused"; reason: string } | null {
  if (typeof result !== "object" || result === null) return null;
  const { status, reason } = result as { status?: unknown; reason?: unknown };
  return status === "refused" && typeof reason === "string" ? { status: "refused", reason } : null;
}

export interface AgentCallPipeline {
  handleAgentCall(connection: AgentConnection, call: AgentCall): Promise<AgentCallResult>;
  executeApprovedHold(userId: string, approvalId: string): Promise<ApprovedHoldResult>;
}

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
    readsAllowed: (call.connector ? permissions.connectorPolicies?.[call.connector]?.readTools : undefined) ?? permissions.readTools,
    changes: (call.connector ? permissions.connectorPolicies?.[call.connector]?.changeTools : undefined) ?? permissions.changeTools,
    highTierAllowed: permissions.highTierAccess,
  };
}

// Assemble the pure engine's context from the resolved connection and the loaded
// member-scoped context. The rule scope is matched on the connection id (the same
// id space the loader filters applicable rules by). For a card request the card
// policy carries the household limits and the rate is the loader's per-call daily
// reference rate (design §8 step 4); the injected static `rate` is only a fallback.
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
    // Unknown provider semantics cannot bypass a never-send or conditional
    // prohibition by omitting trustworthy channel/recipient/amount metadata.
    rules: context.rules.map(rule => call.requiresApproval && rule.kind === "never_allow"
      ? {...rule, condition:undefined, ...(rule.action.type === "send_message" ? {action:{type:"any_change" as const}} : {})}
      : rule) as readonly IdentifiedRule[],
    accountCurrency: context.accountCurrency,
    ruleCurrency: context.cardChecks?.ruleCurrency,
    ruleRate: context.cardChecks?.ruleRate,
    card: cardPolicyFor(context, now),
    rate: effectiveRate(context, rate),
    now,
  };
}

// The loader's per-call daily rate when it found one, else the injected static fallback.
function effectiveRate(context: AgentContext, rate: ReferenceRate | null): ReferenceRate | null {
  return context.cardChecks?.rate ?? rate;
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

// A foreign-currency card amount converted into the account currency with the SAME
// reference rate the policy engine used (to the cent), with the rate's date — the
// approval shows both amounts and the date (brief "Currency"), and the release counts
// the converted amount against the budget. Null when no conversion applies.
function convertedAmount(
  call: AgentCall,
  accountCurrency: string,
  rate: ReferenceRate | null,
): { amount: number; currency: string; rate: number; rateDate: string } | null {
  if (call.request !== "card" || call.amount === undefined || call.currency === undefined) return null;
  if (call.currency === accountCurrency) return null;
  const converted = convert(call.amount, rate);
  if (!converted.ok) return null;
  return {
    amount: Math.round(converted.converted.amount * 100) / 100,
    currency: converted.converted.currency,
    rate: converted.rate,
    rateDate: converted.rateDate,
  };
}

// The sentence of the rule that triggered the ask, or the engine's own plain reason
// when no rule fired (e.g. "A card request needs your approval.").
function triggeringRule(decision: { reason: string; ruleId?: string }, context: AgentContext): string {
  const rule = decision.ruleId === undefined ? undefined : context.rules.find((r) => r.id === decision.ruleId);
  return rule ? ruleSentence(rule) : decision.reason;
}

// The approval `detail` the person reviews in their inbox, display-ready: WHAT the
// held call will do in plain words, the exact details (recipients / amount + currency
// + any converted amount / merchant / field / purpose), the agent's reason and the
// rule that triggered it — stored DEK-encrypted by the approvals store. The raw tool
// arguments live on the linked held request; the raw numeric amount stays here too for
// the release and budget paths.
function toApprovalDetail(
  call: AgentCall,
  decision: { reason: string; ruleId?: string },
  context: AgentContext,
  rate: ReferenceRate | null,
): Record<string, unknown> {
  const converted = convertedAmount(call, context.accountCurrency, rate);
  return {
    tool: call.tool,
    connector: call.connector,
    account: call.connectorAccountLabel,
    request: call.request,
    amount: call.amount,
    currency: call.currency,
    merchant: call.merchant,
    recipients: call.recipients,
    field: call.field,
    purpose: call.purpose,
    reason: call.reason,
    sentence: requestSentence(call),
    rule: triggeringRule(decision, context),
    ...(converted ? { converted } : {}),
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
      payload: { params: call.params, reason: call.reason, connectorAccountId: call.connectorAccountId },
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

  // Record the two request metrics for one handled call (task E17-S03): a count increment
  // (value 1) and a latency reading (elapsed ms, finite and ≥ 0), BOTH tagged with the
  // outcome and, on a failure, the short error-category label. A pipeline built without the
  // seam records nothing. The dimensions are the allowlisted, non-personal set only
  // ({outcome, errorCategory}) — NEVER tool params, identity values, merchant, recipients,
  // reason or message content.
  async function emitRequestMetrics(
    startedAt: number,
    outcome: string,
    errorCategory: string | undefined,
  ): Promise<void> {
    if (!deps.recordMetric) return;
    // Elapsed wall-clock milliseconds read through the clock seam (never Date.now()). A
    // frozen clock yields 0; the guard keeps it non-negative against a clock that steps back.
    const elapsed = clock.now().getTime() - startedAt;
    const latency = elapsed >= 0 ? elapsed : 0;
    const dimensions: Record<string, unknown> = { outcome };
    if (errorCategory !== undefined) dimensions.errorCategory = errorCategory;
    await deps.recordMetric({ name: REQUEST_COUNT_METRIC, value: 1, dimensions });
    await deps.recordMetric({ name: REQUEST_LATENCY_METRIC, value: latency, dimensions });
  }

  // The gatekeeping decision for one agent call (design §6.1), returning the public result
  // plus — on a refusal — the short error-category label the request metrics carry. Every
  // side effect (activity entries, held request, approval, the notifier) is exactly as
  // before; only the return shape is enriched so the caller can tag the metrics.
  async function decide(connection: AgentConnection, call: AgentCall): Promise<DecidedCall> {
    // Every call that reaches the pipeline counts on the agent card: one more request
    // and a fresh last-active time, in one atomic update (member-scoped by the
    // connection's own user id; nothing to count for an id that names no agent).
    await countAgentRequest(db, { userId: connection.userId, id: connection.agentId }, clock);

    // Gate 1 — a disconnected or revoked connection: refuse and record, never
    // execute. (The connection's identity is the session's; no body value.)
    if (!connection.active) {
      const reason = "This agent is not connected.";
      await record(connection, call, "refused");
      return { result: { status: "refused", reason }, errorCategory: CATEGORY_DISCONNECTED };
    }

    // The member-scoped policy context (binds the ids as parameters). Carries the
    // person's configured per-connection rate limit, used next.
    // A card request also loads its household + currency context (design §8 step 4).
    const context = await loadAgentContext(connection, { db, keyWrapper, clock }, cardRequestOf(call));
    if(call.request === "high_tier" && !(await highTierRequestAllowed(db,connection.userId,context.permissions,call.field))) {
      await record(connection,call,"denied");
      return {result:{status:"refused",reason:"This agent cannot request that vault field."},errorCategory:CATEGORY_DENIED};
    }

    // Gate 2 — the per-connection rate limit. A burst over the limit is refused
    // and recorded as ONE summarising entry for the streak, not one per call.
    if (!rateLimiter.allow(connection.connectionId, context.permissions.rateLimit)) {
      const reason = "This agent is going too fast — its request rate limit was reached.";
      if (!burstSummarised.get(connection.connectionId)) {
        await record(connection, call, "rate_limited");
        burstSummarised.set(connection.connectionId, true);
      }
      return { result: { status: "refused", reason }, errorCategory: CATEGORY_RATE_LIMITED };
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
      return { result: { status: "refused", reason: decision.reason }, errorCategory: CATEGORY_DENIED };
    }

    if (deps.prepareCall) {
      const prepared = await deps.prepareCall(call, connection);
      if (!prepared) {
        await record(connection, call, "refused");
        return { result: { status: "refused", reason: "The service account is unavailable or changed. Select an account in this agent’s Connectors settings and submit a new request." }, errorCategory: CATEGORY_DENIED };
      }
      call = prepared;
    }

    // ASK — the person is needed. Warthog HOLDS the call: it parks the exact
    // agent call (its args DEK-encrypted) behind a fresh PENDING approval, records
    // one activity entry for the held call, and tells the agent `pending_approval`
    // WITHOUT executing the tool. The person decides it from their inbox; on
    // approval Warthog runs the held call exactly once.
    if (decision.decision === "ask" || call.requiresApproval) {
      const dek = await dataKeyFor(connection.userId);
      // The pending approval and the held call it guards are written together: a
      // failure part-way never leaves an approval in the inbox with nothing behind it.
      const approval = await withTransaction(db, async (tx) => {
        const created = await createApproval(
          tx,
          {
            userId: connection.userId,
            agentId: connection.agentId,
            // The same rate the engine checked, so the approval's converted amount and
            // the release's ledger amount match it.
            detail: toApprovalDetail(call, call.requiresApproval && decision.decision === "allow" ? {reason:"Provider-hosted tools require approval because their effects are not verified by Warthog."} : decision, context, effectiveRate(context, rate)),
          },
          dek,
          clock,
        );
        await createHeldRequest(
          tx,
          {
            userId: connection.userId,
            agentId: connection.agentId,
            approvalId: created.id,
            args: { ...call },
          },
          dek,
          clock,
        );
        return created;
      });
      await record(connection, call, "pending_approval");
      // Trigger the approval notifier on creation (E12-S07): a push to every
      // registered device within seconds, plus a scheduled fallback anchored to the
      // approval's own createdAt. A push failure does not derail this — the notifier
      // itself schedules the fallback and resolves — so creation still succeeds.
      if (deps.notifyApprovalCreated) {
        await deps.notifyApprovalCreated({
          userId: connection.userId,
          approvalId: approval.id,
          createdAt: approval.createdAt,
          dek,
        });
      }
      return { result: { status: "pending_approval", approval_id: approval.id, expires_at: approval.expiresAt } };
    }

    // ALLOW — execute the tool, then record the activity entry BEFORE the result
    // is returned to the agent. A tool body that refuses (e.g. the connection lacks
    // the permission it checks) did nothing: it is recorded and returned as refused,
    // with the body's own plain reason — never as executed.
    const result = await executeTool(call, connection);
    const refusal = asToolRefusal(result);
    if (refusal) {
      await record(connection, call, "refused");
      return { result: refusal, errorCategory: CATEGORY_TOOL_REFUSED };
    }
    await record(connection, call, "executed");
    return { result: { status: "executed", result } };
  }

  return {
    async handleAgentCall(connection: AgentConnection, call: AgentCall): Promise<AgentCallResult> {
      // The pipeline is the one place that sees every agent call, its outcome and its
      // timing, so it measures the request-count and request-latency metrics here (task
      // E17-S03). Start the timer before the gates run.
      const startedAt = clock.now().getTime();
      let decided: DecidedCall;
      try {
        decided = await decide(connection, call);
      } catch (err) {
        // The tool executor (or a downstream step) threw: measure the operational failure
        // first so error rates capture it, then let the error propagate — the pipeline
        // never swallows a tool failure.
        await emitRequestMetrics(startedAt, EXECUTOR_FAILURE_OUTCOME, CATEGORY_TOOL_ERROR);
        throw err;
      }
      await emitRequestMetrics(startedAt, decided.result.status, decided.errorCategory);
      return decided.result;
    },

    // Run the held call behind an APPROVED approval exactly once (design §6.2;
    // reached by the inbox approve action or `check_approval`). `userId` is the
    // OWNING person — taken by the trusted caller from its session / the resolved
    // agent connection, NEVER a client value — and every read/write below is
    // member-scoped by it. A hold that is still pending, denied or expired, a RELEASE
    // (collected with collect_release, never run), or one whose agent has been
    // disconnected is REFUSED and the held tool is not run (never a silent failure).
    // The call runs under its agent's REAL connection (re-resolved from the agents
    // row: its connection id is what tool permissions are keyed by), and its outcome
    // is stored so a later ask — the agent's check_approval after an inbox approval —
    // gets the result back, not "already run".
    async executeApprovedHold(userId: string, approvalId: string): Promise<ApprovedHoldResult> {
      const dek = await dataKeyFor(userId);

      // The approval must exist FOR THIS PERSON (member-scoped: another person's id
      // finds no approval). Only an `approved` one proceeds; pending / denied /
      // expired is refused with the tool left un-run.
      const approval = await getApproval(db, userId, approvalId, dek);
      if (!approval) {
        return { status: "refused", reason: "There's no approval to run for you." };
      }
      if (approval.status !== "approved") {
        return { status: "refused", reason: "This request hasn't been approved." };
      }

      // The exact agent call Warthog parked behind the approval (member-scoped).
      const held = await getByApproval(db, userId, approvalId, dek);
      if (!held) {
        return { status: "refused", reason: "This approval has no held request to run." };
      }

      // Already run: hand back what it came to (or "still running" mid-run).
      if (held.status === "executed") {
        return held.outcome ?? { status: "in_progress" };
      }

      // A release is handed over by the person's device and collected by the agent;
      // it is never run as a tool, and its hold is never burned.
      const call = held.args as unknown as AgentCall;
      if (isReleaseRequest(call.request)) {
        return { status: "refused", reason: HOLD_IS_RELEASE };
      }

      // Re-resolve the requesting agent (member-scoped): a disconnected or missing
      // agent's approved hold is refused and left unclaimed — never run on a made-up
      // connection.
      const agent = await getAgentById(db, userId, held.agentId);
      if (!agent || agent.status !== "connected") {
        return { status: "refused", reason: HOLD_NOT_CONNECTED };
      }

      // Claim the hold EXACTLY ONCE before running it: markExecuted is a single-shot
      // compare-and-swap, so of two concurrent runs only one claims it; the other
      // hands back the stored outcome (or "still running"). Any other failure
      // propagates — it is never mistaken for "already run".
      let ran: StoredHeldRequest;
      try {
        ran = await markExecuted(db, { userId, id: held.id }, dek, clock);
      } catch (error) {
        if (!(error instanceof HeldRequestAlreadyExecutedError)) throw error;
        const current = await getByApproval(db, userId, approvalId, dek);
        return current?.outcome ?? { status: "in_progress" };
      }

      // Run the held tool under the agent's REAL connection, then record ONE Warthog
      // outcome entry (execute BEFORE record — Warthog writes the record itself,
      // redacted) and keep the outcome for later asks. A tool body's own refusal is
      // recorded and returned as refused, never as executed.
      const connection: AgentConnection = {
        userId: agent.userId,
        connectionId: agent.connectionId,
        agentId: agent.id,
        active: true,
      };
      let outcome: HeldOutcome;
      try {
        const current = await loadAgentContext(connection, { db, keyWrapper, clock }, cardRequestOf(call));
        const policy = evaluate(toPolicyCall(call), toPolicyContext(connection, current, call, clock.now(), rate));
        if (policy.decision === "deny") {
          outcome = { status: "refused", reason: policy.reason };
        } else {
          // Approval satisfies an ask, never a current denial. The tool also checks
          // its current resource grant and the originally approved service account.
          const result = await executeTool(call, connection);
          const refusal = asToolRefusal(result);
          outcome = refusal ?? { status: "executed", result };
        }
      } catch (error) {
        // Keep the failure so a later ask is told the request could not be completed
        // (never "already run"), then let the error propagate — never swallowed.
        await recordOutcome(db, { userId, id: ran.id, outcome: { status: "refused", reason: HOLD_FAILED } }, dek);
        throw error;
      }
      await record(connection, call, outcome.status);
      await recordOutcome(db, { userId, id: ran.id, outcome }, dek);
      return outcome;
    },
  };
}
