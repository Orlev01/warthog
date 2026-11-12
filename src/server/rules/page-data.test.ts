// E12-S15 — Rules read for the page (list-all) (`src/server/rules/page-data.ts`).
//
// RED-first: the module under test does NOT exist yet, so importing `./page-data`
// throws and every test here fails until the builder writes it. That absence IS the
// point of test-first — do NOT implement anything to make these pass; the builder
// writes `page-data.ts` (and whatever list-all storage primitive it needs) afterwards.
//
// These tests pin BEHAVIOUR (what the read returns: which rules, each rendered as its
// English sentence, with its scope and lifecycle status, scoped to whom, parameterised)
// — never the source text of the module or any SQL. A later rename that preserves
// behaviour must not redden them. The sentence is asserted by calling the REAL
// `ruleSentence` on the same rule content, so the two track together and no wording is
// hard-coded here.
//
// WHY this exists (design §8, brief "Rules and approvals"): the Rules page needs ONE
// owner-scoped list-ALL read — every rule the person has written, ACTIVE and PAUSED —
// each rendered back to its exact plain-English sentence with its scope (all agents or a
// chosen agent). It is DISTINCT from the policy engine's `listRules` / `applicableRules`
// (which return only ACTIVE rules for enforcement): the page must also show the paused
// ones so the person can see and resume them. It is for the OWNER and NEVER returns
// another person's rules. A rule's `condition` is PERSONAL CONTENT stored DEK-encrypted
// by the rules store, so this read decrypts it under the INJECTED per-person DEK (it
// holds no key and reads no `process.env`) before rendering the sentence.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // One rule as the Rules page shows it.
//   interface RulesPageItem {
//     id: string;
//     sentence: string;                 // ruleSentence(rule) — the exact English sentence
//     scope: RuleScope;                 // { type: "any_agent" }
//                                        //   | { type: "agent"; agentId; name }
//     status: "active" | "paused";      // so paused rules are distinguishable in the UI
//   }
//
//   rulesPageData(db, userId, dek): Promise<RulesPageItem[]>
//     • Lists ALL of `userId`'s rules — ACTIVE and PAUSED — each rendered as its plain
//       English sentence (its DEK-encrypted condition decrypted under the injected `dek`
//       first), carrying its scope (all agents or the chosen agent's id + name) and its
//       lifecycle status. Member-scoped by the `userId` the caller passes (the session's
//       id, never a client value): another person's rules are never returned. The user
//       id is bound as a parameter (no spliced SQL).
//
// Acceptance criteria → tests:
//   AC1 "Lists all of the owner's rules (active and paused), each rendered as its plain
//        English sentence, with its scope (all agents or chosen agents)."
//   AC2 "A user never receives another user's rules."
//   AC3 [obligation:validate-and-parameterize-input] — a handler rejects malformed /
//        oversized input with a 4xx (nothing reaches a query); the user id is bound as a
//        parameter and a SQL-injection probe in an input field travels as data and cannot
//        alter a query. The handler is a test fixture (the intended usage), not an
//        implementation file.
//   AC4 [obligation:secrets-from-env] — the read runs from its INJECTED deps alone (db,
//        userId, dek): no secret, no ambient config; the condition decrypts only under the
//        injected DEK, so a different DEK cannot read it back (the key is injected, not
//        baked in).
//
// Every real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`, so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { rulesPageData } from "./page-data";
import { createRule, pauseRule } from "../db/rules";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { parseBody, HttpError } from "../http/validate";
import { ruleSentence } from "../../domain/rules/rules";
import type { Db } from "../db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this read only ever receives the already-unwrapped bytes (like the store).
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque; this read never unwraps it — it takes
// the already-unwrapped dek directly).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no
// rows and satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// ===========================================================================
// AC1 — all of the owner's rules (ACTIVE and PAUSED), each rendered as its sentence,
// each with its scope (all agents or a chosen agent).
// ===========================================================================

