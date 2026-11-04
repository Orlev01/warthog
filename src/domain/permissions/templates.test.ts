// E03-S05 — Permission sets and templates (`src/domain/permissions/templates.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (the PermissionSet a template returns — its
// capability flags and the per-service grants), never the source text of the
// module, so a later rename that keeps behaviour leaves them untouched.
//
// This is a pure domain module (conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now). The consent screen and the per-agent
// permissions page build on these templates, so the starting sets live here as a
// pure function of (template name, the services the person ticked), built before
// its consumers.
//
// The vocabulary is EXACTLY the brief's ("Agent consent screen" + "Per-agent
// permissions page"):
//   Minimal  — the low-tier profile, skills and preferences, and logging
//              activity; NOTHING else.
//   Standard — Minimal PLUS reading shared memory, saving its own memories (kept
//              to itself unless sharing is switched on), tasks and life-admin
//              records, and the READ tools of the services the person ticks, with
//              those services' CHANGE-making tools set to "ask me first"; no
//              high-tier requests and no card requests.
//   Custom   — starts from Standard with every setting open to change. High-tier
//              requests, card requests and sharing what it learns are ALWAYS
//              opt-in (default off) — in every template.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
// The brief and this task's ACs fix WHAT each template grants but not the field
// names; the tester fixes those here and the builder conforms:
//
//   type PermissionTemplate = "minimal" | "standard" | "custom";
//
//   // One ticked service's grant: its read tools are granted, its change-making
//   // tools default to "ask me first" (the "ask_first" setting — same vocabulary
//   // as the rules module's RuleKind and the policy engine's "ask me first").
//   interface ServicePermission {
//     service: string;          // the connector/service id the person ticked
//     readTools: boolean;       // may use the service's read tools
//     changeTools: "ask_first"; // the change-making setting — default "ask me first"
//   }
//
//   interface PermissionSet {
//     lowTierProfile: boolean;   // read the low-tier profile without asking
//     skills: boolean;           // receives skills
//     preferences: boolean;      // receives preferences
//     activityLogging: boolean;  // may log activity
//     sharedMemoryRead: boolean; // may read shared memory
//     ownMemorySave: boolean;    // may save its own memories
//     tasks: boolean;            // may use tasks
//     lifeAdmin: boolean;        // may use life-admin records
//     services: ServicePermission[]; // one entry per ticked service
//     highTier: boolean;         // may REQUEST high-tier identity details (opt-in)
//     card: boolean;             // may REQUEST a card (opt-in)
//     learningSharing: boolean;  // shares what it learns with other agents (opt-in)
//     // the builder may carry extra fields (e.g. a `template` discriminator, a
//     // request limit, a card budget) — the tests read only the fields above, so
//     // extra fields do not break them.
//   }
//
//   // The template factory: a pure function of the template name and the ids of
//   // the services the person ticked (Minimal ignores the ticked services — it
//   // grants no services at all). Each call returns a FRESH, independently
//   // editable set (Custom is "fully editable").
//   function permissionTemplate(
//     template: PermissionTemplate,
//     services?: readonly string[],
//   ): PermissionSet;
//
// These tests build the ticked-service lists as plain string arrays and assert
// only on what `permissionTemplate` RETURNS — never on how the module is written.

import { test } from "node:test";
import assert from "node:assert/strict";

import { permissionTemplate } from "./templates";

// ---------------------------------------------------------------------------
// Local, loosely-typed views of the returned set — so the tests stay assignable
// to whatever (reasonable) shape the implementation gives the model, and read
// only the fields the ACs pin.
// ---------------------------------------------------------------------------

interface ServiceView {
  service: string;
  readTools: boolean;
  changeTools: string;
  [k: string]: unknown;
}

interface SetView {
  lowTierProfile: boolean;
  skills: boolean;
  preferences: boolean;
  activityLogging: boolean;
  sharedMemoryRead: boolean;
  ownMemorySave: boolean;
  tasks: boolean;
  lifeAdmin: boolean;
  services: ServiceView[];
  highTier: boolean;
  card: boolean;
  learningSharing: boolean;
  [k: string]: unknown;
}

const TEMPLATES = ["minimal", "standard", "custom"] as const;

