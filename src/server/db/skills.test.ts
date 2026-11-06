// E13-S02 — Skills store
// (`src/server/db/skills.ts`, `db/migrations/0031_skills.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./skills` throws and `freshDb()` has no `skills` table — every test here fails until
// the builder adds them. That absence IS the point of test-first; do NOT implement
// anything to make these pass — the builder writes the module and the migration
// afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the skills a person
// creates / edits / duplicates / disables / deletes, the DEK-encrypted content that
// round-trips only under the owner's key, the agent-scoped index of enabled skills, the
// full text an agent may fetch by title, who may read / change whose skills, what a
// handler rejects, that every value is bound as a parameter), never the source text of
// the module or the SQL file — a later rename that preserves behaviour must not redden
// them.
//
// WHY this exists (task E13-S02; brief §"Skills, preferences and shared memory": "named
// skills (instruction documents) for specific tasks, each with a title and a one-line
// 'use this when' description; each skill applies to all agents or to chosen agents; an
// agent's context lists the titles and 'use this when' lines of the skills it may use
// and the agent fetches a skill's full text by title when it decides the skill is
// relevant … skills can be created, edited, duplicated, switched off and deleted").
//
// PERSONAL CONTENT, SO DEK-ENCRYPTED. A skill is an instruction document a PERSON writes
// — its title, its "use this when" line and its full text are all personal content, not
// filterable metadata. design §4.1 lists the ONLY plaintext columns ("ids, timestamps,
// kinds, agent id, connector id, tool name, outcome, amounts + currency + merchant name
// …, card brand + last four") and skill text is NOT among them; constitution principle
// 19 forbids any operator path to "decrypt or display a person's … skills … contents";
// CLAUDE.md: "Personal content is stored only DEK-encrypted … Plaintext columns are
// limited to the metadata listed in the design doc §4.1." So title, useThisWhen AND
// fullText are each stored DEK-ENCRYPTED (`../crypto/envelope`), decrypting in the app
// within the already member-filtered set (design §4.1 — the same approach as encrypted
// memory/activity search). The enabled flag, the scope ('all' | 'chosen') and the chosen
// agent ids are PLAINTEXT METADATA (an "agent id" is explicitly §4.1 metadata) — needed
// to filter the applicable set — so they are NOT encrypted. (The task names only "full
// text DEK-encrypted"; the three-field rule is the constitution's, which wins — see the
// summary.)
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type SkillScope = "all" | "chosen";   // applies to ALL of the owner's agents, or to CHOSEN ones
//
//   interface NewSkill {               // what createSkill records
//     userId: string;                  // the OWNER (the SESSION's id, NEVER a client value)
//     title: string;                   // the skill's title (stored DEK-encrypted)
//     useThisWhen: string;             // the one-line "use this when" description (DEK-encrypted)
//     fullText: string;                // the full instruction document (DEK-encrypted)
//     scope: SkillScope;               // 'all' agents, or 'chosen' agents
//     scopedAgentIds?: string[];       // the chosen agent ids (relevant when scope==='chosen'); default []
//     enabled?: boolean;               // defaults to true (a fresh skill is on)
//   }
//
//   interface SkillEdits {             // the new content editSkill applies (a full replace; no userId / enabled)
//     title: string;
//     useThisWhen: string;
//     fullText: string;
//     scope: SkillScope;
//     scopedAgentIds?: string[];
//   }
//
//   interface Skill {                  // a skill as handed back to its OWNER (every field DECRYPTED)
//     id: string;
//     userId: string;
//     title: string;
//     useThisWhen: string;
//     fullText: string;
//     scope: SkillScope;
//     scopedAgentIds: string[];
//     enabled: boolean;
//   }
//
//   interface SkillIndexEntry {        // one entry of the agent-scoped index — NO full text
//     title: string;
//     useThisWhen: string;
//   }
//
//   createSkill(db, input: NewSkill, dek): Promise<Skill>
//     • INSERTs a new row with a generated id (a person may hold many skills). title,
//       useThisWhen and fullText are stored DEK-encrypted; scope/enabled/scopedAgentIds
//       are plaintext metadata. The returned Skill is assembled from the inputs (no
//       dependency on a RETURNING read). Member-scoped: the user id is BOUND.
//   editSkill(db, userId, id, edits: SkillEdits, dek): Promise<Skill>
//     • replaces an OWNED skill's content + scope in place (same id), re-encrypting the
//       text; the enabled flag is PRESERVED. Member-scoped (id AND user_id bound).
//       THROWS (never silently) when there is no such skill for this user.
//   duplicateSkill(db, userId, id, dek): Promise<Skill>
//     • copies an OWNED skill into a NEW row (new id) with the same content + scope.
//       Member-scoped. THROWS when there is no such skill for this user.
//   disableSkill(db, userId, id): Promise<void>
//     • switches an OWNED skill OFF (enabled = false); it persists, it is not deleted.
//       Member-scoped. THROWS when there is no such skill for this user.
//   deleteSkill(db, userId, id): Promise<boolean>
//     • deletes an OWNED skill; true when a row was removed, false when there was none
//       for this user (so another person's delete is a no-op). Member-scoped.
//   listSkillsForUser(db, userId, dek): Promise<Skill[]>
//     • ALL of the owner's skills — ENABLED and DISABLED — decrypted under the owner's
//       dek, each carrying its scope and enabled state. Member-scoped; never another
//       person's. A wrong dek fails the GCM tag and rejects.
//   skillsForAgent(db, userId, agentId, dek): Promise<SkillIndexEntry[]>
//     • the agent-scoped index: ONLY the title + useThisWhen of the owner's ENABLED
//       skills whose scope covers `agentId` (scope 'all', or 'chosen' listing agentId).
//       NO full text. Decrypted under the owner's dek. Member-scoped by userId.
//   getSkillText(db, userId, agentId, title, dek): Promise<string | null>
//     • the full text of the owner's ENABLED skill titled `title` IFF its scope covers
//       `agentId`; null otherwise (unknown title, disabled, or not scoped to that agent).
//       Member-scoped by userId: an agent never reads another person's skill. Decrypted
//       under the owner's dek.
//
// Acceptance criteria → tests:
//   AC1 "Create/edit/duplicate/disable/delete persist a skill, and listSkillsForUser
//        returns all of the owner's skills with scope and enabled state." — each mutation
//        is observable through listSkillsForUser; scope + enabled round-trip.
//   AC2 "skillsForAgent returns only the titles and use-this-when lines of enabled skills
//        scoped to that agent, and getSkillText returns a skill's full text only for an
//        agent it is scoped to; full text is stored DEK-encrypted." — the scoped index
//        excludes disabled / other-agent skills and carries no full text; getSkillText
//        gates on scope + enabled; the full text (and title + useThisWhen) never appear
//        as plaintext in a column and round-trip only under the owner's dek.
//   AC3 "A user cannot read or change another user's skills (filtered by session user
//        id)." — B never sees A's skills; B's edit/disable/duplicate on A's id throws and
//        leaves A's untouched; B's delete on A's id is a no-op; the user id is bound.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query; a SQL-injection probe routed through the repo
//        travels as a BOUND value and cannot drop the table. The handler is a test
//        fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo takes `db` and `dek` as
//        injected dependencies, holds no key and reads no `process.env`. Shown
//        behaviourally: content is encrypted under the INJECTED dek (a different dek
//        cannot read it back), the store reads/writes purely from the injected db with no
//        app env configured, and a decoy secret planted in the environment never lands in
//        a stored or returned skill.
//   Migration: the `skills` relation exists after the project migrations and a second run
//        of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  createSkill,
  editSkill,
  duplicateSkill,
  disableSkill,
  deleteSkill,
  listSkillsForUser,
  skillsForAgent,
  getSkillText,
} from "./skills";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased
// at runtime (and test files are excluded from `tsc`), so a rename cannot break these
// tests; the runtime assertions below are what actually gate behaviour.
import type { Skill, NewSkill, SkillEdits, SkillScope, SkillIndexEntry } from "./skills";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this repo only ever receives the already-unwrapped bytes.
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

