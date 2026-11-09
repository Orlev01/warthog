// E07-S15 — the `collect_release` core tool (`src/server/mcp/tools/collect-release.ts`,
// design §4.2 "the in-memory release store (Map, TTL 5 minutes, single collection)" +
// §6.2 MCP core tools; brief "the agent collects it once within 5 minutes, after which
// it is gone from Warthog's working memory").
//
// On approval + step-up the browser decrypts a high-tier identity value or a card and
// posts the PLAINTEXT over TLS to the release endpoint; the server holds it ONLY in the
// process-memory release store (never the database, logs or metrics). `collect_release`
// is the agent's single collection: it hands that value back EXACTLY ONCE within the
// 5-minute window, scoped to the calling connection, then the store discards it.
//
// RED-first: `./collect-release` does not exist yet, so importing
// `createCollectReleaseTool` / `releaseKeyFor` throws and every test here fails until the
// builder writes the minimum code to pass. That absence IS the point of test-first; do
// NOT implement anything to make these pass — the builder writes `collect-release.ts`
// afterwards.
//
// These tests pin BEHAVIOUR (what the tool RETURNS for a release in a given state, that a
// value is handed over at most once, that it is gone after 5 minutes, and that it is
// scoped to the connection it belongs to), never the source text of any module — a later
// rename that preserves behaviour must not redden them.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import { z } from "zod";
//   import type { AgentConnection } from "../context";
//   import type { ReleaseStore } from "../../crypto/release-store";
//
//   // What collect_release returns to the agent.
//   type CollectReleaseResult =
//     | { status: "collected"; value: string }  // the released value, handed over once
//     | { status: "gone" };                      // no release / already collected / expired
//
//   interface CollectReleaseTool {
//     readonly name: string;           // "collect_release"
//     readonly inputSchema: z.ZodType; // a z.object(...) whose .shape carries the universal
//                                       // OPTIONAL string `reason` (design §6.2).
//     // Validate `input` (a bad / oversized / mis-shaped input THROWS HttpError 4xx BEFORE
//     // the store is touched — see the sibling obligations test); then collect THIS
//     // connection's release from the in-memory store EXACTLY ONCE:
//     //   a fresh, unexpired value  → { status: "collected", value }
//     //   none / already collected / expired (>5 min) → { status: "gone" }
//     handle(input: unknown, connection: AgentConnection): Promise<CollectReleaseResult>;
//   }
//
//   interface CollectReleaseDeps {
//     readonly releaseStore: ReleaseStore; // the process-wide in-memory store seam (the SAME
//                                           // singleton the release endpoint puts into). NO db:
//                                           // the value's sole source is this store (AC: the
//                                           // value is never read from the database).
//   }
//
//   function createCollectReleaseTool(deps: CollectReleaseDeps): CollectReleaseTool;
//
//   // The single key scheme shared by the releaser (the release endpoint) and the
//   // collector (this tool), so both agree on where a connection's release lives — one
//   // source of truth. Deterministic per connection, and DISTINCT for distinct
//   // connections (so a release is scoped to the connection it belongs to, never merely
//   // to the person).
//   function releaseKeyFor(connection: AgentConnection, approvalId: string): string;
//
// A release is arranged by PUTTING a value into the real, already-built release-store seam
// (`createReleaseStore(clock)`) under `releaseKeyFor(connection, approvalId)` — the SAME key the tool
// collects with — so no test hard-codes the key format. Time is driven by a controllable
// clock the store reads through, so the 5-minute TTL is crossed deterministically with no
// real delay. No test constructs a database: collect_release needs none. The obligation
// acceptance criteria (4xx validation before the store is touched, input treated purely as
// data, secrets-from-env, no value in logs) live in `collect-release.obligations.test.ts`.
// Tests never touch the network, Azure or a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createCollectReleaseTool, releaseKeyFor } from "./collect-release";
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
import { createReleaseStore } from "../../crypto/release-store";
import type { ReleaseStore } from "../../crypto/release-store";
import type { Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";

const TTL_MS = 5 * 60 * 1000; // the release store's 5-minute TTL (design §4.2)

// Representative released secrets — a high-tier identity value and a card number — handed
// over VERBATIM (collect_release is the one legitimate hand-over of the value; it is not
// redacted on the way to the agent, only kept out of logs/activity).
const HIGH_TIER = "passport-PA1234567";
const CARD = "4111 1111 1111 1111";

// The result shape, kept LOOSE on purpose: the tests assert on `status` + the field that
// status carries, so the builder is free to pick the exact discriminated-union members as
// long as the behaviour holds.
interface CollectResult {
  readonly status: string;
  readonly value?: string;
}

// A clock whose instant the test advances by hand (the release store reads TTL through it),
// so the 5-minute window can be crossed deterministically without real time. Same shape as
// the Clock seam the store is built on.
function controllableClock(start: Date = new Date("2026-11-15T12:00:00.000Z")): {
  clock: Clock;
  advance: (ms: number) => void;
} {
  let current = start.getTime();
  const clock: Clock = { now: () => new Date(current) };
  return {
    clock,
    advance(ms: number): void {
      current += ms;
    },
  };
}

// A resolved agent connection. Built as a variable (not an object literal at the call
// site), so a superset of fields stays assignable and `releaseKeyFor` may read whichever
// id field it keys on. `agentId` defaults to `connectionId` (the E07-S09 shape).
function connectionFor(
  userId: string,
  opts: { connectionId?: string; agentId?: string; active?: boolean } = {},
): AgentConnection {
  const connectionId = opts.connectionId ?? randomUUID();
  return {
    userId,
    connectionId,
    agentId: opts.agentId ?? connectionId,
    active: opts.active ?? true,
  };
}

// ===========================================================================
// AC "collect_release returns the value once for a valid, unexpired release and a second
// call returns gone/empty." The agent's single collection: the first call hands over the
// value verbatim; the store discards it, so a second call finds nothing.
// ===========================================================================

test("collect_release hands over a released value once; a second call returns gone", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);
  const conn = connectionFor("owner-1");

  // Arrange a release for this connection (as the release endpoint would, under the SAME
  // key the tool collects with).
  store.put(releaseKeyFor(conn, APPROVAL_ID), HIGH_TIER);

  const tool = createCollectReleaseTool({ releaseStore: store });

  const first = (await tool.handle({ approval_id: APPROVAL_ID }, conn)) as CollectResult;
  assert.equal(first.status, "collected", "the first collect hands over the released value");
  assert.equal(first.value, HIGH_TIER, "the value is handed back VERBATIM (the one legitimate hand-over)");

  const second = (await tool.handle({ approval_id: APPROVAL_ID }, conn)) as CollectResult;
  assert.equal(second.status, "gone", "a release is collected ONCE — the second call finds it gone");
  assert.equal(second.value, undefined, "a gone result carries no value");
});

