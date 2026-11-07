// E16-S05 — Import service (server) (`src/server/import/import.ts`).
//
// RED-first: the module `./import` does not exist yet, so importing it throws and
// EVERY test here fails until the builder writes it. That absence IS the point of
// test-first — as the TESTER I must NOT create or edit any implementation/source
// file to make these pass; the builder writes `import.ts` afterwards, to the
// contract these tests pin.
//
// WHY this exists (task E16-S05; brief "Export and portability" / "Import"; design:
// data portability; constitution 20 "every person can export all of their data and
// delete their account", and 14 "Warthog writes the record, not the agents"). Import
// lets a person move EVERYTHING THEY KEEP into a brand-new account. It routes every
// restored section through the SAME stores the person's own writes use (so the
// restored content gets their encryption and validation), and sends the old activity
// history to the separate, read-only "Imported history" archive (E16-S04) rather than
// the live, hash-chained activity record — so the import never claims authorship of
// actions Warthog did not handle and never perturbs the live integrity chain.
//
// These tests pin BEHAVIOUR (what the import DOES: the rows it writes through the real
// stores, read back through those stores; the archive it fills; that the live chain
// still verifies; what it refuses; whose rows it owns; that a SQL-shaped value is
// stored as inert data), never the source text of any module — a later
// behaviour-preserving rename must not redden them. State is arranged and observed
// through the ALREADY-BUILT real stores against an isolated in-memory PGlite
// (src/test/db) with the real migrations. Tests never touch the network or Azure;
// every db handle is closed in a `finally`.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Db } from "../db/index";
//   import type { Clock } from "../seams/clock";
//
//   // Validate `document` (the uploaded export, E16-S01 schema) and write it into the
//   // signed-in account `userId`. Member-scoped: EVERY restored row is owned by the
//   // `userId` passed here (the session's id), never an id read from the file.
//   //   • profile / preferences / skills / memory / rules / tasks / life-admin are
//   //     restored through the real stores (saveIdentityField, savePreferences,
//   //     createSkill, createMemory, createRule, createTask, createRecord);
//   //   • the export's activity history goes to the imported-history ARCHIVE
//   //     (createImportedEntry) — NEVER appended to the live activity record;
//   //   • agents and service connections are NOT recreated;
//   //   • a malformed / wrong-version document is rejected with a plain validation
//   //     error and NOTHING is written.
//   // The dek is the session person's already-unwrapped DEK; the clock supplies the
//   // created-at the dated stores stamp. Reads no process.env and holds no key (the
//   // db / dek / clock are all injected) — INV-103.
//   importExportDocument(db, userId, document: unknown, dek, clock): Promise<unknown>
//
// The obligation acceptance criteria (validate-and-parameterize-input, secrets-from-env)
// are pinned below alongside the behaviour. The HTTP boundary (malformed / oversized →
// 4xx) is pinned against the sibling handler factory in `./handler.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { importExportDocument } from "./import";

import { createUser } from "../db/users";
import { listIdentityFields } from "../db/identity-fields";
import { getPreferences } from "../db/preferences";
import { listSkillsForUser } from "../db/skills";
import { createMemory, listMemoriesForUser } from "../db/memories";
import { listAllRules } from "../db/rules";
import { listTasksForUser } from "../db/tasks";
import { listRecordsForUser } from "../db/life-admin-records";
import { listConnectionsForUser } from "../db/connections";
import { listAgentsForUser } from "../db/agents";
import { listImportedEntriesForUser } from "../db/imported-history";
import { readActivity } from "../activity/writer";
import { checkIntegrity } from "../activity/integrity";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import type { Db } from "../db/index";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const T0 = new Date("2026-11-07T09:00:00.000Z");
const CLOCK: Clock = fixedClock(T0);

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a
// layer up; the stores (and so the import) only ever receive the already-unwrapped
// bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A unique tag so accounts never collide on the users.email UNIQUE across tests.
function tag(): string {
  return Math.random().toString(36).slice(2);
}

// A stand-in wrapped DEK for createUser (opaque base64; the import never reads it — it
// is handed the already-unwrapped dek directly).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}-${tag()}@warthog.com.au`, wrappedDek: wrappedDekFor(who) });
  return user.id;
}

// --- a complete, valid export document ----------------------------------------------
//
// Mirrors the shape the EXPORT BUILDER (E16-S02, `../export/build.ts`) emits — the
// single contract both sides agree on (E16-S01 schema). Each section carries a
// distinctive value keyed off `t` so a round-trip proves the field was restored. The
// activity history embeds a unique canary so a test can tell the ARCHIVE from the live
// record.

