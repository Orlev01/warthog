// The six everyday default skills (`./everyday.ts`, docs/adr/editable-builtin-skills.md).
//
// Their text is guidance an agent reads, so these tests pin what keeps it usable and true to the
// code: the shape every default has (keys, titles, the "use this when" line, word counts, gates),
// and that every tool, parameter, field and record kind a body names is one Warthog really has.
// The vocabulary is built from the code itself (the MCP registry's tools, their input schemas and
// descriptions, the curated connector tools and the record catalogue), plus a short list of the
// names agents read back from get_context, list_records and list_tasks, each checked against the
// result types that declare it. A renamed tool or field turns this red instead of leaving a skill
// that points agents at something that isn't there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { EVERYDAY_SKILLS } from "./everyday";
import type { SkillGate } from "../gates";
import { HOUSE_SKILL } from "../index";
import { LIFE_ADMIN_SKILL } from "../../life-admin/skill";
import { PROFILE_SKILL } from "../../life-admin/profile-skill";
import { BUILT_IN_CATEGORIES, BUILT_IN_TYPES } from "../../life-admin/record-types";
import { maskCards } from "../../life-admin/identifiers";
import { neverKeptRule } from "../../content/never-kept";
import { createToolRegistry } from "../../../server/mcp/tools/registry";
import { GOOGLE_CURATED_TOOLS } from "../../../server/connectors/curated/google";
import { MICROSOFT_CURATED_TOOLS } from "../../../server/connectors/curated/microsoft";
import type { AgentContextView, ProfileField } from "../../../server/mcp/tools/get-context";
import type { ListRecordsResult, RecordView } from "../../../server/mcp/tools/records";
import type { TaskView } from "../../../server/mcp/tools/tasks";
import type { JournalSummary } from "../../../server/life-admin/journal-views";
import type { HandoverItem, LifeAdminSummary } from "../../life-admin/summary";

// --- what the code really has ------------------------------------------------------------

// Every gate, as a runtime list. A Record over the union: typecheck fails if a gate is added to
// or removed from SkillGate without this list following.
const GATES: Readonly<Record<SkillGate, true>> = {
  records_read: true,
  records_write: true,
  tasks: true,
  mail_read: true,
  calendar_read: true,
  cards: true,
  profile: true,
  high_tier: true,
  memory: true,
};

// The core tools as the MCP registry builds them (the pipeline is never called).
const notCalled = async (): Promise<never> => { throw new Error("not called"); };
const registry = createToolRegistry({ pipeline: { handleAgentCall: notCalled, executeApprovedHold: notCalled } });
const CORE_TOOLS = [...registry.coreTools, registry.get("find_tools")!, registry.get("call_tool")!];
const CONNECTOR_TOOL_NAMES = [...GOOGLE_CURATED_TOOLS, ...MICROSOFT_CURATED_TOOLS].map((tool) => tool.name);
const TOOL_NAMES = new Set([...CORE_TOOLS.map((tool) => tool.name), ...CONNECTOR_TOOL_NAMES]);

// Names agents read back in results, not in any input schema. Each must be a key of the result
// type it comes from: `satisfies` says so to the editor (tsc skips test files), and the test below
// finds each one declared in those types' source.
type ListRecordsOk = Extract<ListRecordsResult, { records: unknown }>;
const RESULT_KEYS = [
  "lifeAdmin", "serviceAccounts", "permissions", "profile", "connection", "agentId",
  "highTierRequests", "cardRequests", "resources",
  "dueSoon", "dueSoonMore", "waitingForPerson", "openCases", "upcomingBookings", "handover",
  "movingOn",
  "checkedByPerson", "foundIn", "handledBy", "savedBy", "monthlyCost", "nextCursor",
  "openNext", "decisions",
  "recordId", "claimedBy", "notes",
] as const satisfies readonly (
  | keyof AgentContextView
  | keyof AgentContextView["connection"]
  | keyof AgentContextView["permissions"]
  | keyof NonNullable<AgentContextView["permissions"]["resources"]>
  | keyof LifeAdminSummary
  | keyof HandoverItem
  | keyof ProfileField
  | keyof RecordView
  | keyof ListRecordsOk
  | keyof JournalSummary
  | keyof TaskView
)[];

