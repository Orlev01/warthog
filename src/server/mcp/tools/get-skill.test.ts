// E13-S04 — the `get_skill` core tool (`src/server/mcp/tools/get-skill.ts`,
// design §6.2 MCP core tools; brief §"Skills, preferences and shared memory": "an
// agent's context lists the titles and 'use this when' lines of the skills it may use
// and the agent fetches a skill's full text by title when it decides the skill is
// relevant (Warthog never guesses relevance) … Warthog's own house skill is always
// included in full").
//
// RED-first: `./get-skill` does not exist yet, so importing `createGetSkillTool` /
// `HOUSE_SKILL` throws and every test here fails until the builder writes the minimum
// code to pass. That absence IS the point of test-first; do NOT implement anything to
// make these pass — the builder writes `get-skill.ts` afterwards. (The skills STORE it
// reads — `createSkill` / `getSkillText` — and the pipeline it is routed through both
// already exist and are driven here as real, tested seams.)
//
// These tests pin BEHAVIOUR (what the tool RETURNS for a given title + connection: the
// full text of a permitted, enabled skill; a plain refusal for one not scoped to the
// agent; the house skill always, in full; that it runs through the pipeline so a denied
// call never fetches and is recorded; that agent/user come from the connection, never
// the input), never the source text of any module — a later rename that preserves
// behaviour must not redden them.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import { z } from "zod";
//   import type { Db } from "../../db/index";
//   import type { KeyWrapper } from "../../crypto/key-wrapper";
//   import type { AgentConnection } from "../context";
//
//   // Warthog's OWN house skill — a built-in instruction document telling an agent how to
//   // work — is ALWAYS returned in full, regardless of the person's skills or scope. Its
//   // TITLE is the canonical one the agent's index already advertises (`HOUSE_SKILL.title`
//   // from `src/domain/skills`, "Using Warthog"); get_skill supplies the full body that the
//   // index deliberately omits. The builder derives the title from that one source, never a
//   // divergent literal.
//
//   // What get_skill hands back to the agent.
//   type GetSkillResult =
//     | { status: "found"; title: string; text: string }  // the skill's FULL instruction text
//     | { status: "not_available"; reason: string };       // unknown / disabled / not scoped — a PLAIN reason
//
//   interface GetSkillTool {
//     readonly name: string;           // "get_skill"
//     readonly inputSchema: z.ZodType; // a z.object whose .shape has a REQUIRED string `title`
//                                       // and the universal OPTIONAL string `reason` (design §6.2).
//     // Validate `input` (a bad / oversized / mis-shaped input THROWS HttpError 4xx BEFORE
//     // any db access — see the sibling obligations test); then, taking the OWNING person
//     // and the agent from `connection` (NEVER from `input`):
//     //   • the house-skill title (the index's)  → { status: "found", title, text: <full house body> }
//     //   • an enabled skill scoped to the agent → { status: "found", title, text: <fullText> }
//     //   • unknown / disabled / not scoped     → { status: "not_available", reason }
//     handle(input: unknown, connection: AgentConnection): Promise<GetSkillResult>;
//   }
//
//   interface GetSkillDeps {
//     readonly db: Db;               // the parameterizing db seam (the skills store reads through it)
//     readonly keyWrapper: KeyWrapper; // unwraps the person's DEK (to decrypt the member-scoped skills)
//   }
//
//   function createGetSkillTool(deps: GetSkillDeps): GetSkillTool;
//
// "Runs through the pipeline (permission check + an activity entry)" (an AC) is pinned by
// wiring this tool's `handle` as the pipeline's `executeTool` dispatch for get_skill and
// driving a real `createAgentCallPipeline` over the already-built, tested seams (a
// person's grants via `upsertPermissions`, a `never_allow` rule via `createRule`, the real
// in-memory recorder that redacts): an allowed call executes + records ONE Warthog entry;
// a denied call is refused, NEVER fetches the skill, and is still recorded.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations). Tests
// never touch the network, Azure or a real database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createGetSkillTool } from "./get-skill";
// The CANONICAL house-skill identity is the domain constant `buildSkillIndex` advertises
// in every agent's index (E03-S10). One-source-of-truth (principle 7): get_skill must make
// the house skill fetchable BY THAT SAME TITLE — the title the agent actually sees — so the
// test pins the cross-module contract against the domain constant, not a get_skill-internal
// copy. The domain index carries only { title, useThisWhen } (never the body); get_skill
// supplies the full instruction text.
import { HOUSE_SKILL } from "../../../domain/skills/index";
import { createAgentCallPipeline, type AgentCall, type AgentCallResult } from "../pipeline";
import { createRateLimiter } from "../rate-limit";
import { createInMemoryRecorder, type ActivityEntryInput } from "../../activity/recorder";
import { createUser } from "../../db/users";
import { createSkill, type NewSkill } from "../../db/skills";
import { upsertPermissions } from "../../db/agent-permissions";
import { createRule } from "../../db/rules";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock, type Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

