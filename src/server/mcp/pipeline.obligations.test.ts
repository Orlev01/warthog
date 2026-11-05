// E07-S16 — Agent call pipeline, the obligation acceptance criteria
// (`src/server/mcp/pipeline.ts` + its auth / validation boundary).
//
// RED-first: `./pipeline` does not exist yet, so importing `createAgentCallPipeline`
// throws and every test here fails until the builder writes the module. That absence
// IS the point of test-first; do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR, never source text. They cover the three cross-cutting
// safety invariants as they land on the agent-call surface:
//
//   AC5 [obligation:admin-auth-required] (INV-101) — the agent surface is authenticated:
//        a request with no / an invalid bearer to the protected resource (`/mcp`) is
//        rejected (401), while a PUBLIC route stays usable with no auth; and the pipeline
//        takes the caller's identity from the resolved CONNECTION (the session), never a
//        client-supplied value in the call. Here the authentication boundary is the
//        already-built `verifyBearer` (auth is in this task's Touches); the public route
//        is the already-built protected-resource metadata handler.
//   AC6 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-shaped input
//        with a 4xx BEFORE the pipeline runs, and a SQL-injection probe in the connection
//        ids travels as a BOUND value (placeholders, never concatenation) and cannot
//        alter a query. The handler is a test fixture (the intended usage), not an
//        implementation file.
//   AC7 [obligation:secrets-from-env] (INV-103) — the pipeline runs purely from its
//        injected seams and reads no `process.env`, so a decoy secret in the environment
//        never lands in a returned result or a recorded activity entry.
//
// The pinned pipeline contract is documented in `pipeline.test.ts`; this file depends on
// the same `createAgentCallPipeline(deps)` factory and `AgentCallResult` union.
//
// Every db handle is closed in a `finally`; each db-backed test uses its own `freshDb()`
// (an isolated in-memory PGlite with the real migrations). Tests never touch the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";
import { createInMemoryRecorder } from "../activity/recorder";
import { verifyBearer } from "../oauth/verify-bearer";
import { createProtectedResourceMetadataHandler } from "../../app/.well-known/oauth-protected-resource/handler";
import { createUser } from "../db/users";
import { upsertPermissions } from "../db/agent-permissions";
import { parseBody, HttpError } from "../http/validate";
import { loadConfig } from "../config";
import { freshDb } from "../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import type { Db } from "../db/index";

type Grants = Parameters<typeof upsertPermissions>[1];
type Pipeline = ReturnType<typeof createAgentCallPipeline>;

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const CONN = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

async function makePerson(db: Db, who: string, keyWrapper: KeyWrapper): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: ["gmail"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: ["house-skill"],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  };
}

function connectionFor(userId: string, opts: { connectionId?: string; active?: boolean } = {}) {
  const connectionId = opts.connectionId ?? CONN;
  return { userId, connectionId, agentId: connectionId, active: opts.active ?? true };
}

function callFor(overrides: Record<string, unknown> = {}) {
  return { connector: null as string | null, tool: "search_memory", makesChange: false, params: { query: "hi" }, ...overrides };
}

function spyRecorder() {
  const base = createInMemoryRecorder({ clock: fixedClock(NOW) });
  const entries: Awaited<ReturnType<typeof base.record>>[] = [];
  const recorder = {
    async record(input: Parameters<typeof base.record>[0]) {
      const entry = await base.record(input);
      entries.push(entry);
      return entry;
    },
  };
  return { recorder, entries };
}

function spyExecutor(result: unknown = { ok: true, ran: true }) {
  const calls: unknown[] = [];
  const fn = async (call: unknown): Promise<unknown> => {
    calls.push(call);
    return result;
  };
  return { fn, calls };
}

function buildPipeline(
  db: Db,
  keyWrapper: KeyWrapper,
  recorder: ReturnType<typeof createInMemoryRecorder>,
  executeTool: (call: never, connection: never) => Promise<unknown>,
): Pipeline {
  return createAgentCallPipeline({
    db,
    keyWrapper,
    clock: fixedClock(NOW),
    rateLimiter: createRateLimiter(fixedClock(NOW)),
    recorder,
    executeTool,
  });
}

