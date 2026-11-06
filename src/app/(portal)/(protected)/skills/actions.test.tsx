// E13-S08 — Skills page loader + actions
// (`src/app/(portal)/(protected)/skills/actions.ts`, mounted by the thin
// `skills/page.tsx`).
//
// RED-first: the skills-page actions seam does NOT exist yet, so importing
// `./actions` throws (ERR_MODULE_NOT_FOUND) and `tsc --noEmit` reddens on the
// missing module — every test here fails until the builder writes it. That absence
// IS the point of test-first; do NOT implement anything to make these pass. The
// builder writes `actions.ts` afterwards to satisfy exactly this contract and wires
// the thin `page.tsx` over it.
//
// These tests pin BEHAVIOUR (what the loader RETURNS and the view it mounts; what
// each mutation CHANGES in the database; what each one REFUSES) against an isolated
// in-memory PGlite with the REAL migrations (src/test/db) and the REAL already-built
// seams the actions compose — the skills store (`db/skills`, DEK-encrypted content +
// plaintext scope/enabled metadata, E13-S02), the preferences store (`db/preferences`,
// DEK-encrypted, one row per person, E13-S01), the agents store (`db/agents`, for the
// chosen-scope ownership check) and the already-render-tested <SkillsView/> (E13-S07).
// No test asserts on the source text of any module, so a later behaviour-preserving
// refactor (a rename, a moved import) stays green.
//
// Where the task names an entry/page file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// `vault/actions.ts`, `connectors/actions.ts`, `agents/[id]/actions.ts` and
// `settings/security/actions.ts` do) — NEVER on the thin `page.tsx`, which may export
// only its framework fields (`next build` rejects any other export, OBS-025). These
// tests drive that factory directly with real seams; the page mounts a thin loader +
// `"use server"` wrappers over it. A server PAGE that reads the session cookie +
// database cannot be rendered without a live request scope, so — exactly like the
// sibling vault/activity loader tests — the loader's data assembly is pinned on the
// factory's `load`, and the SCREEN it mounts is pinned by feeding `load`'s output
// straight into <SkillsView/>.
//
// WHY this exists (task E13-S08; brief §"Skills, preferences and shared memory";
// design §4.1; CLAUDE.md — skills/preferences are PERSONAL CONTENT stored DEK-encrypted
// and every member-scoped read/write takes userId from the session, never a client
// value). The skills triad reads the person's skills + preferences server-side and
// mounts the view; the actions persist the preferences profile and create / edit /
// duplicate / switch / delete the person's skills, with a chosen scope limited to the
// person's own agents.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   createSkillsActions(deps: { db: Db; keyWrapper: KeyWrapper }): {
//     // the owner's skills + preferences, read member-scoped by session.userId and
//     // shaped into the props <SkillsView/> is mounted over (skills decrypted, the
//     // preferences profile decrypted or null, plus the always-included house skill).
//     load(session): Promise<{ skills; preferences; houseSkill }>
//
//     // upsert the session user's ONE communication-style profile (owner = session,
//     // never a userId smuggled in the input).
//     savePreferences(session, { tone; length; language; units; timeZone; briefing }): Promise<Result>
//
//     // create a NEW skill for the session user. A 'chosen' scope accepts ONLY the
//     // session user's own agents (a foreign / nonexistent agent id is refused and
//     // nothing is stored).
//     createSkill(session, { title; useThisWhen; fullText; scope; scopedAgentIds? }): Promise<Result>
//
//     // replace an OWNED skill's content + scope (id validated at the boundary; a
//     // 'chosen' scope accepts only the session user's own agents). A skill that is
//     // not the session user's is refused and left unchanged.
//     editSkill(session, { id; title; useThisWhen; fullText; scope; scopedAgentIds? }): Promise<Result>
//
//     // copy an OWNED skill into a new one (id validated; a foreign skill is refused).
//     duplicateSkill(session, { id }): Promise<Result>
//
//     // switch an OWNED skill on/off (id validated; a foreign skill is refused).
//     toggleSkill(session, { id; enabled }): Promise<Result>
//
//     // delete an OWNED skill (id validated; a foreign skill is a safe no-op refusal).
//     deleteSkill(session, { id }): Promise<Result>
//   }
//
//   Result = { ok: true } | { ok: false; reason: string }   // never a silent success
//
//   • every read/write is member-scoped by session.userId (the project rule + INV-102):
//     another person's skills / preferences are never read, changed or removed by id.
//   • a 'chosen' scope accepts ONLY the session user's own agents (brief §4.1 — skills
//     are scoped to chosen agents; an agent id that is not the person's is refused).
//   • input is validated at the boundary (zod → a 4xx HttpError) BEFORE anything is
//     written, so malformed / oversized input writes nothing (INV-102). A malformed
//     skill id is rejected as a 4xx BEFORE it can reach `WHERE id = $1` as a cast
//     (OBS-049). Every value reaches storage bound as a query parameter (and the
//     content is additionally DEK-encrypted first), so a value shaped like SQL is
//     stored as data and cannot alter a query.
//   • the module reads no process.env and holds no secret (INV-103): the db and the
//     KeyWrapper are INJECTED seams, so no ambient env value lands in any output.
//
// ─── NOTE on the acceptance-criterion wording vs. this codebase ──────────────────────
// AC2 says "a skill id that is not a positive INTEGER is rejected with a 4xx". That
// phrasing is generic obligation boilerplate (serial catalogue ids); in Warthog
// `skills.id` is a `uuid` (db/migrations/0031_skills.sql — gen_random_uuid()), and the
// sibling stores/actions validate ids with `z.uuid()`. The obligation here is OBS-049 /
// validate-and-parameterize-input: a MALFORMED id is rejected at the boundary with a
// 4xx before it can reach `WHERE id = $1` as a cast. We honour the obligation using the
// ACTUAL id shape — and the malformed probes below include a bare integer, a negative, a
// decimal and the empty string, so "not a positive integer is rejected" holds true as a
// special case of "not a well-formed uuid is rejected".
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's skills + preferences and mounts
//        SkillsView over them (wired to savePreferences / createSkill / editSkill /
//        duplicateSkill / toggleSkill / deleteSkill).
//   AC2  a malformed skill id is rejected with a 4xx (not a raw cast); a 'chosen' scope
//        accepts only the session user's own agents.
//   AC3  a signed-in user cannot READ or CHANGE another user's skills or preferences by
//        id (filtered by session user id).
//   AC4  a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
//        probe in an input field cannot alter a query (parameter binding).  [validate-and-parameterize-input]
//   AC5  no secret value lands in a loaded/saved result; config is read from env.      [secrets-from-env]
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb(). The signed-in person is a REAL user row (every member
// table's user_id is a foreign key to users(id)) whose stored wrapped DEK really
// unwraps under the test KeyWrapper, so content round-trips decrypted. We render
// SkillsView with `react-dom/server` (no DOM/jsdom — React component / E2E testing is a
// per-job ADR), exactly as the sibling view + loader tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createSkillsActions } from "./actions";

import { SkillsView } from "@/components/skills/skills-view";
import { HOUSE_SKILL } from "@/domain/skills/index";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import {
  createSkill as seedSkill,
  listSkillsForUser,
} from "@/server/db/skills";
import {
  savePreferences as seedPreferences,
  getPreferences,
} from "@/server/db/preferences";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit key-encryption key for the local AES wrapper
const NOW = new Date("2026-06-01T00:00:00.000Z");

// A real local KeyWrapper (dev/test), exactly the one a non-production composition
// root selects — so wrap/unwrap is genuine, not a stub.
function makeKeyWrapper(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose stored wrapped-DEK really unwraps (under `keyWrapper`) to the
// returned `dek`, so content saved by the actions round-trips decrypted through the
// stores, and the loader can decrypt what it reads back. Emails are uniquified so
// parallel test files never collide on users.email UNIQUE.
async function makeUserWithDek(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek,
  });
  return { userId: user.id, dek };
}

