// E03-S10 — Skills index and scoping (`src/domain/skills/index.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (what the built index contains for a given agent
// — which skills' title + use-this-when appear, which are excluded, and that the
// house skill is always there), never the source text of the module, so a later
// rename that keeps behaviour leaves them untouched.
//
// This is a pure domain module (CLAUDE.md / conventions: `src/domain/**` has no
// React, no DB, no fetch, no process.env, no Date.now). Building the index is a
// pure function of (the person's skills, the agent it is being built for).
//
// Brief "Skills and preferences": named skills (instruction documents), each with
// a title and a one-line "use this when" description; each skill applies to all
// agents or to chosen agents; an agent's context lists the TITLES and "use this
// when" LINES of the skills it may use (it fetches the full text by title later,
// so the index never carries the full text); Warthog's own house skill is ALWAYS
// included; skills can be switched off.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // A skill applies either to all agents, or to a chosen set of agents. (A
//   // skill may be scoped to SEVERAL chosen agents — brief: the "Travel booking"
//   // skill scoped to Claude AND ChatGPT — so the chosen form carries a list.)
//   type SkillScope =
//     | { type: "all_agents" }
//     | { type: "agents"; agentIds: readonly string[] };
//
//   // One of the person's named skills. `enabled` is the on/off switch; `scope`
//   // decides which agents may use it. The full instruction text is NOT part of
//   // this task's concern and is NEVER copied into an index entry.
//   interface Skill {
//     title: string;
//     useThisWhen: string;
//     enabled: boolean;
//     scope: SkillScope;
//   }
//
//   // What an agent's context lists per skill: ONLY the title and the use-this-when
//   // line — nothing else (not the on/off switch, the scope, or the full text).
//   interface SkillIndexEntry {
//     title: string;
//     useThisWhen: string;
//   }
//
//   // Warthog's own house skill — always present in every agent's index, cannot be
//   // switched off or scoped out (it is not one of the person's skills). Exported so
//   // the context layer and these tests can reference it without hard-coding wording.
//   const HOUSE_SKILL: { title: string; useThisWhen: string };
//
//   // buildSkillIndex(skills, agentId): the title + use-this-when index an agent sees.
//   //  - Includes the house skill, always.
//   //  - Includes each of the person's skills that is enabled AND scoped to agentId
//   //    (scope all_agents, or an agents-list containing agentId).
//   //  - Excludes a switched-off skill (enabled === false), whatever its scope.
//   //  - Excludes an out-of-scope skill (an agents-list that does not contain agentId,
//   //    including the empty list).
//   //  - Each entry is EXACTLY { title, useThisWhen } — the full text / switch / scope
//   //    never leak into agent context.
//   function buildSkillIndex(skills: readonly Skill[], agentId: string): SkillIndexEntry[];
//
// buildSkillIndex is PURE: a fresh array every call, mutating neither the input
// skills nor the HOUSE_SKILL constant, deterministic for the same inputs. Order of
// the person's skills is NOT pinned (the AC is about membership, not ordering) —
// the tests locate entries by title, never by position.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSkillIndex,
  HOUSE_SKILL,
  type Skill,
  type SkillScope,
  type SkillIndexEntry,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures & helpers.
// ---------------------------------------------------------------------------

const AGENT = "agent-claude";
const OTHER = "agent-chatgpt";

const allAgents: SkillScope = { type: "all_agents" };
const onlyFor = (...agentIds: string[]): SkillScope => ({ type: "agents", agentIds });

/** Build a person skill; enabled and all-agents by default unless overridden. */
function skill(
  title: string,
  useThisWhen: string,
  opts: { enabled?: boolean; scope?: SkillScope } = {},
): Skill {
  return {
    title,
    useThisWhen,
    enabled: opts.enabled ?? true,
    scope: opts.scope ?? allAgents,
  };
}

