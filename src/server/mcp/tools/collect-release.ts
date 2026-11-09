// E07-S15 — the `collect_release` core tool (design §4.2 "the in-memory release
// store (Map, TTL 5 minutes, single collection)" + §6.2 MCP core tools; brief
// "the agent collects it once within 5 minutes, after which it is gone from
// Warthog's working memory").
//
// On approval + step-up the browser decrypts a high-tier identity value or a card
// and posts the PLAINTEXT over TLS to the release endpoint; the server holds it
// ONLY in the process-memory release store (never the database, logs or metrics).
// `collect_release` is the agent's single collection: it hands that value back
// EXACTLY ONCE within the 5-minute window, scoped to the calling connection, then
// the store discards it.
//
// The approval ID selects a pending release within the authenticated connection's
// scope. An unknown ID never consumes another approval. Input validation happens
// before the store is touched; no database, secrets or plaintext logging are used.

import { z } from "zod";

import { parseParams } from "../../http/validate";
import type { ReleaseStore } from "../../crypto/release-store";
import type { AgentConnection } from "../context";

// Field cap, so a grossly oversized value is refused at the boundary before the
// store is touched (INV-102). `reason` matches the registry's envelope cap (design
// §6.2 "every tool takes an optional reason").
const MAX_REASON = 2000;

// An explicit approval ID prevents ambiguous collection when several approvals
// are pending for the same agent. The universal reason remains optional.
export const inputSchema = z.object({
  approval_id: z.string().uuid(),
  reason: z.string().max(MAX_REASON).optional(),
});

// What collect_release returns to the agent: the released value handed over once,
// or `gone` for no release / already collected / expired.
export type CollectReleaseResult =
  | { status: "collected"; value: string }
  | { status: "gone" };

export interface CollectReleaseTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<CollectReleaseResult>;
}

// The injected seams — no process.env (INV-103). The release store is the process-
// wide singleton the release endpoint puts into; no db (collect_release needs none).
export interface CollectReleaseDeps {
  readonly releaseStore: ReleaseStore;
}

// The single key scheme shared by the releaser (the release endpoint) and the
// collector (this tool), so both agree on where an approval's release lives — one
// source of truth. Deterministic per connection and DISTINCT for distinct
// connections (so a release is scoped to the connection it belongs to, never merely
// to the person): keyed by the connection id under its owning person.
export function releaseScopeFor(connection: AgentConnection): string {
  return `${connection.userId}:${connection.connectionId}:`;
}

export function releaseKeyFor(connection: AgentConnection, approvalId: string): string {
  return `${releaseScopeFor(connection)}${approvalId}`;
}

export function createCollectReleaseTool(deps: CollectReleaseDeps): CollectReleaseTool {
  const { releaseStore } = deps;

  return {
    name: "collect_release",
    inputSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<CollectReleaseResult> {
      // VALIDATE at the boundary: a bad / oversized / mis-shaped input throws a 4xx
      // `HttpError` BEFORE the store is ever touched. The parsed `reason` is inert
      // data — the collection is scoped by the session connection plus approval ID.
      const { approval_id: approvalId } = parseParams(inputSchema, input);

      // Collect THIS connection's release from the in-memory store exactly once: the
      // store drops the entry on read and hands back the value only while it is
      // fresh (< 5 min), so a second call, an expired value or no release all collect
      // as `gone`.
      const value = releaseStore.collect(releaseKeyFor(connection, approvalId));
      if (value === undefined) {
        return { status: "gone" };
      }
      return { status: "collected", value };
    },
  };
}
