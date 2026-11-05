// E07-S16 — Agent call pipeline: gatekeeping and the allow/deny decision
// (`src/server/mcp/pipeline.ts`, design §6.1 pipeline / §8 policy engine;
// brief NFR "record an activity entry before returning the result",
// "refuse a disconnected agent's next request", "record one entry summarising
// the refused burst", constitution principle 14 "Warthog writes the record").
//
// RED-first: `./pipeline` does not exist yet, so importing `createAgentCallPipeline`
// throws and every test here fails until the builder writes the minimum code to
// pass. That absence IS the point of test-first; do NOT implement anything to make
// these pass — the builder writes `pipeline.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the pipeline DOES for a given connection + call:
// does it execute the tool? does it record? what does it return?), never the source
// text of any module — a later rename that preserves behaviour must not redden them.
// A decision is driven through the ALREADY-BUILT, tested seams: a connection's grants
// (`upsertPermissions`), its rules (`createRule`), its owning person (`createUser` +
// a real `KeyWrapper`), the real rate limiter (`createRateLimiter`) and the real
// in-memory recorder (`createInMemoryRecorder`, which redacts). The tool executor is a
// spy, so "executed / not executed" is observed directly.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // The resolved connection the pipeline acts for (exactly E07-S09's shape).
//   interface AgentConnection {
//     userId: string;        // the OWNING person (member scope) — from the
//                            // session/connection, NEVER a client value.
//     connectionId: string;  // the agent connection (an opaque uuid).
//     agentId: string;       // the agent identity (same id space as connectionId).
//     active: boolean;       // false ⇒ disconnected or revoked.
//   }
//
//   // What the agent is asking to do. The policy-relevant fields are exactly the
//   // policy engine's PolicyCall (connector/tool/makesChange/request/amount/…),
//   // plus the tool `params` (executed + recorded, redacted) and an optional `reason`.
//   interface AgentCall {
//     connector: string | null;   // the connected service, or null for a core tool / request
//     tool: string;
//     makesChange: boolean;        // tool class (false = a read)
//     request?: "card" | "high_tier";
//     amount?: number;
//     currency?: string;
//     merchant?: string;
//     recipients?: string | readonly string[] | null;
//     messageChannel?: "email" | "chat" | "post";
//     params?: unknown;            // the tool arguments — executed and recorded (redacted)
//     reason?: string;             // optional agent reason, shown to the person + stored
//   }
//
//   // The injected seams — no process.env (INV-103).
//   interface PipelineDeps {
//     db: Db;                      // parameterizing db seam (loadAgentContext reads through it)
//     keyWrapper: KeyWrapper;      // unwraps the person's DEK (to decrypt rule conditions)
//     clock: Clock;                // the current instant (budget-period key)
//     rateLimiter: RateLimiter;    // the per-connection sliding-window limiter (E07-S08)
//     recorder: ActivityRecorder;  // Warthog writes the record through this one contract
//     executeTool: (call: AgentCall, connection: AgentConnection) => Promise<unknown>;
//     rate?: ReferenceRate | null; // daily reference rate for card currency conversion (optional)
//   }
//
//   // A discriminated union on `status` (the repo idiom).
//   type AgentCallResult =
//     | { status: "executed";       result: unknown }  // allow → tool ran; its result returned
//     | { status: "refused";        reason: string }   // disconnected / rate-limited / denied
//     | { status: "not_supported";  reason: string };  // an ASK decision — the NEXT task holds it
//
//   createAgentCallPipeline(deps: PipelineDeps): {
//     handleAgentCall(connection: AgentConnection, call: AgentCall): Promise<AgentCallResult>;
//   }
//
// WHY a FACTORY (not a bare function): "a burst over the rate limit is recorded as ONE
// summarising entry, not one per refused call" (brief NFR) needs state that spans calls
// — the pipeline must know a refusal is a CONTINUATION of the current over-limit streak,
// not a fresh one. The factory closes over that per-connection burst state; each test
// makes its own pipeline, so the state is isolated (the production root memoizes one).
//
// Permission mapping note: the stored grants (`agent_permissions`) grant whole
// CONNECTORS plus read/change tool CLASSES — there is no per-tool allowlist column — so
// the pipeline treats a tool as permitted when its connector is granted AND its class
// (read / change) is allowed. (A core tool / card / high-tier request has
// `connector: null` and is gated by the request flags, not a connector grant.)
//
// Acceptance criteria → tests:
//   AC1 "An allowed call executes the tool and records an activity entry before the
//        result is returned." — a granted read runs the executor exactly once and
//        records ONE Warthog entry, execute-before-record, and returns `executed`.
//   AC2 "A call on a disconnected or revoked connection is refused and recorded without
//        executing." — `active: false` ⇒ `refused`, the executor is never called, and a
//        Warthog entry is still recorded.
//   AC3 "A burst over the rate limit is refused and recorded as ONE summarising entry,
//        not one per refused call." — with the limit reached, a run of over-limit calls
//        is each `refused` (never executed) yet adds exactly ONE activity entry.
//   AC4 "A denied call is refused without executing the tool and is recorded." — a
//        connector that is not granted, and a matching never_allow rule, each `refused`
//        + recorded, the executor never called.
//   ASK "An ask decision returns a clearly-typed not-yet-supported result." — a card
//        request (and an ask_first rule) return `not_supported`; the executor is never
//        called (the next task adds hold + approval).
//   SEC  (CLAUDE.md redaction hard rule / INV-103) — the recorded entry's parameters go
//        through redaction: a secret-named field and a card number never appear raw in
//        the recorded entry.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";
import { createInMemoryRecorder } from "../activity/recorder";
import { createUser } from "../db/users";
import { upsertPermissions } from "../db/agent-permissions";
import { createRule } from "../db/rules";
import { freshDb } from "../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";
import type { Db } from "../db/index";