// ===========================================================================
// AC (edge of the window): a release is still collectable just inside the 5-minute TTL.
// ===========================================================================

test("a release is still collectable within the 5-minute window", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);
  const conn = connectionFor("in-window");

  store.put(releaseKeyFor(conn, APPROVAL_ID), CARD);
  c.advance(TTL_MS - 1000); // 4m59s — inside the window

  const result = (await tool(store).handle({ approval_id: APPROVAL_ID }, conn)) as CollectResult;
  assert.equal(result.status, "collected", "a release younger than 5 minutes is still collectable");
  assert.equal(result.value, CARD, "the card value is handed back within the window");
});

// ===========================================================================
// AC "After 5 minutes the release is expired and collect_release returns gone; the value
// is never read from the database." The whole feature is exercised with a tool built from
// ONLY the in-memory store — no database is ever constructed — so the value's sole source
// is the store, and expiry is the store's own TTL.
// ===========================================================================

test("after 5 minutes the release has expired and collect_release returns gone (no database involved)", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);
  const conn = connectionFor("expired-release");

  store.put(releaseKeyFor(conn, APPROVAL_ID), HIGH_TIER);
  c.advance(TTL_MS + 1000); // 5m01s — past the window

  // The tool is constructed with ONLY a release store (no db seam). If the value could
  // come from, or expiry could depend on, a database, this db-free setup could not serve
  // the feature at all.
  const result = (await createCollectReleaseTool({ releaseStore: store }).handle({ approval_id: APPROVAL_ID }, conn)) as CollectResult;
  assert.equal(result.status, "gone", "a release older than 5 minutes has expired and collects as gone");
  assert.equal(result.value, undefined, "an expired release hands back no value");
});

// ===========================================================================
// AC: a connection with no release gets gone (not a throw, not a stale value).
// ===========================================================================

test("collect_release returns gone for a connection that has no release", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);
  const conn = connectionFor("no-release");

  const result = (await createCollectReleaseTool({ releaseStore: store }).handle({ approval_id: APPROVAL_ID }, conn)) as CollectResult;
  assert.equal(result.status, "gone", "no release for this connection → gone");
  assert.equal(result.value, undefined, "nothing is handed over");
});

// ===========================================================================
// AC "An agent cannot collect a release that belongs to another connection." The two
// connections belong to the SAME person (so scoping is proven to be by CONNECTION, not by
// person): one connection's release is invisible to the other, and collecting (or failing
// to collect) through one never consumes the other's.
// ===========================================================================