interface ProfileField {
  readonly kind: string;
  readonly value: string;
  readonly movingOn: string | null;
}
interface ExportDoc {
  version: number;
  exportedAt: string;
  profile: { name?: string; email?: string; fields: ProfileField[] };
  preferences: Record<string, unknown>;
  skills: Array<Record<string, unknown>>;
  memory: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  lifeAdmin: Array<Record<string, unknown>>;
  connections: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
  deviceProtected?: Record<string, unknown>;
}

function activityCanary(t: string): string {
  return `activity-canary-${t}`;
}

function fullExport(t: string, overrides: Partial<ExportDoc> = {}): ExportDoc {
  return {
    version: 1,
    exportedAt: T0.toISOString(),
    profile: {
      name: `Robin ${t}`,
      email: `robin-${t}@example.com`,
      fields: [
        { kind: "name", value: `Robin ${t}`, movingOn: null },
        { kind: "email", value: `robin-${t}@example.com`, movingOn: null },
        { kind: "postal_address", value: `14 Warthog Lane ${t}`, movingOn: "2027-03-01" },
      ],
    },
    preferences: {
      tone: `warm-${t}`,
      length: "short",
      language: "en-AU",
      units: "metric",
      timeZone: "Australia/Sydney",
      briefing: "mornings",
    },
    skills: [
      {
        id: randomUUID(),
        title: `Book flights ${t}`,
        text: `Book flights ${t}\n\nUse this when: travelling\n\nAlways choose an aisle seat.`,
      },
    ],
    memory: [
      {
        id: randomUUID(),
        content: `Prefers a window seat ${t}`,
        scope: "shared",
        sourceAgentId: null,
        createdAt: T0.toISOString(),
      },
    ],
    rules: [
      {
        id: randomUUID(),
        kind: "ask_first",
        scope: { type: "any_agent" },
        action: { type: "card_request" },
        condition: { type: "amount_over", amount: 100 },
        status: "active",
      },
    ],
    tasks: [
      {
        id: randomUUID(),
        title: `Renew passport ${t}`,
        notes: [{ author: { kind: "person" }, text: `packed-${t}` }],
        assignee: "any",
        status: "open",
        createdBy: { kind: "person" },
      },
    ],
    lifeAdmin: [
      {
        id: randomUUID(),
        kind: "subscription",
        fields: { name: `Streamly ${t}`, amount: 15 },
        dueDate: "2027-01-15",
        status: "active",
        reminderOffsets: [14, 1],
        source: { kind: "person" },
      },
    ],
    connections: [
      {
        id: randomUUID(),
        connectorId: "google",
        accountLabel: `Personal Gmail ${t}`,
        status: "connected",
        connectedAt: T0.toISOString(),
      },
    ],
    activity: [
      {
        seq: 1,
        occurredAt: T0.toISOString(),
        kind: "identity_release",
        source: "warthog",
        agentId: randomUUID(),
        payload: { note: activityCanary(t) },
        prevHash: "GENESIS",
        entryHash: "hash-1",
      },
      {
        seq: 2,
        occurredAt: T0.toISOString(),
        kind: "card_release",
        source: "agent_reported",
        payload: { detail: "an old reported action" },
        prevHash: "hash-1",
        entryHash: "hash-2",
      },
    ],
    ...overrides,
  };
}

// Find exactly one element of a list for which `pick` returns `want`.
function one<T>(items: readonly T[], pick: (item: T) => unknown, want: unknown, label: string): T {
  const matches = items.filter((item) => pick(item) === want);
  assert.equal(matches.length, 1, `expected exactly one ${label} (${String(want)}), found ${matches.length}`);
  return matches[0]!;
}

// =====================================================================================
// AC1 — a valid export restores profile, preferences, skills, memory, rules, tasks and
// life-admin records, all readable under the signed-in account.
// =====================================================================================

