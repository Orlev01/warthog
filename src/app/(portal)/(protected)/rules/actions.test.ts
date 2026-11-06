// E12-S17 — Rules page actions (`src/app/(portal)/(protected)/rules/actions.ts`).
//
// RED-first: the rules dir holds only a placeholder `page.tsx`; `./actions` does NOT
// exist yet, so importing it throws and every test here fails until the builder adds
// it. That absence IS the point of test-first — do NOT implement anything to make
// these pass. The builder adds `actions.ts` afterwards as the minimum code that turns
// these green.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file
// may export ONLY its framework fields, so the injectable, unit-testable seam — the
// `createRulesActions(deps)` factory AND the FormData→rule mapping the create form's
// server action uses — cannot live there without breaking `next build`. The thin
// protected-page loader renders the Rules screen; the testable logic lives in this
// plain sibling (the convention's `createXActions(deps)` factory, the same shape as
// `createInboxActions`). These tests drive the factory directly against an isolated
// in-memory PGlite with the REAL migrations (`@/test/db`), the REAL rules store, a
// real `KeyWrapper`, and the validation boundary. No test asserts on the source text
// of any module, so a later behaviour-preserving refactor (a rename, a moved import)
// stays green.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   createRulesActions(deps: { db: Db; clock: Clock; keyWrapper: KeyWrapper }): {
//     load(session):                      Promise<{ rules; agents; currency? }>   // read (page.test.tsx)
//     createRule(session, input):         Promise<{ ok:true } | { ok:false; reason }>
//     updateRule(session, id, input):     Promise<{ ok:true } | { ok:false; reason }>
//     pauseRule(session, id):             Promise<{ ok:true } | { ok:false; reason }>
//     deleteRule(session, id):            Promise<{ ok:true } | { ok:false; reason }>
//   }
//
//   ruleInputFromForm(formData): the pure FormData→rule mapping the create form's
//     server action runs before createRule (the brief's own field vocabulary). Reads
//     the NAMED fields the rule form carries: `rule-template`, `rule-action`,
//     `rule-channel` (a message channel), `rule-target` (a tool or service name),
//     `rule-condition` + `rule-condition-detail`, and `rule-scope`.
//
//   • Every method takes the person's VERIFIED Session and derives the acting user id
//     from `session.userId` — never a client-supplied value (CLAUDE.md member scope /
//     design §5). So one person can never create under, change, or delete another's
//     rule by id: a rule that is not theirs resolves to no row and the call is refused
//     ({ ok:false }), never a silent success and never a 500.
//   • createRule VALIDATES the action + condition against the brief's vocabulary
//     (ask_first/never_allow over the six actions, with an optional condition) before
//     a row is written: an unknown action or a malformed/oversized condition is
//     rejected at the boundary with a 4xx `HttpError`, and nothing is stored.
//   • A mis-shaped rule id (not a well-formed uuid — see the NOTE below) is rejected at
//     the boundary with a 4xx for update/pause/delete, never cast at `WHERE id = $1`
//     (OBS-049, INV-102).
//
// ─── Obligations (this task's cross-cutting invariants, as behaviour) ─────────────────
//   [obligation:validate-and-parameterize-input] (INV-102) — malformed/oversized input
//     is rejected with a 4xx; a SQL-injection probe in an input field travels as a
//     BOUND value (it is stored verbatim as data and never concatenated into the SQL).
//   [obligation:secrets-from-env] (INV-103) — the actions run purely from their injected
//     seams and read no `process.env`, so a decoy env secret never lands in a result or
//     in stored rule content.
//
// NOTE on the acceptance-criteria wording "a rule id that is not a positive integer":
// that is the obligation's GENERIC template phrasing. In THIS codebase the rules table
// keys on a `uuid` (the store's createRule generates `randomUUID()`), and the sibling
// inbox/security actions already validate ids as `z.uuid()`. So the real boundary shape
// here is a well-formed UUID, and these tests pin exactly that: a value that is not a
// well-formed UUID is rejected with a 4xx — the same OBS-049 defence the "positive
// integer" phrasing stands in for. (Noted for the build.)
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()`, so
// tests share no state. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRulesActions, ruleInputFromForm } from "./actions";

import { listAllRules } from "@/server/db/rules";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { ruleSentence } from "@/domain/rules/rules";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db, QueryResult } from "@/server/db/index";

// --- shapes derived from the factory's own signature, so a later type rename that
// preserves behaviour does not redden these tests. ------------------------------------
type RulesActions = ReturnType<typeof createRulesActions>;
type ActionResult = Awaited<ReturnType<RulesActions["createRule"]>>;

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// A frozen instant the actions read time through. Mid-month noon UTC.
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper` (the resolution
// path the actions use: getUserById + keyWrapper.unwrap), returning their id and the
// DEK their rule conditions are encrypted under — so a test can read their rules back.
async function makePerson(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { userId: user.id, dek };
}

function makeActions(db: Db, keyWrapper: KeyWrapper, clock: Clock = fixedClock(NOW)): RulesActions {
  return createRulesActions({ db, clock, keyWrapper });
}

async function sessionFor(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock: fixedClock(NOW), random: systemRandom });
  return created.session;
}