// --- shapes derived defensively, so the (absent) module's exact types do not gate compile.

// The result shape, kept LOOSE on purpose: the tests assert on `status` + the field that
// status carries, so the builder is free to pick the exact discriminated-union members as
// long as the behaviour holds.
interface SkillResult {
  readonly status: string;
  readonly title?: string;
  readonly text?: string;
  readonly reason?: string;
}

type Grants = Parameters<typeof upsertPermissions>[1];
type NewRuleArg = Parameters<typeof createRule>[1];

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 KEK the KeyWrapper seam wraps the DEK under

// The frozen instant the pipeline reads time through (budget-period key + rate-limit
// window). Mid-month noon UTC, so the buckets are unambiguous in UTC arithmetic.
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK REALLY unwraps under `keyWrapper` (the tool resolves
// the DEK from the user row through the wrapper, exactly as the pipeline does), returning
// their id and the raw DEK the skills below are encrypted under — so a round-trip proves
// the tool read under the person's own key.
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

// A fresh agent id (an opaque uuid — the same id space the skills store scopes by).
function agentId(): string {
  return randomUUID();
}

// The resolved connection the tool acts for. Built as a variable (not a literal at the call
// site) so a superset of fields stays assignable to the tool's param type. `agentId`
// defaults to `connectionId` (the E07-S09 shape).
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

// A fully-populated grants record for the pipeline integration; a test overrides only what
// it is about. Built via a helper (a non-literal) so excess-property checks never bite.
function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: [],
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
  } as Grants;
}

// Build a NewSkill for `userId`; distinct fields per test prove each is stored/read
// independently. Default scope 'all' (covers every agent).
function newSkillFor(userId: string, overrides: Partial<NewSkill> = {}): NewSkill {
  return {
    userId,
    title: "Travel booking",
    useThisWhen: "Use this when booking flights, trains or hotels for the person",
    fullText:
      "Always prefer refundable fares. Book an aisle seat. Keep each trip under the daily budget. Confirm dates with the person before paying.",
    scope: "all",
    scopedAgentIds: [],
    enabled: true,
    ...overrides,
  } as NewSkill;
}

// A recorder that wraps the REAL in-memory recorder (so redaction + chaining really happen)
// and captures each input, so the pipeline tests can prove ONE Warthog entry was written.
function spyRecorder(clock: Clock) {
  const base = createInMemoryRecorder({ clock });
  const inputs: ActivityEntryInput[] = [];
  const recorder = {
    async record(input: ActivityEntryInput) {
      inputs.push(input);
      return base.record(input);
    },
  };
  return { recorder, inputs };
}