// Give `userId` one of their OWN agents and return its id, for the chosen-scope
// ownership check (a skill scoped to 'chosen' may only list the person's own agents).
async function makeAgent(db: Db, userId: string, name: string): Promise<string> {
  const agent = await createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName: name, platform: "claude" },
    systemClock,
  );
  return agent.id;
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// Build the skills actions under test with the real db + keyWrapper seams.
function makeActions(db: Db, keyWrapper: KeyWrapper) {
  return createSkillsActions({ db, keyWrapper });
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL when it does not — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Visible text with tags stripped: the words a sighted reader sees (no attributes).
function strip(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- types/casts derived from the factory (so tests don't hard-code a type NAME) ----
type Actions = ReturnType<typeof createSkillsActions>;
type SaveResult = Awaited<ReturnType<Actions["createSkill"]>>;

// Cast a loose object (what an untrusted form body could carry) to a method's input
// type, so a test can pass a partial edit, a malformed value, or a smuggled rogue key
// without a type error — exactly what an untrusted body could carry.
const prefsInput = (o: Record<string, unknown>): Parameters<Actions["savePreferences"]>[1] =>
  o as unknown as Parameters<Actions["savePreferences"]>[1];
const createInput = (o: Record<string, unknown>): Parameters<Actions["createSkill"]>[1] =>
  o as unknown as Parameters<Actions["createSkill"]>[1];
const editInput = (o: Record<string, unknown>): Parameters<Actions["editSkill"]>[1] =>
  o as unknown as Parameters<Actions["editSkill"]>[1];
const dupInput = (o: Record<string, unknown>): Parameters<Actions["duplicateSkill"]>[1] =>
  o as unknown as Parameters<Actions["duplicateSkill"]>[1];
const toggleInput = (o: Record<string, unknown>): Parameters<Actions["toggleSkill"]>[1] =>
  o as unknown as Parameters<Actions["toggleSkill"]>[1];
const deleteInput = (o: Record<string, unknown>): Parameters<Actions["deleteSkill"]>[1] =>
  o as unknown as Parameters<Actions["deleteSkill"]>[1];

const okOf = (r: unknown): boolean => (r as { ok: boolean }).ok;

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
      (err as HttpError).status >= 400 && (err as HttpError).status < 500,
      `${label}: the rejection must carry a 4xx status, got ${(err as HttpError).status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// Assert a mutation is REFUSED — either a thrown 4xx HttpError or a reported
// { ok: false } refusal, never a silent success and never an uncontrolled 500. (An
// ownership/scope refusal that depends on stored state may legitimately be reported
// rather than thrown; this accepts both, but a thrown plain Error — a raw 500 — fails.)
async function assertRejected(label: string, fn: () => Promise<SaveResult>): Promise<void> {
  let result: SaveResult | undefined;
  try {
    result = await fn();
  } catch (err) {
    assert.ok(
      err instanceof HttpError && err.status >= 400 && err.status < 500,
      `${label}: a thrown rejection must be a 4xx HttpError (not a raw 500), got ${String(err)}`,
    );
    return;
  }
  assert.equal(
    okOf(result),
    false,
    `${label}: the mutation must be refused (ok:false), not a silent success`,
  );
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's skills + preferences and mounts
// SkillsView over them.
// =====================================================================================

test("the loader returns the session user's skills + preferences and mounts SkillsView over them", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "loader-ok");

    // A saved preferences profile and one skill (both DEK-encrypted by the stores).
    await seedPreferences(
      db,
      {
        userId,
        tone: "Warm and plain",
        length: "Short",
        language: "English (Australia)",
        units: "Metric",
        timeZone: "Australia/Perth",
        briefing: "Tell me the headline first",
      },
      dek,
    );
    const SKILL_TITLE = "Weekly grocery run";
    const SKILL_WHEN = "when I ask you to top up the pantry";
    await seedSkill(
      db,
      { userId, title: SKILL_TITLE, useThisWhen: SKILL_WHEN, fullText: "Buy the usual staples.", scope: "all" },
      dek,
    );

    const data = await makeActions(db, keyWrapper).load(sessionFor(userId));

    // The loader hands back the owner's decrypted skill + preferences and the
    // always-included house skill (not one of the person's skills).
    assert.ok(
      data.skills.some((s: { title?: string }) => s.title === SKILL_TITLE),
      `the loader returns the owner's skill; got ${JSON.stringify(data.skills)}`,
    );
    assert.ok(data.preferences != null, "the loader returns the owner's saved preferences profile");
    assert.equal(
      (data.preferences as { tone?: string }).tone,
      "Warm and plain",
      "the preferences profile is decrypted",
    );
    assert.equal(data.houseSkill.title, HOUSE_SKILL.title, "the always-included house skill is carried");

    // "mounts SkillsView": the loader's output IS the screen's data — feeding it
    // straight into the already-render-tested view renders the owner's skills screen.
    const markup = renderToStaticMarkup(
      <SkillsView skills={data.skills} preferences={data.preferences} houseSkill={data.houseSkill} />,
    );
    const text = strip(markup);
    assert.ok(text.includes(SKILL_TITLE), "mounting SkillsView renders the owner's skill title");
    assert.ok(text.includes(SKILL_WHEN), "the owner's use-this-when line renders");
    assert.ok(text.includes(HOUSE_SKILL.title), "the house skill renders, always included");
    assert.ok(markup.includes("Warm and plain"), "the owner's saved tone renders as an editable control");
  } finally {
    await db.close();
  }
});