// A fresh agent id. The skills store treats an agent id as an opaque plaintext id
// (§4.1 metadata); it needs no agents-table row, so a bare UUID is a valid scope target.
function agentId(): string {
  return randomUUID();
}

// Local scope type, decoupled from the (absent) module's exported type at the point it
// runs. Mirrors SkillScope.
type Scope = "all" | "chosen";

// A structural view of a skill's settable content, so helpers below do not depend on the
// (absent) module's exported type.
interface SkillFields {
  readonly title: string;
  readonly useThisWhen: string;
  readonly fullText: string;
  readonly scope: Scope;
  readonly scopedAgentIds: string[];
}

// A sample skill; override fields per test. Distinct values per field so a round-trip
// proves each is stored and read independently (not collapsed). Scope defaults to 'all'
// (applies to every agent), with no chosen agents.
function sampleSkill(overrides: Partial<SkillFields> = {}): SkillFields {
  return {
    title: "Travel booking",
    useThisWhen: "Use this when booking flights, trains or hotels for the person",
    fullText:
      "Always prefer refundable fares. Book an aisle seat. Keep each trip under the daily budget. Confirm dates with the person before paying.",
    scope: "all",
    scopedAgentIds: [],
    ...overrides,
  };
}

// A structural view of a returned skill, decoupled from the (absent) module's type.
interface SkillLike {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly useThisWhen: string;
  readonly fullText: string;
  readonly scope: string;
  readonly scopedAgentIds: string[];
  readonly enabled: boolean;
}

