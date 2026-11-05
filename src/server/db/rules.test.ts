// E07-S06 — Rules store (`src/server/db/rules.ts`, `db/migrations/0014_rules.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./rules` throws and `freshDb()` has no `rules` table — every test here
// fails until the builder adds them. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes the module and the
// migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: a rule round-trips,
// what `list` and `applicableRules` return, who may read/change what, that condition
// values are encrypted at rest, what a handler rejects, that every value is bound as a
// parameter), never the source text of the module or the SQL file — a later rename
// that preserves behaviour must not redden them.
//
// WHY this exists (design §8 policy engine, brief "Rules and approvals"): a rule is a
// plain-language `ask_first` or `never_allow` instruction scoped to all agents or a
// chosen agent (the domain model + `ruleSentence` already live in
// `src/domain/rules/rules.ts`, E03-S04). This store persists them and reads back the
// ones APPLICABLE to a connection and action so the policy engine (§8 steps 3 & 6) can
// evaluate the never-allow and ask-first rules on every agent call; the rules screen
// manages them. A rule's CONDITION carries personal content (a recipient address, a
// merchant list), so the condition is stored only DEK-ENCRYPTED (design §4.1, project
// rule: personal content is encrypted with the per-person DEK; the plaintext never
// lands in a column). The kind, scope and action are PLAINTEXT METADATA — needed to
// filter the applicable set — so, like a connection's grants, they are not encrypted.
//
// The scope's `agentId` / the lookup's `connectionId` is an opaque uuid here (the
// connections table is created by a later migration, so — exactly like 0011/0012/0013
// bind agent_id/connection_id — this store binds it by value, with ownership enforced
// by the session's user_id, not a foreign key to a table that does not exist yet).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
// The rule model is the EXISTING pure domain one (`src/domain/rules/rules.ts`), reused
// here (constitution: one-source-of-truth):
//   RuleKind   = "ask_first" | "never_allow"
//   RuleScope  = { type: "any_agent" } | { type: "agent"; agentId; name }
//   RuleAction = send_message{channel} | specific_tool{tool} | service_tool{service}
//              | any_change | card_request | high_tier_request
//   RuleCondition = recipient_is{address} | recipient_in_domain{domain}
//              | amount_over{amount} | merchant_in{merchants} | merchant_not_in{merchants}
//
//   type RuleStatus = "active" | "paused";
//
//   interface NewRule {            // what createRule writes
//     userId: string;              // the person (the session's id, NEVER a client value)
//     kind: RuleKind;
//     scope: RuleScope;
//     action: RuleAction;
//     condition?: RuleCondition;   // optional; stored DEK-encrypted when present
//   }
//   interface RuleEdits {          // the new content updateRule applies (a full replace)
//     kind: RuleKind;
//     scope: RuleScope;
//     action: RuleAction;
//     condition?: RuleCondition;
//   }
//   interface StoredRule extends NewRule {
//     id: string;                  // generated on create
//     status: RuleStatus;          // "active" on create; "paused" after pauseRule
//     condition?: RuleCondition;   // DECRYPTED on read, under the injected DEK
//   }
//
//   createRule(db, input: NewRule, dek): Promise<StoredRule>
//     • inserts an ACTIVE rule for `input.userId`, its condition DEK-encrypted when
//       present, and returns the StoredRule (carrying the generated id).
//   updateRule(db, userId, id, edits: RuleEdits, dek): Promise<StoredRule>
//     • member-scoped: replaces the owned rule's content in place (same id), the
//       condition re-encrypted; returns the updated StoredRule. THROWS (never
//       silently) when no rule with that id belongs to `userId`.
//   pauseRule(db, userId, id): Promise<void>
//     • member-scoped: marks the owned rule paused (it persists, it is not deleted).
//       THROWS when no rule with that id belongs to `userId`.
//   deleteRule(db, userId, id): Promise<boolean>
//     • member-scoped: deletes the owned rule; returns true when a row was removed,
//       false when there was none for `userId` (so another user's delete is a no-op).
//   listRules(db, userId, dek): Promise<StoredRule[]>
//     • the user's ACTIVE rules (member-scoped), conditions decrypted under `dek`.
//   applicableRules(db, userId, connectionId, action, dek): Promise<StoredRule[]>
//     • the user's ACTIVE rules (member-scoped) whose scope covers `connectionId`
//       (any_agent OR that chosen agent) AND whose action matches `action`, conditions
//       decrypted under `dek`. Returns BOTH kinds (never_allow + ask_first) — the
//       policy engine partitions them. A PAUSED rule is excluded.
//
// Acceptance criteria → tests:
//   AC1 "Create/update/pause/delete persist a rule and list returns the user's active
//        rules; a paused rule is excluded from the applicable set." — a round-trip
//        across every rule field; update replaces in place (one row); delete removes it;
//        pause persists the rule but drops it from the applicable set.
//   AC2 "applicableRules(connectionId, action) returns only rules scoped to all agents
//        or that chosen agent, with recipient/merchant condition values decrypted." —
//        any-agent and the chosen agent's rules are returned, another agent's are not;
//        the action filters; both kinds come back; the condition is decrypted.
//   AC3 "A user cannot read or change another user's rules by id (filtered by session
//        user id)." — B's list/applicableRules never shows A's rules; B's
//        update/pause/delete on A's rule id cannot touch it; the user id is bound.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed/oversized/mis-shaped input with a
//        4xx before any query runs; a SQL-injection probe routed through the repo travels
//        as a BOUND value (placeholders, never concatenation) and cannot drop the table.
//        The handler is a test fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the condition is encrypted under the
//        INJECTED DEK, not a baked-in secret: a different DEK cannot read it back; and
//        the repo reads no `process.env` and holds no key (config flows from
//        `src/server/config.ts` alone), so a decoy secret in the environment never lands
//        in a stored or returned rule.
//   Migration: the `rules` relation exists after the project migrations and a second run
//        of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  createRule,
  updateRule,
  pauseRule,
  deleteRule,
  listRules,
  applicableRules,
} from "./rules";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- the pinned shapes, taken from the store's own signatures so a later type rename
// that preserves behaviour does not redden these tests. -----------------------------
type NewRuleInput = Parameters<typeof createRule>[1];
type RuleEdits = Parameters<typeof updateRule>[3];
type StoredRule = Awaited<ReturnType<typeof createRule>>;

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a
// layer up; this repo only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// Agent/connection ids are uuids; use valid uuids so a `uuid` column accepts them. In
// this task the lookup's `connectionId` and a rule scope's `agentId` are the SAME id
// space — "that chosen agent".
const AGENT_X = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AGENT_Y = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AGENT_Z = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// Rule parts (the domain vocabulary), as `as const` literals so each is assignable to
// its discriminated-union member without importing the domain type names.
const ANY_AGENT = { type: "any_agent" } as const;
function agentScope(agentId: string, name = "Claude") {
  return { type: "agent", agentId, name } as const;
}
const SEND_EMAIL = { type: "send_message", channel: "email" } as const;
const CARD_REQUEST = { type: "card_request" } as const;

