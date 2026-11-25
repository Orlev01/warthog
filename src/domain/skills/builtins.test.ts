// Warthog's own skills (docs/adr/editable-builtin-skills.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { BUILTIN_SKILLS, builtinAvailableTo, builtinByKey, builtinByTitle, effectiveBuiltin, isReservedSkillTitle, HOUSE_KEY } from "./builtins";
import type { AgentGates, SkillGate } from "./gates";

const gates = (...passes: SkillGate[]): AgentGates => ({ passes: new Set(passes) });

test("every Warthog skill has its own key and title, and the house skill comes first", () => {
  assert.equal(new Set(BUILTIN_SKILLS.map((skill) => skill.key)).size, BUILTIN_SKILLS.length);
  assert.equal(new Set(BUILTIN_SKILLS.map((skill) => skill.title.toLowerCase())).size, BUILTIN_SKILLS.length);
  assert.equal(BUILTIN_SKILLS[0]!.key, HOUSE_KEY);
  for (const skill of BUILTIN_SKILLS) {
    assert.match(skill.key, /^[a-z][a-z0-9_]{1,39}$/, "fits the table's key check");
    assert.ok(skill.version >= 1);
  }
});

// Warthog's text changing without a new version would leave a person's edit looking current.
// Changing a skill's guidance: bump its version, then update its line here.
const PINS: Record<string, [number, string]> = {
  using_warthog: [2, "9e1e5e828b5e321b"],
  life_admin_records: [2, "092eb6cbc949220a"],
  building_a_profile: [1, "6cac249767c38c87"],
  weekly_check_in: [1, "a656336f8ea17a92"],
  renewals_switching: [1, "4f6cfe9aa6d824eb"],
  paying: [1, "2c139c1054adb2b4"],
  filling_in_details: [1, "0bd405bc24df8d2c"],
  booking_appointment: [1, "7f71f1a049a63ea0"],
  handing_over: [1, "eacc2533b4ea2b0f"],
  trip_planning: [1, "159f34042780e5da"],
  tax_time: [1, "9f0b4089f2579b41"],
  inbox_catch_up: [1, "080d36e50ab3ec35"],
  business_problem: [1, "64e782d899a96ddf"],
  school_family: [1, "c3a02155653925dc"],
  parents_affairs: [1, "6c914678604a7fd8"],
  sole_trader: [1, "5c5c68a4cdee8eba"],
  new_to_australia: [1, "a4ba91f01508738d"],
};

test("Warthog's guidance can't change without a new version", () => {
  const actual = Object.fromEntries(BUILTIN_SKILLS.map((skill) => [skill.key, [skill.version, createHash("sha256").update(skill.guidance).digest("hex").slice(0, 16)]]));
  assert.deepEqual(actual, PINS, "a skill's guidance changed: bump its version and update PINS");
});

test("a person who hasn't changed anything gets Warthog's text, everyday skills on and packs off", () => {
  const house = effectiveBuiltin(builtinByKey(HOUSE_KEY)!);
  assert.equal(house.state, "on");
  assert.equal(house.edited, false);
  const pack = effectiveBuiltin({ ...builtinByKey(HOUSE_KEY)!, group: "pack", startsOn: false });
  assert.equal(pack.state, "off");
});

test("an edit is the person's wording, and Warthog's newer text is offered rather than lost", () => {
  const def = builtinByKey(HOUSE_KEY)!;
  const mine = effectiveBuiltin(def, { state: "on", scope: { type: "all_agents" }, useThisWhen: null, guidance: "Mine.", basedOnVersion: def.version });
  assert.equal(mine.guidance, "Mine.");
  assert.equal(mine.useThisWhen, def.useThisWhen);
  assert.equal(mine.edited, true);
  assert.equal(mine.updateAvailable, false);
  const older = effectiveBuiltin({ ...def, version: def.version + 1 }, { state: "on", scope: { type: "all_agents" }, useThisWhen: null, guidance: "Mine.", basedOnVersion: def.version });
  assert.equal(older.updateAvailable, true);
});

test("an agent gets a Warthog skill only when it's on, in scope and the agent passes its gates", () => {
  const def = builtinByKey("life_admin_records")!;
  const on = effectiveBuiltin(def);
  assert.equal(builtinAvailableTo(on, "a1", gates("records_read")), true);
  assert.equal(builtinAvailableTo(on, "a1", gates()), false, "no Life admin access, no Life admin skill");
  const off = effectiveBuiltin(def, { state: "off", scope: { type: "all_agents" }, useThisWhen: null, guidance: null, basedOnVersion: null });
  assert.equal(builtinAvailableTo(off, "a1", gates("records_read")), false);
  const removed = effectiveBuiltin(def, { state: "removed", scope: { type: "all_agents" }, useThisWhen: null, guidance: null, basedOnVersion: null });
  assert.equal(builtinAvailableTo(removed, "a1", gates("records_read")), false);
  const chosen = effectiveBuiltin(def, { state: "on", scope: { type: "agents", agentIds: ["a2"] }, useThisWhen: null, guidance: null, basedOnVersion: null });
  assert.equal(builtinAvailableTo(chosen, "a1", gates("records_read")), false);
  assert.equal(builtinAvailableTo(chosen, "a2", gates("records_read")), true);
});

test("a Warthog skill's title is reserved, whatever the case or spacing", () => {
  assert.equal(isReservedSkillTitle("building a  PROFILE "), true);
  assert.equal(isReservedSkillTitle("Using Warthog"), true);
  assert.equal(isReservedSkillTitle("Rowing club"), false);
  assert.equal(builtinByTitle("life admin records")?.key, "life_admin_records");
});