test("AC1: a valid export restores every content section, readable under the session account", async () => {
  const db = await freshDb();
  try {
    const t = tag();
    const userId = await makeUser(db, "import-ok");
    const dek = freshDek();

    await importExportDocument(db, userId, fullExport(t), dek, CLOCK);

    // profile — the full low-tier identity field list is restored (the export's
    // authoritative profile data lives in `profile.fields`).
    const fields = await listIdentityFields(db, userId, dek);
    const name = one(fields, (f) => f.kind, "name", "name field");
    assert.equal(name.value, `Robin ${t}`, "the name identity field round-trips");
    const postal = one(fields, (f) => f.kind, "postal_address", "postal field");
    assert.equal(postal.value, `14 Warthog Lane ${t}`, "the postal address round-trips");
    assert.equal(String(postal.movingOn), "2027-03-01", "the moving-on date round-trips");

    // preferences — the whole communication-style profile is restored.
    const prefs = await getPreferences(db, userId, dek);
    assert.ok(prefs, "a preferences profile is saved");
    assert.equal(prefs!.tone, `warm-${t}`, "tone round-trips");
    assert.equal(prefs!.language, "en-AU", "language round-trips");
    assert.equal(prefs!.timeZone, "Australia/Sydney", "time zone round-trips");

    // skills — restored and readable (the title round-trips; the full text decrypts).
    const skills = await listSkillsForUser(db, userId, dek);
    assert.equal(skills.length, 1, "one skill is restored");
    assert.equal(skills[0]!.title, `Book flights ${t}`, "the skill title round-trips");

    // memory — content, scope and source round-trip.
    const memories = await listMemoriesForUser(db, userId, dek);
    assert.equal(memories.length, 1, "one memory is restored");
    assert.equal(memories[0]!.content, `Prefers a window seat ${t}`, "the memory content round-trips");
    assert.equal(memories[0]!.scope, "shared", "the memory scope round-trips");
    assert.equal(memories[0]!.sourceAgentId, null, "a person-authored memory keeps a null source");

    // rules — kind, scope, action and condition round-trip (decrypted under the dek).
    const rules = await listAllRules(db, userId, dek);
    assert.equal(rules.length, 1, "one rule is restored");
    assert.equal(rules[0]!.kind, "ask_first", "the rule kind round-trips");
    assert.deepEqual(rules[0]!.action, { type: "card_request" }, "the rule action round-trips");
    assert.deepEqual(rules[0]!.condition, { type: "amount_over", amount: 100 }, "the rule condition round-trips");

    // tasks — title, assignee and status round-trip.
    const tasks = await listTasksForUser(db, userId, dek);
    assert.equal(tasks.length, 1, "one task is restored");
    assert.equal(tasks[0]!.title, `Renew passport ${t}`, "the task title round-trips");
    assert.equal(tasks[0]!.assignee, "any", "the task assignee round-trips");
    assert.equal(tasks[0]!.status, "open", "the task status round-trips");

    // life-admin — kind, fields, due date and source round-trip.
    const records = await listRecordsForUser(db, userId, dek);
    assert.equal(records.length, 1, "one life-admin record is restored");
    assert.equal(records[0]!.kind, "subscription", "the record kind round-trips");
    assert.deepEqual(records[0]!.fields, { name: `Streamly ${t}`, amount: 15 }, "the record fields round-trip");
    assert.equal(String(records[0]!.dueDate), "2027-01-15", "the record due date round-trips");
  } finally {
    await db.close();
  }
});

test("AC1: an export whose optional sections are empty imports without error (no preferences, no content rows)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "import-empty");
    const dek = freshDek();

    // The server-only export emits `{}` preferences and empty arrays when a person has
    // nothing of a kind; importing it must not throw.
    const empty: ExportDoc = {
      version: 1,
      exportedAt: T0.toISOString(),
      profile: { fields: [] },
      preferences: {},
      skills: [],
      memory: [],
      rules: [],
      tasks: [],
      lifeAdmin: [],
      connections: [],
      activity: [],
    };

    await importExportDocument(db, userId, empty, dek, CLOCK);

    assert.equal(await getPreferences(db, userId, dek), null, "no preferences profile is written when the section is empty");
    assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "no memory rows");
    assert.deepEqual(await listSkillsForUser(db, userId, dek), [], "no skill rows");
    assert.deepEqual(await listImportedEntriesForUser(db, userId, dek), [], "no archived history");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the activity history goes to the imported-history ARCHIVE and is NEVER appended
// to the live activity record, so the account's integrity check still passes.
// =====================================================================================

test("AC2: the export's activity history lands in the imported-history archive, not the live record", async () => {
  const db = await freshDb();
  try {
    const t = tag();
    const userId = await makeUser(db, "import-activity");
    const dek = freshDek();

    await importExportDocument(db, userId, fullExport(t), dek, CLOCK);

    // The old history is archived, decryptable under the owner's dek, carrying its
    // original plaintext labels.
    const archived = await listImportedEntriesForUser(db, userId, dek);
    assert.equal(archived.length, 2, "both exported activity entries are archived");
    const kinds = archived.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ["card_release", "identity_release"], "the archived entries keep their original kinds");
    const archivedBlob = JSON.stringify(archived);
    assert.ok(archivedBlob.includes(activityCanary(t)), "the archived content carries the original activity payload");
  } finally {
    await db.close();
  }
});

