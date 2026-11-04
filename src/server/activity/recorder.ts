// E07-S02 — Activity recorder interface and in-memory chained recorder
// (design §9, constitution principle 14 "Warthog writes the record").
//
// The agent pipeline and every write-through record through ONE contract — the
// `ActivityRecorder` — so Warthog itself writes every entry at the moment it
// handles it. Before the Postgres writer exists, this in-memory recorder serves
// tests and local dev. It:
//   (a) assigns a contiguous per-user `seq` and chains each entry to the previous
//       one of the SAME user by hash, starting a fresh chain per user;
//   (b) runs the payload through redaction (`src/domain/redaction`), including the
//       per-user released-value matcher, BEFORE the entry is stored; and
//   (c) computes `entry_hash` over `prev_hash` plus the canonical other fields, so
//       that altering a stored entry is caught by recomputation (the daily
//       integrity check, a later task, recomputes exactly this).
//
// This module reads no `process.env` and holds no secret: the clock and the
// released-value matcher are INJECTED (INV-103), so it stays a pure function of its
// seams and inputs.

import { createHash } from "node:crypto";

import type { Clock } from "../seams/clock";
import { redact } from "../../domain/redaction/redact";

// The input handed to `record()`: the required core plus optional metadata and the
// (yet-to-be-redacted) payload.
export interface ActivityEntryInput {
  userId: string;
  kind: string;
  source: "warthog" | "agent_reported";
  agentId?: string;
  connectorId?: string;
  tool?: string;
  outcome?: string;
  merchant?: string;
  payload?: unknown;
}

// The stored, chained entry `record()` returns. `payload` is the REDACTED payload;
// `prevHash` and `entryHash` carry the per-user hash chain.
export interface ActivityEntry {
  userId: string;
  seq: number;
  occurredAt: string;
  kind: string;
  source: "warthog" | "agent_reported";
  agentId?: string;
  connectorId?: string;
  tool?: string;
  outcome?: string;
  merchant?: string;
  payload: unknown;
  prevHash: string;
  entryHash: string;
}

// The one contract the pipeline and every write-through depend on.
export interface ActivityRecorder {
  record(input: ActivityEntryInput): Promise<ActivityEntry>;
}

export interface InMemoryRecorderOptions {
  // Supplies occurred_at (constitution: take a clock, never Date.now()).
  clock: Clock;
  // The per-user released-value fingerprint lookup the real DB writer will back
  // with the release-fingerprint store; injected here so the recorder stays
  // testable without a DB. Omitted ⇒ only the released-value rule is inactive;
  // cards and secret field names are still redacted.
  matchesReleased?: (userId: string, normalisedToken: string) => boolean;
}

// The genesis sentinel a fresh per-user chain's first entry links back to. It is
// deliberately NOT a 64-hex string, so it can never collide with a real entry hash.
const GENESIS_PREV_HASH = "GENESIS";

// Recompute the entry hash over `prev_hash` plus every OTHER canonical field (i.e.
// everything except `entry_hash` itself). `record()` sets `entryHash` to this
// value, so a genuine entry verifies and any mutation to a stored field is caught.
export function computeEntryHash(entry: ActivityEntry): string {
  const hashed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "entryHash") continue;
    hashed[key] = value;
  }
  return createHash("sha256").update(canonicalJson(hashed), "utf8").digest("hex");
}

// A deterministic serialisation that sorts object keys recursively, so the hash is
// reproducible (the integrity check must recompute it) and independent of the order
// fields happen to be enumerated in.
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function createInMemoryRecorder(options: InMemoryRecorderOptions): ActivityRecorder {
  const { clock, matchesReleased } = options;

  // Per-user chain state: the last seq assigned and the last entry_hash emitted.
  const lastSeq = new Map<string, number>();
  const lastHash = new Map<string, string>();

  return {
    async record(input: ActivityEntryInput): Promise<ActivityEntry> {
      const { userId } = input;

      const seq = (lastSeq.get(userId) ?? 0) + 1;
      const prevHash = lastHash.get(userId) ?? GENESIS_PREV_HASH;

      // Redact the payload with the per-user matcher BEFORE it is stored.
      const perUser = (token: string): boolean =>
        matchesReleased ? matchesReleased(userId, token) : false;
      const payload = redact(input.payload, perUser);

      const entry: ActivityEntry = {
        userId,
        seq,
        occurredAt: clock.now().toISOString(),
        kind: input.kind,
        source: input.source,
        agentId: input.agentId,
        connectorId: input.connectorId,
        tool: input.tool,
        outcome: input.outcome,
        merchant: input.merchant,
        payload,
        prevHash,
        entryHash: "",
      };
      entry.entryHash = computeEntryHash(entry);

      lastSeq.set(userId, seq);
      lastHash.set(userId, entry.entryHash);

      return entry;
    },
  };
}