// Assert a returned skill carries exactly the given content (ignoring id / enabled).
function assertSkillContent(skill: SkillLike, fields: SkillFields): void {
  assert.equal(skill.title, fields.title, "title round-trips");
  assert.equal(skill.useThisWhen, fields.useThisWhen, "useThisWhen round-trips");
  assert.equal(skill.fullText, fields.fullText, "fullText round-trips");
  assert.equal(skill.scope, fields.scope, "scope round-trips");
  assert.deepEqual(
    [...skill.scopedAgentIds].sort(),
    [...fields.scopedAgentIds].sort(),
    "the chosen agent ids round-trip",
  );
}

// Find exactly one skill with this title in a list (titles are decrypted by the read).
function byTitle(skills: SkillLike[], title: string): SkillLike {
  const matches = skills.filter((s) => s.title === title);
  assert.equal(matches.length, 1, `expected exactly one skill titled "${title}"`);
  return matches[0];
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no rows
// and satisfies the `Db` shape structurally (query + close).
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

// Assert the probe reached the query layer as a BOUND value and never as spliced SQL
// text, scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// ===========================================================================
// AC1 — create / edit / duplicate / disable / delete persist a skill; listSkillsForUser
// returns ALL of the owner's skills (enabled and disabled) with scope + enabled state.
// ===========================================================================

test("createSkill returns a skill with the owner, a generated id, and the recorded content", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-create");
    const fields = sampleSkill();

    const saved = await createSkill(db, { userId, ...fields }, freshDek());

    assert.ok(saved.id, "a skill id was generated");
    assert.equal(saved.userId, userId, "the skill belongs to the creating person");
    assert.equal(saved.enabled, true, "a fresh skill is enabled");
    assertSkillContent(saved, fields);
  } finally {
    await db.close();
  }
});

test("listSkillsForUser returns the owner's skills with scope and enabled state, decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();
    const agentA = agentId();

    const all = sampleSkill({ title: "How I like updates", scope: "all", scopedAgentIds: [] });
    const chosen = sampleSkill({
      title: "Travel booking",
      scope: "chosen",
      scopedAgentIds: [agentA],
    });
    await createSkill(db, { userId, ...all }, dek);
    await createSkill(db, { userId, ...chosen }, dek);

    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assert.equal(skills.length, 2, "both of the owner's skills are listed");
    for (const s of skills) assert.equal(s.userId, userId, "every listed skill belongs to the owner");

    assertSkillContent(byTitle(skills, "How I like updates"), all);
    assertSkillContent(byTitle(skills, "Travel booking"), chosen);
    assert.equal(byTitle(skills, "How I like updates").enabled, true, "enabled state is reported");
    assert.equal(byTitle(skills, "Travel booking").enabled, true, "enabled state is reported");
  } finally {
    await db.close();
  }
});