test("AC2: after an import the live activity record is untouched and its integrity check still passes", async () => {
  const db = await freshDb();
  try {
    const t = tag();
    const userId = await makeUser(db, "import-integrity");
    const dek = freshDek();

    await importExportDocument(db, userId, fullExport(t), dek, CLOCK);

    // The imported (old) history was NOT appended to the live, hash-chained record:
    // no live entry carries the old payload canary.
    const live = await readActivity(db, userId, dek);
    const liveBlob = JSON.stringify(live);
    assert.ok(
      !liveBlob.includes(activityCanary(t)),
      "the imported activity history is never appended to the live activity record",
    );

    // And the per-user hash chain still verifies end to end.
    const integrity = await checkIntegrity(db, userId);
    assert.equal(integrity.intact, true, "the account's integrity check still passes after an import");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — agents and service connections in the export are not recreated.
// =====================================================================================

test("AC3: service connections in the export are not recreated, and no agents are created", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "import-skip");
    const dek = freshDek();

    // The document carries a connection; import must not recreate it (a connection's
    // own credentials never travel in an export, so it cannot be rebuilt).
    await importExportDocument(db, userId, fullExport(tag()), dek, CLOCK);

    assert.deepEqual(await listConnectionsForUser(db, userId), [], "no service connection is recreated");
    assert.deepEqual(await listAgentsForUser(db, userId), [], "no agent connection is recreated");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a malformed or wrong-version export is rejected with a plain validation error
// and writes nothing.
// =====================================================================================

test("AC4: a wrong-version export is rejected and writes nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "import-badversion");
    const dek = freshDek();

    const wrongVersion = fullExport(tag(), { version: 2 });
    await assert.rejects(
      () => importExportDocument(db, userId, wrongVersion, dek, CLOCK),
      "a wrong-version export is rejected",
    );

    await assertNothingWritten(db, userId, dek);
  } finally {
    await db.close();
  }
});

test("AC4: a malformed export (a section of the wrong kind) is rejected and writes nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "import-malformed");
    const dek = freshDek();

    // `memory` must be a list; a string is malformed. The rejection must come BEFORE
    // any store write, so nothing is persisted.
    const malformed = { ...fullExport(tag()), memory: "not-a-list" } as unknown;
    await assert.rejects(
      () => importExportDocument(db, userId, malformed, dek, CLOCK),
      "a malformed export is rejected",
    );

    await assertNothingWritten(db, userId, dek);
  } finally {
    await db.close();
  }
});

test("AC4: a non-object body is rejected and writes nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "import-nonobject");
    const dek = freshDek();

    for (const bad of [null, "a string", 42, []] as unknown[]) {
      await assert.rejects(() => importExportDocument(db, userId, bad, dek, CLOCK));
    }
    await assertNothingWritten(db, userId, dek);
  } finally {
    await db.close();
  }
});

// Assert the account has NO restored rows in any section — the "writes nothing" half of
// AC4, scoped to the one account under test.
async function assertNothingWritten(db: Db, userId: string, dek: Uint8Array): Promise<void> {
  assert.deepEqual(await listIdentityFields(db, userId, dek), [], "no identity fields written");
  assert.equal(await getPreferences(db, userId, dek), null, "no preferences written");
  assert.deepEqual(await listSkillsForUser(db, userId, dek), [], "no skills written");
  assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "no memories written");
  assert.deepEqual(await listAllRules(db, userId, dek), [], "no rules written");
  assert.deepEqual(await listTasksForUser(db, userId, dek), [], "no tasks written");
  assert.deepEqual(await listRecordsForUser(db, userId, dek), [], "no life-admin records written");
  assert.deepEqual(await listImportedEntriesForUser(db, userId, dek), [], "no archived history written");
}

// =====================================================================================
// AC5 — every restored row is owned by the session user; an id in the file cannot
// target another account.
// =====================================================================================