test("the loader returns a null preferences profile and no skills for a person who has saved neither", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "loader-empty");

    const data = await makeActions(db, keyWrapper).load(sessionFor(userId));

    assert.deepEqual(data.skills, [], "a person with no skills gets an empty list");
    assert.equal(data.preferences, null, "a person with no profile gets a null profile");
    assert.equal(data.houseSkill.title, HOUSE_SKILL.title, "the house skill is present even with nothing saved");

    // The screen still renders (the house skill, the create/save controls) with no
    // person-skills — no crash on the empty case.
    const text = strip(
      renderToStaticMarkup(
        <SkillsView skills={data.skills} preferences={data.preferences} houseSkill={data.houseSkill} />,
      ),
    );
    assert.ok(text.includes(HOUSE_SKILL.title), "the empty screen still shows the house skill");
  } finally {
    await db.close();
  }
});

test("savePreferences / createSkill persist the session user's content, which the loader reads back decrypted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "roundtrip");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const savedPrefs = await actions.savePreferences(
      session,
      prefsInput({
        tone: "Direct",
        length: "Medium",
        language: "English",
        units: "Metric",
        timeZone: "Australia/Sydney",
        briefing: "Bullet points",
      }),
    );
    assert.equal(okOf(savedPrefs), true, "savePreferences succeeds for the session user");

    const createdSkill = await actions.createSkill(
      session,
      createInput({
        title: "Book flights",
        useThisWhen: "when I want to travel somewhere",
        fullText: "Prefer morning departures.",
        scope: "all",
      }),
    );
    assert.equal(okOf(createdSkill), true, "createSkill succeeds for the session user");

    // Both round-trip through the stores, decrypted under the owner's DEK.
    const profile = await getPreferences(db, userId, dek);
    assert.equal(profile?.tone, "Direct", "the saved tone round-trips decrypted");
    assert.equal(profile?.briefing, "Bullet points", "the saved briefing round-trips decrypted");
    const skills = await listSkillsForUser(db, userId, dek);
    assert.ok(skills.some((s) => s.title === "Book flights"), "the created skill round-trips decrypted");

    // …and the loader reflects exactly what was saved.
    const data = await actions.load(session);
    assert.equal((data.preferences as { tone?: string } | null)?.tone, "Direct", "the loader reads the saved profile");
    assert.ok(
      data.skills.some((s: { title?: string }) => s.title === "Book flights"),
      "the loader reads the created skill",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — a malformed skill id is rejected with a 4xx (not a raw cast); a 'chosen' scope
// accepts only the session user's own agents.
// =====================================================================================

test("a malformed skill id is rejected with a 4xx before any query (OBS-049) — edit / duplicate / toggle / delete", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "bad-id");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // Not a well-formed uuid — including a bare integer, a negative, a decimal, the
    // empty string, whitespace and a SQL-shaped id. Each is rejected at the boundary
    // BEFORE it can reach `WHERE id = $1` as a cast (so it never surfaces as a 500, and
    // a SQL-shaped id never reaches a query). "A bare integer is rejected" subsumes the
    // criterion's "not a positive integer".
    const badIds = ["5", "-1", "1.5", "", "   ", "not-a-uuid", "x'; DROP TABLE skills; --"];
    for (const badId of badIds) {
      await assertRejects4xx(`editSkill(id=${JSON.stringify(badId)})`, () =>
        actions.editSkill(
          session,
          editInput({ id: badId, title: "x", useThisWhen: "y", fullText: "z", scope: "all" }),
        ),
      );
      await assertRejects4xx(`duplicateSkill(id=${JSON.stringify(badId)})`, () =>
        actions.duplicateSkill(session, dupInput({ id: badId })),
      );
      await assertRejects4xx(`toggleSkill(id=${JSON.stringify(badId)})`, () =>
        actions.toggleSkill(session, toggleInput({ id: badId, enabled: false })),
      );
      await assertRejects4xx(`deleteSkill(id=${JSON.stringify(badId)})`, () =>
        actions.deleteSkill(session, deleteInput({ id: badId })),
      );
    }

    // The table is intact — no SQL-shaped id was ever executed.
    assert.equal(await tableExists(db, "skills"), true, "the skills table survives a SQL-shaped id");
  } finally {
    await db.close();
  }
});

