// E07-S14 — the `check_approval` core tool (design §6.2 MCP server
// "check_approval (wait_seconds ≤ 50, long-poll)"; brief "Agents wait safely";
// docs/adr/approval-continuation.md).
//
// An agent that got `{status:"pending_approval", approval_id, …}` back from a held
// call long-polls this tool to learn the outcome, calling it again while it says
// pending, so it can carry on in the same reply once the person decides. It reads the
// approval MEMBER-SCOPED by the session connection's owning person AND owned by that
// connection's agent (another connection's id finds nothing → refused), and then:
//   pending      → waits up to min(wait_seconds, 50) seconds, re-reading the
//                  approval between sleeps, and returns the first non-pending
//                  outcome, else `pending` with its expiry and what to do next
//                  (stopping early, still `pending`, when the agent's request is
//                  cancelled); a pending approval already past its window is
//                  expired on the spot (stored) and refused at once;
//   approved     → a RELEASE (card / high-tier) is collected, never run: the agent
//                  is told `released` (once the person's device has handed it over;
//                  else `approved`) with `next: "collect_release"`. Any other
//                  held call runs via `executeApprovedHold` EXACTLY ONCE (the
//                  single-shot claim lives in the pipeline) and its stored outcome
//                  is returned — the same outcome however often the agent asks,
//                  even when the inbox ran it on approval; while another caller is
//                  still running it, the agent keeps waiting;
//   denied/expired → a refusal;
//   more_detail  → the person's question.
//
// A SERVER module built purely from its INJECTED seams (db, keyWrapper, clock,
// sleep, executeApprovedHold): it reads no `process.env` and holds no secret
// (INV-103) — the data key is resolved through the KeyWrapper seam, time through
// the Clock seam, and the wait through the injected `sleep`. The handler VALIDATES
// its input at the boundary (zod → a 4xx `HttpError` BEFORE anything is read or
// run, INV-102); every read is member-scoped by the connection's owning user id —
// never a value in the input — and the approvals store binds its ids as
// parameters, so a SQL-shaped `approval_id` travels as data and cannot alter a
// query.

import { z } from "zod";

import { parseParams } from "../../http/validate";
import { decide, getApproval } from "../../db/approvals";
import { getUserById } from "../../db/users";
import { isDue } from "../../../domain/approvals/state-machine";
import { isReleaseRequest } from "../../../domain/approvals/release-kind";
import type { Db } from "../../db/index";
import type { KeyWrapper } from "../../crypto/key-wrapper";
import type { Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";

// The long-poll ceiling (design §6.2 "wait_seconds ≤ 50"): a larger request is
// clamped down to this many seconds. It stays under the shortest tool-call limit an
// agent's app is known to set (ChatGPT stops any tool call at 60 s), so a wait always
// comes back as `pending` rather than being cut off (docs/adr/approval-continuation.md).
const MAX_WAIT_SECONDS = 50;

// What a still-pending result tells the agent to do next.
const STILL_PENDING_NEXT =
  "The person hasn't decided yet. Call check_approval again with this approval_id to keep waiting, until expires_at. Don't send the request again.";

// How long to wait between re-reads of a still-pending approval. Kept well below
// the ceiling so a decision that arrives mid-wait is picked up promptly.
const POLL_INTERVAL_MS = 1000;

// Field caps, so a grossly oversized value is refused at the boundary before any
// read (INV-102). `reason` matches the registry's envelope cap (design §6.2 "every
// tool takes an optional reason").
const MAX_APPROVAL_ID = 200;
const MAX_REASON = 2000;

// The validated input: the REQUIRED approval id, the OPTIONAL wait, and the
// universal OPTIONAL `reason`. A z.object, so its `.shape` exposes each field
// (the registry and tests read `.shape.approval_id`). `approval_id` is any capped
// string at the schema boundary — its UUID shape is checked separately below.
export const inputSchema = z.object({
  approval_id: z.string().min(1).max(MAX_APPROVAL_ID),
  wait_seconds: z.number().optional(),
  reason: z.string().max(MAX_REASON).optional(),
});

// Every approval id is a UUID (created with `randomUUID` / `gen_random_uuid`), and
// the `approvals.id` column is uuid-typed. A well-formed-but-non-UUID `approval_id`
// — e.g. a SQL-injection probe — can therefore match no approval; we shape-guard it
// at the boundary and refuse it rather than feed it to `WHERE id = $1`, where the
// uuid cast would fail (OBS-049: resolve an id-typed selector's shape deliberately).
const approvalIdShape = z.uuid();

// What an approved held call hands back (the pipeline's ApprovedHoldResult shape):
// its outcome, or `in_progress` while another caller is still running it.
export type ApprovedHoldResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string }
  | { status: "failed" | "unknown"; reason: string }
  | { status: "in_progress" };

// What check_approval returns to the waiting agent. `released` / `approved` + `next`
// is an approved RELEASE: the agent collects the value with collect_release (`released`
// once the person's device has handed it over).
export type CheckApprovalResult =
  | { status: "pending"; approval_id: string; expires_at: string; next: string }
  | { status: "executed"; result: unknown }
  | { status: "approved" | "released"; approval_id: string; next: "collect_release" }
  | { status: "refused"; reason: string }
  | { status: "failed" | "unknown"; reason: string }
  | { status: "more_detail"; approval_id: string; question: string };

