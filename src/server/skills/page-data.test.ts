// E13-S06 — Skills and preferences read for the page (list-all)
// (`src/server/skills/page-data.ts`).
//
// RED-first: the module under test does NOT exist yet, so importing `./page-data`
// throws and every test here fails until the builder writes it. That absence IS the
// point of test-first — do NOT implement anything to make these pass; the builder
// writes `page-data.ts` afterwards, composing the already-built, tested storage
// primitives (`listSkillsForUser`, `getPreferences`) and the pure domain constant
// (`HOUSE_SKILL`) rather than re-running SQL, re-implementing decryption, or
// hard-coding the house skill's wording.
//
// These tests pin BEHAVIOUR (what the read RETURNS: which skills, each with its scope
// and enabled state; the owner's preferences profile; the always-included Warthog house
// skill; who may read whose data; that every value is bound as a parameter) — never the
// source text of the module or any SQL. A later rename that preserves behaviour must not
// redden them. The house skill's wording is asserted against the REAL `HOUSE_SKILL`
// constant (not a literal here), so the two track together and no wording is hard-coded.
//
// WHY this exists (task E13-S06; design §4.1; brief "Skills, preferences and shared
// memory"): the Skills page needs ONE owner-scoped list-ALL read — every skill the
// person has written, ENABLED and DISABLED, each carrying its scope (all agents or a
// chosen set) and enabled state — PLUS the person's preferences profile, and it must
// note Warthog's own house skill, which is ALWAYS included for every agent and is not
// one of the person's skills (it cannot be switched off or scoped out — see
// `src/domain/skills/index.ts`). It is for the OWNER and NEVER returns another person's
// skills or preferences. A skill's content and every preferences field are PERSONAL
// CONTENT stored DEK-encrypted by their stores, so this read decrypts them under the
// INJECTED per-person DEK (it holds no key and reads no `process.env`).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type SkillScope = "all" | "chosen";   // the skills store's scope
//
//   // One of the person's own skills as the Skills page shows it: its id, its
//   // decrypted title + "use this when" line, its scope (+ chosen agent ids) and its
//   // on/off state.
//   interface SkillsPageItem {
//     id: string;
//     title: string;
//     useThisWhen: string;
//     scope: SkillScope;              // "all" | "chosen"
//     scopedAgentIds: string[];       // the chosen agents (empty for an 'all' skill)
//     enabled: boolean;               // the on/off switch
//   }
//
//   // Warthog's own house skill, ALWAYS included for every agent — not one of the
//   // person's skills, so it is carried separately and marked always-included.
//   interface HouseSkillMarker {
//     title: string;                  // === HOUSE_SKILL.title
//     useThisWhen: string;            // === HOUSE_SKILL.useThisWhen
//     alwaysIncluded: true;
//   }
//
//   interface SkillsPageData {
//     skills: SkillsPageItem[];                     // ALL of the owner's skills (on and off)
//     preferences: PreferencesProfile | null;       // the owner's profile, or null if unset
//     houseSkill: HouseSkillMarker;                 // the always-included house skill
//   }
//
//   skillsPageData(db, userId, dek): Promise<SkillsPageData>
//     • Lists ALL of `userId`'s skills — ENABLED and DISABLED — each content field
//       decrypted under the injected `dek`, carrying its scope (+ chosen agent ids) and
//       enabled state; reads the owner's preferences profile (null when unset), every
//       field decrypted under the same `dek`; and notes the always-included house skill
//       (its wording from the `HOUSE_SKILL` constant). Member-scoped by the `userId` the
//       caller passes (the session's id, never a client value): another person's skills
//       and preferences are never returned. The user id is bound as a parameter (no
//       spliced SQL).
//
// Acceptance criteria → tests:
//   AC1 "Returns all of the owner's skills with scope and enabled state and the
//        preferences profile, and marks the Warthog house skill as always included."
//   AC2 "A user never receives another user's skills or preferences."
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler rejects
//        malformed / oversized input with a 4xx (nothing reaches a query); the user id is
//        bound as a parameter and a SQL-injection probe in an input field travels as data
//        and cannot alter a query. The handler is a test fixture (the intended usage),
//        not an implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the read runs from its INJECTED deps
//        alone (db, userId, dek): no secret, no ambient config. Shown behaviourally: the
//        content decrypts only under the injected DEK (a different DEK cannot read it
//        back), and a decoy secret planted in the environment never lands in the page.
//
// Every real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`, so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { skillsPageData } from "./page-data";
import { createSkill, disableSkill, listSkillsForUser } from "../db/skills";
import { savePreferences, getPreferences } from "../db/preferences";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { parseBody, HttpError } from "../http/validate";
import { HOUSE_SKILL } from "../../domain/skills/index";
import type { Db } from "../db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this read only ever receives the already-unwrapped bytes (like the stores it uses).
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