// --- shapes derived from the stores' own signatures, so a later type rename that
// preserves behaviour does not redden these tests. ---------------------------------
type Grants = Parameters<typeof upsertPermissions>[1];
type NewRule = Parameters<typeof createRule>[1];
type Pipeline = ReturnType<typeof createAgentCallPipeline>;
type Result = Awaited<ReturnType<Pipeline["handleAgentCall"]>>;
type RecorderBase = ReturnType<typeof createInMemoryRecorder>;
type RecEntry = Awaited<ReturnType<RecorderBase["record"]>>;
type RecInput = Parameters<RecorderBase["record"]>[0];

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// Connection ids are uuids (the columns are `uuid`); the rule-scope "chosen agent" id is
// the SAME id space.
const CONN = "11111111-1111-1111-1111-111111111111";
const OTHER_CONN = "22222222-2222-2222-2222-222222222222";

// The frozen instant the pipeline reads time through (budget-period key + rate-limit
// window). Mid-month noon UTC, so the buckets are unambiguous in UTC arithmetic.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// Rule parts (the domain vocabulary) as `as const` literals.
const ANY_AGENT = { type: "any_agent" } as const;
const ANY_CHANGE = { type: "any_change" } as const;

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning their id
// and the DEK the rules are encrypted under (the loader resolves the DEK from the user row).
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

// A fully-populated grants record; a test overrides only what it is about. Built via a
// helper (a non-literal passed to upsertPermissions) so excess-property checks never bite.
function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: ["gmail", "google-calendar"],
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

// The resolved connection the pipeline acts for. Built as a variable (not a literal at the
// call site), so a superset of fields stays assignable to the pipeline's param type.
function connectionFor(
  userId: string,
  opts: { connectionId?: string; agentId?: string; active?: boolean } = {},
) {
  const connectionId = opts.connectionId ?? CONN;
  return { userId, connectionId, agentId: opts.agentId ?? connectionId, active: opts.active ?? true };
}

