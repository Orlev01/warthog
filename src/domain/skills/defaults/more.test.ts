import { test } from "node:test";
import assert from "node:assert/strict";

import { PACK_SKILLS, SECOND_WAVE_SKILLS } from "./more";
import type { DefaultSkillText } from "./types";
import type { SkillGate } from "../gates";
import { BUILT_IN_CATEGORIES, BUILT_IN_TYPES } from "../../life-admin/record-types";
import { createToolRegistry } from "../../../server/mcp/tools/registry";
import type { AgentCallPipeline } from "../../../server/mcp/pipeline";
import { GOOGLE_CURATED_TOOLS } from "../../../server/connectors/curated/google";
import { MICROSOFT_CURATED_TOOLS } from "../../../server/connectors/curated/microsoft";

const ALL: readonly DefaultSkillText[] = [...SECOND_WAVE_SKILLS, ...PACK_SKILLS];

// Every gate there is: `satisfies` fails the typecheck if SkillGate gains or loses one.
const GATES = {
  records_read: true,
  records_write: true,
  tasks: true,
  mail_read: true,
  calendar_read: true,
  cards: true,
  profile: true,
  high_tier: true,
  memory: true,
} as const satisfies Record<SkillGate, true>;

// The tools these texts may name, checked against registry.ts and the curated connector tools below.
const CORE_TOOLS = [
  "get_context", "get_skill", "request_identity_detail", "request_card", "check_approval",
  "collect_release", "remember", "search_memory", "list_tasks", "create_task", "update_task",
  "complete_task", "list_records", "save_record", "update_record", "log_activity",
  "find_tools", "call_tool",
] as const;
const CONNECTOR_TOOLS = [
  "google-gmail__search", "google-gmail__read", "google-gmail__draft", "google-gmail__send",
  "microsoft-outlook-mail__search", "microsoft-outlook-mail__read", "microsoft-outlook-mail__draft", "microsoft-outlook-mail__send",
  "google-calendar__list", "google-calendar__create", "google-calendar__update", "google-calendar__delete",
  "microsoft-outlook-calendar__list", "microsoft-outlook-calendar__create", "microsoft-outlook-calendar__update", "microsoft-outlook-calendar__delete",
] as const;
const KNOWN_TOOLS: ReadonlySet<string> = new Set([...CORE_TOOLS, ...CONNECTOR_TOOLS]);

// A word that reads as a tool name: a core tool's verb_noun, or a <connector>__<tool> name.
const CORE_TOOL_WORD = /\b(?:get|list|save|update|create|complete|request|check|collect|log|search|find|call)_[a-z_]+\b/g;
const CONNECTOR_TOOL_WORD = /\b[a-z]+(?:-[a-z]+)+__[a-z_]+\b/g;

// A record kind as category.kind (and not a web address such as ato.gov.au).
const CATEGORY_IDS = BUILT_IN_CATEGORIES.map((category) => category.id).join("|");
const KIND_WORD = new RegExp(`\\b(?:${CATEGORY_IDS})\\.[a-z_]+\\b(?!\\.[a-z])`, "g");
const KNOWN_KINDS: ReadonlySet<string> = new Set(BUILT_IN_TYPES.map((type) => type.id));

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const toolsIn = (text: string): string[] => [...(text.match(CORE_TOOL_WORD) ?? []), ...(text.match(CONNECTOR_TOOL_WORD) ?? [])];
const kindsIn = (text: string): string[] => text.match(KIND_WORD) ?? [];

test("four second-wave skills and four packs, with fixed keys and titles", () => {
  assert.deepEqual(
    SECOND_WAVE_SKILLS.map((skill) => [skill.key, skill.title]),
    [
      ["trip_planning", "Planning a trip"],
      ["tax_time", "Tax time"],
      ["inbox_catch_up", "Inbox catch-up"],
      ["business_problem", "Sorting out a problem with a business"],
    ],
  );
  assert.deepEqual(
    PACK_SKILLS.map((skill) => [skill.key, skill.title]),
    [
      ["school_family", "School and family"],
      ["parents_affairs", "A parent's affairs"],
      ["sole_trader", "Sole trader"],
      ["new_to_australia", "New to Australia"],
    ],
  );
});

test("keys and titles are unique across both lists", () => {
  assert.equal(new Set(ALL.map((skill) => skill.key)).size, ALL.length);
  assert.equal(new Set(ALL.map((skill) => skill.title.toLowerCase())).size, ALL.length);
  for (const skill of ALL) assert.match(skill.key, /^[a-z]+(?:_[a-z]+)*$/, skill.key);
});