// A recipient / merchant condition carrying a UNIQUE token, so an at-rest scan for it
// is unambiguous — a raw hit would be a genuine plaintext leak, not a coincidence.
function recipientCondition(token: string) {
  return { type: "recipient_is", address: `manager-${token}@example.com` } as const;
}
function merchantCondition(token: string) {
  return { type: "merchant_in", merchants: [`SecretStore-${token}`, "BoxCo"] } as const;
}

// The rule shape the tester pins. Built via a helper so each test starts from a
// sensible, fully-populated rule and overrides only what it is about — a non-literal
// value passed to createRule, so excess-property checks never bite.
function baseRule(userId: string, overrides: Partial<NewRuleInput> = {}): NewRuleInput {
  return {
    userId,
    kind: "ask_first",
    scope: ANY_AGENT,
    action: SEND_EMAIL,
    ...overrides,
  };
}

// The content for updateRule (no userId — the user is the member scope, bound
// separately). Built the same way so a test overrides only what it changes.
function edits(overrides: Partial<RuleEdits> = {}): RuleEdits {
  return {
    kind: "ask_first",
    scope: ANY_AGENT,
    action: SEND_EMAIL,
    ...overrides,
  };
}

const hasId = (rules: StoredRule[], id: string): boolean => rules.some((r) => r.id === id);
const byId = (rules: StoredRule[], id: string): StoredRule | undefined =>
  rules.find((r) => r.id === id);

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