const titlesOf = (index: readonly SkillIndexEntry[]): string[] => index.map((e) => e.title);
const byTitle = (index: readonly SkillIndexEntry[], title: string): SkillIndexEntry[] =>
  index.filter((e) => e.title === title);

// Sentinel titles that are plainly NOT the house skill, so absence checks are
// unambiguous even without knowing the house skill's wording.
const OFF_TITLE = "OFF-SKILL-SENTINEL-do-not-list";
const OUT_TITLE = "OUT-OF-SCOPE-SENTINEL-do-not-list";

// ===========================================================================
// AC1 — builds the list of title + use-this-when for enabled, in-scope skills.
// ===========================================================================

test("an enabled all-agents skill appears with its title and use-this-when", () => {
  const s = skill("Travel booking", "when booking flights, trains or hotels");
  const index = buildSkillIndex([s], AGENT);

  const entries = byTitle(index, "Travel booking");
  assert.equal(entries.length, 1, "an enabled, in-scope skill is listed exactly once");
  assert.equal(entries[0].useThisWhen, "when booking flights, trains or hotels", "its use-this-when line rides along");
});

test("an enabled skill scoped to the agent (among several chosen agents) is listed for that agent", () => {
  const s = skill("Expense coding", "when categorising a receipt", {
    scope: onlyFor(OTHER, AGENT),
  });
  const index = buildSkillIndex([s], AGENT);

  assert.ok(titlesOf(index).includes("Expense coding"), "a skill whose chosen-agents list contains this agent is in its index");
});

test("the same chosen-agent skill is scoped PER agent — listed for one, hidden from another", () => {
  const s = skill("Weekly review", "when writing the Monday summary", { scope: onlyFor(AGENT) });

  const forAgent = buildSkillIndex([s], AGENT);
  const forOther = buildSkillIndex([s], OTHER);

  assert.ok(titlesOf(forAgent).includes("Weekly review"), "the chosen agent sees the skill");
  assert.ok(!titlesOf(forOther).includes("Weekly review"), "a different agent does not see a skill not scoped to it");
});

test("an all-agents skill is listed for whichever agent asks", () => {
  const s = skill("How I like updates", "when deciding tone and length of a reply");

  for (const agent of [AGENT, OTHER, "some-brand-new-agent"]) {
    assert.ok(
      titlesOf(buildSkillIndex([s], agent)).includes("How I like updates"),
      `an all-agents skill appears for agent ${agent}`,
    );
  }
});

test("several enabled in-scope skills are all listed", () => {
  const index = buildSkillIndex(
    [
      skill("Travel booking", "when booking travel"),
      skill("Expense coding", "when categorising a receipt", { scope: onlyFor(AGENT) }),
      skill("Weekly review", "when writing the Monday summary"),
    ],
    AGENT,
  );

  for (const t of ["Travel booking", "Expense coding", "Weekly review"]) {
    assert.ok(titlesOf(index).includes(t), `${t} is listed`);
  }
});

// ===========================================================================
// Entry shape — the index lists ONLY title + use-this-when, never the full
// instruction text, the on/off switch, or the scope.
// ===========================================================================

test("an index entry is exactly { title, useThisWhen } — switch and scope do not leak", () => {
  const s = skill("Travel booking", "when booking travel", { scope: onlyFor(AGENT) });
  const index = buildSkillIndex([s], AGENT);

  const entry = index.find((e) => e.title === "Travel booking");
  assert.ok(entry, "the skill is listed");
  assert.deepEqual(
    entry,
    { title: "Travel booking", useThisWhen: "when booking travel" },
    "the entry carries only the title and the use-this-when line — not enabled, not scope",
  );
});