test("createSkill with a 'chosen' scope accepts the session user's OWN agents and stores them", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "scope-own");
    const myAgent = await makeAgent(db, userId, "My Claude");
    const actions = makeActions(db, keyWrapper);

    const result = await actions.createSkill(
      sessionFor(userId),
      createInput({
        title: "Investor updates",
        useThisWhen: "when drafting an investor note",
        fullText: "Keep it factual.",
        scope: "chosen",
        scopedAgentIds: [myAgent],
      }),
    );
    assert.equal(okOf(result), true, "a skill scoped to the person's own agent is accepted");

    const skills = await listSkillsForUser(db, userId, dek);
    const stored = skills.find((s) => s.title === "Investor updates");
    assert.ok(stored != null, "the chosen-scope skill is stored");
    assert.equal(stored!.scope, "chosen", "its scope is chosen");
    assert.deepEqual(stored!.scopedAgentIds, [myAgent], "its chosen agent id is stored");
  } finally {
    await db.close();
  }
});

test("createSkill with a 'chosen' scope REFUSES a foreign or nonexistent agent id and stores nothing", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "scope-foreign");
    const other = await makeUserWithDek(db, keyWrapper, "scope-other");
    const othersAgent = await makeAgent(db, other.userId, "Someone else's Claude");
    const actions = makeActions(db, keyWrapper);

    // Another person's real agent id — well-formed, but NOT the session user's.
    await assertRejected("createSkill(chosen → another person's agent)", () =>
      actions.createSkill(
        sessionFor(userId),
        createInput({
          title: "Leak via scope",
          useThisWhen: "x",
          fullText: "y",
          scope: "chosen",
          scopedAgentIds: [othersAgent],
        }),
      ),
    );
    // A syntactically valid uuid that is nobody's agent.
    await assertRejected("createSkill(chosen → nonexistent agent)", () =>
      actions.createSkill(
        sessionFor(userId),
        createInput({
          title: "Leak via ghost",
          useThisWhen: "x",
          fullText: "y",
          scope: "chosen",
          scopedAgentIds: [randomUUID()],
        }),
      ),
    );

    // Nothing was stored by either refused create.
    const mine = await listSkillsForUser(db, userId, dek);
    assert.ok(!mine.some((s) => s.title === "Leak via scope"), "no skill was stored for the foreign-agent scope");
    assert.ok(!mine.some((s) => s.title === "Leak via ghost"), "no skill was stored for the nonexistent-agent scope");
  } finally {
    await db.close();
  }
});