// Narrowing helpers (assert.fail is `never`, so the result narrows after).
function expectExecuted(r: AgentCallResult) {
  if (r.status !== "executed") assert.fail(`expected an executed result, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}
function expectRefused(r: AgentCallResult) {
  if (r.status !== "refused") assert.fail(`expected a refused result, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}

// ===========================================================================
// AC1 (part 1) — get_skill returns the FULL TEXT of a permitted, enabled skill by title.
// ===========================================================================

test("get_skill returns the full text of an enabled skill scoped to ALL agents", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "all-scope", keyWrapper);
    const skill = await createSkill(db, newSkillFor(userId, { scope: "all" }), dek);

    const tool = createGetSkillTool({ db, keyWrapper });
    const result = (await tool.handle({ title: skill.title }, connectionFor(userId))) as SkillResult;

    assert.equal(result.status, "found", "an enabled 'all' skill is found by its title");
    assert.equal(result.text, skill.fullText, "the FULL instruction text is returned verbatim");
  } finally {
    await db.close();
  }
});

test("get_skill returns the full text of a 'chosen' skill when the agent is one of the chosen", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "chosen-match", keyWrapper);
    const thisAgent = agentId();
    const skill = await createSkill(
      db,
      newSkillFor(userId, {
        title: "Inbox triage",
        fullText: "Sort by sender importance; never archive anything from the person's accountant.",
        scope: "chosen",
        scopedAgentIds: [thisAgent, agentId()],
      }),
      dek,
    );

    const tool = createGetSkillTool({ db, keyWrapper });
    const conn = connectionFor(userId, { connectionId: thisAgent, agentId: thisAgent });
    const result = (await tool.handle({ title: skill.title }, conn)) as SkillResult;

    assert.equal(result.status, "found", "a 'chosen' skill listing this agent is found");
    assert.equal(result.text, skill.fullText, "its full text is returned to the chosen agent");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 (part 2) — get_skill REFUSES a skill not scoped to the agent, with a PLAIN reason.
// (The skill exists and is enabled, but this agent is not among its chosen agents.)
// ===========================================================================

test("get_skill refuses a skill scoped to OTHER agents with a plain reason (not the text)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "chosen-miss", keyWrapper);
    const SECRET_STEPS = "Only the finance agent may see these account-reconciliation steps.";
    const skill = await createSkill(
      db,
      newSkillFor(userId, {
        title: "Reconcile accounts",
        fullText: SECRET_STEPS,
        scope: "chosen",
        scopedAgentIds: [agentId(), agentId()], // NOT this connection's agent
      }),
      dek,
    );

    const tool = createGetSkillTool({ db, keyWrapper });
    // A different agent of the SAME person: scoping is proven to be by AGENT, not by person.
    const conn = connectionFor(userId, { connectionId: agentId(), agentId: agentId() });
    const result = (await tool.handle({ title: skill.title }, conn)) as SkillResult;

    assert.equal(result.status, "not_available", "a skill not scoped to this agent is refused");
    assert.ok((result.reason ?? "").length > 0, "the refusal carries a PLAIN reason");
    assert.notEqual(result.text, SECRET_STEPS, "the full text of an out-of-scope skill does not leak");
  } finally {
    await db.close();
  }
});