test("another connection of the same person cannot collect this connection's release", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);

  // Same person (userId), two DIFFERENT connections (distinct connectionId AND agentId), so
  // the scoping holds whether the key is derived from the connection id or the agent id — a
  // person-only key would (wrongly) let them cross-collect and fail this test.
  const userId = "shared-person";
  const connA = connectionFor(userId, {
    connectionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    agentId: "agent-A",
  });
  const connB = connectionFor(userId, {
    connectionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    agentId: "agent-B",
  });

  // Distinct connections must key to distinct releases (the scoping property itself).
  assert.notEqual(
    releaseKeyFor(connA, APPROVAL_ID),
    releaseKeyFor(connB, APPROVAL_ID),
    "distinct connections key to distinct releases — a release is scoped to its connection",
  );

  store.put(releaseKeyFor(connA, APPROVAL_ID), HIGH_TIER);
  const t = createCollectReleaseTool({ releaseStore: store });

  // Connection B cannot see A's release.
  const bTries = (await t.handle({ approval_id: APPROVAL_ID }, connB)) as CollectResult;
  assert.equal(bTries.status, "gone", "another connection cannot collect this connection's release");
  assert.equal(bTries.value, undefined, "the released value does not leak to another connection");

  // A's release was untouched by B's attempt and is still collectable by A.
  const aCollects = (await t.handle({ approval_id: APPROVAL_ID }, connA)) as CollectResult;
  assert.equal(aCollects.status, "collected", "the owning connection can still collect its own release");
  assert.equal(aCollects.value, HIGH_TIER, "the value is intact for the connection it belongs to");
});

test("each connection collects only its own release (independent per connection)", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);

  const connA = connectionFor("person-x", { connectionId: "11111111-1111-1111-1111-111111111111" });
  const connB = connectionFor("person-y", { connectionId: "22222222-2222-2222-2222-222222222222" });

  store.put(releaseKeyFor(connA, APPROVAL_ID), "value-for-A");
  store.put(releaseKeyFor(connB, APPROVAL_ID), "value-for-B");

  const t = createCollectReleaseTool({ releaseStore: store });

  // Collecting one connection's release neither returns nor consumes the other's.
  const b = (await t.handle({ approval_id: APPROVAL_ID }, connB)) as CollectResult;
  assert.equal(b.value, "value-for-B", "connection B collects B's release");
  const a = (await t.handle({ approval_id: APPROVAL_ID }, connA)) as CollectResult;
  assert.equal(a.value, "value-for-A", "connection A still collects A's own release");
  assert.equal(((await t.handle({ approval_id: APPROVAL_ID }, connA)) as CollectResult).status, "gone", "and only once each");
});

// ===========================================================================
// AC (envelope): the tool names itself and carries the universal optional `reason`
// (design §6.2 "every tool takes an optional reason"); a reason, when given, does not
// change the collection outcome.
// ===========================================================================

test("the collect_release tool is named and exposes an optional reason in its schema", () => {
  const store = createReleaseStore(controllableClock().clock);
  const built = createCollectReleaseTool({ releaseStore: store });

  assert.equal(built.name, "collect_release", "the tool names itself collect_release");

  const reason = subschema(built.inputSchema, "reason");
  assert.ok(reason, "the input schema exposes a `reason` field");
  assert.equal(reason!.safeParse(undefined).success, true, "`reason` is OPTIONAL");
  assert.equal(reason!.safeParse("for the hotel booking").success, true, "`reason` accepts a string");
  assert.equal(reason!.safeParse(12345).success, false, "`reason` rejects a non-string");
});

test("a reason, when supplied, does not change the collection outcome", async () => {
  const store = createReleaseStore(controllableClock().clock);
  const conn = connectionFor("with-reason");
  store.put(releaseKeyFor(conn, APPROVAL_ID), CARD);

  const result = (await createCollectReleaseTool({ releaseStore: store }).handle(
    { approval_id: APPROVAL_ID, reason: "collecting the card for the booking" },
    conn,
  )) as CollectResult;
  assert.equal(result.status, "collected", "a well-formed reason is accepted and the value still collects");
  assert.equal(result.value, CARD, "the released value is handed over regardless of the reason");
});

// --- small helpers ----------------------------------------------------------------

// Build the tool over a given store (a one-liner used where the store is arranged above).
function tool(store: ReleaseStore) {
  return createCollectReleaseTool({ releaseStore: store });
}

// Read a named sub-schema of the input's z.object `.shape` defensively (the schema exposes
// `.shape` at runtime). Returns undefined when absent, so a test asserts a HELPFUL failure
// rather than throwing.
function subschema(
  schema: unknown,
  field: string,
): { safeParse(v: unknown): { success: boolean } } | undefined {
  const shape = (schema as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> } | null)
    ?.shape;
  return shape?.[field];
}