test("editSkill replaces an owned skill's content and scope in place, preserving its id and enabled flag", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-edit");
    const dek = freshDek();
    const created = await createSkill(db, { userId, ...sampleSkill() }, dek);

    const chosenAgent = agentId();
    const edits: SkillFields = {
      title: "Travel booking (revised)",
      useThisWhen: "Use when the person asks to book or change any travel",
      fullText: "New rules: economy only; confirm the budget first; never book without approval.",
      scope: "chosen",
      scopedAgentIds: [chosenAgent],
    };
    const updated = (await editSkill(db, userId, created.id, edits, dek)) as SkillLike;

    assert.equal(updated.id, created.id, "edit keeps the same id (replace in place, not a new row)");
    assert.equal(updated.enabled, true, "edit preserves the enabled flag");
    assertSkillContent(updated, edits);

    // Still exactly one skill for the person, now carrying the edited content.
    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assert.equal(skills.length, 1, "edit did not create a second row");
    assertSkillContent(skills[0], edits);
  } finally {
    await db.close();
  }
});

test("duplicateSkill copies an owned skill into a new row with the same content", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-dup");
    const dek = freshDek();
    const chosenAgent = agentId();
    const fields = sampleSkill({ scope: "chosen", scopedAgentIds: [chosenAgent] });
    const original = await createSkill(db, { userId, ...fields }, dek);

    const copy = (await duplicateSkill(db, userId, original.id, dek)) as SkillLike;

    assert.notEqual(copy.id, original.id, "the duplicate is a NEW row with its own id");
    assert.equal(copy.userId, userId, "the duplicate belongs to the same owner");
    assertSkillContent(copy, fields);

    // The owner now has two skills; both decrypt to the same content.
    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assert.equal(skills.length, 2, "duplicate added a second persisted skill");
    for (const s of skills) assertSkillContent(s, fields);
  } finally {
    await db.close();
  }
});

test("disableSkill switches a skill off (it persists, disabled) and listSkillsForUser reflects it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-disable");
    const dek = freshDek();
    const keep = await createSkill(db, { userId, ...sampleSkill({ title: "Keep on" }) }, dek);
    const off = await createSkill(db, { userId, ...sampleSkill({ title: "Switch off" }) }, dek);
    assert.ok(keep.id && off.id);

    await disableSkill(db, userId, off.id);

    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assert.equal(skills.length, 2, "a disabled skill still persists (it is not deleted)");
    assert.equal(byTitle(skills, "Switch off").enabled, false, "the disabled skill reads enabled = false");
    assert.equal(byTitle(skills, "Keep on").enabled, true, "the other skill is untouched");
  } finally {
    await db.close();
  }
});

test("deleteSkill removes an owned skill and returns true; listSkillsForUser no longer shows it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-delete");
    const dek = freshDek();
    const a = await createSkill(db, { userId, ...sampleSkill({ title: "Alpha" }) }, dek);
    await createSkill(db, { userId, ...sampleSkill({ title: "Beta" }) }, dek);

    const removed = await deleteSkill(db, userId, a.id);
    assert.equal(removed, true, "deleting an owned skill reports a removal");

    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assert.equal(skills.length, 1, "only the remaining skill is listed");
    assert.equal(skills[0].title, "Beta", "the deleted skill is gone, the other remains");
  } finally {
    await db.close();
  }
});