test("the full instruction text is never copied into the index entry", () => {
  // The stored skill carries a full instruction document (`body`). The index is a
  // lightweight listing: the agent fetches the full text BY TITLE later, so the
  // body must never ride along in context. (Constructed as a superset of Skill so
  // the extra field is NOT forced onto the pinned Skill type.)
  const SECRET_BODY = "FULL-INSTRUCTION-TEXT-DO-NOT-LEAK-7f3a9c";
  type StoredSkill = Skill & { body: string };
  const stored: StoredSkill = {
    ...skill("Travel booking", "when booking travel"),
    body: SECRET_BODY,
  };

  const index = buildSkillIndex([stored], AGENT);
  const entry = index.find((e) => e.title === "Travel booking");

  assert.ok(entry, "the skill is listed");
  assert.deepEqual(
    entry,
    { title: "Travel booking", useThisWhen: "when booking travel" },
    "only title + use-this-when survive into the entry",
  );
  // Scoped narrowly to this one entry — the sentinel is unique, so this proves the
  // body is not smuggled into some other field of the entry.
  assert.ok(
    !JSON.stringify(entry).includes(SECRET_BODY),
    "the full instruction text does not appear anywhere in the index entry",
  );
});

// ===========================================================================
// AC2 (exclusion) — a switched-off or out-of-scope skill is excluded.
// ===========================================================================

test("a switched-off skill is excluded even though it is in scope", () => {
  const s = skill(OFF_TITLE, "never shown", { enabled: false, scope: allAgents });
  const index = buildSkillIndex([s], AGENT);

  assert.ok(!titlesOf(index).includes(OFF_TITLE), "an enabled === false skill is left out of the agent's index");
});

test("switching a skill off beats its scope — off wins over a chosen-agent match", () => {
  const s = skill(OFF_TITLE, "never shown", { enabled: false, scope: onlyFor(AGENT) });
  const index = buildSkillIndex([s], AGENT);

  assert.ok(!titlesOf(index).includes(OFF_TITLE), "a switched-off skill is excluded even when scoped to this agent");
});

test("an out-of-scope skill (chosen agents not including this one) is excluded", () => {
  const s = skill(OUT_TITLE, "never shown", { scope: onlyFor(OTHER) });
  const index = buildSkillIndex([s], AGENT);

  assert.ok(!titlesOf(index).includes(OUT_TITLE), "a skill scoped only to other agents is not in this agent's index");
});

test("a skill scoped to an empty chosen-agents list is excluded for everyone", () => {
  const s = skill(OUT_TITLE, "never shown", { scope: onlyFor() });

  assert.ok(!titlesOf(buildSkillIndex([s], AGENT)).includes(OUT_TITLE), "scoped to nobody → not listed for this agent");
  assert.ok(!titlesOf(buildSkillIndex([s], OTHER)).includes(OUT_TITLE), "scoped to nobody → not listed for any agent");
});

test("off and out-of-scope skills are dropped while an enabled in-scope one is kept", () => {
  const index = buildSkillIndex(
    [
      skill(OFF_TITLE, "never shown", { enabled: false }),
      skill(OUT_TITLE, "never shown", { scope: onlyFor(OTHER) }),
      skill("Travel booking", "when booking travel"),
    ],
    AGENT,
  );

  const titles = titlesOf(index);
  assert.ok(titles.includes("Travel booking"), "the one enabled in-scope skill survives");
  assert.ok(!titles.includes(OFF_TITLE), "the switched-off skill is dropped");
  assert.ok(!titles.includes(OUT_TITLE), "the out-of-scope skill is dropped");
});

// ===========================================================================
// AC2 (house skill) — the house skill is always present.
// ===========================================================================

test("the exported house skill is a real entry with a title and a use-this-when line", () => {
  assert.equal(typeof HOUSE_SKILL.title, "string");
  assert.ok(HOUSE_SKILL.title.length > 0, "the house skill has a title");
  assert.equal(typeof HOUSE_SKILL.useThisWhen, "string");
  assert.ok(HOUSE_SKILL.useThisWhen.length > 0, "the house skill has a use-this-when line");
});