// One agent call; a test overrides only what it is about. The default is a core READ
// (connector null, no change) — allowed by policy with no grants beyond a permissions row.
function callFor(overrides: Record<string, unknown> = {}) {
  return {
    connector: null as string | null,
    tool: "search_memory",
    makesChange: false,
    params: { query: "hello" },
    ...overrides,
  };
}

// A recorder that wraps the REAL in-memory recorder (so redaction and chaining really
// happen) and captures each input and the stored (redacted) entry for assertions.
function spyRecorder(clock: Clock, order?: string[]) {
  const base = createInMemoryRecorder({ clock });
  const inputs: RecInput[] = [];
  const entries: RecEntry[] = [];
  const recorder = {
    async record(input: RecInput): Promise<RecEntry> {
      inputs.push(input);
      const entry = await base.record(input);
      if (order) order.push("record");
      entries.push(entry);
      return entry;
    },
  };
  return { recorder, inputs, entries };
}

// A tool executor spy: records every invocation (so "executed vs not" is observed) and
// returns a sentinel result. Appends "execute" to the order log when one is passed.
function spyExecutor(order?: string[], result: unknown = { ok: true, ran: true }) {
  const calls: { call: unknown; connection: unknown }[] = [];
  const fn = async (call: unknown, connection: unknown): Promise<unknown> => {
    calls.push({ call, connection });
    if (order) order.push("execute");
    return result;
  };
  return { fn, calls };
}

interface Seams {
  clock: Clock;
  rateLimiter: ReturnType<typeof createRateLimiter>;
  recorder: RecorderBase;
  executeTool: (call: never, connection: never) => Promise<unknown>;
}

function buildPipeline(db: Db, keyWrapper: KeyWrapper, seams: Seams): Pipeline {
  return createAgentCallPipeline({
    db,
    keyWrapper,
    clock: seams.clock,
    rateLimiter: seams.rateLimiter,
    recorder: seams.recorder,
    executeTool: seams.executeTool,
  });
}

// --- result narrowing helpers (assert.fail is `never`, so the result narrows after) ---