test("listSkillsForUser returns an empty array for a person with no skills", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const skills = await listSkillsForUser(db, userId, freshDek());
    assert.deepEqual(skills, [], "a person with no skills reads an empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the agent-scoped index (skillsForAgent) and the by-title full-text fetch
// (getSkillText). The index carries only title + useThisWhen of ENABLED skills whose
// scope covers the agent; getSkillText gates full text on scope + enabled.
// ===========================================================================

test("skillsForAgent returns title + useThisWhen of enabled skills scoped to that agent, and no full text", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-index");
    const dek = freshDek();
    const claude = agentId();
    const chatgpt = agentId();

    // Visible to `claude`: an all-agents skill, and a chosen skill that lists claude.
    const forAll = sampleSkill({
      title: "How I like updates",
      useThisWhen: "Use when giving the person a status update",
      fullText: "LEAKCHECK_fulltext_all keep it to three bullet points",
      scope: "all",
      scopedAgentIds: [],
    });
    const forClaude = sampleSkill({
      title: "Travel booking",
      useThisWhen: "Use when booking travel",
      fullText: "LEAKCHECK_fulltext_claude economy only",
      scope: "chosen",
      scopedAgentIds: [claude],
    });
    // NOT visible to `claude`: a chosen skill for chatgpt only, and a disabled skill.
    const forChatgpt = sampleSkill({
      title: "Expense report",
      scope: "chosen",
      scopedAgentIds: [chatgpt],
    });
    await createSkill(db, { userId, ...forAll }, dek);
    await createSkill(db, { userId, ...forClaude }, dek);
    await createSkill(db, { userId, ...forChatgpt }, dek);
    const disabled = await createSkill(
      db,
      { userId, ...sampleSkill({ title: "Old skill", scope: "all" }) },
      dek,
    );
    await disableSkill(db, userId, disabled.id);

    const index = (await skillsForAgent(db, userId, claude, dek)) as SkillIndexEntryLike[];

    const titles = index.map((e) => e.title).sort();
    assert.deepEqual(
      titles,
      ["How I like updates", "Travel booking"],
      "only the enabled skills scoped to this agent appear — not chatgpt's, not the disabled one",
    );

    // Each entry carries the "use this when" line and NO full text.
    const travel = index.find((e) => e.title === "Travel booking")!;
    assert.equal(travel.useThisWhen, forClaude.useThisWhen, "the use-this-when line is in the index");
    for (const entry of index) {
      assert.equal(typeof entry.title, "string", "each entry has a title");
      assert.equal(typeof entry.useThisWhen, "string", "each entry has a use-this-when line");
      assert.ok(!("fullText" in entry), "an index entry must not carry the full text");
    }
    // The full-text sentinels never leak through the index (scoped to the index output).
    const serialised = JSON.stringify(index);
    assert.ok(!serialised.includes("LEAKCHECK_fulltext_all"), "no full text leaks into the index");
    assert.ok(!serialised.includes("LEAKCHECK_fulltext_claude"), "no full text leaks into the index");
  } finally {
    await db.close();
  }
});

test("skillsForAgent is empty for an agent with no skills scoped to it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-index-empty");
    const dek = freshDek();
    const claude = agentId();
    const other = agentId();
    await createSkill(
      db,
      { userId, ...sampleSkill({ title: "Only for other", scope: "chosen", scopedAgentIds: [other] }) },
      dek,
    );

    const index = await skillsForAgent(db, userId, claude, dek);
    assert.deepEqual(index, [], "an agent with nothing scoped to it sees an empty index");
  } finally {
    await db.close();
  }
});

test("getSkillText returns the full text for an agent the skill is scoped to (all-agents scope)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-text-all");
    const dek = freshDek();
    const claude = agentId();
    const fields = sampleSkill({ title: "Travel booking", scope: "all", fullText: "Book refundable fares only." });
    await createSkill(db, { userId, ...fields }, dek);

    const text = await getSkillText(db, userId, claude, "Travel booking", dek);
    assert.equal(text, fields.fullText, "an all-agents skill's full text is returned, decrypted");
  } finally {
    await db.close();
  }
});