// A real Config built via the one env seam, with a chosen public base URL (dev env, so
// pglite is allowed and no production secrets are required beyond the test values).
function configWithBaseUrl(publicBaseUrl: string) {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: publicBaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  } as NodeJS.ProcessEnv);
}

// A db stand-in that records every query instead of running it (so a test proves WHAT
// reached the query layer and HOW — bound value vs. spliced text). It answers the
// users DEK lookup with a valid wrapped DEK so the loader proceeds to the member-scoped
// reads that bind the connection ids; everything else returns no rows.
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(wrappedDek: string): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.toLowerCase().includes("wrapped_dek")) {
        return Promise.resolve({ rows: [{ wrapped_dek: wrappedDek }] as Record<string, unknown>[] });
      }
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// ===========================================================================
// AC5 — the agent surface is authenticated; public routes stay public.
// ===========================================================================

test("the agent surface is authenticated: a request with no bearer is rejected with a 401 challenge", async () => {
  const db = await freshDb();
  try {
    const result = await verifyBearer(
      new Request("https://warthog.example/mcp", { method: "POST" }),
      { db, config: configWithBaseUrl("https://warthog.example"), clock: fixedClock(NOW) },
    );
    assert.equal(result.ok, false, "an unauthenticated agent request must be rejected");
    if (result.ok === false) {
      assert.equal(result.status, 401, "the rejection is a 401");
      assert.match(result.wwwAuthenticate, /^Bearer\b/, "it carries a Bearer challenge");
    }
  } finally {
    await db.close();
  }
});

test("a public route (the protected-resource metadata) is served 200 with no bearer", async () => {
  // INV-101: public routes stay usable with no auth. This is the real, already-built
  // handler an agent uses to discover HOW to get a token — reachable with no bearer.
  const handler = createProtectedResourceMetadataHandler({ config: configWithBaseUrl("https://warthog.example") });
  const response = await handler(new Request("https://warthog.example/.well-known/oauth-protected-resource"));
  assert.equal(response.status, 200, "a public route must be served with no auth header or session");
});

test("the pipeline takes identity from the resolved connection, never a client-supplied value in the call", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, "obl-alice", keyWrapper);
    const bob = await makePerson(db, "obl-bob", keyWrapper);

    // Both hold a row for the SAME connection id. Alice has no blocking rule; Bob's rule
    // would DENY the very same change. A call made for Alice's connection must follow
    // ALICE's grants/rules, even when the call body smuggles Bob's ids.
    await upsertPermissions(db, baseGrants(alice.userId, CONN));
    await upsertPermissions(db, baseGrants(bob.userId, CONN));
    const { createRule } = await import("../db/rules");
    await createRule(
      db,
      { userId: bob.userId, kind: "never_allow", scope: { type: "any_agent" }, action: { type: "any_change" } } as Parameters<typeof createRule>[1],
      bob.dek,
    );

    const rec = spyRecorder();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, rec.recorder, exec.fn);

    const result = await pipeline.handleAgentCall(
      connectionFor(alice.userId),
      callFor({
        tool: "save_memory",
        makesChange: true,
        // A hostile client smuggles Bob's identity in the call body — it must be ignored.
        params: { userId: bob.userId, connectionId: CONN, note: "hi" },
      }),
    );

    assert.equal(result.status, "executed", "Alice's own grants/rules decide — not Bob's deny, not a body value");
    assert.equal(exec.calls.length, 1, "the call executed under Alice's identity");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC6 — validate input (a 4xx before the pipeline) and parameterize every query.
// ===========================================================================

