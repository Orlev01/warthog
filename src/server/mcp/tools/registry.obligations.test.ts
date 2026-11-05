// E07-S11 — MCP core tool registry, the obligation acceptance criteria
// (`src/server/mcp/tools/registry.ts` + its validation / parameter-binding / config
// boundaries, design §6.2; INV-102 validate-and-parameterize-input, INV-103
// secrets-from-env).
//
// RED-first: `./registry` does not exist yet, so importing `createToolRegistry`
// throws and every test here fails until the builder writes the module. That absence
// IS the point of test-first; do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR, never source text. The pinned registry contract is
// documented in the sibling `registry.test.ts`; this file depends on the same
// `createToolRegistry({ pipeline })` factory and `ToolDefinition.handle` surface.
//
//   AC [obligation:validate-and-parameterize-input] (INV-102) —
//     • a core-tool handler rejects malformed / oversized / mis-shaped input with a
//       4xx HttpError BEFORE the pipeline runs (and never routes it on); and
//     • a SQL-injection probe in an input FIELD travels to the database as a BOUND
//       value — a sentinel table is intact afterwards and the probe round-trips as
//       inert data, so it cannot alter a query.
//   AC [obligation:secrets-from-env] (INV-103) — the registry runs purely from its
//     injected seams and reads no `process.env`, so a decoy env secret never lands in
//     a returned result or a recorded activity entry; config flows in, never baked in.
//
// Every db handle is closed in a `finally`; each db-backed test uses its own
// `freshDb()` (an isolated in-memory PGlite with the real migrations). Tests never
// touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createToolRegistry } from "./registry";
import { createAgentCallPipeline } from "../pipeline";
import { createRateLimiter } from "../rate-limit";
import { createInMemoryRecorder } from "../../activity/recorder";
import { createDbRecorder } from "../../activity/writer";
import { createUser, getUserById } from "../../db/users";
import { upsertPermissions } from "../../db/agent-permissions";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import { HttpError } from "../../http/validate";
import type { AgentCall, AgentCallResult, AgentCallPipeline } from "../pipeline";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const CONN = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

type Grants = Parameters<typeof upsertPermissions>[1];
function baseGrants(userId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId: CONN,
    grantedConnectors: ["gmail"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  };
}

function connectionFor(userId: string): AgentConnection {
  return { userId, connectionId: CONN, agentId: CONN, active: true };
}

// A pipeline spy that records every handleAgentCall, so a validation test proves
// WHETHER an input reached the pipeline at all.
function spyPipeline(result: AgentCallResult = { status: "executed", result: { ok: true } }) {
  const calls: { connection: AgentConnection; call: AgentCall }[] = [];
  const pipeline: AgentCallPipeline = {
    async handleAgentCall(connection: AgentConnection, call: AgentCall): Promise<AgentCallResult> {
      calls.push({ connection, call });
      return result;
    },
    async executeApprovedHold() {
      return { status: "refused" as const, reason: "unused in these tests" };
    },
  };
  return { pipeline, calls };
}

// A real pipeline over a real (in-process PGlite) database, so a handler is exercised
// end-to-end against parameterized stores. The tool executor is a spy (the real
// tool bodies are later tasks); the recorder is supplied by the caller.
function realPipeline(
  db: Db,
  keyWrapper: KeyWrapper,
  recorder: Parameters<typeof createAgentCallPipeline>[0]["recorder"],
): AgentCallPipeline {
  return createAgentCallPipeline({
    db,
    keyWrapper,
    clock: fixedClock(NOW),
    rateLimiter: createRateLimiter(fixedClock(NOW)),
    recorder,
    executeTool: async () => ({ ok: true, ran: true }),
  });
}

const is4xx = (err: unknown): boolean =>
  err instanceof HttpError && err.status >= 400 && err.status < 500;

// ===========================================================================
// AC [validate-and-parameterize-input] — a handler rejects bad input with a 4xx
// BEFORE the pipeline runs.
// ===========================================================================

test("every core tool's handler rejects a mis-shaped (non-object) input with a 4xx, before the pipeline runs", async () => {
  const { pipeline, calls } = spyPipeline();
  const registry = createToolRegistry({ pipeline });
  const conn = connectionFor("validate-person");

  for (const def of registry.coreTools) {
    // A tool's input is an object; a bare scalar is mis-shaped for all of them.
    await assert.rejects(
      () => def.handle(42, conn),
      (err: unknown) => is4xx(err),
      `"${def.name}" must reject a non-object input with a 4xx HttpError`,
    );
    // A wrong-typed reason is likewise rejected (reason is a string field on every tool).
    await assert.rejects(
      () => def.handle({ reason: 999 }, conn),
      (err: unknown) => is4xx(err),
      `"${def.name}" must reject a non-string reason with a 4xx HttpError`,
    );
  }

  assert.equal(calls.length, 0, "no mis-shaped input is ever routed to the pipeline");
});