test("get_skill refuses an UNKNOWN title and a DISABLED skill (not_available, no text)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "unknown-disabled", keyWrapper);
    const DISABLED_TEXT = "Draft replies in the person's voice — switched off for now.";
    await createSkill(
      db,
      newSkillFor(userId, { title: "Draft replies", fullText: DISABLED_TEXT, scope: "all", enabled: false }),
      dek,
    );

    const tool = createGetSkillTool({ db, keyWrapper });
    const conn = connectionFor(userId);

    const unknown = (await tool.handle({ title: "No such skill here" }, conn)) as SkillResult;
    assert.equal(unknown.status, "not_available", "a title the person has no skill for is refused");
    assert.ok((unknown.reason ?? "").length > 0, "it carries a plain reason");

    const disabled = (await tool.handle({ title: "Draft replies" }, conn)) as SkillResult;
    assert.equal(disabled.status, "not_available", "a switched-off skill is refused even when its title matches");
    assert.notEqual(disabled.text, DISABLED_TEXT, "a disabled skill's text is never handed over");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Member scope — the agent/user come from the CONNECTION, never the input. Person A owns a
// skill scoped to ALL of A's agents; a connection for a DIFFERENT person B requesting the
// same title never reads A's skill.
// ===========================================================================

test("get_skill never reads another person's skill (userId comes from the connection)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await makePerson(db, "owner-a", keyWrapper);
    const b = await makePerson(db, "other-b", keyWrapper);
    const A_ONLY = "Person A's private packing checklist and lounge access codes.";
    const skill = await createSkill(
      db,
      newSkillFor(a.userId, { title: "Pack for a trip", fullText: A_ONLY, scope: "all" }),
      a.dek,
    );

    const tool = createGetSkillTool({ db, keyWrapper });

    // Person A's own agent fetches it fine.
    const mine = (await tool.handle({ title: skill.title }, connectionFor(a.userId))) as SkillResult;
    assert.equal(mine.status, "found", "the owner reads their own skill");
    assert.equal(mine.text, A_ONLY, "the owner gets the full text");

    // Person B asks for the SAME title — never finds A's skill (scope is the connection's user).
    const theirs = (await tool.handle({ title: skill.title }, connectionFor(b.userId))) as SkillResult;
    assert.equal(theirs.status, "not_available", "another person's agent cannot read A's skill");
    assert.notEqual(theirs.text, A_ONLY, "A's full text does not cross to another person");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — Warthog's OWN house skill is ALWAYS returned IN FULL, regardless of scope. A person
// whose agent has NOTHING scoped to it (only a skill for a different agent) still gets the
// house skill in full by its title.
// ===========================================================================

test("the Warthog house skill is always returned in full, regardless of scope", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "house-always", keyWrapper);
    // A user skill scoped to a DIFFERENT agent, so this connection's agent has nothing of
    // its own in scope — the house skill must still come through in full.
    await createSkill(
      db,
      newSkillFor(userId, { title: "Someone else's skill", scope: "chosen", scopedAgentIds: [agentId()] }),
      dek,
    );

    const tool = createGetSkillTool({ db, keyWrapper });
    const conn = connectionFor(userId); // a fresh agent, nothing scoped to it

    const result = (await tool.handle({ title: HOUSE_SKILL.title }, conn)) as SkillResult;
    assert.equal(result.status, "found", "the house skill is always available by the title the index advertises");
    assert.ok((result.text ?? "").length > 0, "it is returned with a real instruction body");
    // The FULL body, not a trivial echo of the one-line index entry.
    assert.notEqual(result.text, HOUSE_SKILL.title, "the body is more than the title");
    assert.notEqual(result.text, HOUSE_SKILL.useThisWhen, "the body is the full text, not the one-line use-this-when");
  } finally {
    await db.close();
  }
});

test("the house skill comes through even for a person who has created no skills at all", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "house-no-skills", keyWrapper);

    const tool = createGetSkillTool({ db, keyWrapper });
    const result = (await tool.handle({ title: HOUSE_SKILL.title }, connectionFor(userId))) as SkillResult;

    assert.equal(result.status, "found", "no personal skills does not withhold the house skill");
    assert.ok((result.text ?? "").length > 0, "the house skill's full text is returned");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Envelope — the tool names itself get_skill and its schema carries a REQUIRED `title` and
// the universal OPTIONAL `reason` (design §6.2 "every tool takes an optional reason").
// ===========================================================================