test("editSkill REFUSES a 'chosen' scope naming an agent that is not the session user's and leaves the skill unchanged", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "edit-scope");
    const other = await makeUserWithDek(db, keyWrapper, "edit-scope-other");
    const othersAgent = await makeAgent(db, other.userId, "Not mine");
    const actions = makeActions(db, keyWrapper);

    // An owned skill, scoped to all agents.
    const seeded = await seedSkill(
      db,
      { userId, title: "Pantry", useThisWhen: "groceries", fullText: "staples", scope: "all" },
      dek,
    );

    await assertRejected("editSkill(chosen → another person's agent)", () =>
      actions.editSkill(
        sessionFor(userId),
        editInput({
          id: seeded.id,
          title: "Pantry",
          useThisWhen: "groceries",
          fullText: "staples",
          scope: "chosen",
          scopedAgentIds: [othersAgent],
        }),
      ),
    );

    // The skill is unchanged — still 'all', not re-scoped to the foreign agent.
    const after = (await listSkillsForUser(db, userId, dek)).find((s) => s.id === seeded.id);
    assert.ok(after != null, "the skill still exists after a refused edit");
    assert.equal(after!.scope, "all", "the refused edit did not re-scope the skill");
    assert.ok(!after!.scopedAgentIds.includes(othersAgent), "the foreign agent id was never stored on the skill");
  } finally {
    await db.close();
  }
});