// How many rule rows exist for one person — proves update changes in place rather than
// inserting, and that delete truly removes. A stored-state assertion (behaviour).
async function ruleRowCount(db: Db, userId: string): Promise<number> {
  const result = await db.query("SELECT count(*) AS n FROM rules WHERE user_id = $1", [userId]);
  return Number(result.rows[0]?.n ?? 0);
}

// ===========================================================================
// AC1 — create stores a rule and returns it; list reads the user's active rules
// back, across every field; update replaces in place; delete removes.
// ===========================================================================

test("createRule stores a rule and returns it with an id, active status and its content", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const input = baseRule(userId, {
      kind: "never_allow",
      scope: agentScope(AGENT_X, "Claude"),
      action: SEND_EMAIL,
      condition: recipientCondition("CREATE1"),
    });

    const saved = await createRule(db, input, freshDek());

    assert.equal(typeof saved.id, "string", "createRule returns an id string");
    assert.ok(saved.id.length > 0, "the returned id is non-empty");
    assert.equal(saved.status, "active", "a freshly created rule is active");
    assert.equal(saved.userId, userId, "the rule belongs to the creating person");
    assert.equal(saved.kind, "never_allow", "the kind is preserved");
    assert.deepEqual(saved.scope, agentScope(AGENT_X, "Claude"), "the scope is preserved");
    assert.deepEqual(saved.action, SEND_EMAIL, "the action is preserved");
  } finally {
    await db.close();
  }
});

test("createRule gives each rule a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = await createRule(db, baseRule(userId), dek);
    const two = await createRule(db, baseRule(userId), dek);
    assert.notEqual(one.id, two.id, "two created rules have different ids");
  } finally {
    await db.close();
  }
});

test("listRules returns the user's active rules with their content and decrypted conditions", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();

    const withCond = await createRule(
      db,
      baseRule(userId, {
        kind: "ask_first",
        scope: ANY_AGENT,
        action: SEND_EMAIL,
        condition: recipientCondition("LIST1"),
      }),
      dek,
    );
    const noCond = await createRule(
      db,
      baseRule(userId, { kind: "never_allow", scope: agentScope(AGENT_X), action: CARD_REQUEST }),
      dek,
    );

    const rules = await listRules(db, userId, dek);
    assert.equal(rules.length, 2, "both of the user's active rules are listed");

    const a = byId(rules, withCond.id);
    assert.ok(a, "the rule with a condition is listed");
    assert.equal(a!.kind, "ask_first", "its kind round-trips");
    assert.deepEqual(a!.scope, ANY_AGENT, "its scope round-trips");
    assert.deepEqual(a!.action, SEND_EMAIL, "its action round-trips");
    assert.deepEqual(
      a!.condition,
      recipientCondition("LIST1"),
      "its recipient condition is decrypted and round-trips verbatim",
    );

    const b = byId(rules, noCond.id);
    assert.ok(b, "the rule without a condition is listed");
    assert.deepEqual(b!.scope, agentScope(AGENT_X), "its chosen-agent scope round-trips");
    assert.deepEqual(b!.action, CARD_REQUEST, "its card-request action round-trips");
    assert.equal(b!.condition ?? undefined, undefined, "a rule with no condition reads back with none");
  } finally {
    await db.close();
  }
});