export interface CheckApprovalTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<CheckApprovalResult>;
}

// The injected seams — no process.env (INV-103).
export interface CheckApprovalDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly executeApprovedHold: (userId: string, approvalId: string) => Promise<ApprovedHoldResult>;
  // True once the agent's request has been cancelled (its stream closed): the wait stops
  // there, as the transport treats a closed stream as cancellation. Absent, never.
  readonly cancelled?: () => boolean;
}

// A plain-English refusal when the approval cannot be read for this connection
// (not found for this person, or owned by another of their connections). The same
// message either way, so an id probe cannot distinguish "not mine" from "not here".
const NOT_FOUND = "There's no approval to check for you.";
const EXPIRED = "This request expired before it was approved.";

// The pure machine's view of a stored approval — just what `isDue` reads.
function approvalWindow(approval: NonNullable<Awaited<ReturnType<typeof getApproval>>>) {
  return {
    id: approval.id,
    agentId: approval.agentId,
    status: approval.status,
    request: approval.detail,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };
}

export function createCheckApprovalTool(deps: CheckApprovalDeps): CheckApprovalTool {
  const { db, keyWrapper, clock, sleep, executeApprovedHold } = deps;
  const cancelled = deps.cancelled ?? (() => false);

  // Resolve the person's unwrapped DEK: read their wrapped DEK (bound by userId
  // through the users store) and unwrap it through the KeyWrapper seam. Throws when
  // the person has no row (never fails silently).
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("check_approval: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Map one reading of the approval to an outcome, or `null` when it is still
  // pending (keep long-polling). The read is already member-scoped by the owning
  // user id; here we also require the approval to belong to THIS connection's agent.
  async function resolve(
    approval: Awaited<ReturnType<typeof getApproval>>,
    connection: AgentConnection,
    dek: Uint8Array,
  ): Promise<CheckApprovalResult | null> {
    if (!approval || approval.agentId !== connection.agentId) {
      return { status: "refused", reason: NOT_FOUND };
    }
    switch (approval.status) {
      case "pending": {
        // An approval already past its window "is denied" now, not when the minute
        // sweep next runs: store the expiry (a decision that landed first stands) and
        // answer with whatever the approval actually came to.
        if (!isDue(approvalWindow(approval), clock.now())) return null;
        const settled = await decide(
          db,
          { userId: connection.userId, id: approval.id, decision: { status: "expired" } },
          dek,
          clock,
        );
        return settled.status === "pending" ? null : resolve(settled, connection, dek);
      }
      case "approved": {
        // A release is collected, never run: tell the agent where to get it.
        if (isReleaseRequest(approval.detail.request)) {
          const status = approval.releasedAt !== undefined ? "released" : "approved";
          return { status, approval_id: approval.id, next: "collect_release" };
        }
        // Run the held call exactly once (the pipeline's single-shot claim) and hand
        // back its stored outcome; keep waiting while another caller is running it.
        const outcome = await executeApprovedHold(connection.userId, approval.id);
        return outcome.status === "in_progress" ? null : outcome;
      }
      case "denied":
        return { status: "refused", reason: "The person denied this request." };
      case "expired":
        return { status: "refused", reason: EXPIRED };
      case "more_detail":
        return { status: "more_detail", approval_id: approval.id, question: approval.question ?? "" };
    }
  }

  return {
    name: "check_approval",
    inputSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<CheckApprovalResult> {
      // VALIDATE at the boundary: a bad / oversized / mis-shaped input throws a 4xx
      // `HttpError` BEFORE anything is read or run.
      const parsed = parseParams(inputSchema, input);

      // Shape-guard the id: a well-formed string that is not a UUID matches no
      // approval (never cast against the uuid column) and is refused.
      if (!approvalIdShape.safeParse(parsed.approval_id).success) {
        return { status: "refused", reason: NOT_FOUND };
      }

      const dek = await dataKeyFor(connection.userId);

      // The long-poll deadline: min(wait_seconds, 50) seconds from now (a missing
      // wait waits the full ceiling; a negative one waits not at all).
      const waitSeconds = Math.max(0, Math.min(parsed.wait_seconds ?? MAX_WAIT_SECONDS, MAX_WAIT_SECONDS));
      const deadline = clock.now().getTime() + waitSeconds * 1000;

      // Read the approval; if it is already decided, return its outcome at once
      // (no wait). While it is pending, sleep and re-read until the deadline passes
      // or the request is cancelled.
      while (true) {
        const approval = await getApproval(db, connection.userId, parsed.approval_id, dek);
        const outcome = await resolve(approval, connection, dek);
        if (outcome) return outcome;

        const now = clock.now().getTime();
        if (now >= deadline || cancelled()) {
          // Only a pending approval of this connection's agent reaches here (resolve
          // refuses any other), so its expiry is the agent's own to see.
          return { status: "pending", approval_id: parsed.approval_id, expires_at: approval!.expiresAt.toISOString(), next: STILL_PENDING_NEXT };
        }
        await sleep(Math.min(POLL_INTERVAL_MS, deadline - now));
      }
    },
  };
}