function expectExecuted(r: Result) {
  if (r.status !== "executed") assert.fail(`expected an executed result, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}
function expectRefused(r: Result) {
  if (r.status !== "refused") assert.fail(`expected a refused result, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}
function expectNotSupported(r: Result) {
  if (r.status !== "not_supported") assert.fail(`expected a not_supported result, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}

// ===========================================================================
// AC1 — an allowed call executes the tool and records an activity entry before
// the result is returned to the agent.
// ===========================================================================

test("an allowed core read executes the tool and records ONE Warthog entry, execute before record", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac1-core", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const order: string[] = [];
    const rec = spyRecorder(fixedClock(NOW), order);
    const exec = spyExecutor(order);
    const pipeline = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const result = expectExecuted(
      await pipeline.handleAgentCall(connectionFor(userId), callFor({ tool: "search_memory" })),
    );

    assert.equal(exec.calls.length, 1, "the tool is executed exactly once for an allowed call");
    assert.equal(rec.entries.length, 1, "exactly one activity entry is recorded");

    const [entry] = rec.entries;
    assert.ok(entry, "an activity entry was recorded");
    assert.equal(entry.source, "warthog", "Warthog writes the record itself (not the agent)");
    assert.equal(entry.tool, "search_memory", "the entry names the called tool");
    assert.deepEqual(
      order,
      ["execute", "record"],
      "the tool runs and the entry is recorded (both before the result is returned)",
    );
    assert.equal(result.status, "executed");
  } finally {
    await db.close();
  }
});

test("an allowed connector read (connector granted + reads allowed) executes and records the connector + tool", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac1-connector", keyWrapper);
    await upsertPermissions(
      db,
      baseGrants(userId, CONN, { grantedConnectors: ["gmail"], readTools: true, changeTools: "off" }),
    );

    const rec = spyRecorder(fixedClock(NOW));
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const result = expectExecuted(
      await pipeline.handleAgentCall(
        connectionFor(userId),
        callFor({ connector: "gmail", tool: "gmail.messages.list", makesChange: false }),
      ),
    );

    assert.equal(result.status, "executed");
    assert.equal(exec.calls.length, 1, "a granted connector read executes the tool");
    assert.equal(rec.entries.length, 1, "one activity entry is recorded");
    const [entry] = rec.entries;
    assert.ok(entry);
    assert.equal(entry.connectorId, "gmail", "the entry names the connected service");
    assert.equal(entry.tool, "gmail.messages.list", "the entry names the tool");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a call on a disconnected or revoked connection is refused and recorded
// without executing.
// ===========================================================================

test("a disconnected (inactive) connection is refused and recorded, without executing the tool", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac2-disconnected", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const rec = spyRecorder(fixedClock(NOW));
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const result = expectRefused(
      await pipeline.handleAgentCall(connectionFor(userId, { active: false }), callFor()),
    );

    assert.ok(result.reason.length > 0, "a refusal carries a plain reason");
    assert.equal(exec.calls.length, 0, "a disconnected connection never reaches the tool");
    assert.equal(rec.entries.length, 1, "the refusal is still recorded (one entry)");
    const [entry] = rec.entries;
    assert.ok(entry);
    assert.equal(entry.source, "warthog", "Warthog records the refusal itself");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a burst over the rate limit is refused and recorded as ONE summarising
// activity entry, not one per refused call.
// ===========================================================================

test("a burst over the rate limit is each refused (never executed) and recorded as ONE summarising entry", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac3-burst", keyWrapper);
    // A tiny per-connection limit so a short burst exceeds it deterministically.
    await upsertPermissions(db, baseGrants(userId, CONN, { rateLimit: 2 }));

    const rec = spyRecorder(fixedClock(NOW));
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      // A FROZEN clock keeps every call inside the one sliding window, so once the
      // limit is reached it stays reached for the rest of the burst.
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const conn = connectionFor(userId);

    // The first two calls are within the limit → executed.
    expectExecuted(await pipeline.handleAgentCall(conn, callFor()));
    expectExecuted(await pipeline.handleAgentCall(conn, callFor()));
    assert.equal(exec.calls.length, 2, "calls within the limit execute");
    const afterAllowed = rec.entries.length;

    // The next three calls are over the limit → each refused, none executed.
    for (let i = 0; i < 3; i += 1) {
      const result = expectRefused(await pipeline.handleAgentCall(conn, callFor()));
      assert.ok(result.reason.length > 0, "each over-limit call is refused with a plain reason");
    }

    assert.equal(exec.calls.length, 2, "no over-limit call reaches the tool");
    assert.equal(
      rec.entries.length - afterAllowed,
      1,
      "the whole refused burst adds exactly ONE summarising entry, not one per refused call",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a denied call is refused without executing the tool and is recorded.
// ===========================================================================

test("a call on a connector that is not granted is denied: refused + recorded, never executed", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ac4-connector", keyWrapper);
    // Only gmail is granted; the call targets slack → the permission gate denies.
    await upsertPermissions(db, baseGrants(userId, CONN, { grantedConnectors: ["gmail"], readTools: true }));

    const rec = spyRecorder(fixedClock(NOW));
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const result = expectRefused(
      await pipeline.handleAgentCall(
        connectionFor(userId),
        callFor({ connector: "slack", tool: "slack.post", makesChange: false }),
      ),
    );

    assert.ok(result.reason.length > 0, "the denial carries a plain reason");
    assert.equal(exec.calls.length, 0, "a denied call never reaches the tool");
    assert.equal(rec.entries.length, 1, "the denial is recorded (one entry)");
    const [entry] = rec.entries;
    assert.ok(entry);
    assert.equal(entry.source, "warthog");
  } finally {
    await db.close();
  }
});

test("a matching never_allow rule denies the call: refused + recorded, never executed", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "ac4-rule", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));
    // "Never allow any agent to make a change" → a change-making core tool is denied.
    await createRule(
      db,
      { userId, kind: "never_allow", scope: ANY_AGENT, action: ANY_CHANGE } as NewRule,
      dek,
    );

    const rec = spyRecorder(fixedClock(NOW));
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const result = expectRefused(
      await pipeline.handleAgentCall(
        connectionFor(userId),
        callFor({ connector: null, tool: "save_memory", makesChange: true }),
      ),
    );

    assert.ok(result.reason.length > 0, "the rule denial carries a plain reason");
    assert.equal(exec.calls.length, 0, "a rule-denied call never reaches the tool");
    assert.equal(rec.entries.length, 1, "the denial is recorded (one entry)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// ASK — an ask decision returns a clearly-typed not-yet-supported result (the
// NEXT task holds it); the tool is never executed.
// ===========================================================================

test("a card request (an ASK decision) returns a clearly-typed not-yet-supported result, without executing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "ask-card", keyWrapper);
    // Card access with a budget that comfortably covers the request → the policy engine
    // reaches "ask" (a card request always needs the person), not "deny".
    await upsertPermissions(
      db,
      baseGrants(userId, CONN, {
        cardAccess: true,
        cardBudget: { amount: 200, currency: "AUD", period: "month" },
      }),
    );

    const rec = spyRecorder(fixedClock(NOW));
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const result = expectNotSupported(
      await pipeline.handleAgentCall(
        connectionFor(userId),
        callFor({
          connector: null,
          tool: "request_card",
          makesChange: true,
          request: "card",
          amount: 42,
          currency: "AUD",
          merchant: "BoxCo",
        }),
      ),
    );

    assert.ok(result.reason.length > 0, "the not-yet-supported result carries a plain reason");
    assert.equal(exec.calls.length, 0, "an ask decision does not execute the tool");
  } finally {
    await db.close();
  }
});

test("an ask_first rule (an ASK decision) returns a not-yet-supported result, without executing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "ask-rule", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));
    // "Ask me before any agent makes a change" → a change-making call asks.
    await createRule(
      db,
      { userId, kind: "ask_first", scope: ANY_AGENT, action: ANY_CHANGE } as NewRule,
      dek,
    );

    const rec = spyRecorder(fixedClock(NOW));
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const result = expectNotSupported(
      await pipeline.handleAgentCall(
        connectionFor(userId),
        callFor({ connector: null, tool: "update_task", makesChange: true }),
      ),
    );

    assert.ok(result.reason.length > 0);
    assert.equal(exec.calls.length, 0, "an ask decision does not execute the tool");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// SEC — the recorded entry's parameters pass through redaction: no secret-named
// field value and no card number appear raw in the recorded activity entry
// (CLAUDE.md redaction hard rule; INV-103). Scoped to the ONE recorded entry.
// ===========================================================================

test("the recorded entry runs the call parameters through redaction: no raw secret or card number survives", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "sec-redaction", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const rec = spyRecorder(fixedClock(NOW));
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: exec.fn,
    });

    const SECRET = "sk-live-TOPSECRET-value-xyz";
    const PAN = "4242424242424242"; // a Luhn-valid 16-digit number

    expectExecuted(
      await pipeline.handleAgentCall(
        connectionFor(userId),
        callFor({
          tool: "search_memory",
          // `apiKey` is a secret FIELD NAME (redacted by key); the card number sits in a
          // free-text, non-secret field (redacted by the Luhn card rule).
          params: { apiKey: SECRET, note: `charge ref ${PAN} now` },
        }),
      ),
    );

    assert.equal(rec.entries.length, 1);
    const [entry] = rec.entries;
    assert.ok(entry);
    const recorded = JSON.stringify(entry);
    assert.ok(!recorded.includes(SECRET), "a secret-named field value must not appear raw in the recorded entry");
    assert.ok(!recorded.includes(PAN), "a card number must not appear raw in the recorded entry");
    assert.ok(recorded.includes("[redacted]"), "the secret-named field is replaced with [redacted]");
  } finally {
    await db.close();
  }
});