test("updateRule replaces an owned rule's content in place, keeping its id and re-encrypting the condition", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-update");
    const dek = freshDek();

    const created = await createRule(
      db,
      baseRule(userId, { kind: "ask_first", action: SEND_EMAIL, condition: recipientCondition("OLD") }),
      dek,
    );

    const updated = await updateRule(
      db,
      userId,
      created.id,
      edits({
        kind: "never_allow",
        scope: agentScope(AGENT_Y, "ChatGPT"),
        action: CARD_REQUEST,
        condition: merchantCondition("NEW"),
      }),
      dek,
    );

    assert.equal(updated.id, created.id, "the rule keeps its id across an update");
    assert.equal(updated.kind, "never_allow", "the kind is replaced");
    assert.deepEqual(updated.scope, agentScope(AGENT_Y, "ChatGPT"), "the scope is replaced");
    assert.deepEqual(updated.action, CARD_REQUEST, "the action is replaced");

    const rules = await listRules(db, userId, dek);
    assert.equal(await ruleRowCount(db, userId), 1, "update changes in place — exactly one row remains");
    const reloaded = byId(rules, created.id);
    assert.ok(reloaded, "the updated rule is still listed");
    assert.equal(reloaded!.kind, "never_allow", "the replaced kind is persisted");
    assert.deepEqual(
      reloaded!.condition,
      merchantCondition("NEW"),
      "the new merchant condition is persisted and decrypts back",
    );
  } finally {
    await db.close();
  }
});

test("deleteRule removes a rule from the user's list and reports whether a row was removed", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-delete");
    const dek = freshDek();
    const created = await createRule(db, baseRule(userId), dek);

    assert.ok(hasId(await listRules(db, userId, dek), created.id), "the rule is listed before deletion");

    const removed = await deleteRule(db, userId, created.id);
    assert.equal(removed, true, "deleting an owned rule reports a row was removed");
    assert.equal(hasId(await listRules(db, userId, dek), created.id), false, "the deleted rule is gone from the list");
    assert.equal(await ruleRowCount(db, userId), 0, "and no rule row remains for the user");

    const again = await deleteRule(db, userId, created.id);
    assert.equal(again, false, "deleting a rule that is no longer there reports no row removed");
  } finally {
    await db.close();
  }
});

test("pauseRule persists the rule (it is not deleted) but drops it from the applicable set", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-pause");
    const dek = freshDek();
    const rule = await createRule(db, baseRule(userId, { scope: ANY_AGENT, action: SEND_EMAIL }), dek);

    // Applicable before pausing.
    assert.ok(
      hasId(await applicableRules(db, userId, AGENT_X, SEND_EMAIL, dek), rule.id),
      "the active rule is in the applicable set",
    );

    await pauseRule(db, userId, rule.id);

    // Excluded from the applicable set — read back from the db, so this proves the
    // paused state actually persisted, not just a computed return value.
    assert.equal(
      hasId(await applicableRules(db, userId, AGENT_X, SEND_EMAIL, dek), rule.id),
      false,
      "a paused rule is excluded from the applicable set",
    );

    // Still EXISTS (pause is not delete): the row is still in the table — a deleted rule
    // would be gone. (Read straight from the table so this does not depend on whether
    // `listRules` surfaces paused rules.)
    assert.equal(await ruleRowCount(db, userId), 1, "the paused rule row still exists — it was paused, not deleted");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — applicableRules: scope (all agents / the chosen agent), action matching,
// both kinds, and condition decryption.
// ===========================================================================

test("applicableRules returns any-agent rules and the chosen agent's rules, never another agent's", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-scope");
    const dek = freshDek();

    const anyRule = await createRule(db, baseRule(userId, { scope: ANY_AGENT, action: SEND_EMAIL }), dek);
    const xRule = await createRule(db, baseRule(userId, { scope: agentScope(AGENT_X), action: SEND_EMAIL }), dek);
    const yRule = await createRule(db, baseRule(userId, { scope: agentScope(AGENT_Y), action: SEND_EMAIL }), dek);

    const forX = await applicableRules(db, userId, AGENT_X, SEND_EMAIL, dek);
    assert.ok(hasId(forX, anyRule.id), "an all-agents rule applies to connection X");
    assert.ok(hasId(forX, xRule.id), "a rule scoped to X applies to connection X");
    assert.equal(hasId(forX, yRule.id), false, "a rule scoped to Y never applies to connection X");

    const forY = await applicableRules(db, userId, AGENT_Y, SEND_EMAIL, dek);
    assert.ok(hasId(forY, anyRule.id), "an all-agents rule applies to connection Y too");
    assert.ok(hasId(forY, yRule.id), "a rule scoped to Y applies to connection Y");
    assert.equal(hasId(forY, xRule.id), false, "a rule scoped to X never applies to connection Y");

    const forZ = await applicableRules(db, userId, AGENT_Z, SEND_EMAIL, dek);
    assert.ok(hasId(forZ, anyRule.id), "an all-agents rule applies to an unscoped connection Z");
    assert.equal(hasId(forZ, xRule.id), false, "no chosen-agent rule applies to a different connection");
    assert.equal(hasId(forZ, yRule.id), false, "no chosen-agent rule applies to a different connection");
  } finally {
    await db.close();
  }
});