// A structural view of a settable skill's content, so helpers below do not depend on the
// (absent) module's exported type. Scope defaults to 'all' (applies to every agent).
interface SkillFields {
  readonly title: string;
  readonly useThisWhen: string;
  readonly fullText: string;
  readonly scope: "all" | "chosen";
  readonly scopedAgentIds: string[];
}
function sampleSkill(overrides: Partial<SkillFields> = {}): SkillFields {
  return {
    title: "Travel booking",
    useThisWhen: "Use this when booking flights, trains or hotels for the person",
    fullText:
      "Always prefer refundable fares. Book an aisle seat. Keep each trip under the daily budget.",
    scope: "all",
    scopedAgentIds: [],
    ...overrides,
  };
}

// A structural view of a settable preferences profile's fields.
interface ProfileFields {
  readonly tone: string;
  readonly length: string;
  readonly language: string;
  readonly units: string;
  readonly timeZone: string;
  readonly briefing: string;
}
function sampleProfile(overrides: Partial<ProfileFields> = {}): ProfileFields {
  return {
    tone: "warm, direct",
    length: "concise",
    language: "en-AU",
    units: "metric",
    timeZone: "Australia/Sydney",
    briefing: "Brief me in plain English, bullet points first, no protocol jargon",
    ...overrides,
  };
}