test("getSkillText returns the full text for a chosen agent, and null for an agent not chosen", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-text-chosen");
    const dek = freshDek();
    const claude = agentId();
    const chatgpt = agentId();
    const fields = sampleSkill({
      title: "Travel booking",
      scope: "chosen",
      scopedAgentIds: [claude],
      fullText: "Economy only; confirm the budget first.",
    });
    await createSkill(db, { userId, ...fields }, dek);

    assert.equal(
      await getSkillText(db, userId, claude, "Travel booking", dek),
      fields.fullText,
      "the chosen agent gets the full text",
    );
    assert.equal(
      await getSkillText(db, userId, chatgpt, "Travel booking", dek),
      null,
      "an agent NOT in the chosen list gets null — the text is only for a scoped agent",
    );
  } finally {
    await db.close();
  }
});

test("getSkillText returns null for a disabled skill, even for an agent it is scoped to", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-text-disabled");
    const dek = freshDek();
    const claude = agentId();
    const created = await createSkill(
      db,
      { userId, ...sampleSkill({ title: "Travel booking", scope: "all", fullText: "secret steps" }) },
      dek,
    );
    await disableSkill(db, userId, created.id);

    assert.equal(
      await getSkillText(db, userId, claude, "Travel booking", dek),
      null,
      "a switched-off skill hands back no full text",
    );
  } finally {
    await db.close();
  }
});

test("getSkillText returns null for an unknown title", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-text-unknown");
    const dek = freshDek();
    const claude = agentId();
    await createSkill(db, { userId, ...sampleSkill({ title: "Travel booking", scope: "all" }) }, dek);

    assert.equal(
      await getSkillText(db, userId, claude, "No such skill", dek),
      null,
      "a title the person never wrote hands back null",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 (at rest) — title, useThisWhen AND fullText are each stored DEK-encrypted (design
// §4.1 personal content; constitution principle 19 — operators cannot read skills
// contents). None of their plaintext appears in a raw column; all round-trip only under
// the owner's dek.
// ===========================================================================

test("every content field is stored DEK-encrypted: no plaintext of title / useThisWhen / fullText in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-atrest");
    const dek = freshDek();
    // A unique sentinel in EACH content field, so any raw occurrence is a genuine
    // plaintext leak of that specific field.
    const fields = sampleSkill({
      title: "LEAKCHECK_title_7k2",
      useThisWhen: "LEAKCHECK_usethiswhen_7k2 when booking",
      fullText: "LEAKCHECK_fulltext_7k2 the full instructions go here",
    });
    await createSkill(db, { userId, ...fields }, dek);

    // Scan every cell of the one table under test. Scoped to `skills` alone — the same
    // value could legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM skills");
    assert.ok(all.rows.length >= 1, "the skill row was stored");
    const sentinels = [fields.title, fields.useThisWhen, fields.fullText];
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          for (const sentinel of sentinels) {
            assert.ok(
              !cell.includes(sentinel),
              `the plaintext of a content field (${sentinel}) must never be written to a column`,
            );
          }
        }
      }
    }

    // …yet every field round-trips under the owner's dek.
    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assertSkillContent(skills[0], fields);
  } finally {
    await db.close();
  }
});

test("listSkillsForUser cannot decrypt a skill with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-wrongdek");
    const dek = freshDek();
    await createSkill(db, { userId, ...sampleSkill() }, dek);

    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listSkillsForUser(db, userId, wrongDek);
      },
      "a skill is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read or change another's skills.
// The user id is bound from the session, never the client.
// ===========================================================================

test("listSkillsForUser never returns another person's skills", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");
    const dek = freshDek();

    const aliceSkill = sampleSkill({ title: "Alice only" });
    await createSkill(db, { userId: alice, ...aliceSkill }, dek);

    assert.deepEqual(await listSkillsForUser(db, bob, dek), [], "Bob sees none of Alice's skills");
    const aliceList = (await listSkillsForUser(db, alice, dek)) as SkillLike[];
    assert.equal(aliceList.length, 1, "Alice sees exactly her own");
    assertSkillContent(aliceList[0], aliceSkill);
  } finally {
    await db.close();
  }
});