test("applicableRules returns only rules whose action matches the queried action", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-action");
    const dek = freshDek();

    const sendRule = await createRule(db, baseRule(userId, { scope: ANY_AGENT, action: SEND_EMAIL }), dek);
    const cardRule = await createRule(db, baseRule(userId, { scope: ANY_AGENT, action: CARD_REQUEST }), dek);

    const forSend = await applicableRules(db, userId, AGENT_X, SEND_EMAIL, dek);
    assert.ok(hasId(forSend, sendRule.id), "a send-message rule applies to a send-message action");
    assert.equal(hasId(forSend, cardRule.id), false, "a card-request rule does not apply to a send-message action");

    const forCard = await applicableRules(db, userId, AGENT_X, CARD_REQUEST, dek);
    assert.ok(hasId(forCard, cardRule.id), "a card-request rule applies to a card-request action");
    assert.equal(hasId(forCard, sendRule.id), false, "a send-message rule does not apply to a card-request action");
  } finally {
    await db.close();
  }
});

test("applicableRules returns both never-allow and ask-first rules (the engine partitions them)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-kinds");
    const dek = freshDek();

    const ask = await createRule(db, baseRule(userId, { kind: "ask_first", scope: ANY_AGENT, action: SEND_EMAIL }), dek);
    const never = await createRule(db, baseRule(userId, { kind: "never_allow", scope: ANY_AGENT, action: SEND_EMAIL }), dek);

    const applicable = await applicableRules(db, userId, AGENT_X, SEND_EMAIL, dek);
    const a = byId(applicable, ask.id);
    const n = byId(applicable, never.id);
    assert.ok(a, "the ask-first rule is in the applicable set");
    assert.ok(n, "the never-allow rule is in the applicable set");
    assert.equal(a!.kind, "ask_first", "its kind is carried for the engine to partition on");
    assert.equal(n!.kind, "never_allow", "its kind is carried for the engine to partition on");
  } finally {
    await db.close();
  }
});

