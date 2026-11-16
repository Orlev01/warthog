// Review fix D4 — the production activity recorder with released-value redaction active
// (design §4.3 rule 3; brief: "never write a high-tier identity value to any activity
// entry"; constitution principle 14 "Warthog writes the record").
//
// The DB-backed writer (`../activity/writer`) redacts every payload before it is
// encrypted, but its released-value rule only fires when it is handed a matcher, and that
// matcher is synchronous while a person's release fingerprints live in the database. This
// recorder closes the gap for every record: it resolves the person's DEK once, loads their
// LIVE (unexpired) release fingerprints, builds the keyed matcher over them, and only then
// hands the entry to the writer — so a value released to an agent and echoed back in a
// later tool call is stored as `[released value]`, never the value.
//
// Inside an MCP request it also links each entry for the calling agent to the request's
// run and names the product the request came through (docs/adr/agent-runs.md), so a
// tool's own entries (log_activity, a rejected call) are grouped with the pipeline's.
//
// A SERVER module built purely from its INJECTED seams (db, clock, the per-user DEK
// lookup): it reads no `process.env` and holds no key (INV-103). Every read is
// member-scoped by the entry's own `userId` — the session's / the agent connection's,
// never a client value — and parameter-bound by the stores (INV-102).

import { createDbRecorder } from "../activity/writer";
import type { ActivityEntry, ActivityEntryInput, ActivityRecorder } from "../activity/recorder";
import { releasedValueMatcher } from "../crypto/hmac";
import { lookupForUser } from "../db/release-fingerprints";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { requestObservation, type RequestObservation } from "./client-observation";

export interface RedactingRecorderDeps {
  readonly db: Db;
  readonly clock: Clock;
  // The person's already-unwrapped DEK, resolved per user (injected; holds no key here).
  readonly dekFor: (userId: string) => Promise<Uint8Array>;
}

// The production recorder: the DB-backed writer with the person's released-value matcher
// loaded for each entry. One DEK unwrap per entry — the writer reuses the one resolved here.
export function createRedactingRecorder(deps: RedactingRecorderDeps): ActivityRecorder {
  const { db, clock, dekFor } = deps;

  return {
    forTransaction: (tx, transactionKey) => createRedactingRecorder({ ...deps, db: tx, dekFor: transactionKey }),
    async record(input: ActivityEntryInput): Promise<ActivityEntry> {
      const dek = await dekFor(input.userId);
      const matches = releasedValueMatcher(dek, await lookupForUser(db, input.userId, clock));
      const writer = createDbRecorder({
        db,
        clock,
        dekFor: async () => dek,
        matchesReleased: (_userId, normalisedToken) => matches(normalisedToken),
      });
      return writer.record(withRequestContext(input, requestObservation.getStore()));
    },
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// The entry as recorded inside `observed`'s request: when it is for the request's own agent,
// it is linked to the request's run (unless the caller named one: an approved hold carries
// the run it was asked under) and its payload names the run and the product, without
// overwriting anything the caller set. Outside a request, or for another agent, unchanged.
export function withRequestContext(input: ActivityEntryInput, observed: RequestObservation | undefined): ActivityEntryInput {
  if (!observed || input.agentId === undefined || input.agentId !== observed.agentId) return input;
  const run = input.runId === undefined ? observed.run : undefined;
  if (!run && observed.via === undefined) return input;
  const linked: ActivityEntryInput = run ? { ...input, runId: run.id } : input;
  const payload = input.payload ?? {};
  if (!isPlainObject(payload)) return linked;
  return {
    ...linked,
    payload: {
      ...payload,
      ...(run && payload.run === undefined ? { run } : {}),
      ...(observed.via !== undefined && payload.via === undefined ? { via: observed.via } : {}),
    },
  };
}