test("a core tool's handler accepts valid input but rejects an OVERSIZED input with a 4xx (and never routes it)", async () => {
  const { pipeline, calls } = spyPipeline();
  const registry = createToolRegistry({ pipeline });
  const conn = connectionFor("oversize-person");

  const getContext = registry.get("get_context");
  assert.ok(getContext, "get_context is a core tool");

  // A small, well-formed input is accepted and routed to the pipeline …
  await getContext!.handle({ reason: "catching up" }, conn);
  assert.equal(calls.length, 1, "a small valid input is routed to the pipeline");

  // … but the SAME field, grossly oversized, is rejected with a 4xx and never routed.
  await assert.rejects(
    () => getContext!.handle({ reason: "x".repeat(500_000) }, conn),
    (err: unknown) => is4xx(err),
    "an oversized input must be rejected with a 4xx HttpError",
  );
  assert.equal(calls.length, 1, "the oversized input is never routed to the pipeline");
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a SQL-injection probe in an input field is
// bound, never executed: the database is intact and the probe round-trips as data.
// ===========================================================================

test("a SQL-injection probe in an input field travels as a BOUND value and cannot alter a query", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "sql-probe", keyWrapper);
    // Card access + a budget that covers the request, so a card request reaches the
    // hold path (which records a Warthog activity entry carrying the `merchant`
    // metadata as a PLAINTEXT, bound column value).
    await upsertPermissions(
      db,
      baseGrants(userId, {
        cardAccess: true,
        cardBudget: { amount: 200, currency: "AUD", period: "month" },
      }),
    );

    // The real DB-backed recorder, so the agent-supplied `merchant` field actually
    // reaches a parameterized INSERT.
    const dekFor = async (uid: string): Promise<Uint8Array> => {
      const user = await getUserById(db, uid);
      if (!user) throw new Error("no user");
      return keyWrapper.unwrap(user.wrappedDek);
    };
    const recorder = createDbRecorder({ db, clock: fixedClock(NOW), dekFor });
    const pipeline = realPipeline(db, keyWrapper, recorder);
    const registry = createToolRegistry({ pipeline });

    const requestCard = registry.get("request_card");
    assert.ok(requestCard, "request_card is a core tool");

    // A probe that would drop a table if it were concatenated into SQL.
    const probe = "Acme'); DROP TABLE agent_permissions; --";
    const result = await requestCard!.handle(
      { amount: 10, currency: "AUD", merchant: probe, reason: "buying parts" },
      connectionFor(userId),
    );

    // The card request is held (treated as data, not rejected as SQL).
    assert.equal(result.status, "pending_approval", "the card request is handled (held for approval)");

    // The probe did NOT drop/alter the table: the person's permissions row survives.
    const perms = await db.query(
      "SELECT count(*)::int AS n FROM agent_permissions WHERE user_id = $1",
      [userId],
    );
    assert.equal(perms.rows[0]!.n, 1, "the injection could not drop/alter agent_permissions");

    // Exactly one activity entry was written (no extra injected statement ran), and the
    // probe round-trips verbatim in the plaintext, parameter-bound merchant column — it
    // was stored as inert data, never interpreted as SQL.
    const entries = await db.query(
      "SELECT merchant FROM activity_entries WHERE user_id = $1",
      [userId],
    );
    assert.equal(entries.rows.length, 1, "the probe injected no extra statements");
    assert.equal(entries.rows[0]!.merchant, probe, "the probe is stored as a bound, literal value");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [secrets-from-env] — the registry reads no process.env: a decoy env secret never
// appears in a returned result or a recorded activity entry.
// ===========================================================================

test("the registry reads no process.env: a decoy env secret never appears in a result or a recorded entry", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;

  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "secrets-env", keyWrapper);
    await upsertPermissions(db, baseGrants(userId));

    // Capture the recorded entries through the real (redacting, chaining) in-memory recorder.
    const base = createInMemoryRecorder({ clock: fixedClock(NOW) });
    const entries: Awaited<ReturnType<typeof base.record>>[] = [];
    const recorder = {
      async record(input: Parameters<typeof base.record>[0]) {
        const entry = await base.record(input);
        entries.push(entry);
        return entry;
      },
    };

    const pipeline = realPipeline(db, keyWrapper, recorder);
    const registry = createToolRegistry({ pipeline });

    const getContext = registry.get("get_context");
    assert.ok(getContext, "get_context is a core tool");

    const result = await getContext!.handle({ reason: "just checking" }, connectionFor(userId));

    assert.equal(result.status, "executed", "the registry + pipeline run purely from their injected seams");
    assert.ok(
      !JSON.stringify(result).includes(DECOY),
      "no ambient env value is folded into the returned result",
    );
    for (const entry of entries) {
      assert.ok(
        !JSON.stringify(entry).includes(DECOY),
        "no ambient env value is folded into a recorded activity entry",
      );
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