test("applicableRules returns the recipient/merchant condition values decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-decrypt");
    const dek = freshDek();

    const rule = await createRule(
      db,
      baseRule(userId, { scope: ANY_AGENT, action: SEND_EMAIL, condition: recipientCondition("APPLY1") }),
      dek,
    );

    const applicable = await applicableRules(db, userId, AGENT_X, SEND_EMAIL, dek);
    const got = byId(applicable, rule.id);
    assert.ok(got, "the rule is applicable");
    assert.deepEqual(
      got!.condition,
      recipientCondition("APPLY1"),
      "the condition's recipient value is decrypted under the injected DEK",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1/AC2 — a paused rule is excluded from the applicable set.
// ===========================================================================

test("a paused rule is excluded from the applicable set while the active ones remain", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-paused");
    const dek = freshDek();

    const stays = await createRule(db, baseRule(userId, { scope: ANY_AGENT, action: SEND_EMAIL }), dek);
    const paused = await createRule(db, baseRule(userId, { scope: ANY_AGENT, action: SEND_EMAIL }), dek);

    await pauseRule(db, userId, paused.id);

    const applicable = await applicableRules(db, userId, AGENT_X, SEND_EMAIL, dek);
    assert.ok(hasId(applicable, stays.id), "the active rule is still applicable");
    assert.equal(hasId(applicable, paused.id), false, "the paused rule is not applicable");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the condition is encrypted at rest and under the INJECTED dek.
// ===========================================================================

test("the condition values are stored DEK-encrypted: the plaintext recipient and merchant never appear in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-atrest");
    const dek = freshDek();

    await createRule(
      db,
      baseRule(userId, { action: SEND_EMAIL, condition: recipientCondition("LEAKrcpt9x") }),
      dek,
    );
    await createRule(
      db,
      baseRule(userId, { action: CARD_REQUEST, condition: merchantCondition("LEAKmerch7q") }),
      dek,
    );

    // Scan every cell of the one table under test. The recipient address and the merchant
    // name are personal content that MUST be encrypted, and their tokens are unique, so
    // any raw occurrence is a genuine plaintext leak. Scoped to `rules` alone — the same
    // value may legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM rules");
    assert.ok(all.rows.length >= 2, "the rule rows were stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes("LEAKrcpt9x"), "the plaintext recipient must never be written to a column");
          assert.ok(!cell.includes("manager-LEAKrcpt9x@example.com"), "nor the full recipient address");
          assert.ok(!cell.includes("LEAKmerch7q"), "the plaintext merchant must never be written to a column");
        }
      }
    }

    // And they still decrypt back for their owner.
    const rules = await listRules(db, userId, dek);
    const addresses: string[] = [];
    for (const r of rules) {
      const c = r.condition;
      if (c && c.type === "recipient_is") addresses.push(c.address);
    }
    assert.ok(addresses.includes("manager-LEAKrcpt9x@example.com"), "the recipient condition round-trips when decrypted");
  } finally {
    await db.close();
  }
});

test("listRules cannot decrypt a rule's condition with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    await createRule(db, baseRule(userId, { action: SEND_EMAIL, condition: recipientCondition("WRONGDEK") }), dek);

    // A different DEK is the wrong key; the GCM tag must fail rather than return other
    // bytes — so reading the condition under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listRules(db, userId, wrongDek);
      },
      "the condition is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in a rule", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-env");
    const dek = freshDek();
    await createRule(db, baseRule(userId, { action: SEND_EMAIL, condition: recipientCondition("ENVCHECK") }), dek);

    const rules = await listRules(db, userId, dek);
    assert.ok(rules.length >= 1, "the rule reads and writes purely from the injected db — no app env needed");
    assert.ok(!JSON.stringify(rules).includes(DECOY), "no ambient env value is folded into a returned rule");

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the
    // same value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM rules");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read or change another's
// rules. The user id is bound from the session, never the client.
// ===========================================================================

test("listRules never returns another user's rules", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    const alices = await createRule(db, baseRule(alice, { action: SEND_EMAIL }), dek);

    assert.ok(hasId(await listRules(db, alice, dek), alices.id), "Alice can list her own rule");
    assert.deepEqual(await listRules(db, bob, dek), [], "Bob's list never includes Alice's rules");
  } finally {
    await db.close();
  }
});

test("applicableRules never returns another user's rules", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "applic-alice");
    const bob = await makeUser(db, "applic-bob");
    const dek = freshDek();

    await createRule(db, baseRule(alice, { scope: ANY_AGENT, action: SEND_EMAIL }), dek);

    assert.ok(
      (await applicableRules(db, alice, AGENT_X, SEND_EMAIL, dek)).length >= 1,
      "Alice sees her own applicable rule",
    );
    assert.deepEqual(
      await applicableRules(db, bob, AGENT_X, SEND_EMAIL, dek),
      [],
      "Bob's applicable set never includes Alice's rules by the same connection id",
    );
  } finally {
    await db.close();
  }
});