test("rulesPageData lists all of the owner's rules — active AND paused — each as its sentence with its scope", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    // An all-agents ask_first rule (active).
    const r1 = await createRule(
      db,
      {
        userId,
        kind: "ask_first",
        scope: { type: "any_agent" },
        action: { type: "send_message", channel: "email" },
      },
      dek,
    );

    // A chosen-agent never_allow rule WITH a condition (active) — exercises decryption,
    // and the condition must round-trip so the full sentence can be rendered.
    const shopId = randomUUID();
    const r2 = await createRule(
      db,
      {
        userId,
        kind: "never_allow",
        scope: { type: "agent", agentId: shopId, name: "Shopping Agent" },
        action: { type: "card_request" },
        condition: { type: "merchant_not_in", merchants: ["Woolworths", "Coles"] },
      },
      dek,
    );

    // Two more, then PAUSE them — so a correct list-all includes paused rules (the
    // enforcement reads `listRules`/`applicableRules` would wrongly drop these).
    const r3 = await createRule(
      db,
      {
        userId,
        kind: "ask_first",
        scope: { type: "any_agent" },
        action: { type: "high_tier_request" },
      },
      dek,
    );
    await pauseRule(db, userId, r3.id);

    const researchId = randomUUID();
    const r4 = await createRule(
      db,
      {
        userId,
        kind: "never_allow",
        scope: { type: "agent", agentId: researchId, name: "Research Agent" },
        action: { type: "specific_tool", tool: "gmail__send" },
      },
      dek,
    );
    await pauseRule(db, userId, r4.id);

    const page = await rulesPageData(db, userId, dek);
    const byId = new Map(page.map((item) => [item.id, item]));

    // Every rule — ACTIVE and PAUSED — is listed.
    for (const r of [r1, r2, r3, r4]) {
      assert.ok(byId.has(r.id), `rule ${r.id} is listed`);
    }
    assert.equal(page.length, 4, "all four rules (two active, two paused) are listed");

    // Each is rendered as its EXACT ruleSentence (the real renderer, on the same rule).
    assert.equal(byId.get(r1.id)!.sentence, ruleSentence(r1), "an all-agents rule renders as its sentence");
    assert.equal(byId.get(r2.id)!.sentence, ruleSentence(r2), "a conditioned rule renders its full sentence (condition decrypted)");
    assert.equal(byId.get(r3.id)!.sentence, ruleSentence(r3), "a paused rule still renders as its sentence");
    assert.equal(byId.get(r4.id)!.sentence, ruleSentence(r4), "a paused chosen-agent rule renders as its sentence");

    // Status distinguishes active from paused so the page can show which are paused.
    assert.equal(byId.get(r1.id)!.status, "active", "r1 is active");
    assert.equal(byId.get(r2.id)!.status, "active", "r2 is active");
    assert.equal(byId.get(r3.id)!.status, "paused", "r3 is paused");
    assert.equal(byId.get(r4.id)!.status, "paused", "r4 is paused");

    // Scope — all agents vs a chosen agent (with its id and name).
    assert.deepEqual(byId.get(r1.id)!.scope, { type: "any_agent" }, "an all-agents rule's scope is 'any_agent'");
    assert.deepEqual(
      byId.get(r2.id)!.scope,
      { type: "agent", agentId: shopId, name: "Shopping Agent" },
      "a chosen-agent rule's scope carries the agent id and name",
    );
    assert.deepEqual(
      byId.get(r4.id)!.scope,
      { type: "agent", agentId: researchId, name: "Research Agent" },
      "a paused chosen-agent rule's scope carries the agent id and name",
    );
  } finally {
    await db.close();
  }
});

test("rulesPageData returns a paused rule even when it is the person's ONLY rule", async () => {
  // Guards against an implementation that reuses the active-only enforcement read: a lone
  // paused rule must still appear on the page.
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-lone-paused");
    const dek = freshDek();

    const only = await createRule(
      db,
      {
        userId,
        kind: "ask_first",
        scope: { type: "any_agent" },
        action: { type: "any_change" },
      },
      dek,
    );
    await pauseRule(db, userId, only.id);

    const page = await rulesPageData(db, userId, dek);
    assert.equal(page.length, 1, "the lone paused rule is listed");
    assert.equal(page[0]!.id, only.id, "it is the paused rule");
    assert.equal(page[0]!.status, "paused", "it is marked paused");
    assert.equal(page[0]!.sentence, ruleSentence(only), "it renders as its sentence");
  } finally {
    await db.close();
  }
});