// A valid ask-first send-message rule (any-agent scope), the default the form posts.
// Built fresh each call so an "unknown action" override cannot leak between tests.
function validInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "ask_first",
    scope: { type: "any_agent" },
    action: { type: "send_message", channel: "email" },
    ...overrides,
  };
}

// Narrowers (assert.fail is `never`, so the result narrows after).
function expectOk(r: ActionResult, label: string) {
  if (!r.ok) assert.fail(`${label}: expected success, got refusal "${r.reason}"`);
  return r;
}
function expectRefused(r: ActionResult, label: string) {
  if (r.ok) assert.fail(`${label}: expected a refusal, got success`);
  assert.ok(r.reason.length > 0, `${label}: the refusal carries a plain reason`);
  return r;
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary).
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      err.status >= 400 && err.status < 500,
      `${label}: the rejection must carry a 4xx status, got ${err.status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// The person's rules (active + paused), decrypted — a direct read-back independent of
// the loader, so "what was stored" is checked at the store, not through a render.
async function rulesOf(db: Db, userId: string, dek: Uint8Array) {
  return listAllRules(db, userId, dek);
}

// Build a real FormData the way the browser posts the create form, carrying the
// task's NAMED fields. Only the fields a given state needs are appended.
function formOf(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [name, value] of Object.entries(fields)) fd.append(name, value);
  return fd;
}

// =====================================================================================
// AC6 — the FormData→rule mapping, driven by a REAL FormData. Submitting the /rules
// form in its DEFAULT state (Ask me first + Send a message + Any time) with a message
// channel filled in maps to an ask-first send-message, any-agent rule with no condition.
// =====================================================================================

test("ruleInputFromForm maps the default /rules form (Ask me first + Send a message + Any time) to an ask-first send-message rule", () => {
  const fd = formOf({
    "rule-template": "ask_first",
    "rule-action": "send_message",
    "rule-channel": "email",
    "rule-condition": "none",
    "rule-scope": "any_agent",
  });

  const input = ruleInputFromForm(fd);

  assert.equal(input.kind, "ask_first", "the template maps to the ask_first kind");
  assert.deepEqual(input.scope, { type: "any_agent" }, "the default scope is all agents");
  assert.deepEqual(
    input.action,
    { type: "send_message", channel: "email" },
    "a send-message action carries the chosen channel from the named channel field",
  );
  assert.equal(input.condition, undefined, "the 'Any time' condition maps to no condition");
});

test("ruleInputFromForm reads the named channel, tool-or-service and condition-detail fields", () => {
  // A chat-channel send-message.
  assert.deepEqual(
    ruleInputFromForm(
      formOf({
        "rule-template": "never_allow",
        "rule-action": "send_message",
        "rule-channel": "chat",
        "rule-condition": "none",
        "rule-scope": "any_agent",
      }),
    ).action,
    { type: "send_message", channel: "chat" },
    "the channel field drives the message channel",
  );

  // A specific tool — the tool-or-service field is the tool name.
  assert.deepEqual(
    ruleInputFromForm(
      formOf({
        "rule-template": "ask_first",
        "rule-action": "specific_tool",
        "rule-target": "send_email",
        "rule-condition": "none",
        "rule-scope": "any_agent",
      }),
    ).action,
    { type: "specific_tool", tool: "send_email" },
    "a specific-tool action reads the tool name from the tool-or-service field",
  );

  // Any tool of a service — the SAME field is the service name.
  assert.deepEqual(
    ruleInputFromForm(
      formOf({
        "rule-template": "ask_first",
        "rule-action": "service_tool",
        "rule-target": "gmail",
        "rule-condition": "none",
        "rule-scope": "any_agent",
      }),
    ).action,
    { type: "service_tool", service: "gmail" },
    "a service action reads the service name from the tool-or-service field",
  );

  // A recipient-is condition reads its address from the condition-detail field.
  assert.deepEqual(
    ruleInputFromForm(
      formOf({
        "rule-template": "ask_first",
        "rule-action": "send_message",
        "rule-channel": "email",
        "rule-condition": "recipient_is",
        "rule-condition-detail": "manager@example.com",
        "rule-scope": "any_agent",
      }),
    ).condition,
    { type: "recipient_is", address: "manager@example.com" },
    "a recipient condition reads its address from the condition-detail field",
  );

  // An amount-over condition reads its figure as a NUMBER from the condition-detail field.
  assert.deepEqual(
    ruleInputFromForm(
      formOf({
        "rule-template": "ask_first",
        "rule-action": "card_request",
        "rule-condition": "amount_over",
        "rule-condition-detail": "500",
        "rule-scope": "any_agent",
      }),
    ).condition,
    { type: "amount_over", amount: 500 },
    "an amount condition reads its figure as a number from the condition-detail field",
  );
});

test("submitting the default /rules form stores the rule under the session user", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);

    const fd = formOf({
      "rule-template": "ask_first",
      "rule-action": "send_message",
      "rule-channel": "email",
      "rule-condition": "none",
      "rule-scope": "any_agent",
    });

    expectOk(await actions.createRule(session, ruleInputFromForm(fd)), "create from the default form");

    const rules = await rulesOf(db, alice.userId, alice.dek);
    assert.equal(rules.length, 1, "the submitted form stores exactly one rule");
    const stored = rules[0]!;
    assert.equal(stored.status, "active", "a newly created rule is active");
    assert.equal(
      ruleSentence(stored),
      "Ask me before any agent sends email",
      "the stored rule reads back as the default ask-first send-email sentence",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — createRule validates the action/condition against the brief's vocabulary and
// stores a valid rule under the SESSION user (never another person's).
// =====================================================================================

test("createRule stores a valid rule under the session user and never another person's", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const actions = makeActions(db, keyWrapper);

    expectOk(
      await actions.createRule(
        await sessionFor(db, alice.userId),
        validInput({
          action: { type: "send_message", channel: "email" },
          condition: { type: "recipient_is", address: "manager@example.com" },
        }),
      ),
      "alice creates a rule",
    );

    const aliceRules = await rulesOf(db, alice.userId, alice.dek);
    assert.equal(aliceRules.length, 1, "the rule is stored for the acting (session) user");
    assert.equal(
      ruleSentence(aliceRules[0]!),
      "Ask me before any agent sends email to manager@example.com",
      "the condition is persisted and reads back in the sentence",
    );

    const bobRules = await rulesOf(db, bob.userId, bob.dek);
    assert.equal(bobRules.length, 0, "the rule is never created under another person's id");
  } finally {
    await db.close();
  }
});

test("createRule rejects an unknown action with a 4xx and stores nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);

    await assertRejects4xx("unknown action", () =>
      actions.createRule(session, validInput({ action: { type: "delete_everything" } })),
    );
    await assertRejects4xx("unknown kind", () =>
      actions.createRule(session, validInput({ kind: "auto_approve" })),
    );

    assert.equal((await rulesOf(db, alice.userId, alice.dek)).length, 0, "a rejected rule is never stored");
  } finally {
    await db.close();
  }
});

test("createRule rejects a malformed condition with a 4xx and stores nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);

    // An amount condition whose figure is not a number.
    await assertRejects4xx("non-numeric amount", () =>
      actions.createRule(
        session,
        validInput({ action: { type: "card_request" }, condition: { type: "amount_over", amount: "heaps" } }),
      ),
    );
    // A recipient condition with an empty address.
    await assertRejects4xx("empty recipient", () =>
      actions.createRule(session, validInput({ condition: { type: "recipient_is", address: "" } })),
    );
    // A condition type outside the brief's vocabulary.
    await assertRejects4xx("unknown condition", () =>
      actions.createRule(session, validInput({ condition: { type: "when_i_feel_like_it" } })),
    );

    assert.equal((await rulesOf(db, alice.userId, alice.dek)).length, 0, "no malformed rule is stored");
  } finally {
    await db.close();
  }
});

test("createRule rejects oversized input with a 4xx (a tool name that is a payload, not a name)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);

    await assertRejects4xx("oversized tool name", () =>
      actions.createRule(
        session,
        validInput({ action: { type: "specific_tool", tool: "a".repeat(1_000_000) } }),
      ),
    );

    assert.equal((await rulesOf(db, alice.userId, alice.dek)).length, 0, "an oversized rule is never stored");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Member scope / ownership (CLAUDE.md: userId from the session; every member-scoped
// task has an ownership test) — a signed-in user can NEVER change or delete ANOTHER
// user's rule by id. Each attempt is refused and the owner's rule is left untouched.
// =====================================================================================

test("a signed-in user cannot update, pause or delete another user's rule by id", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const owner = await makePerson(db, keyWrapper, "owner");
    const intruder = await makePerson(db, keyWrapper, "intruder");
    const actions = makeActions(db, keyWrapper);

    expectOk(
      await actions.createRule(await sessionFor(db, owner.userId), validInput()),
      "owner creates a rule",
    );
    const ownersRule = (await rulesOf(db, owner.userId, owner.dek))[0]!;
    const intruderSession = await sessionFor(db, intruder.userId);

    // The intruder, by the owner's rule id, is refused on every mutation.
    expectRefused(
      await actions.updateRule(intruderSession, ownersRule.id, validInput({ kind: "never_allow" })),
      "intruder update",
    );
    expectRefused(await actions.pauseRule(intruderSession, ownersRule.id), "intruder pause");
    expectRefused(await actions.deleteRule(intruderSession, ownersRule.id), "intruder delete");

    // The owner's rule is exactly as it was: present, active, unchanged content.
    const after = await rulesOf(db, owner.userId, owner.dek);
    assert.equal(after.length, 1, "the owner's rule is never removed by a non-owner");
    assert.equal(after[0]!.status, "active", "the owner's rule is never paused by a non-owner");
    assert.equal(after[0]!.kind, "ask_first", "the owner's rule content is never changed by a non-owner");

    // The intruder's own view holds nothing — nothing was created under their id either.
    assert.equal((await rulesOf(db, intruder.userId, intruder.dek)).length, 0, "nothing leaks to the intruder");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — a mis-shaped rule id (not a well-formed
// UUID; see the NOTE at the top on the "positive integer" wording) is rejected at the
// validation boundary with a 4xx for update/pause/delete, and never reaches a query as a
// cast. A SQL-shaped id is likewise rejected here, never bound into a running query.
// =====================================================================================

test("a mis-shaped rule id is rejected with a 4xx at the boundary (update/pause/delete)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);

    for (const bad of ["not-a-uuid-at-all", "42", "'; DROP TABLE rules; --"]) {
      await assertRejects4xx(`updateRule(${bad})`, () => actions.updateRule(session, bad, validInput()));
      await assertRejects4xx(`pauseRule(${bad})`, () => actions.pauseRule(session, bad));
      await assertRejects4xx(`deleteRule(${bad})`, () => actions.deleteRule(session, bad));
    }

    // The table is intact and empty — no cast ran and no injected statement executed.
    assert.equal((await rulesOf(db, alice.userId, alice.dek)).length, 0, "no mis-shaped id altered the store");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// update / pause / delete happy paths over an OWNED rule.
// =====================================================================================

test("updateRule replaces an owned rule's content; pauseRule pauses it; deleteRule removes it", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);

    expectOk(await actions.createRule(session, validInput()), "create");
    const id = (await rulesOf(db, alice.userId, alice.dek))[0]!.id;

    // Update — a full content replace to a never-allow make-any-change rule.
    expectOk(
      await actions.updateRule(
        session,
        id,
        validInput({ kind: "never_allow", action: { type: "any_change" } }),
      ),
      "update",
    );
    const updated = (await rulesOf(db, alice.userId, alice.dek))[0]!;
    assert.equal(
      ruleSentence(updated),
      "Never allow any agent to make any change",
      "the rule's content is replaced in place",
    );

    // Pause — the rule persists but is marked paused (still returned by listAllRules).
    expectOk(await actions.pauseRule(session, id), "pause");
    assert.equal((await rulesOf(db, alice.userId, alice.dek))[0]!.status, "paused", "the rule is paused");

    // Delete — the rule is removed.
    expectOk(await actions.deleteRule(session, id), "delete");
    assert.equal((await rulesOf(db, alice.userId, alice.dek)).length, 0, "the rule is removed");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — a SQL-injection probe in a rule field
// travels as a BOUND value: it is stored verbatim as DATA (the table is not dropped and
// the value round-trips unchanged) and never appears concatenated into the SQL text.
// Proven with a recording proxy over a real db that passes queries through while
// capturing text + values.
// =====================================================================================

interface RecordingProxy extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingProxy(real: Db): RecordingProxy {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close(): Promise<void> {
      return real.close();
    },
  };
}

test("a SQL-injection probe in a rule field is bound and stored as data, never altering a query", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);

    const proxy = recordingProxy(db);
    const actions = createRulesActions({ db: proxy, clock: fixedClock(NOW), keyWrapper });

    // The probe rides a plaintext-bound field (the tool name inside the action jsonb).
    const PROBE = "'; DROP TABLE rules; -- send_email";
    expectOk(
      await actions.createRule(
        session,
        validInput({ action: { type: "specific_tool", tool: PROBE } }),
      ),
      "createRule with a SQL probe in the tool name",
    );

    // Stored verbatim as DATA: the table still exists and the value round-trips unchanged.
    const rules = await rulesOf(db, alice.userId, alice.dek);
    assert.equal(rules.length, 1, "the rule was stored (the table was not dropped)");
    assert.deepEqual(
      rules[0]!.action,
      { type: "specific_tool", tool: PROBE },
      "the probe is stored verbatim as data, not executed",
    );

    // Every captured query bound its values; the probe and the user id travel as BOUND
    // values, never spliced into the SQL text.
    assert.ok(proxy.calls.length >= 1, "the action issues at least one member-scoped query");
    const allValues = proxy.calls.flatMap((c) => c.values);
    assert.ok(
      allValues.some((v) => typeof v === "string" && v.includes(PROBE)),
      "the probe travels as a bound value (inside the action json)",
    );
    assert.ok(allValues.includes(alice.userId), "the acting user id travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes(PROBE), "the probe is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:secrets-from-env] — the actions run purely from their injected seams and
// read no `process.env`: a decoy secret set in the environment never appears in a result
// or in stored rule content. (Config reaches the actions only as injected seams.)
// =====================================================================================

test("the actions read no process.env: a decoy env secret never appears in a result or stored content", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_rules";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = makeActions(db, keyWrapper);

    const created = await actions.createRule(session, validInput());
    assert.equal(created.ok, true, "the action works purely from its injected seams");
    assert.ok(!JSON.stringify(created).includes(DECOY), "no ambient env value is folded into the result");

    const stored = await rulesOf(db, alice.userId, alice.dek);
    assert.ok(!JSON.stringify(stored).includes(DECOY), "no ambient env value is folded into stored rule content");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