test("updateRule cannot change another user's rule by id, and leaves it untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "update-alice");
    const bob = await makeUser(db, "update-bob");
    const dek = freshDek();

    const alices = await createRule(db, baseRule(alice, { kind: "ask_first", action: SEND_EMAIL }), dek);

    // Bob tries to rewrite Alice's rule by its id: member-scoped, so there is no such
    // rule FOR BOB — updateRule must refuse (never silently rewrite it).
    await assert.rejects(
      async () => {
        await updateRule(db, bob, alices.id, edits({ kind: "never_allow", action: CARD_REQUEST }), dek);
      },
      "Bob cannot update a rule that is not his",
    );

    const reloaded = byId(await listRules(db, alice, dek), alices.id);
    assert.ok(reloaded, "Alice's rule is still there");
    assert.equal(reloaded!.kind, "ask_first", "Alice's rule is untouched by Bob's attempt");
    assert.deepEqual(reloaded!.action, SEND_EMAIL, "none of Alice's rule changed");
  } finally {
    await db.close();
  }
});

test("pauseRule cannot pause another user's rule, and leaves it applicable", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "pause-alice");
    const bob = await makeUser(db, "pause-bob");
    const dek = freshDek();

    const alices = await createRule(db, baseRule(alice, { scope: ANY_AGENT, action: SEND_EMAIL }), dek);

    await assert.rejects(
      async () => {
        await pauseRule(db, bob, alices.id);
      },
      "Bob cannot pause a rule that is not his",
    );

    assert.ok(
      hasId(await applicableRules(db, alice, AGENT_X, SEND_EMAIL, dek), alices.id),
      "Alice's rule is still applicable — Bob's attempt did not pause it",
    );
  } finally {
    await db.close();
  }
});