test("the get_skill tool is named and its schema requires a title and allows an optional reason", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const built = createGetSkillTool({ db, keyWrapper });
    assert.equal(built.name, "get_skill", "the tool names itself get_skill");

    const title = subschema(built.inputSchema, "title");
    assert.ok(title, "the input schema exposes a `title` field");
    assert.equal(title!.safeParse("Travel booking").success, true, "`title` accepts a string");
    assert.equal(title!.safeParse(undefined).success, false, "`title` is REQUIRED (a skill is fetched BY title)");

    const reason = subschema(built.inputSchema, "reason");
    assert.ok(reason, "the input schema exposes a `reason` field");
    assert.equal(reason!.safeParse(undefined).success, true, "`reason` is OPTIONAL");
    assert.equal(reason!.safeParse("the skill looks relevant").success, true, "`reason` accepts a string");
    assert.equal(reason!.safeParse(123).success, false, "`reason` rejects a non-string");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the call RUNS THROUGH THE PIPELINE: the permission check gates it and an activity
// entry is written. An ALLOWED get_skill call executes (returns the text) and records ONE
// Warthog entry for the tool. (The tool's `handle` is wired as the pipeline's executeTool
// dispatch for get_skill, exactly as the composition root wires it.)
// ===========================================================================

test("through the pipeline: an allowed get_skill call returns the text and records ONE Warthog entry", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "pipe-allow", keyWrapper);
    const conn = connectionFor(userId);
    await upsertPermissions(db, baseGrants(userId, conn.connectionId));
    const skill = await createSkill(
      db,
      newSkillFor(userId, { title: "Weekly review", fullText: "Summarise the week; flag anything overdue." }),
      dek,
    );

    const tool = createGetSkillTool({ db, keyWrapper });
    const rec = spyRecorder(fixedClock(NOW));
    let fetches = 0;
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      // The pipeline executes get_skill by dispatching to the tool body, taking the agent/
      // user from the resolved connection it is handed — never from the call body.
      executeTool: async (call: AgentCall, connection: AgentConnection) => {
        fetches += 1;
        return tool.handle(call.params, connection);
      },
    });

    const call: AgentCall = {
      connector: null,
      tool: "get_skill",
      makesChange: false,
      params: { title: skill.title },
    };
    const outcome = expectExecuted(await pipeline.handleAgentCall(conn, call));

    const body = outcome.result as SkillResult;
    assert.equal(body.status, "found", "the allowed call fetched and returned the skill");
    assert.equal(body.text, skill.fullText, "its full text flows back through the pipeline");
    assert.equal(fetches, 1, "the tool body ran exactly once");

    const entries = rec.inputs.filter((e) => e.tool === "get_skill");
    assert.equal(entries.length, 1, "exactly ONE activity entry is written for the call");
    assert.equal(entries[0].source, "warthog", "Warthog writes the record itself (not the agent)");
  } finally {
    await db.close();
  }
});

test("through the pipeline: a never_allow rule refuses get_skill — never fetched, still recorded", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "pipe-deny", keyWrapper);
    const conn = connectionFor(userId);
    await upsertPermissions(db, baseGrants(userId, conn.connectionId));
    // A rule that forbids this exact tool for any agent → the policy engine DENIES it.
    await createRule(
      db,
      { userId, kind: "never_allow", scope: { type: "any_agent" }, action: { type: "specific_tool", tool: "get_skill" } } as NewRuleArg,
      dek,
    );
    // The person DOES own a matching, enabled, in-scope skill — so a refusal can only be the
    // permission check, not a missing skill.
    await createSkill(db, newSkillFor(userId, { title: "Blocked skill", scope: "all" }), dek);

    const tool = createGetSkillTool({ db, keyWrapper });
    const rec = spyRecorder(fixedClock(NOW));
    let fetches = 0;
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      executeTool: async (call: AgentCall, connection: AgentConnection) => {
        fetches += 1;
        return tool.handle(call.params, connection);
      },
    });

    const call: AgentCall = {
      connector: null,
      tool: "get_skill",
      makesChange: false,
      params: { title: "Blocked skill" },
    };
    const outcome = expectRefused(await pipeline.handleAgentCall(conn, call));

    assert.ok(outcome.reason.length > 0, "the refusal carries a plain reason");
    assert.equal(fetches, 0, "a denied call NEVER reaches the skill fetch");
    assert.equal(rec.inputs.length, 1, "the denial is still recorded (one Warthog entry)");
    assert.equal(rec.inputs[0].source, "warthog", "Warthog writes the record itself");
  } finally {
    await db.close();
  }
});

// --- small helpers ----------------------------------------------------------------

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