// A structural view of a returned skills-page item, decoupled from the (absent) type.
interface SkillsPageItemLike {
  readonly id: string;
  readonly title: string;
  readonly useThisWhen: string;
  readonly scope: string;
  readonly scopedAgentIds: string[];
  readonly enabled: boolean;
}
// A structural view of the whole returned page data.
interface SkillsPageDataLike {
  readonly skills: SkillsPageItemLike[];
  readonly preferences:
    | {
        readonly userId?: string;
        readonly tone: string;
        readonly length: string;
        readonly language: string;
        readonly units: string;
        readonly timeZone: string;
        readonly briefing: string;
      }
    | null;
  readonly houseSkill: {
    readonly title: string;
    readonly useThisWhen: string;
    readonly alwaysIncluded: boolean;
  };
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

// Assert the probe reached the query layer as a BOUND value and never as spliced SQL text,
// scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// ===========================================================================
// AC1 — all of the owner's skills (ENABLED and DISABLED) with scope + enabled state, the
// preferences profile, and the always-included Warthog house skill.
// ===========================================================================

test("skillsPageData lists all of the owner's skills — enabled AND disabled — with scope and enabled state", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    // An 'all'-scope skill (enabled by default).
    const allSkill = await createSkill(
      db,
      { userId, ...sampleSkill({ title: "How I like updates", scope: "all", scopedAgentIds: [] }) },
      dek,
    );

    // A 'chosen'-scope skill naming two agents (enabled).
    const claude = randomUUID();
    const chatgpt = randomUUID();
    const chosenSkill = await createSkill(
      db,
      {
        userId,
        ...sampleSkill({ title: "Travel booking", scope: "chosen", scopedAgentIds: [claude, chatgpt] }),
      },
      dek,
    );

    // A third skill, then switch it OFF — a correct list-all still returns it (an
    // agent-facing read would wrongly drop a disabled skill).
    const offSkill = await createSkill(
      db,
      { userId, ...sampleSkill({ title: "Switch me off", scope: "all" }) },
      dek,
    );
    await disableSkill(db, userId, offSkill.id);

    const page = (await skillsPageData(db, userId, dek)) as SkillsPageDataLike;
    const byId = new Map(page.skills.map((s) => [s.id, s]));

    // Every skill — enabled AND disabled — is listed, and no extra (the house skill is
    // NOT one of the person's skills, so it is not mixed into this list).
    assert.equal(page.skills.length, 3, "all three of the owner's skills are listed");
    for (const s of [allSkill, chosenSkill, offSkill]) {
      assert.ok(byId.has(s.id), `skill ${s.id} is listed`);
    }

    // The decrypted content comes through (the page shows title + use-this-when).
    assert.equal(byId.get(allSkill.id)!.title, "How I like updates", "an enabled skill's title round-trips");
    assert.equal(
      byId.get(allSkill.id)!.useThisWhen,
      sampleSkill().useThisWhen,
      "the use-this-when line round-trips",
    );

    // Enabled state distinguishes on from off.
    assert.equal(byId.get(allSkill.id)!.enabled, true, "the 'all' skill is enabled");
    assert.equal(byId.get(chosenSkill.id)!.enabled, true, "the 'chosen' skill is enabled");
    assert.equal(byId.get(offSkill.id)!.enabled, false, "the switched-off skill is marked disabled, not dropped");

    // Scope round-trips — an 'all' skill vs a 'chosen' skill carrying its agent ids.
    assert.equal(byId.get(allSkill.id)!.scope, "all", "an all-agents skill's scope is 'all'");
    assert.equal(byId.get(chosenSkill.id)!.scope, "chosen", "a chosen-agents skill's scope is 'chosen'");
    assert.deepEqual(
      [...byId.get(chosenSkill.id)!.scopedAgentIds].sort(),
      [claude, chatgpt].sort(),
      "the chosen skill carries its chosen agent ids",
    );
  } finally {
    await db.close();
  }
});

test("skillsPageData returns the owner's preferences profile, decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-prefs");
    const dek = freshDek();
    const fields = sampleProfile();
    await savePreferences(db, { userId, ...fields }, dek);

    const page = (await skillsPageData(db, userId, dek)) as SkillsPageDataLike;

    // The page's preferences are exactly the canonical profile read (same decryption,
    // same shape) — behaviour-anchored to `getPreferences`, not a re-implementation.
    const expected = await getPreferences(db, userId, dek);
    assert.ok(page.preferences, "a profile was returned");
    assert.deepEqual(page.preferences, expected, "the page's preferences match the canonical profile read");
    assert.equal(page.preferences!.tone, fields.tone, "tone round-trips");
    assert.equal(page.preferences!.briefing, fields.briefing, "briefing round-trips");
  } finally {
    await db.close();
  }
});

test("skillsPageData returns null preferences for a person who has saved no profile", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-no-prefs");
    const page = (await skillsPageData(db, userId, freshDek())) as SkillsPageDataLike;
    assert.equal(page.preferences, null, "no profile → null, not an error");
  } finally {
    await db.close();
  }
});

test("skillsPageData marks the Warthog house skill as always included", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-house");
    const dek = freshDek();
    // Give the person one of their own skills so we can prove the house skill is noted
    // SEPARATELY, not folded into the owner's list.
    const own = await createSkill(db, { userId, ...sampleSkill({ title: "My own skill" }) }, dek);

    const page = (await skillsPageData(db, userId, dek)) as SkillsPageDataLike;

    // The house skill is carried and marked always-included, with the canonical wording.
    assert.equal(page.houseSkill.title, HOUSE_SKILL.title, "the house skill's title is the canonical one");
    assert.equal(
      page.houseSkill.useThisWhen,
      HOUSE_SKILL.useThisWhen,
      "the house skill's use-this-when is the canonical one",
    );
    assert.equal(page.houseSkill.alwaysIncluded, true, "the house skill is marked as always included");

    // It is NOT one of the person's skills — their list holds only their own skill.
    assert.equal(page.skills.length, 1, "the owner's list holds only their own skills");
    assert.equal(page.skills[0]!.id, own.id, "and it is the person's own skill, not the house skill");
  } finally {
    await db.close();
  }
});