test("toggleSkill switches an owned skill off and back on; duplicate and delete act on the owner's skill", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "lifecycle");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const seeded = await seedSkill(
      db,
      { userId, title: "Morning brief", useThisWhen: "each morning", fullText: "Summarise the day.", scope: "all" },
      dek,
    );
    assert.equal(
      (await listSkillsForUser(db, userId, dek)).find((s) => s.id === seeded.id)!.enabled,
      true,
      "precondition: a fresh skill is on",
    );

    // Switch off → persists as disabled, not deleted.
    const off = await actions.toggleSkill(session, toggleInput({ id: seeded.id, enabled: false }));
    assert.equal(okOf(off), true, "switching a skill off succeeds");
    assert.equal(
      (await listSkillsForUser(db, userId, dek)).find((s) => s.id === seeded.id)!.enabled,
      false,
      "the skill is now off (still present)",
    );

    // Switch back on → enabled again (the 'Switch on' control is not dead).
    const on = await actions.toggleSkill(session, toggleInput({ id: seeded.id, enabled: true }));
    assert.equal(okOf(on), true, "switching a skill back on succeeds");
    assert.equal(
      (await listSkillsForUser(db, userId, dek)).find((s) => s.id === seeded.id)!.enabled,
      true,
      "the skill is on again",
    );

    // Duplicate → a second skill with the same content exists.
    const dup = await actions.duplicateSkill(session, dupInput({ id: seeded.id }));
    assert.equal(okOf(dup), true, "duplicating an owned skill succeeds");
    assert.equal(
      (await listSkillsForUser(db, userId, dek)).filter((s) => s.title === "Morning brief").length,
      2,
      "the duplicate is a second skill with the same title",
    );

    // Delete the original → it is gone; the duplicate remains.
    const del = await actions.deleteSkill(session, deleteInput({ id: seeded.id }));
    assert.equal(okOf(del), true, "deleting an owned skill succeeds");
    const remaining = await listSkillsForUser(db, userId, dek);
    assert.ok(!remaining.some((s) => s.id === seeded.id), "the deleted skill is gone");
    assert.equal(remaining.filter((s) => s.title === "Morning brief").length, 1, "the duplicate survives the delete");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a signed-in user cannot READ or CHANGE another user's skills or preferences by
// id (filtered by session user id).
// =====================================================================================

test("the loader reads ONLY the session user's skills + preferences — another person's never appear", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "read-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "read-other");
    const actions = makeActions(db, keyWrapper);

    await seedPreferences(
      db,
      { userId: alice.userId, tone: "Alice tone secret", length: "L", language: "en", units: "m", timeZone: "Z", briefing: "b" },
      alice.dek,
    );
    await seedSkill(
      db,
      { userId: alice.userId, title: "Alice only skill", useThisWhen: "x", fullText: "y", scope: "all" },
      alice.dek,
    );
    await seedSkill(
      db,
      { userId: bob.userId, title: "Bob own skill", useThisWhen: "x", fullText: "y", scope: "all" },
      bob.dek,
    );

    const bobsScreen = await actions.load(sessionFor(bob.userId));

    assert.ok(
      bobsScreen.skills.some((s: { title?: string }) => s.title === "Bob own skill"),
      "Bob sees his own skill",
    );
    const whole = JSON.stringify(bobsScreen);
    assert.ok(!whole.includes("Alice only skill"), "Alice's skill never appears on Bob's screen");
    assert.ok(!whole.includes("Alice tone secret"), "Alice's preferences never appear on Bob's screen");
  } finally {
    await db.close();
  }
});

test("a signed-in user cannot CHANGE another person's skill by id — it is untouched and nothing is created", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "change-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "change-attacker");
    const actions = makeActions(db, keyWrapper);

    const alicesSkill = await seedSkill(
      db,
      { userId: alice.userId, title: "Alice secret skill", useThisWhen: "hers", fullText: "private", scope: "all" },
      alice.dek,
    );

    // Bob, holding Alice's real skill id, tries every mutation on it. Each is refused
    // (member-scoped by Bob's session id) — never an uncontrolled 500.
    await assertRejected("editSkill(bob → alice's skill)", () =>
      actions.editSkill(
        sessionFor(bob.userId),
        editInput({ id: alicesSkill.id, title: "hijacked", useThisWhen: "x", fullText: "z", scope: "all" }),
      ),
    );
    await assertRejected("toggleSkill(bob → alice's skill)", () =>
      actions.toggleSkill(sessionFor(bob.userId), toggleInput({ id: alicesSkill.id, enabled: false })),
    );
    await assertRejected("duplicateSkill(bob → alice's skill)", () =>
      actions.duplicateSkill(sessionFor(bob.userId), dupInput({ id: alicesSkill.id })),
    );
    await assertRejected("deleteSkill(bob → alice's skill)", () =>
      actions.deleteSkill(sessionFor(bob.userId), deleteInput({ id: alicesSkill.id })),
    );

    // Alice's skill is unchanged: still present, same title, still on.
    const alices = await listSkillsForUser(db, alice.userId, alice.dek);
    const stillThere = alices.find((s) => s.id === alicesSkill.id);
    assert.ok(stillThere != null, "Alice's skill still exists");
    assert.equal(stillThere!.title, "Alice secret skill", "Alice's skill title is unchanged");
    assert.equal(stillThere!.enabled, true, "Alice's skill was not switched off by Bob");
    assert.equal(alices.length, 1, "Bob's duplicate attempt created nothing under Alice");

    // Bob gained nothing from the borrowed id.
    assert.deepEqual(await listSkillsForUser(db, bob.userId, bob.dek), [], "Bob's refused attempts created no skill for him");
  } finally {
    await db.close();
  }
});