test("each is version 1", () => {
  for (const skill of ALL) assert.equal(skill.version, 1, skill.key);
});

test("useThisWhen is at most 200 characters and starts with \"when \"", () => {
  for (const skill of ALL) {
    assert.ok(skill.useThisWhen.length <= 200, `${skill.key}: ${skill.useThisWhen.length} characters`);
    assert.ok(skill.useThisWhen.startsWith("when "), skill.key);
  }
});

test("no two skills lead with the same words in useThisWhen", () => {
  const leads = ALL.map((skill) => skill.useThisWhen.split(/[:,]/)[0]!.trim());
  assert.equal(new Set(leads).size, leads.length, leads.join(" | "));
});

test("each body is 150 to 450 words", () => {
  for (const skill of ALL) {
    const count = words(skill.guidance);
    assert.ok(count >= 150 && count <= 450, `${skill.key}: ${count} words`);
  }
});

test("each body says what to give back and which neighbour it is not for", () => {
  for (const skill of ALL) {
    assert.match(skill.guidance, /^What to give back: /m, skill.key);
    assert.match(skill.guidance, /^Not for /m, skill.key);
  }
});

test("each body points to the Using Warthog skill for the ground rules", () => {
  for (const skill of ALL) assert.ok(skill.guidance.includes("\"Using Warthog\""), skill.key);
});

test("the tools named are real", () => {
  for (const skill of ALL) {
    for (const name of toolsIn(skill.guidance)) assert.ok(KNOWN_TOOLS.has(name), `${skill.key} names ${name}`);
  }
});

test("the known tool list matches Warthog's own tools", () => {
  const pipeline = {} as AgentCallPipeline;
  const registry = createToolRegistry({ pipeline });
  for (const name of CORE_TOOLS) assert.ok(registry.get(name), `${name} is not a core tool`);
  const curated = new Set([...GOOGLE_CURATED_TOOLS, ...MICROSOFT_CURATED_TOOLS].map((tool) => tool.name));
  for (const name of CONNECTOR_TOOLS) assert.ok(curated.has(name), `${name} is not a curated connector tool`);
});

test("the record kinds named are real", () => {
  for (const skill of ALL) {
    for (const kind of kindsIn(skill.guidance)) assert.ok(KNOWN_KINDS.has(kind), `${skill.key} names ${kind}`);
  }
});

test("each skill that saves records names the kinds it saves", () => {
  for (const skill of ALL.filter((s) => s.requires.includes("records_write"))) {
    assert.ok(kindsIn(skill.guidance).length > 0, skill.key);
  }
});

test("no NEVER or ALWAYS in capitals", () => {
  for (const skill of ALL) {
    const text = `${skill.title}\n${skill.useThisWhen}\n${skill.guidance}`;
    assert.doesNotMatch(text, /\b(?:NEVER|ALWAYS)\b/, skill.key);
  }
});

test("requires uses only SkillGate values, as each skill needs", () => {
  for (const skill of ALL) {
    for (const gate of skill.requires) assert.ok(Object.hasOwn(GATES, gate), `${skill.key} requires ${gate}`);
  }
  const requires = Object.fromEntries(ALL.map((skill) => [skill.key, skill.requires]));
  assert.deepEqual(requires, {
    trip_planning: ["records_write"],
    tax_time: ["records_write"],
    inbox_catch_up: ["mail_read"],
    business_problem: ["records_write"],
    school_family: ["records_write"],
    parents_affairs: ["records_write"],
    sole_trader: ["records_write"],
    new_to_australia: ["records_write"],
  });
});

test("the texts keep identifiers and numbers out of records", () => {
  const byKey = Object.fromEntries(ALL.map((skill) => [skill.key, skill.guidance]));
  assert.match(byKey.trip_planning!, /passport/i);
  assert.match(byKey.tax_time!, /tax file number/i);
  assert.match(byKey.new_to_australia!, /grant number/i);
  assert.match(byKey.new_to_australia!, /\bTFN\b/);
  assert.match(byKey.parents_affairs!, /reference number/i);
});

test("the texts carry no figures that go stale", () => {
  for (const skill of ALL) {
    assert.doesNotMatch(skill.guidance, /\$\s?\d|\d+(?:\.\d+)?\s?%/, skill.key);
  }
});