test("editSkill on another person's skill throws and leaves it untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "edit-alice");
    const bob = await makeUser(db, "edit-bob");
    const dek = freshDek();
    const aliceFields = sampleSkill({ title: "Alice original" });
    const aliceSkill = await createSkill(db, { userId: alice, ...aliceFields }, dek);

    await assert.rejects(
      async () => {
        await editSkill(
          db,
          bob,
          aliceSkill.id,
          { title: "hijacked", useThisWhen: "x", fullText: "x", scope: "all", scopedAgentIds: [] },
          dek,
        );
      },
      "Bob cannot edit a skill that is not his",
    );

    // Alice's skill is unchanged.
    const aliceList = (await listSkillsForUser(db, alice, dek)) as SkillLike[];
    assert.equal(aliceList.length, 1);
    assertSkillContent(aliceList[0], aliceFields);
  } finally {
    await db.close();
  }
});

test("disableSkill on another person's skill throws and leaves it enabled", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "disable-alice");
    const bob = await makeUser(db, "disable-bob");
    const dek = freshDek();
    const aliceSkill = await createSkill(db, { userId: alice, ...sampleSkill() }, dek);

    await assert.rejects(
      async () => {
        await disableSkill(db, bob, aliceSkill.id);
      },
      "Bob cannot switch off a skill that is not his",
    );

    const aliceList = (await listSkillsForUser(db, alice, dek)) as SkillLike[];
    assert.equal(aliceList[0].enabled, true, "Alice's skill is still enabled");
  } finally {
    await db.close();
  }
});

test("duplicateSkill on another person's skill throws and creates nothing for the caller", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "dup-alice");
    const bob = await makeUser(db, "dup-bob");
    const dek = freshDek();
    const aliceSkill = await createSkill(db, { userId: alice, ...sampleSkill() }, dek);

    await assert.rejects(
      async () => {
        await duplicateSkill(db, bob, aliceSkill.id, dek);
      },
      "Bob cannot duplicate a skill that is not his",
    );

    assert.deepEqual(await listSkillsForUser(db, bob, dek), [], "no copy was created for Bob");
    const aliceList = (await listSkillsForUser(db, alice, dek)) as SkillLike[];
    assert.equal(aliceList.length, 1, "Alice still has exactly her one skill");
  } finally {
    await db.close();
  }
});

test("deleteSkill on another person's skill is a no-op (returns false) and does not remove it", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "del-alice");
    const bob = await makeUser(db, "del-bob");
    const dek = freshDek();
    const aliceSkill = await createSkill(db, { userId: alice, ...sampleSkill() }, dek);

    const removed = await deleteSkill(db, bob, aliceSkill.id);
    assert.equal(removed, false, "Bob's delete of Alice's skill removes nothing");

    const aliceList = (await listSkillsForUser(db, alice, dek)) as SkillLike[];
    assert.equal(aliceList.length, 1, "Alice's skill still exists");
  } finally {
    await db.close();
  }
});

test("getSkillText never hands an agent another person's skill text (member-scoped by userId)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "text-alice");
    const bob = await makeUser(db, "text-bob");
    const dek = freshDek();
    const bobAgent = agentId();
    // Alice has an all-agents skill; Bob (a different person) asks for it by title.
    await createSkill(
      db,
      { userId: alice, ...sampleSkill({ title: "Travel booking", scope: "all", fullText: "alice secret" }) },
      dek,
    );

    assert.equal(
      await getSkillText(db, bob, bobAgent, "Travel booking", dek),
      null,
      "Bob's agent cannot read Alice's skill text by its title",
    );
  } finally {
    await db.close();
  }
});

// Binding (the parameterize half of INV-102): the member-scope key travels as a bound
// value, never spliced into the SQL text — even when it is shaped like an injection.

