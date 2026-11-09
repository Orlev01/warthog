// E10-S09 — One-click disconnect (design §6.1, brief "One-click disconnect").
//
// The person owns the agent; one switch kills it dead. `disconnectAgent` resolves
// the agent by (session.userId, agentId) FIRST — so another person's agent id
// matches nothing and the call is refused, with their agent left wholly working —
// then, in ONE transaction and BEFORE it returns, it:
//   (a) deletes the connection's OAuth tokens AND per-agent access keys, so the
//       agent's very next request carrying either credential is refused;
//   (b) denies the agent's PENDING approvals (through the pure state machine's
//       storage skin, `decide`, so only pending ones move and the transition is the
//       one the inbox uses — one source of truth);
//   (c) marks the agent disconnected; and
//   (d) records the disconnection in the activity feed (source "warthog" — Warthog
//       writes the record, constitution principle 14), as the LAST write.
// Every write runs through the SINGLE transaction-scoped handle `withTransaction`
// (`../db`) hands us — one pinned connection on a pooled driver, the one in-process
// connection on PGlite — so the steps commit together or not at all. If any step fails
// the whole transaction rolls back: the agent stays connected, its credential keeps
// verifying and its pending approvals stay pending — never a half-disconnected state,
// and never a success confirmation.
//
// The uncollected release lives in a process-memory store (not the database), so it
// is cancelled AFTER the transaction commits — a rolled-back disconnect must not
// discard a release that the still-connected agent could yet collect.
//
// Validate-and-parameterize (INV-102): a malformed / oversized / SQL-shaped agent id
// is refused at the boundary with a 4xx `HttpError` before any query, so it never
// reaches `WHERE id = $1` as a failing cast (OBS-049) and no query is altered; every
// id, hash and connection id travels as a BOUND value. Every read/write is
// member-scoped by `session.userId` (never a client value). Secrets-from-env
// (INV-103): this module reads no `process.env` and holds no key — the db, clock,
// release store and per-user DEK lookup are all INJECTED — so no ambient value can be
// folded into the confirmation or the recorded disconnection.

import { z } from "zod";

import { parseParams } from "../http/validate";
import { revokeAccessKey } from "../oauth/access-key";
import { lockOAuthConnection } from "../oauth/connection-lock";
import { createRedactingRecorder } from "../mcp/recorder";
import { ApprovalAlreadyDecidedError, decide } from "../db/approvals";
import { getAgentById } from "../db/agents";
import { withTransaction } from "../db/index";
import { releaseScopeFor } from "../mcp/tools/collect-release";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { ReleaseStore } from "../crypto/release-store";
import type { Session } from "../auth/session";

// Every seam injected — no process.env, no secret (INV-103).
export interface DisconnectDeps {
  // The one db handle every write in the transaction runs through.
  readonly db: Db;
  // Supplies the decided-at / occurred-at instants (never SQL now()).
  readonly clock: Clock;
  // The in-memory release store whose uncollected release is cancelled.
  readonly releaseStore: ReleaseStore;
  // The acting person's already-unwrapped DEK (for the approval denial and the
  // activity write); injected, so this module holds no key.
  readonly dekFor: (userId: string) => Promise<Uint8Array>;
}

// The confirmation: the disconnected agent's id on success, or a refusal naming why
// (the agent is not this person's / does not exist). Fields are a pure function of
// the inputs — no ambient value is folded in (INV-103).
export type DisconnectResult =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly reason: "not_found" };

// An agent id is a UUID (created with `randomUUID` / `gen_random_uuid`, and
// `agents.id` is uuid-typed). A well-formed-but-non-UUID id — a SQL-injection probe,
// an oversized blob — can match no agent, so we shape-guard it at the boundary and
// refuse it with a 4xx rather than feed it to `WHERE id = $1`, where the uuid cast
// would fail (OBS-049).
const agentIdSchema = z.uuid();

// Disconnect one of the acting person's own agents. Resolves the agent member-scoped
// by (session.userId, agentId); if it is not theirs, nothing is touched and the call
// is refused. Otherwise, in ONE transaction before it returns, revokes the
// connection's credentials, denies its pending approvals, marks it disconnected and
// records the disconnection; then cancels its uncollected release.
export async function disconnectAgent(
  deps: DisconnectDeps,
  session: Session,
  agentId: string,
): Promise<DisconnectResult> {
  const { db, clock, releaseStore, dekFor } = deps;

  // VALIDATE at the boundary — a malformed / oversized / SQL-shaped id throws a 4xx
  // HttpError here, before any query runs.
  const id = parseParams(agentIdSchema, agentId);
  const userId = session.userId;

  // Resolve the agent member-scoped: another person's id returns null, so they can
  // disconnect nothing. No write has happened yet.
  const agent = await getAgentById(db, userId, id);
  if (agent === null) {
    return { ok: false, reason: "not_found" };
  }
  const connectionId = agent.connectionId;
  const dek = await dekFor(userId);

  // One transaction: every write below runs through `tx` — a single pinned connection —
  // so they all commit together or not at all. The activity write is LAST, so a mid-way
  // failure (a DB error on any step) rolls the earlier writes back rather than leaving a
  // half-disconnected agent; `withTransaction` surfaces that failure (never a silent
  // success).
  await withTransaction(db, async (tx) => {
    await lockOAuthConnection(tx, connectionId);
    await tx.query("DELETE FROM oauth_auth_codes WHERE connection_id = $1::uuid", [connectionId]);
    // (a) Revoke both credential kinds for this connection — the next request
    // carrying either the OAuth token or the access key no longer verifies.
    await tx.query("DELETE FROM oauth_tokens WHERE connection_id = $1::uuid", [connectionId]);
    await revokeAccessKey(tx, { connectionId });

    // (b) Deny the agent's PENDING approvals (only pending ones match), each through
    // the pure state machine's storage skin so the transition and timestamp are the
    // inbox's own — one source of truth. Approvals are keyed by the requesting AGENT's
    // row id (approvals.agent_id = agents.id, as the pipeline writes it), never the
    // connection id — the two are distinct uuids. A decision that lands first (the
    // person approving on another device, or the window passing) stands: the store's
    // compare-and-swap refuses the deny and the disconnect carries on.
    const pending = await tx.query(
      "SELECT id FROM approvals WHERE user_id = $1 AND agent_id = $2::uuid AND status = 'pending'",
      [userId, agent.id],
    );
    for (const row of pending.rows) {
      try {
        await decide(tx, { userId, id: row.id as string, decision: { status: "denied" } }, dek, clock);
      } catch (error) {
        if (!(error instanceof ApprovalAlreadyDecidedError)) throw error;
      }
    }

    // (c) Mark the agent disconnected (the row survives — the policy engine reads its
    // status), member-scoped.
    await tx.query(
      "UPDATE agents SET status = 'disconnected' WHERE id = $1 AND user_id = $2",
      [id, userId],
    );

    // (d) Record the disconnection — Warthog writes the record (principle 14). LAST,
    // so it is the step that fails under a mid-transaction error.
    const recorder = createRedactingRecorder({ db: tx, clock, dekFor: async () => dek });
    await recorder.record({
      userId,
      kind: "connection_change",
      source: "warthog",
      agentId: agent.id,
      outcome: "disconnected",
      payload: { displayName: agent.displayName, platform: agent.platform },
    });
  });

  // Discard every uncollected approval AFTER commit, scoped by the collector's
  // shared person/connection prefix. Other connections keep their own releases.
  releaseStore.discardScope(releaseScopeFor({ userId, connectionId, agentId: agent.id, active: false }));

  return { ok: true, agentId: agent.id };
}