test("the house skill is present even when the person has no skills at all", () => {
  const index = buildSkillIndex([], AGENT);

  assert.deepEqual(
    index,
    [{ title: HOUSE_SKILL.title, useThisWhen: HOUSE_SKILL.useThisWhen }],
    "with no person skills, the index is just the house skill — and only once",
  );
});

test("the house skill is present for any agent", () => {
  for (const agent of [AGENT, OTHER, "yet-another-agent"]) {
    const house = byTitle(buildSkillIndex([], agent), HOUSE_SKILL.title);
    assert.equal(house.length, 1, `the house skill appears exactly once for agent ${agent}`);
    assert.deepEqual(house[0], { title: HOUSE_SKILL.title, useThisWhen: HOUSE_SKILL.useThisWhen });
  }
});

test("the house skill survives when every person skill is switched off or out of scope", () => {
  const index = buildSkillIndex(
    [
      skill(OFF_TITLE, "never shown", { enabled: false }),
      skill(OUT_TITLE, "never shown", { scope: onlyFor(OTHER) }),
    ],
    AGENT,
  );

  const titles = titlesOf(index);
  assert.ok(titles.includes(HOUSE_SKILL.title), "the house skill is still there when nothing else qualifies");
  assert.ok(!titles.includes(OFF_TITLE), "the off skill is still excluded");
  assert.ok(!titles.includes(OUT_TITLE), "the out-of-scope skill is still excluded");
});

test("the house skill appears exactly once alongside the person's enabled skills", () => {
  const index = buildSkillIndex(
    [skill("Travel booking", "when booking travel"), skill("Weekly review", "when writing the summary")],
    AGENT,
  );

  assert.equal(byTitle(index, HOUSE_SKILL.title).length, 1, "the house skill is not duplicated");
  assert.ok(titlesOf(index).includes("Travel booking"));
  assert.ok(titlesOf(index).includes("Weekly review"));
});

// ===========================================================================
// Purity — a fresh array each call, no mutation of inputs or the house constant.
// ===========================================================================

test("buildSkillIndex does not mutate the input skills", () => {
  const skills: Skill[] = [
    skill("Travel booking", "when booking travel", { scope: onlyFor(AGENT) }),
    skill(OFF_TITLE, "never shown", { enabled: false }),
  ];
  const snapshot = JSON.parse(JSON.stringify(skills));

  buildSkillIndex(skills, AGENT);

  assert.deepEqual(skills, snapshot, "the person's stored skills are read, never rewritten");
});

test("buildSkillIndex returns a fresh array each call — mutating the result does not bleed across calls", () => {
  const skills = [skill("Travel booking", "when booking travel")];

  const first = buildSkillIndex(skills, AGENT);
  first.push({ title: "injected", useThisWhen: "tampering" });
  first.length && (first[0].title = "clobbered");

  const second = buildSkillIndex(skills, AGENT);
  assert.ok(!titlesOf(second).includes("injected"), "a later call is unaffected by mutating an earlier result");
  assert.ok(titlesOf(second).includes("Travel booking"), "the real skill is still listed on the fresh call");
});

test("buildSkillIndex does not mutate the HOUSE_SKILL constant", () => {
  const before = { title: HOUSE_SKILL.title, useThisWhen: HOUSE_SKILL.useThisWhen };
  const index = buildSkillIndex([skill("Travel booking", "when booking travel")], AGENT);
  index.length && (index[0].title = "clobbered");

  assert.equal(HOUSE_SKILL.title, before.title, "the shared house-skill title is untouched");
  assert.equal(HOUSE_SKILL.useThisWhen, before.useThisWhen, "the shared house-skill use-this-when is untouched");
});

test("buildSkillIndex is deterministic for the same inputs", () => {
  const skills = [
    skill("Travel booking", "when booking travel"),
    skill(OUT_TITLE, "never shown", { scope: onlyFor(OTHER) }),
  ];

  assert.deepEqual(buildSkillIndex(skills, AGENT), buildSkillIndex(skills, AGENT), "same skills + same agent → same index");
});