// The agent-call handler validates the request body (every tool takes an optional
// `reason`, design §6.1), then calls the pipeline with the SESSION's connection — whose
// identity is the session's, NEVER a body value. A rejected input maps to a 4xx Response
// and never reaches the pipeline. This is the intended usage, written as a test fixture.
function agentCallHandler(pipeline: Pipeline, sessionConnection: ReturnType<typeof connectionFor>) {
  const schema = z.object({
    tool: z.string().max(200),
    connector: z.string().max(200).nullable().optional(),
    makesChange: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await pipeline.handleAgentCall(sessionConnection, {
        connector: body.connector ?? null,
        tool: body.tool,
        makesChange: body.makesChange ?? false,
        reason: body.reason,
      });
      return new Response(JSON.stringify({ status: result.status }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed, oversized and mis-shaped input with a 4xx, before the pipeline runs", async () => {
  const keyWrapper = keyWrapperFor();
  const db = recordingDb(await keyWrapper.wrap(randomBytes(DEK_BYTES)));
  const exec = spyExecutor();
  const rec = spyRecorder();
  const pipeline = buildPipeline(db, keyWrapper, rec.recorder, exec.fn);
  const handler = agentCallHandler(pipeline, connectionFor("session-user"));

  const malformed = await handler(jsonRequest("{ not valid json"));
  const oversized = await handler(jsonRequest(JSON.stringify({ tool: "search_memory", reason: "a".repeat(10 * 1024) })));
  const misshaped = await handler(jsonRequest(JSON.stringify({ tool: 123 })));

  for (const [label, res] of [["malformed", malformed], ["oversized", oversized], ["mis-shaped", misshaped]] as const) {
    assert.ok(res.status >= 400 && res.status < 500, `${label} input must be a 4xx, got ${res.status}`);
  }
  assert.equal(exec.calls.length, 0, "rejected input must never reach the tool");
  assert.equal(rec.entries.length, 0, "rejected input must never be recorded as an activity entry");
  assert.equal(db.calls.length, 0, "rejected input must never reach a query");
});

test("a SQL-injection probe in the connection ids travels as a BOUND value and cannot alter a query", async () => {
  const keyWrapper = keyWrapperFor();
  const wrappedDek = await keyWrapper.wrap(randomBytes(DEK_BYTES));
  const db = recordingDb(wrappedDek);
  const exec = spyExecutor();
  const rec = spyRecorder();
  const pipeline = buildPipeline(db, keyWrapper, rec.recorder, exec.fn);

  const userProbe = "u'; DROP TABLE agent_permissions; --";
  const connProbe = "c'; DROP TABLE rules; --";

  // The pipeline may reject the (unseeded) connection partway; we only care that whatever
  // reached the db was bound. Swallow any resulting rejection.
  await pipeline
    .handleAgentCall({ userId: userProbe, connectionId: connProbe, agentId: connProbe, active: true }, callFor())
    .catch(() => undefined);

  assert.ok(db.calls.length >= 1, "the pipeline issues at least one member-scoped query");
  const allValues = db.calls.flatMap((c) => c.values);
  assert.ok(allValues.includes(userProbe), "the owning user id travels as a bound value");
  assert.ok(allValues.includes(connProbe), "the connection id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userProbe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes(connProbe), "the connection id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

// ===========================================================================
// AC7 — the pipeline reads no process.env: a decoy secret in the environment never
// appears in a returned result or a recorded activity entry.
// ===========================================================================

test("the pipeline reads no process.env: a decoy env secret never appears in the result or a recorded entry", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "obl-env", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const rec = spyRecorder();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, rec.recorder, exec.fn);

    const result = await pipeline.handleAgentCall(connectionFor(userId), callFor({ tool: "search_memory" }));

    assert.equal(result.status, "executed", "the pipeline works purely from its injected seams");
    assert.ok(!JSON.stringify(result).includes(DECOY), "no ambient env value is folded into the returned result");
    for (const entry of rec.entries) {
      assert.ok(!JSON.stringify(entry).includes(DECOY), "no ambient env value is folded into a recorded activity entry");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