test("skillsPageData returns an empty skill list and null preferences for a fresh person — still noting the house skill", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const page = (await skillsPageData(db, userId, freshDek())) as SkillsPageDataLike;

    assert.deepEqual(page.skills, [], "no skills → an empty list, not an error");
    assert.equal(page.preferences, null, "no profile → null");
    assert.equal(page.houseSkill.title, HOUSE_SKILL.title, "the house skill is still noted");
    assert.equal(page.houseSkill.alwaysIncluded, true, "and still marked always included");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a person NEVER receives another person's skills or preferences.
// ===========================================================================

test("skillsPageData returns only the owner's skills and preferences — never another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const dekA = freshDek();
    const dekB = freshDek();

    const aliceSkill = await createSkill(db, { userId: alice, ...sampleSkill({ title: "Alice only" }) }, dekA);
    const bobSkill = await createSkill(db, { userId: bob, ...sampleSkill({ title: "Bob only" }) }, dekB);

    await savePreferences(db, { userId: alice, ...sampleProfile({ tone: "alice-tone-unique" }) }, dekA);
    await savePreferences(db, { userId: bob, ...sampleProfile({ tone: "bob-tone-unique" }) }, dekB);

    // Alice's page: only Alice's skill and Alice's preferences.
    const alicePage = (await skillsPageData(db, alice, dekA)) as SkillsPageDataLike;
    const aliceIds = alicePage.skills.map((s) => s.id);
    assert.ok(aliceIds.includes(aliceSkill.id), "Alice sees her skill");
    assert.ok(!aliceIds.includes(bobSkill.id), "Alice never sees Bob's skill");
    assert.equal(alicePage.preferences!.tone, "alice-tone-unique", "Alice sees her own preferences");
    assert.notEqual(alicePage.preferences!.tone, "bob-tone-unique", "Alice never sees Bob's preferences");

    // Bob's page: only Bob's skill and Bob's preferences.
    const bobPage = (await skillsPageData(db, bob, dekB)) as SkillsPageDataLike;
    const bobIds = bobPage.skills.map((s) => s.id);
    assert.ok(bobIds.includes(bobSkill.id), "Bob sees his skill");
    assert.ok(!bobIds.includes(aliceSkill.id), "Bob never sees Alice's skill");
    assert.equal(bobPage.preferences!.tone, "bob-tone-unique", "Bob sees his own preferences");
    assert.notEqual(bobPage.preferences!.tone, "alice-tone-unique", "Bob never sees Alice's preferences");
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

function skillsHandler(
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
      const page = (await skillsPageData(db, sessionUserId, dek)) as SkillsPageDataLike;
      return new Response(
        JSON.stringify({
          skillIds: page.skills.map((s) => s.id),
          hasPreferences: page.preferences != null,
          houseSkillTitle: page.houseSkill.title,
        }),
        { status: 200 },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/skills/page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("skillsPageData binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE skills; --";

  const page = (await skillsPageData(db, probe, freshDek())) as SkillsPageDataLike;
  assert.deepEqual(page.skills, [], "the recording db returns no rows, so the skill list is empty");
  assert.equal(page.preferences, null, "the recording db returns no rows, so there is no profile");

  assertBoundNotSpliced(db, probe);
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = skillsHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = skillsHandler(db, freshDek(), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ filler: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler reads the SESSION user's data and ignores a user id supplied in the body", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice");
    const bob = await makeUser(db, "handler-bob");
    const dekA = freshDek();
    const dekB = freshDek();

    const aliceSkill = await createSkill(db, { userId: alice, ...sampleSkill() }, dekA);
    const bobSkill = await createSkill(db, { userId: bob, ...sampleSkill() }, dekB);
    await savePreferences(db, { userId: alice, ...sampleProfile() }, dekA);

    // The handler is Alice's session; the body tries to pass BOB's id.
    const handler = skillsHandler(db, dekA, alice);
    const res = await handler(jsonRequest(JSON.stringify({ userId: bob })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const body = (await res.json()) as { skillIds: string[]; hasPreferences: boolean };
    assert.ok(body.skillIds.includes(aliceSkill.id), "the handler reads the session (Alice's) skills");
    assert.ok(!body.skillIds.includes(bobSkill.id), "the body's user id is ignored — never widens the scope");
    assert.equal(body.hasPreferences, true, "and it reads Alice's preferences");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a skill's title round-trips through the read as inert data", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "Grace'); DROP TABLE skills; --";
    const created = await createSkill(db, { userId, ...sampleSkill({ title: probe }) }, dek);

    const page = (await skillsPageData(db, userId, dek)) as SkillsPageDataLike;

    assert.equal(await tableExists(db, "skills"), true, "the skills table survives the read (the probe is data, not SQL)");
    const item = page.skills.find((s) => s.id === created.id);
    assert.ok(item, "the skill is read back");
    assert.equal(item!.title, probe, "the probe title round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:secrets-from-env] (INV-103) — the read runs from its INJECTED deps
// alone (db, userId, dek): no secret, no ambient config; the content decrypts only under
// the injected DEK, so a different DEK cannot read it back (the key is injected, not
// baked in); and a decoy secret in the environment never lands in the page.
// ===========================================================================

test("skillsPageData runs from injected deps alone: no secret and no ambient configuration", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-secrets");
    const dek = freshDek();
    const created = await createSkill(db, { userId, ...sampleSkill() }, dek);
    await savePreferences(db, { userId, ...sampleProfile() }, dek);

    // Only db / userId / dek — no connection string, no key read from env.
    const page = (await skillsPageData(db, userId, dek)) as SkillsPageDataLike;

    assert.ok(page.skills.some((s) => s.id === created.id), "the page reads the skill with no secret or env handed to it");
    assert.ok(page.preferences, "the page reads the preferences with no secret or env handed to it");
  } finally {
    await db.close();
  }
});

test("skillsPageData cannot decrypt the owner's content with a different DEK (the key is injected, not baked in)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-wrongdek");
    const realDek = freshDek();
    // Seed BOTH a skill and a profile under the real DEK, so whichever the read decrypts
    // first, a wrong DEK fails the GCM tag and the whole read rejects.
    await createSkill(db, { userId, ...sampleSkill() }, realDek);
    await savePreferences(db, { userId, ...sampleProfile() }, realDek);

    const wrongDek = freshDek();
    await assert.rejects(
      () => skillsPageData(db, userId, wrongDek),
      "a DEK that did not encrypt the content cannot read it back",
    );
  } finally {
    await db.close();
  }
});

test("skillsPageData folds no ambient env value into the page: a decoy secret in the environment never appears", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-decoy");
    const dek = freshDek();
    await createSkill(db, { userId, ...sampleSkill() }, dek);
    await savePreferences(db, { userId, ...sampleProfile() }, dek);

    const page = (await skillsPageData(db, userId, dek)) as SkillsPageDataLike;

    assert.equal(page.skills.length, 1, "the read works purely from the injected db — no app env needed");
    assert.ok(page.preferences, "the profile reads purely from the injected db");
    assert.ok(
      !JSON.stringify(page).includes(DECOY),
      "no ambient env value is folded into the returned page data",
    );

    // Sanity: the skills the read returned carry no decoy (scoped narrowly to this read).
    const stored = await listSkillsForUser(db, userId, dek);
    for (const s of stored) {
      assert.ok(!JSON.stringify(s).includes(DECOY), "no ambient env value is written into a skill");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