const GMAIL = "gmail";
const GCAL = "google-calendar";
const TICKED = [GMAIL, GCAL];

// The four capabilities Minimal grants — the base every template carries.
const BASE_FOUR = ["lowTierProfile", "skills", "preferences", "activityLogging"] as const;

// The capabilities that are always opt-in (default off in EVERY template).
const OPT_IN = ["highTier", "card", "learningSharing"] as const;

// The capabilities Standard adds on top of the base four (service grants aside).
const STANDARD_ADDS = ["sharedMemoryRead", "ownMemorySave", "tasks", "lifeAdmin"] as const;

function build(template: (typeof TEMPLATES)[number], services?: readonly string[]): SetView {
  return permissionTemplate(template, services) as unknown as SetView;
}

// The capability flags only (no services) — used to assert Custom starts from
// Standard without locking any extra fields the builder may carry.
function flags(set: SetView): Record<string, boolean> {
  return {
    lowTierProfile: set.lowTierProfile,
    skills: set.skills,
    preferences: set.preferences,
    activityLogging: set.activityLogging,
    sharedMemoryRead: set.sharedMemoryRead,
    ownMemorySave: set.ownMemorySave,
    tasks: set.tasks,
    lifeAdmin: set.lifeAdmin,
    highTier: set.highTier,
    card: set.card,
    learningSharing: set.learningSharing,
  };
}