test("createSkill binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE skills; --";

  try {
    await createSkill(db, { userId: probe, ...sampleSkill() }, freshDek());
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listSkillsForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE skills; --";

  const result = await listSkillsForUser(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("skillsForAgent binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'); DROP TABLE skills; --";

  const result = await skillsForAgent(db, probe, agentId(), freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the index is empty");

  assertBoundNotSpliced(db, probe);
});

test("getSkillText binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "g'); DROP TABLE skills; --";

  const result = await getSkillText(db, probe, agentId(), "Travel booking", freshDek());
  assert.equal(result, null, "the recording db returns no rows, so the read is null");

  assertBoundNotSpliced(db, probe);
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value) and the
// injected dek. A rejected input maps to a 4xx Response and never reaches a query. This
// handler is a test fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function createSkillHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the skill's content + scope; the user id comes from the session,
  // never the body. Lengths are capped so an absurd value is rejected, but generous
  // enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    title: z.string().min(1).max(200),
    useThisWhen: z.string().max(400),
    fullText: z.string().max(500_000),
    scope: z.enum(["all", "chosen"]),
    scopedAgentIds: z.array(z.string().max(200)).max(200).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 64 * 1024 });
      const saved = await createSkill(db, { userId: sessionUserId, ...body }, dek);
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test
      // sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function skillBody(overrides: Partial<SkillFields> = {}): string {
  return JSON.stringify(sampleSkill(overrides));
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createSkillHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createSkillHandler(db, freshDek(), "session-user");

  // ~200 KiB full text, well over the handler's 64 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(skillBody({ fullText: "a".repeat(200 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createSkillHandler(db, freshDek(), "session-user");

  // Omit `title` — a skill must have one, so a missing title is a schema violation.
  const { title: _omit, ...rest } = sampleSkill();
  const res = await handler(jsonRequest(JSON.stringify(rest)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createSkillHandler(db, freshDek(), "session-user");

  // `title` must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ ...sampleSkill(), title: 42 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler rejects an invalid scope value with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createSkillHandler(db, freshDek(), "session-user");

  // `scope` must be 'all' | 'chosen' — any other value is a schema violation.
  const res = await handler(jsonRequest(JSON.stringify({ ...sampleSkill(), scope: "everyone" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-range scope must never reach a query");
});

test("the handler accepts a well-formed body and records the skill for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = createSkillHandler(db, dek, userId);
    const fields = sampleSkill();

    const res = await handler(jsonRequest(skillBody()));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assert.equal(skills.length, 1, "the skill was recorded");
    assertSkillContent(skills[0], fields);
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body (no cross-user write)", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const handler = createSkillHandler(db, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, ...sampleSkill() })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const forSession = (await listSkillsForUser(db, sessionUser, dek)) as SkillLike[];
    assert.equal(forSession.length, 1, "the skill is recorded under the SESSION user");
    assert.deepEqual(
      await listSkillsForUser(db, attacker, dek),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe title is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = createSkillHandler(db, dek, userId);
    const probe = "Grace'); DROP TABLE skills; --";

    const res = await handler(jsonRequest(skillBody({ title: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "skills"), true, "the skills table must still exist");

    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assert.equal(skills.length, 1, "the skill is readable after the probe");
    assert.equal(
      skills[0].title,
      probe,
      "the probe round-trips verbatim as data, not interpreted as SQL",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env and holds no key (INV-103), shown behaviourally
// with a decoy secret in the environment.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a skill", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-decoy");
    const dek = freshDek();
    await createSkill(db, { userId, ...sampleSkill() }, dek);

    const skills = (await listSkillsForUser(db, userId, dek)) as SkillLike[];
    assert.equal(skills.length, 1, "the skill reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(skills).includes(DECOY),
      "no ambient env value is folded into the returned skill",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly).
    const all = await db.query("SELECT * FROM skills");
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
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the skills migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "skills"),
      true,
      "the skills table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0031_skills"),
      "db/migrations/0031_skills.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0031's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// Structural view of an index entry, decoupled from the (absent) module's type.
interface SkillIndexEntryLike {
  readonly title: string;
  readonly useThisWhen: string;
}

// Type anchors referenced so the type-only imports are not flagged as unused by linters
// that check it; erased at runtime.
export type _SkillAnchors = [Skill, NewSkill, SkillEdits, SkillScope, SkillIndexEntry];