test("savePreferences / createSkill take the owner from the session — a userId smuggled in the input is ignored", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const session = await makeUserWithDek(db, keyWrapper, "scope-session");
    const victim = await makeUserWithDek(db, keyWrapper, "scope-victim");
    const actions = makeActions(db, keyWrapper);

    // Both inputs try to write under the victim's id.
    const savedPrefs = await actions.savePreferences(
      sessionFor(session.userId),
      prefsInput({
        tone: "Smuggled tone",
        length: "L",
        language: "en",
        units: "m",
        timeZone: "Z",
        briefing: "b",
        userId: victim.userId,
      }),
    );
    assert.equal(okOf(savedPrefs), true, "the profile save succeeds under the session user");
    const savedSkill = await actions.createSkill(
      sessionFor(session.userId),
      createInput({ title: "Smuggled skill", useThisWhen: "x", fullText: "y", scope: "all", userId: victim.userId }),
    );
    assert.equal(okOf(savedSkill), true, "the skill create succeeds under the session user");

    // Everything landed under the SESSION user, never the smuggled victim id.
    assert.equal((await getPreferences(db, session.userId, session.dek))?.tone, "Smuggled tone", "the profile is the session user's");
    assert.equal(await getPreferences(db, victim.userId, victim.dek), null, "the victim gained no profile");
    assert.ok(
      (await listSkillsForUser(db, session.userId, session.dek)).some((s) => s.title === "Smuggled skill"),
      "the skill is stored under the session user",
    );
    assert.deepEqual(
      await listSkillsForUser(db, victim.userId, victim.dek),
      [],
      "the smuggled userId never redirected the write to another person",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
// probe in an input field is bound as data (parameter binding).
// [obligation:validate-and-parameterize-input]
// =====================================================================================

test("malformed input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "malformed");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // createSkill: an unknown scope value, a missing title, a title that is not a string.
    await assertRejects4xx("createSkill(unknown scope)", () =>
      actions.createSkill(session, createInput({ title: "x", useThisWhen: "y", fullText: "z", scope: "everyone" })),
    );
    await assertRejects4xx("createSkill(missing title)", () =>
      actions.createSkill(session, createInput({ useThisWhen: "y", fullText: "z", scope: "all" })),
    );
    await assertRejects4xx("createSkill(title not a string)", () =>
      actions.createSkill(session, createInput({ title: 42, useThisWhen: "y", fullText: "z", scope: "all" })),
    );
    // createSkill: a 'chosen' scope with an agent id that is not a well-formed uuid.
    await assertRejects4xx("createSkill(chosen with malformed agent id)", () =>
      actions.createSkill(
        session,
        createInput({ title: "x", useThisWhen: "y", fullText: "z", scope: "chosen", scopedAgentIds: ["not-a-uuid"] }),
      ),
    );
    // savePreferences: a missing field, and a field that is not a string.
    await assertRejects4xx("savePreferences(missing field)", () =>
      actions.savePreferences(session, prefsInput({ tone: "t", length: "l", language: "en", units: "m", timeZone: "Z" })),
    );
    await assertRejects4xx("savePreferences(field not a string)", () =>
      actions.savePreferences(
        session,
        prefsInput({ tone: 7, length: "l", language: "en", units: "m", timeZone: "Z", briefing: "b" }),
      ),
    );

    // Nothing was persisted by any rejected call.
    assert.deepEqual(await listSkillsForUser(db, userId, dek), [], "no malformed skill was stored");
    assert.equal(await getPreferences(db, userId, dek), null, "no malformed profile was stored");
  } finally {
    await db.close();
  }
});

