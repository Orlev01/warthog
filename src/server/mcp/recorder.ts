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
    async record(input: ActivityEntryInput): Promise<ActivityEntry> {
      const dek = await dekFor(input.userId);
      const matches = releasedValueMatcher(dek, await lookupForUser(db, input.userId, clock));
      const writer = createDbRecorder({
        db,
        clock,
        dekFor: async () => dek,
        matchesReleased: (_userId, normalisedToken) => matches(normalisedToken),
      });
      return writer.record(input);
    },
  };
}