// Where those result types are declared.
const RESULT_SOURCES = [
  "../../../server/mcp/tools/get-context.ts",
  "../../life-admin/summary.ts",
  "../../../server/mcp/tools/records.ts",
  "../../../server/mcp/tools/tasks.ts",
  "../../../server/life-admin/journal-views.ts",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");

const IDENTIFIER = /[A-Za-z][A-Za-z0-9_]*/g;
function identifiersIn(text: string): string[] {
  return text.match(IDENTIFIER) ?? [];
}

// Every parameter name, enum value and word in each tool's schema and description, the record
// kinds' field keys, and the result keys above.
const VOCABULARY = new Set<string>([
  ...TOOL_NAMES,
  ...RESULT_KEYS,
  ...BUILT_IN_TYPES.flatMap((type) => type.fields.map((field) => field.key)),
  ...CORE_TOOLS.flatMap((tool) => [
    ...identifiersIn(tool.description),
    ...identifiersIn(JSON.stringify(z.toJSONSchema(tool.inputSchema, { unrepresentable: "any", io: "input" }))),
  ]),
]);

const KNOWN_TITLES = new Set([
  HOUSE_SKILL.title,
  LIFE_ADMIN_SKILL.title,
  PROFILE_SKILL.title,
  ...EVERYDAY_SKILLS.map((skill) => skill.title),
]);
const KIND_IDS = new Set(BUILT_IN_TYPES.map((type) => type.id));
const CATEGORY_IDS = BUILT_IN_CATEGORIES.map((category) => category.id);

// A connector tool (`google-gmail__search`), a snake_case name, a camelCase name, a record kind.
const CONNECTOR_TOOL = /\b[a-z0-9]+(?:-[a-z0-9]+)*__[a-z_]+\b/g;
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const CAMEL = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;
const RECORD_KIND = new RegExp(`\\b(${CATEGORY_IDS.join("|")})\\.([a-z_]+|\\*)`, "g");
// A name shaped like one of Warthog's tools: a verb, an underscore, the thing.
const TOOL_SHAPED = /^(get|list|save|update|create|complete|request|check|collect|log|search|find|call|remember)_/;

const words = (text: string) => text.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
const bodyOf = (text: string) => text.replace(CONNECTOR_TOOL, " ");

// --- the shape of each default ----------------------------------------------------------------

test("there are six everyday skills with the fixed keys and titles, each at version 1", () => {
  assert.deepEqual(
    EVERYDAY_SKILLS.map((skill) => [skill.key, skill.title]),
    [
      ["weekly_check_in", "What needs me this week"],
      ["renewals_switching", "Renewals and switching"],
      ["paying", "Paying for something"],
      ["filling_in_details", "Filling in my details"],
      ["booking_appointment", "Booking an appointment"],
      ["handing_over", "Handing over work"],
    ],
  );
  assert.equal(new Set(EVERYDAY_SKILLS.map((skill) => skill.key)).size, EVERYDAY_SKILLS.length);
  assert.equal(new Set(EVERYDAY_SKILLS.map((skill) => skill.title.toLowerCase())).size, EVERYDAY_SKILLS.length);
  for (const skill of EVERYDAY_SKILLS) {
    assert.equal(skill.version, 1, skill.key);
    assert.match(skill.key, /^[a-z]+(?:_[a-z]+)*$/, skill.key);
    const titleWords = skill.title.split(" ").length;
    assert.ok(titleWords >= 2 && titleWords <= 5, `${skill.key}: title is 2 to 5 words`);
  }
});

test("no everyday title clashes with one of Warthog's own skills", () => {
  for (const skill of EVERYDAY_SKILLS) {
    for (const own of [HOUSE_SKILL.title, LIFE_ADMIN_SKILL.title, PROFILE_SKILL.title]) {
      assert.notEqual(skill.title.toLowerCase(), own.toLowerCase(), skill.key);
    }
  }
});

test("each use-this-when line starts \"when \" and is at most 200 characters", () => {
  for (const skill of EVERYDAY_SKILLS) {
    assert.ok(skill.useThisWhen.startsWith("when "), `${skill.key}: starts "when "`);
    assert.ok(skill.useThisWhen.length <= 200, `${skill.key}: ${skill.useThisWhen.length} characters`);
    assert.doesNotMatch(skill.useThisWhen, /\n/, `${skill.key}: one line`);
  }
});

test("each body is 150 to 450 words", () => {
  for (const skill of EVERYDAY_SKILLS) {
    const count = words(skill.guidance);
    assert.ok(count >= 150 && count <= 450, `${skill.key}: ${count} words`);
  }
});

test("every result name the bodies may use is declared on a result type", () => {
  for (const key of RESULT_KEYS) {
    assert.match(RESULT_SOURCES, new RegExp(`\\breadonly ${key}\\??:|[{,;]\\s*${key}\\??:`), `"${key}" is not declared on a result type`);
  }
});

test("requires names only real gates, once each", () => {
  for (const skill of EVERYDAY_SKILLS) {
    for (const gate of skill.requires) assert.ok(Object.hasOwn(GATES, gate), `${skill.key}: unknown gate ${gate}`);
    assert.equal(new Set(skill.requires).size, skill.requires.length, `${skill.key}: a gate listed twice`);
  }
});

test("each skill asks only for the gates it can't do without", () => {
  const requires = Object.fromEntries(EVERYDAY_SKILLS.map((skill) => [skill.key, [...skill.requires]]));
  assert.deepEqual(requires, {
    weekly_check_in: ["records_read"],
    renewals_switching: ["records_read", "records_write"],
    paying: ["cards"],
    filling_in_details: ["profile"],
    booking_appointment: ["records_write"],
    handing_over: [],
  });
});

// --- the text --------------------------------------------------------------------------------

test("every tool a body names is a real Warthog tool", () => {
  for (const skill of EVERYDAY_SKILLS) {
    for (const name of skill.guidance.match(CONNECTOR_TOOL) ?? []) {
      assert.ok(TOOL_NAMES.has(name), `${skill.key}: no connector tool "${name}"`);
    }
    for (const name of bodyOf(skill.guidance).match(SNAKE) ?? []) {
      if (TOOL_SHAPED.test(name)) assert.ok(TOOL_NAMES.has(name), `${skill.key}: no tool "${name}"`);
    }
    for (const call of skill.guidance.match(/\b[a-z][a-z0-9_]*(?=\()/g) ?? []) {
      assert.ok(TOOL_NAMES.has(call), `${skill.key}: "${call}(" is not a tool`);
    }
  }
});

test("every parameter, field or result name a body uses is one the code has", () => {
  for (const skill of EVERYDAY_SKILLS) {
    const text = bodyOf(skill.guidance);
    for (const name of [...(text.match(SNAKE) ?? []), ...(text.match(CAMEL) ?? [])]) {
      assert.ok(VOCABULARY.has(name), `${skill.key}: "${name}" is not a tool, parameter, field or result name`);
    }
  }
});

test("every record kind a body names is a built-in kind", () => {
  for (const skill of EVERYDAY_SKILLS) {
    for (const match of skill.guidance.matchAll(RECORD_KIND)) {
      if (match[2] === "*") continue;
      assert.ok(KIND_IDS.has(`${match[1]}.${match[2]}`), `${skill.key}: no record kind "${match[0]}"`);
    }
  }
});

test("every skill a body points to exists", () => {
  for (const skill of EVERYDAY_SKILLS) {
    for (const match of skill.guidance.matchAll(/\b(?:follow|use|fetch|in) "([^"]+)"/gi)) {
      assert.ok(KNOWN_TITLES.has(match[1]!), `${skill.key}: no skill titled "${match[1]}"`);
    }
    assert.ok(skill.guidance.includes(`"${HOUSE_SKILL.title}"`), `${skill.key}: points to "${HOUSE_SKILL.title}"`);
  }
});

test("each body ends with what to give back and a Not for line naming a neighbouring skill", () => {
  for (const skill of EVERYDAY_SKILLS) {
    const lines = skill.guidance.split("\n").filter((line) => line.trim() !== "");
    assert.ok(lines.some((line) => line.startsWith("What to give back: ")), `${skill.key}: a "What to give back" line`);
    const last = lines[lines.length - 1]!;
    assert.ok(last.startsWith("Not for: "), `${skill.key}: ends with "Not for"`);
    const named = [...last.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(named.length > 0, `${skill.key}: the Not for line names a skill`);
    for (const title of named) {
      assert.ok(KNOWN_TITLES.has(title), `${skill.key}: no skill titled "${title}"`);
      assert.notEqual(title, skill.title, `${skill.key}: points to itself`);
    }
  }
});

test("the text explains rather than shouts: no all-caps NEVER, ALWAYS or MUST", () => {
  for (const skill of EVERYDAY_SKILLS) {
    for (const text of [skill.title, skill.useThisWhen, skill.guidance]) {
      assert.doesNotMatch(text, /\b(?:NEVER|ALWAYS|MUST)\b/, skill.key);
    }
  }
});

test("no text carries a card, ID or account number, or anything Warthog never keeps", () => {
  for (const skill of EVERYDAY_SKILLS) {
    for (const text of [skill.title, skill.useThisWhen, skill.guidance]) {
      assert.doesNotMatch(text, /\d(?:[ -]?\d){4,}/, `${skill.key}: a long run of digits`);
      assert.equal(maskCards(text).masked, false, `${skill.key}: a card number`);
      assert.equal(neverKeptRule(text), null, `${skill.key}: something Warthog never keeps`);
    }
  }
});

test("no text quotes a price, rate or threshold that will go stale", () => {
  for (const skill of EVERYDAY_SKILLS) {
    assert.doesNotMatch(skill.guidance, /[$%]|\bper cent\b/i, skill.key);
  }
});

test("each use-this-when line is plain words, not tool names", () => {
  for (const skill of EVERYDAY_SKILLS) {
    assert.doesNotMatch(skill.useThisWhen, SNAKE, skill.key);
    assert.doesNotMatch(skill.useThisWhen, CONNECTOR_TOOL, skill.key);
  }
});