// The service grants, normalised and sorted — so two sets can be compared
// independent of ordering.
function services(set: SetView): Array<{ service: string; readTools: boolean; changeTools: string }> {
  return [...set.services]
    .map((s) => ({ service: s.service, readTools: s.readTools, changeTools: s.changeTools }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

function serviceFor(set: SetView, id: string): ServiceView | undefined {
  return set.services.find((s) => s.service === id);
}

// ===========================================================================
// AC1 — Minimal grants ONLY low-tier profile, skills, preferences and activity
// logging.
// ===========================================================================

test("Minimal grants the low-tier profile, skills, preferences and activity logging", () => {
  const set = build("minimal");
  assert.equal(set.lowTierProfile, true, "Minimal grants the low-tier profile");
  assert.equal(set.skills, true, "Minimal grants skills");
  assert.equal(set.preferences, true, "Minimal grants preferences");
  assert.equal(set.activityLogging, true, "Minimal grants activity logging");
});

test("Minimal grants NOTHING else — no memory, tasks, life-admin, services, high-tier, card or sharing", () => {
  const set = build("minimal");
  assert.equal(set.sharedMemoryRead, false, "Minimal does not grant shared-memory read");
  assert.equal(set.ownMemorySave, false, "Minimal does not grant own-memory save");
  assert.equal(set.tasks, false, "Minimal does not grant tasks");
  assert.equal(set.lifeAdmin, false, "Minimal does not grant life-admin");
  assert.deepEqual(set.services, [], "Minimal grants no services");
  assert.equal(set.highTier, false, "Minimal does not grant high-tier requests");
  assert.equal(set.card, false, "Minimal does not grant card requests");
  assert.equal(set.learningSharing, false, "Minimal does not share what it learns");
});

test("Minimal ignores ticked services — it grants no services even when some are passed", () => {
  // The consent screen only offers ticked-service grants from Standard up; Minimal
  // is "nothing else", so a ticked-service list passed to it changes nothing.
  const set = build("minimal", TICKED);
  assert.deepEqual(set.services, [], "a ticked-service list does not add service grants to Minimal");
});

// ===========================================================================
// AC2 — Standard adds shared-memory read, own-memory save, tasks, life-admin and
// the ticked services' read tools (change tools defaulting to ask-me-first), and
// never high-tier or card.
// ===========================================================================

test("Standard keeps the base four Minimal grants", () => {
  const set = build("standard");
  for (const cap of BASE_FOUR) {
    assert.equal(set[cap], true, `Standard keeps Minimal's ${cap}`);
  }
});

test("Standard adds shared-memory read, own-memory save, tasks and life-admin — even with no ticked services", () => {
  // These additions are not service-dependent: Standard grants them regardless of
  // which (if any) services the person ticks.
  const set = build("standard");
  for (const cap of STANDARD_ADDS) {
    assert.equal(set[cap], true, `Standard grants ${cap}`);
  }
});

test("Standard grants the read tools of each ticked service, with its change tools set to ask-me-first", () => {
  const set = build("standard", TICKED);
  assert.equal(set.services.length, TICKED.length, "one service grant per ticked service");
  for (const id of TICKED) {
    const grant = serviceFor(set, id);
    assert.ok(grant, `${id} appears in the service grants`);
    assert.equal(grant!.readTools, true, `${id}'s read tools are granted`);
    assert.equal(grant!.changeTools, "ask_first", `${id}'s change-making tools default to "ask me first"`);
  }
});

test("Standard never grants high-tier or card requests", () => {
  // Both with and without ticked services — ticking a service must never pull in
  // high-tier or card access.
  for (const ticked of [[] as string[], TICKED]) {
    const set = build("standard", ticked);
    assert.equal(set.highTier, false, "Standard never grants high-tier requests");
    assert.equal(set.card, false, "Standard never grants card requests");
  }
});

test("Standard does not share what it learns by default (sharing is opt-in)", () => {
  const set = build("standard", TICKED);
  assert.equal(set.learningSharing, false, "Standard keeps saved memories to the agent unless sharing is switched on");
});

// ===========================================================================
// AC3 — Custom starts from Standard (fully editable); high-tier, card and
// learning-sharing default off.
// ===========================================================================

test("Custom starts from Standard — same capability flags for the same ticked services", () => {
  const custom = build("custom", TICKED);
  const standard = build("standard", TICKED);
  assert.deepEqual(flags(custom), flags(standard), "Custom's starting flags equal Standard's");
  assert.deepEqual(services(custom), services(standard), "Custom's starting service grants equal Standard's");
});

test("Custom defaults high-tier, card and learning-sharing off", () => {
  const set = build("custom", TICKED);
  assert.equal(set.highTier, false, "Custom defaults high-tier requests off");
  assert.equal(set.card, false, "Custom defaults card requests off");
  assert.equal(set.learningSharing, false, "Custom defaults learning-sharing off");
});

test("Custom is fully editable — each call returns a fresh, independent set", () => {
  // "Fully editable" means the consent screen can mutate the returned set without
  // disturbing any other agent's set: distinct object and distinct arrays per call,
  // and mutating one leaves the other untouched.
  const a = build("custom", TICKED);
  const b = build("custom", TICKED);
  assert.notEqual(a, b, "each call returns a distinct set object");
  assert.notEqual(a.services, b.services, "each call returns a distinct services array");

  a.card = true;
  a.services.push({ service: "extra", readTools: true, changeTools: "ask_first" });
  assert.equal(b.card, false, "editing one set's card flag does not change another set");
  assert.equal(b.services.length, TICKED.length, "editing one set's services does not change another set");
});

// ===========================================================================
// Cross-template invariants — "high-tier, card and learning-sharing must always
// be opt-in", and the base four are the floor every template sits on. These hold
// across EVERY template, not just one in isolation.
// ===========================================================================

test("high-tier, card and learning-sharing are off (opt-in) in every template", () => {
  for (const template of TEMPLATES) {
    const set = build(template, TICKED);
    for (const cap of OPT_IN) {
      assert.equal(set[cap], false, `${template} defaults ${cap} off — it is always opt-in`);
    }
  }
});

test("the base four (profile, skills, preferences, activity logging) are granted in every template", () => {
  for (const template of TEMPLATES) {
    const set = build(template, TICKED);
    for (const cap of BASE_FOUR) {
      assert.equal(set[cap], true, `${template} grants ${cap}`);
    }
  }
});

test("every ticked-service grant a template makes is a read grant with ask-me-first changes", () => {
  // Wherever a template DOES grant services (Standard, Custom), every such grant is
  // a read grant whose change-making tools default to "ask me first" — never an
  // unticked allow-changes grant slipping in.
  for (const template of TEMPLATES) {
    const set = build(template, TICKED);
    for (const grant of set.services) {
      assert.equal(grant.readTools, true, `${template}: ${grant.service} grants read tools`);
      assert.equal(grant.changeTools, "ask_first", `${template}: ${grant.service} defaults changes to ask-me-first`);
    }
  }
});