test("AC5: every restored row is owned by the session user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "import-owner");
    const dek = freshDek();

    await importExportDocument(db, userId, fullExport(tag()), dek, CLOCK);

    const owners: Array<{ userId: string }> = [
      ...(await listIdentityFields(db, userId, dek)),
      ...(await listSkillsForUser(db, userId, dek)),
      ...(await listMemoriesForUser(db, userId, dek)),
      ...(await listAllRules(db, userId, dek)),
      ...(await listTasksForUser(db, userId, dek)),
      ...(await listRecordsForUser(db, userId, dek)),
      ...(await listImportedEntriesForUser(db, userId, dek)),
    ];
    assert.ok(owners.length > 0, "there is restored content to check ownership of");
    for (const row of owners) {
      assert.equal(row.userId, userId, "every restored row is owned by the session user");
    }
    const prefs = await getPreferences(db, userId, dek);
    assert.equal(prefs!.userId, userId, "the preferences profile is owned by the session user");
  } finally {
    await db.close();
  }
});

test("AC5: an id in the file cannot target another account — the importer's session id wins", async () => {
  const db = await freshDb();
  try {
    // Victim account B with one existing memory.
    const victim = await makeUser(db, "import-victim");
    const dekB = freshDek();
    const bContent = `B-private-${randomUUID()}`;
    const bMemory = await createMemory(db, { userId: victim, content: bContent, sourceAgentId: null, scope: "kept" }, dekB, CLOCK);

    // Importer account A. The document's memory `id` is set to B's real row id — the
    // attack: a crafted file trying to steer the write onto another account's row.
    const importer = await makeUser(db, "import-attacker");
    const dekA = freshDek();
    const aContent = `A-imported-${randomUUID()}`;
    const doc = fullExport(tag(), {
      memory: [{ id: bMemory.id, content: aContent, scope: "shared", sourceAgentId: null }],
    });

    await importExportDocument(db, importer, doc, dekA, CLOCK);

    // A gets a FRESH row it owns, with a new id — not B's id.
    const aMemories = await listMemoriesForUser(db, importer, dekA);
    const restored = one(aMemories, (m) => m.content, aContent, "A's imported memory");
    assert.equal(restored.userId, importer, "A's imported memory is owned by A");
    assert.notEqual(restored.id, bMemory.id, "the file's id did not become A's row id — a fresh id is generated");

    // B's memory is completely untouched (not overwritten, not deleted, still B's).
    const bMemories = await listMemoriesForUser(db, victim, dekB);
    assert.equal(bMemories.length, 1, "B still has exactly their original memory");
    assert.equal(bMemories[0]!.content, bContent, "B's memory content is untouched by A's import");
    assert.equal(bMemories[0]!.id, bMemory.id, "B's memory id is unchanged");

    // A never gained a view of B's content.
    assert.ok(
      !aMemories.some((m) => m.content === bContent),
      "the import never lets the importer read the victim's content",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC6 (parameter binding) — a SQL-injection probe in an input field is stored as inert
// data and cannot alter a query. [obligation:validate-and-parameterize-input]
// =====================================================================================

test("AC6: a SQL-injection probe in an input field is stored as literal data (parameter binding)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "import-sqli");
    const dek = freshDek();

    const probe = `Robert'); DROP TABLE memories;-- ${randomUUID()}`;
    const doc = fullExport(tag(), { memory: [{ id: randomUUID(), content: probe, scope: "shared", sourceAgentId: null }] });

    await importExportDocument(db, userId, doc, dek, CLOCK);

    // The probe survived verbatim as DATA (so it was bound, not executed), and the
    // table it tried to drop is still there and readable.
    const memories = await listMemoriesForUser(db, userId, dek);
    assert.equal(memories.length, 1, "the memories table survives the injection probe");
    assert.equal(memories[0]!.content, probe, "the SQL-shaped value round-trips as inert data");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC7 — config is read from the environment; no ambient secret leaks into restored data.
// [obligation:secrets-from-env]
// =====================================================================================

test("AC7: the import runs entirely from its injected seams and folds no ambient env secret into restored data", async () => {
  const db = await freshDb();
  const CANARY = `env-secret-${randomUUID()}`;
  process.env.WARTHOG_IMPORT_TEST_CANARY = CANARY;
  try {
    const t = tag();
    const userId = await makeUser(db, "import-env");
    const dek = freshDek();

    // The import takes db / dek / clock as arguments and holds no key; it must complete
    // with no reliance on reading a secret from the environment.
    const result = await importExportDocument(db, userId, fullExport(t), dek, CLOCK);

    const restored = JSON.stringify({
      result: result ?? null,
      memory: await listMemoriesForUser(db, userId, dek),
      prefs: await getPreferences(db, userId, dek),
      skills: await listSkillsForUser(db, userId, dek),
    });
    assert.ok(!restored.includes(CANARY), "no ambient environment secret leaks into the restored data or the result");
  } finally {
    delete process.env.WARTHOG_IMPORT_TEST_CANARY;
    await db.close();
  }
});