test("deleteRule cannot delete another user's rule: it reports no removal and leaves it in place", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "del-alice");
    const bob = await makeUser(db, "del-bob");
    const dek = freshDek();

    const alices = await createRule(db, baseRule(alice, { action: SEND_EMAIL }), dek);

    const removed = await deleteRule(db, bob, alices.id);
    assert.equal(removed, false, "Bob's delete of Alice's rule id removes nothing");
    assert.ok(hasId(await listRules(db, alice, dek), alices.id), "Alice's rule survives Bob's delete attempt");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("createRule binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'; DROP TABLE rules; --";

  await createRule(db, baseRule(probe, { action: SEND_EMAIL }), freshDek());

  assert.ok(db.calls.length >= 1, "creating issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("listRules binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'; DROP TABLE rules; --";

  const result = await listRules(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assert.ok(db.calls.length >= 1, "the list issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("applicableRules binds the user id and connection id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "x'; DROP TABLE rules; --";

  const result = await applicableRules(db, probe, probe, SEND_EMAIL, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the applicable set is empty");

  assert.ok(db.calls.length >= 1, "the lookup issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in a plaintext rule field is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "gmail'); DROP TABLE rules; --";

    // The probe rides in a plaintext metadata field (a specific-tool action's tool
    // name) — the surface the policy engine filters on.
    const created = await createRule(
      db,
      baseRule(userId, { scope: agentScope(AGENT_X, probe), action: { type: "specific_tool", tool: probe } }),
      dek,
    );

    assert.equal(
      await tableExists(db, "rules"),
      true,
      "the rules table must still exist (the probe was stored as data, not run as SQL)",
    );

    const reloaded = byId(await listRules(db, userId, dek), created.id);
    assert.ok(reloaded, "the rule with the probe is read back");
    assert.deepEqual(reloaded!.action, { type: "specific_tool", tool: probe }, "the probe round-trips verbatim as data");
    const scope = reloaded!.scope;
    assert.equal(
      scope.type === "agent" ? scope.name : null,
      probe,
      "the probe in the scope name round-trips verbatim as data",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value). A rejected
// input maps to a 4xx Response and never reaches a query. This handler is a test fixture
// that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function ruleHandler(db: Db, dek: Uint8Array, sessionUserId: string): (req: Request) => Promise<Response> {
  // The body carries the rule (kind, scope, action and the optional condition); the
  // user id comes from the session. Lengths/counts are capped so an absurd value is
  // rejected, but generous enough that a probe can still REACH the query to prove it
  // is bound. The discriminated unions mirror the domain rule model exactly.
  const scopeSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("any_agent") }),
    z.object({ type: z.literal("agent"), agentId: z.string().min(1).max(64), name: z.string().min(1).max(200) }),
  ]);
  const actionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("send_message"), channel: z.enum(["email", "chat", "post"]) }),
    z.object({ type: z.literal("specific_tool"), tool: z.string().min(1).max(128) }),
    z.object({ type: z.literal("service_tool"), service: z.string().min(1).max(128) }),
    z.object({ type: z.literal("any_change") }),
    z.object({ type: z.literal("card_request") }),
    z.object({ type: z.literal("high_tier_request") }),
  ]);
  const conditionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("recipient_is"), address: z.string().min(1).max(320) }),
    z.object({ type: z.literal("recipient_in_domain"), domain: z.string().min(1).max(255) }),
    z.object({ type: z.literal("amount_over"), amount: z.number() }),
    z.object({ type: z.literal("merchant_in"), merchants: z.array(z.string().max(128)).max(200) }),
    z.object({ type: z.literal("merchant_not_in"), merchants: z.array(z.string().max(128)).max(200) }),
  ]);
  const schema = z.object({
    kind: z.enum(["ask_first", "never_allow"]),
    scope: scopeSchema,
    action: actionSchema,
    condition: conditionSchema.optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const saved = await createRule(db, { userId: sessionUserId, ...body }, dek);
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a
      // test sees the raw-500 failure rather than a masked success.
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

// A fully-valid request body (every rule field), for the tests that vary one thing.
function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "ask_first",
    scope: { type: "any_agent" },
    action: { type: "send_message", channel: "email" },
    condition: { type: "recipient_is", address: "manager@example.com" },
    ...overrides,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = ruleHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = ruleHandler(db, freshDek(), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(validBody({ condition: { type: "recipient_is", address: "a".repeat(10 * 1024) } })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = ruleHandler(db, freshDek(), "session-user");

  // No action — a rule must name the action it governs.
  const bad = JSON.parse(validBody()) as Record<string, unknown>;
  delete bad.action;
  const res = await handler(jsonRequest(JSON.stringify(bad)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-shaped field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = ruleHandler(db, freshDek(), "session-user");

  // kind must be one of the two rule kinds — an unknown value is a schema violation,
  // rejected before any query.
  const res = await handler(jsonRequest(validBody({ kind: "sometimes" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped field must never reach a query");
});

test("the handler accepts a well-formed body and creates the rule for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = ruleHandler(db, dek, userId);

    const res = await handler(
      jsonRequest(validBody({ kind: "never_allow", condition: { type: "recipient_is", address: "boss@example.com" } })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const stored = byId(await listRules(db, userId, dek), id);
    assert.ok(stored, "a valid body is persisted for the session user");
    assert.equal(stored!.kind, "never_allow", "with the submitted kind");
    assert.deepEqual(
      stored!.condition,
      { type: "recipient_is", address: "boss@example.com" },
      "and the submitted condition, decrypted on read",
    );
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const handler = ruleHandler(db, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.ok((await listRules(db, sessionUser, dek)).length >= 1, "the rule is written under the SESSION user");
    assert.deepEqual(await listRules(db, attacker, dek), [], "and never under the user id smuggled in the body");
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe condition is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = ruleHandler(db, dek, userId);
    const probe = "grace'); DROP TABLE rules; --";

    const res = await handler(jsonRequest(validBody({ condition: { type: "recipient_is", address: probe } })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "rules"), true, "the rules table must still exist");

    const { id } = (await res.json()) as { id: string };
    const stored = byId(await listRules(db, userId, dek), id);
    assert.ok(stored, "the rule is read back");
    assert.deepEqual(
      stored!.condition,
      { type: "recipient_is", address: probe },
      "the probe is stored verbatim (encrypted), not interpreted as SQL",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the rules migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "rules"),
      true,
      "the rules table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0014_rules"),
      "db/migrations/0014_rules.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0014's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