test("rulesPageData returns an empty list for a person with no rules", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const page = await rulesPageData(db, userId, freshDek());
    assert.deepEqual(page, [], "no rules → an empty list, not an error");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a person NEVER receives another person's rules (active or paused).
// ===========================================================================

test("rulesPageData returns only the owner's rules — never another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const dekA = freshDek();
    const dekB = freshDek();

    const aliceActive = await createRule(
      db,
      { userId: alice, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "any_change" } },
      dekA,
    );
    const alicePaused = await createRule(
      db,
      { userId: alice, kind: "never_allow", scope: { type: "any_agent" }, action: { type: "card_request" } },
      dekA,
    );
    await pauseRule(db, alice, alicePaused.id);

    const bobActive = await createRule(
      db,
      { userId: bob, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "any_change" } },
      dekB,
    );
    const bobPaused = await createRule(
      db,
      { userId: bob, kind: "never_allow", scope: { type: "any_agent" }, action: { type: "card_request" } },
      dekB,
    );
    await pauseRule(db, bob, bobPaused.id);

    // Alice's page: both of Alice's ids, neither of Bob's.
    const aliceIds = (await rulesPageData(db, alice, dekA)).map((i) => i.id);
    assert.ok(aliceIds.includes(aliceActive.id), "Alice sees her active rule");
    assert.ok(aliceIds.includes(alicePaused.id), "Alice sees her paused rule");
    assert.ok(!aliceIds.includes(bobActive.id), "Alice never sees Bob's active rule");
    assert.ok(!aliceIds.includes(bobPaused.id), "Alice never sees Bob's paused rule");

    // Bob's page: both of Bob's ids, neither of Alice's.
    const bobIds = (await rulesPageData(db, bob, dekB)).map((i) => i.id);
    assert.ok(bobIds.includes(bobActive.id), "Bob sees his active rule");
    assert.ok(bobIds.includes(bobPaused.id), "Bob sees his paused rule");
    assert.ok(!bobIds.includes(aliceActive.id), "Bob never sees Alice's active rule");
    assert.ok(!bobIds.includes(alicePaused.id), "Bob never sees Alice's paused rule");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 [obligation:validate-and-parameterize-input] (INV-102)
//
// A route handler validates the request HERE (`parseBody`), then reads the page for the
// SESSION's user id — NEVER a value from the request body. A rejected input maps to a 4xx
// Response and never reaches a query. The user id is bound as a parameter (no spliced
// SQL). This handler is a test fixture that EXERCISES the modules — not an implementation
// file.
// ===========================================================================

function rulesHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body is OPTIONAL and the only member scope is the SESSION's id — a `userId` in
  // the body is accepted by the shape but IGNORED (it must never widen the scope). The
  // size cap keeps an absurd body out before it is parsed.
  const schema = z.object({ userId: z.string().max(256).optional() });
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const page = await rulesPageData(db, sessionUserId, dek);
      return new Response(JSON.stringify({ ruleIds: page.map((i) => i.id) }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("rulesPageData binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'; DROP TABLE rules; --";

  const page = await rulesPageData(db, probe, freshDek());
  assert.deepEqual(page, [], "the recording db returns no rows, so the page is empty");

  assert.ok(db.calls.length >= 1, "the read issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = rulesHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = rulesHandler(db, freshDek(), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ filler: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler reads the SESSION user's rules and ignores a user id supplied in the body", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice");
    const bob = await makeUser(db, "handler-bob");
    const dekA = freshDek();
    const dekB = freshDek();

    const aliceRule = await createRule(
      db,
      { userId: alice, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "any_change" } },
      dekA,
    );
    const bobRule = await createRule(
      db,
      { userId: bob, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "any_change" } },
      dekB,
    );

    // The handler is Alice's session; the body tries to pass BOB's id.
    const handler = rulesHandler(db, dekA, alice);
    const res = await handler(jsonRequest(JSON.stringify({ userId: bob })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { ruleIds } = (await res.json()) as { ruleIds: string[] };
    assert.ok(ruleIds.includes(aliceRule.id), "the handler reads the session (Alice's) rules");
    assert.ok(!ruleIds.includes(bobRule.id), "the body's user id is ignored — never widens the scope");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a rule's text round-trips through the read as inert data", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const agentId = randomUUID();
    // A plaintext-metadata field (the chosen agent's name) and an encrypted field (the
    // condition's address) both carry a SQL-shaped value; neither may alter a query.
    const evilName = "evil'); DROP TABLE rules; --";
    const created = await createRule(
      db,
      {
        userId,
        kind: "ask_first",
        scope: { type: "agent", agentId, name: evilName },
        action: { type: "send_message", channel: "chat" },
        condition: { type: "recipient_is", address: "x'); DROP TABLE rules; --@evil.example" },
      },
      dek,
    );

    const page = await rulesPageData(db, userId, dek);

    assert.equal(await tableExists(db, "rules"), true, "the rules table survives the read (the probe is data, not SQL)");
    const item = page.find((i) => i.id === created.id)!;
    assert.ok(item, "the rule is read back");
    assert.deepEqual(
      item.scope,
      { type: "agent", agentId, name: evilName },
      "the probe agent name round-trips verbatim in the scope",
    );
    assert.equal(item.sentence, ruleSentence(created), "the sentence (built from the probe name + condition) round-trips");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:secrets-from-env] — the read runs from its INJECTED deps alone (db,
// userId, dek): no secret, no ambient config; the condition decrypts only under the
// injected DEK, so a different DEK cannot read it back (the key is injected, not baked
// in).
// ===========================================================================

test("rulesPageData runs from injected deps alone: no secret and no ambient configuration", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-secrets");
    const dek = freshDek();
    const created = await createRule(
      db,
      { userId, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "any_change" } },
      dek,
    );

    // Only db / userId / dek — no connection string, no key read from env.
    const page = await rulesPageData(db, userId, dek);

    assert.ok(page.some((i) => i.id === created.id), "the page reads with no secret or env handed to it");
  } finally {
    await db.close();
  }
});

test("rulesPageData cannot decrypt a rule's condition with a different DEK (the key is injected, not baked in)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-wrongdek");
    const realDek = freshDek();
    await createRule(
      db,
      {
        userId,
        kind: "never_allow",
        scope: { type: "any_agent" },
        action: { type: "send_message", channel: "email" },
        condition: { type: "recipient_is", address: "ceo@example.com" },
      },
      realDek,
    );

    const wrongDek = freshDek();
    await assert.rejects(
      () => rulesPageData(db, userId, wrongDek),
      "a DEK that did not encrypt the condition cannot read it back",
    );
  } finally {
    await db.close();
  }
});

// UI/UX follow-up: the Rules page names a tool by its title and a service by its catalogue
// name. The labels are injected (the page builds them from the tool registry and the
// catalogue); without them, and for an id they don't know, the id is shown as it is.
test("rulesPageData names tools and services through the injected display labels, falling back to the id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "labels");
    const dek = freshDek();
    for (const action of [
      { type: "specific_tool", tool: "create_task" },
      { type: "service_tool", service: "google-gmail" },
      { type: "specific_tool", tool: "retired_tool" },
    ] as const) {
      await createRule(db, { userId, kind: "ask_first", scope: { type: "any_agent" }, action }, dek);
    }
    const labels = {
      toolTitle: (tool: string) => (tool === "create_task" ? "Create a task" : undefined),
      serviceName: (service: string) => (service === "google-gmail" ? "Gmail" : undefined),
    };
    const labelled = (await rulesPageData(db, userId, dek, undefined, labels)).map((item) => item.sentence).sort();
    assert.deepEqual(labelled, [
      "Ask me before any agent uses Create a task",
      "Ask me before any agent uses any Gmail tool",
      "Ask me before any agent uses retired_tool",
    ]);
    const plain = (await rulesPageData(db, userId, dek)).map((item) => item.sentence).sort();
    assert.deepEqual(plain, [
      "Ask me before any agent uses any google-gmail tool",
      "Ask me before any agent uses create_task",
      "Ask me before any agent uses retired_tool",
    ]);
  } finally {
    await db.close();
  }
});