test("oversized input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "oversized");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);
    const HUGE = "x".repeat(200_000);

    await assertRejects4xx("createSkill(oversized title)", () =>
      actions.createSkill(session, createInput({ title: HUGE, useThisWhen: "y", fullText: "z", scope: "all" })),
    );
    await assertRejects4xx("createSkill(oversized fullText)", () =>
      actions.createSkill(session, createInput({ title: "x", useThisWhen: "y", fullText: HUGE, scope: "all" })),
    );
    await assertRejects4xx("savePreferences(oversized tone)", () =>
      actions.savePreferences(
        session,
        prefsInput({ tone: HUGE, length: "l", language: "en", units: "m", timeZone: "Z", briefing: "b" }),
      ),
    );

    assert.deepEqual(await listSkillsForUser(db, userId, dek), [], "no oversized skill was stored");
    assert.equal(await getPreferences(db, userId, dek), null, "no oversized profile was stored");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a skill title is bound as data: the table survives and the value round-trips", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "sqli-skill");
    const actions = makeActions(db, keyWrapper);

    // If the title were concatenated into the statement text it would corrupt the query
    // (or run the trailing statement); bound as a parameter it is inert — and here
    // additionally DEK-encrypted before it is bound.
    const probe = "Robert'); DROP TABLE skills; --";
    const result = await actions.createSkill(
      sessionFor(userId),
      createInput({ title: probe, useThisWhen: "y", fullText: "z", scope: "all" }),
    );
    assert.equal(okOf(result), true, "a title shaped like SQL is accepted and stored as data");

    assert.equal(await tableExists(db, "skills"), true, "the skills table survives the probe");
    const skills = await listSkillsForUser(db, userId, dek);
    assert.ok(skills.some((s) => s.title === probe), "the SQL-shaped title round-trips verbatim as data (decrypted)");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a preferences field is bound as data: the table survives and the value round-trips", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "sqli-prefs");
    const actions = makeActions(db, keyWrapper);

    const probe = "metric'); DROP TABLE preferences; --";
    const result = await actions.savePreferences(
      sessionFor(userId),
      prefsInput({ tone: "t", length: "l", language: "en", units: probe, timeZone: "Z", briefing: "b" }),
    );
    assert.equal(okOf(result), true, "a preferences value shaped like SQL is accepted and stored as data");

    assert.equal(await tableExists(db, "preferences"), true, "the preferences table survives the probe");
    const profile = await getPreferences(db, userId, dek);
    assert.equal(profile?.units, probe, "the SQL-shaped preferences value round-trips verbatim as data (decrypted)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no secret value lands in a loaded/saved result; config is read from env.
// [obligation:secrets-from-env] — the module reads no process.env and holds no secret,
// so no ambient env value can leak into what it stores or the screen it loads.
// =====================================================================================

test("no ambient env secret leaks into any stored row or the loaded screen; the actions run from their injected seams alone", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  // Prove the actions do not reach for an ambient database URL: point it at a decoy and
  // rely solely on the injected db seam.
  process.env.DATABASE_URL = `postgres://decoy:${DECOY}@127.0.0.1:1/decoy`;

  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "env-user");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const prefs = await actions.savePreferences(
      session,
      prefsInput({ tone: "Env tone", length: "l", language: "en", units: "m", timeZone: "Z", briefing: "b" }),
    );
    assert.equal(okOf(prefs), true, "the profile save works from the injected seams with a decoy env present");
    const skill = await actions.createSkill(
      session,
      createInput({ title: "Env skill", useThisWhen: "y", fullText: "z", scope: "all" }),
    );
    assert.equal(okOf(skill), true, "the skill create works from the injected seams");

    // The decoy appears in neither the loaded screen…
    const data = await actions.load(session);
    assert.equal((data.preferences as { tone?: string } | null)?.tone, "Env tone", "the loader works from its injected inputs alone");
    assert.ok(!JSON.stringify(data).includes(DECOY), "no ambient env value is folded into the loaded screen");

    // …nor the stored rows.
    assert.ok(
      !JSON.stringify(await listSkillsForUser(db, userId, dek)).includes(DECOY),
      "no ambient env value is folded into the stored skill",
    );
    assert.ok(
      !JSON.stringify(await getPreferences(db, userId, dek)).includes(DECOY),
      "no ambient env value is folded into the stored profile",
    );
  } finally {
    await db.close();
    if (prevDecoy === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prevDecoy;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  }
});
