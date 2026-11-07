// E16-S02 — Export document builder (server) (`src/server/export/build.ts`).
//
// RED-first: the module under test does NOT exist yet, so importing `./build`
// throws (ERR_MODULE_NOT_FOUND) and this whole suite fails to load. That absence IS
// the point of test-first — do NOT implement anything to make these pass; the builder
// writes `build.ts` AFTERWARDS, composing the already-built, tested list-all reads and
// stores (`listIdentityFields`, `getPreferences`, `listSkillsForUser`,
// `listMemoriesForUser`, `listAllRules`, `listTasksForUser`, `listRecordsForUser`,
// `listConnectionsForUser`, and the activity read) rather than re-running SQL or
// re-implementing decryption — "building it from the existing list-all reads keeps one
// source of truth".
//
// These tests pin BEHAVIOUR (what the built document CONTAINS, what it must NEVER
// contain, who may export whose data, and what a boundary handler does with bad
// input), never the source text of a module or any SQL — a later rename that preserves
// behaviour must not redden them. The content the builder decrypts is seeded through
// the REAL stores (DEK-encrypted) and the REAL migrations, so the builder genuinely
// decrypts server-side.
//
// WHY this exists (task E16-S02; brief "Export and portability"; design: data
// portability; constitution 20 "every person can export all of their data"): a person
// must be able to take EVERYTHING THEY KEEP to another account or provider, as a
// complete, openly-documented export built to the E16-S01 schema (`./schema`). This is
// the SERVER builder: a server-only export, so it carries NO device-protected section
// (high-tier values and card numbers are encrypted in the browser and the server
// cannot decrypt them — the brief decrypts those "on the device", a separate path).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the builder implements EXACTLY this).
//
//   // `src/server/export/build.ts`
//   export async function buildExportDocument(
//     db: Db,
//     userId: string,      // the SESSION person's id — the member scope, never a client value
//     dek: Uint8Array,     // the person's unwrapped DEK — decrypts DEK-encrypted content server-side
//     clock: Clock,        // supplies `exportedAt` (constitution: take a clock, never Date.now())
//   ): Promise<ExportDocument>;   // the E16-S01 `ExportDocument` — validates against exportDocumentSchema
//
// The returned document (to the E16-S01 schema):
//   • `version` === 1 and `exportedAt` === clock.now().toISOString().
//   • `profile`      — an object carrying the person's LOW-TIER identity (name, emails, …).
//   • `preferences`  — an object carrying the person's preferences profile.
//   • `skills`       — one object per skill (enabled AND disabled), each with a plain-text
//                      `text` field (title, a "use this when" line, then the body) usable
//                      outside Warthog.
//   • `memory`, `rules`, `tasks`, `lifeAdmin`, `connections`, `activity` — arrays carrying
//                      the person's rows; `connections` WITHOUT any credentials; `activity`
//                      the FULL history.
//   • NO `deviceProtected` section (a server-only export omits it).
//   • Member-scoped by `userId` alone — never another person's rows, and an id supplied by a
//     caller (e.g. in a request body) can NEVER widen the scope.
//
// Acceptance criteria → tests:
//   AC1 "The built document contains profile, preferences, skills, memory, rules, tasks,
//        life-admin records, connections and the full activity history for the person." —
//        every section's seeded (DEK-encrypted) content round-trips into the document, which
//        validates against the E16-S01 schema; the full activity history survives even across
//        many entries (the bounded-batch read loses none).
//   AC2 "Connector credentials, OAuth tokens and API keys never appear anywhere in the export
//        document." — a connection seeded WITH secret credentials is listed (label + connector)
//        but none of its secret token values appears anywhere in the document.
//   AC3 "Each skill is emitted as plain text (title, 'use this when' line, body) usable outside
//        Warthog." — a skill's plain-text rendering carries its title, a labelled use-this-when
//        line and its body.
//   AC4 "Only the signed-in person's own rows are exported; an id supplied by the caller cannot
//        widen the scope to another person's data." — two people's data stays separated; a
//        handler exports the SESSION user and ignores a body-supplied id.
//   AC5 [obligation:validate-and-parameterize-input] (INV-102) — a fixture handler on the
//        `../http/validate` boundary rejects malformed / oversized input with a 4xx BEFORE a
//        query runs; the user id is bound as a parameter (no spliced SQL); a SQL-injection probe
//        in an input field travels as inert data and cannot alter a query.
//   AC6 [obligation:secrets-from-env] (INV-103) — the builder runs from its INJECTED deps alone
//        (db, userId, dek, clock): the content decrypts only under the injected DEK (a different
//        DEK cannot read it back), and a decoy secret in the environment never lands in the doc.
//
// Every real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`, so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { buildExportDocument } from "./build";
import { exportDocumentSchema, type ExportDocument } from "./schema";
import { createUser } from "../db/users";
import { saveIdentityField } from "../db/identity-fields";
import { savePreferences } from "../db/preferences";
import { createSkill, disableSkill } from "../db/skills";
import { createMemory } from "../db/memories";
import { createRule } from "../db/rules";
import { createTask } from "../db/tasks";
import { createRecord } from "../db/life-admin-records";
import { createConnection } from "../db/connections";
import { createDbRecorder } from "../activity/writer";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import type { Db } from "../db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const EXPORTED_AT = "2026-11-07T03:21:00.000Z"; // a clean whole-ms UTC instant
const clockAt = (iso: string): Clock => fixedClock(new Date(iso));

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a
// layer up; the builder only ever receives the already-unwrapped bytes (like the
// stores it composes).
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque; this builder never unwraps it — it
// takes the already-unwrapped dek directly).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id — the
// builder's member scope).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A set of DISTINCT sentinels for one person's seeded content, so presence/absence
// checks are unambiguous and never collide with each other or with another person's.
// The `tag` keeps two people's sentinels disjoint in the ownership tests.
interface Sentinels {
  readonly name: string;
  readonly idEmail: string;
  readonly prefTone: string;
  readonly prefBriefing: string;
  readonly skillTitle: string;
  readonly skillUse: string;
  readonly skillBody: string;
  readonly memory: string;
  readonly ruleAddress: string;
  readonly taskTitle: string;
  readonly lifeField: string;
  readonly connectorId: string;
  readonly connLabel: string;
  readonly connAccessToken: string;
  readonly connApiKey: string;
  readonly connRefreshToken: string;
  readonly activityNote: string;
}
function sentinels(tag: string): Sentinels {
  const u = `${tag}_${randomUUID().slice(0, 8)}`;
  return {
    name: `LowTierName_${u}`,
    idEmail: `lowtier.${u}@example.com`,
    prefTone: `prefTone_${u}`,
    prefBriefing: `prefBriefing_${u}`,
    skillTitle: `SkillTitle_${u}`,
    skillUse: `booking flights and hotels ${u}`,
    skillBody: `SkillBody_prefer_refundable_${u}`,
    memory: `MemoryContent_${u}`,
    ruleAddress: `rulecond.${u}@example.com`,
    taskTitle: `TaskTitle_${u}`,
    lifeField: `LifeField_${u}`,
    // A catalogue slug is shared vocabulary; keep it a real-looking slug.
    connectorId: "gmail",
    connLabel: `connlabel.${u}@gmail.com`,
    // Credential secrets — these must NEVER appear anywhere in the export (AC2).
    connAccessToken: `OAUTH_ACCESS_TOKEN_SENTINEL_${u}`,
    connApiKey: `API_KEY_SENTINEL_${u}`,
    connRefreshToken: `REFRESH_TOKEN_SENTINEL_${u}`,
    activityNote: `ActivityPayloadNote_${u}`,
  };
}

// Record ONE activity entry for `userId` through the REAL writer, so it is genuinely
// stored, hash-chained and DEK-encrypted — exactly what the builder reads back. The
// writer is stateless across calls (it reads the chain head from the db each time), so
// a fresh recorder per call with a frozen clock gives each entry its own occurred_at.
async function recordActivity(
  db: Db,
  userId: string,
  dek: Uint8Array,
  at: string,
  payload: unknown,
  kind = "tool_call",
): Promise<void> {
  const recorder = createDbRecorder({
    db,
    clock: clockAt(at),
    dekFor: async () => dek,
  });
  await recorder.record({ userId, kind, source: "warthog", payload });
}

// Seed ONE of every exportable thing for a person, under their DEK: a low-tier profile
// (name + email), a preferences profile, one ENABLED skill (carrying the plain-text
// sentinels), a memory, a rule with a DEK-encrypted condition, a task, a life-admin
// record, a connection WITH secret credentials, and one activity entry.
async function seedPerson(
  db: Db,
  userId: string,
  dek: Uint8Array,
  s: Sentinels,
): Promise<void> {
  const clock = clockAt(EXPORTED_AT);

  await saveIdentityField(db, { userId, kind: "name", value: s.name }, dek);
  await saveIdentityField(db, { userId, kind: "email", value: s.idEmail }, dek);

  await savePreferences(
    db,
    {
      userId,
      tone: s.prefTone,
      length: "concise",
      language: "en-AU",
      units: "metric",
      timeZone: "Australia/Sydney",
      briefing: s.prefBriefing,
    },
    dek,
  );

  await createSkill(
    db,
    { userId, title: s.skillTitle, useThisWhen: s.skillUse, fullText: s.skillBody, scope: "all" },
    dek,
  );

  await createMemory(db, { userId, content: s.memory, sourceAgentId: null, scope: "kept" }, dek, clock);

  await createRule(
    db,
    {
      userId,
      kind: "ask_first",
      scope: { type: "any_agent" },
      action: { type: "send_message", channel: "email" },
      condition: { type: "recipient_is", address: s.ruleAddress },
    },
    dek,
  );

  await createTask(db, { userId, title: s.taskTitle, assignee: "any", createdBy: { kind: "person" } }, dek);

  await createRecord(
    db,
    { userId, kind: "subscription", fields: { name: s.lifeField }, status: "active", source: { kind: "person" } },
    dek,
  );

  await createConnection(
    db,
    {
      userId,
      connectorId: s.connectorId,
      accountLabel: s.connLabel,
      credentials: {
        accessToken: s.connAccessToken,
        apiKey: s.connApiKey,
        refreshToken: s.connRefreshToken,
      },
    },
    dek,
    clock,
  );

  await recordActivity(db, userId, dek, EXPORTED_AT, { summary: s.activityNote });
}

// Treat the document / a section as an indexable record / array for field reads
// (the builder returns the loose `ExportDocument`; these keep the asserts readable).
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const asArray = (v: unknown): unknown[] => v as unknown[];

// Whole-of-section text, for "the decrypted value is present SOMEWHERE in this section"
// checks that do not over-pin exactly which field carries it.
const sectionText = (v: unknown): string => JSON.stringify(v);

// Whether a relation of this exact name exists. `to_regclass` yields the relation name
// when it exists and NULL when it does not — a non-throwing probe scoped to the one
// table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

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
// AC1 — the built document contains every section's content, to the E16-S01 schema.
// ===========================================================================

test("buildExportDocument assembles a complete, schema-valid export with every section's content", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "complete");
    const dek = freshDek();
    const s = sentinels("ada");
    await seedPerson(db, userId, dek, s);

    // The return type is the E16-S01 `ExportDocument` (compiles only if the signature
    // returns it); and the produced value validates against the shared schema.
    const doc: ExportDocument = await buildExportDocument(db, userId, dek, clockAt(EXPORTED_AT));
    const parsed = exportDocumentSchema.safeParse(doc);
    assert.ok(
      parsed.success,
      `the built document must validate against the E16-S01 schema; got ${
        parsed.success ? "" : JSON.stringify(parsed.error.issues)
      }`,
    );

    const r = asRecord(doc);

    // Envelope metadata: version 1 and the clock's instant.
    assert.equal(r.version, 1, "the export carries version 1");
    assert.equal(r.exportedAt, EXPORTED_AT, "exportedAt comes from the injected clock");

    // A server-only export omits the device-protected section (the server cannot
    // decrypt the browser-encrypted high-tier values / cards).
    assert.equal(r.deviceProtected, undefined, "a server-only export carries no deviceProtected section");

    // Profile (low-tier identity) — the person's name and email are carried.
    assert.ok(r.profile && typeof r.profile === "object" && !Array.isArray(r.profile), "profile is an object");
    assert.ok(sectionText(r.profile).includes(s.name), "the low-tier name is in the profile");
    assert.ok(sectionText(r.profile).includes(s.idEmail), "the low-tier email is in the profile");

    // Preferences — the person's profile fields are carried.
    assert.ok(
      r.preferences && typeof r.preferences === "object" && !Array.isArray(r.preferences),
      "preferences is an object",
    );
    assert.ok(sectionText(r.preferences).includes(s.prefTone), "the preferences tone is carried");
    assert.ok(sectionText(r.preferences).includes(s.prefBriefing), "the preferences briefing is carried");

    // Every list section is present and non-empty, carrying its decrypted content.
    assert.ok(Array.isArray(r.skills) && asArray(r.skills).length >= 1, "skills is a non-empty array");
    assert.ok(sectionText(r.skills).includes(s.skillTitle), "the skill title is exported");

    assert.ok(Array.isArray(r.memory) && asArray(r.memory).length >= 1, "memory is a non-empty array");
    assert.ok(sectionText(r.memory).includes(s.memory), "the decrypted memory content is exported");

    assert.ok(Array.isArray(r.rules) && asArray(r.rules).length >= 1, "rules is a non-empty array");
    assert.ok(sectionText(r.rules).includes(s.ruleAddress), "the decrypted rule condition is exported");

    assert.ok(Array.isArray(r.tasks) && asArray(r.tasks).length >= 1, "tasks is a non-empty array");
    assert.ok(sectionText(r.tasks).includes(s.taskTitle), "the decrypted task title is exported");

    assert.ok(Array.isArray(r.lifeAdmin) && asArray(r.lifeAdmin).length >= 1, "lifeAdmin is a non-empty array");
    assert.ok(sectionText(r.lifeAdmin).includes(s.lifeField), "the decrypted life-admin field is exported");

    assert.ok(Array.isArray(r.connections) && asArray(r.connections).length >= 1, "connections is a non-empty array");
    assert.ok(sectionText(r.connections).includes(s.connLabel), "the connection's account label is exported");
    assert.ok(sectionText(r.connections).includes(s.connectorId), "the connection's connector is exported");

    assert.ok(Array.isArray(r.activity) && asArray(r.activity).length >= 1, "activity is a non-empty array");
    assert.ok(sectionText(r.activity).includes(s.activityNote), "the activity history is exported");
  } finally {
    await db.close();
  }
});

test("buildExportDocument exports ALL of the person's skills, including disabled ones", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "allskills");
    const dek = freshDek();

    const enabled = await createSkill(
      db,
      { userId, title: "EnabledSkill_keepme", useThisWhen: "when on", fullText: "on body", scope: "all" },
      dek,
    );
    const toDisable = await createSkill(
      db,
      { userId, title: "DisabledSkill_keepme", useThisWhen: "when off", fullText: "off body", scope: "all" },
      dek,
    );
    await disableSkill(db, userId, toDisable.id);

    const doc = asRecord(await buildExportDocument(db, userId, dek, clockAt(EXPORTED_AT)));

    assert.equal(asArray(doc.skills).length, 2, "both skills are exported — a disabled skill is not dropped");
    const text = sectionText(doc.skills);
    assert.ok(text.includes("EnabledSkill_keepme"), "the enabled skill is exported");
    assert.ok(text.includes("DisabledSkill_keepme"), "the disabled skill is still exported");
    void enabled;
  } finally {
    await db.close();
  }
});

test("buildExportDocument exports the FULL activity history, losing none across many entries", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "activity-batches");
    const dek = freshDek();

    // Enough entries to cross a plausible bounded-batch boundary: a correct batched
    // read returns ALL of them; a broken loop would silently truncate.
    const N = 25;
    const expectedNotes = new Set<string>();
    for (let i = 0; i < N; i += 1) {
      const note = `batch-entry-${i}-${randomUUID().slice(0, 6)}`;
      expectedNotes.add(note);
      // Distinct, ascending instants (one per entry).
      const at = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
      await recordActivity(db, userId, dek, at, { summary: note });
    }

    const doc = asRecord(await buildExportDocument(db, userId, dek, clockAt(EXPORTED_AT)));
    const activity = asArray(doc.activity);

    assert.equal(activity.length, N, "every activity entry is exported (the batched read loses none)");

    // Every entry's seq 1..N is present (no gap from a mis-stepped batch loop)...
    const seqs = new Set(activity.map((e) => asRecord(e).seq));
    for (let seq = 1; seq <= N; seq += 1) {
      assert.ok(seqs.has(seq), `activity entry seq ${seq} is present`);
    }
    // ...and every payload summary survived.
    const text = sectionText(activity);
    for (const note of expectedNotes) {
      assert.ok(text.includes(note), `activity payload ${note} is exported`);
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — connector credentials, OAuth tokens and API keys never appear anywhere.
// ===========================================================================

test("buildExportDocument lists connections WITHOUT their credentials — no secret token appears anywhere", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "nocreds");
    const dek = freshDek();
    const s = sentinels("secret");
    await seedPerson(db, userId, dek, s);

    const doc = await buildExportDocument(db, userId, dek, clockAt(EXPORTED_AT));
    const whole = JSON.stringify(doc);

    // The connection itself IS exported (label + connector), proving it is listed...
    assert.ok(whole.includes(s.connLabel), "the connection's account label is exported");
    assert.ok(whole.includes(s.connectorId), "the connection's connector id is exported");

    // ...but NONE of its secret credential values appears anywhere in the document.
    // Each sentinel is unique to the credentials, so a whole-document absence check
    // here means exactly "the credential never leaked", not some unrelated collision.
    assert.ok(!whole.includes(s.connAccessToken), "the OAuth access token never appears in the export");
    assert.ok(!whole.includes(s.connApiKey), "the API key never appears in the export");
    assert.ok(!whole.includes(s.connRefreshToken), "the refresh token never appears in the export");

    // Narrowly: the connection entry itself carries no credential-shaped keys.
    const r = asRecord(doc);
    const conn = asRecord(asArray(r.connections).find((c) => asRecord(c).accountLabel === s.connLabel));
    assert.ok(conn, "the seeded connection is present in the connections list");
    for (const key of ["credentials", "accessToken", "apiKey", "refreshToken"]) {
      assert.ok(!(key in conn), `the exported connection carries no '${key}' field`);
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — each skill is emitted as plain text (title, "use this when" line, body).
// ===========================================================================

test("each exported skill is plain text carrying its title, a use-this-when line and its body", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "plaintext");
    const dek = freshDek();
    const title = "Travel booking helper";
    const useThisWhen = "booking flights, trains or hotels for the person";
    const body = "Always prefer refundable fares. Book an aisle seat. Keep each trip under budget.";
    await createSkill(db, { userId, title, useThisWhen, fullText: body, scope: "all" }, dek);

    const doc = asRecord(await buildExportDocument(db, userId, dek, clockAt(EXPORTED_AT)));
    const skills = asArray(doc.skills);
    assert.equal(skills.length, 1, "the one skill is exported");

    const entry = asRecord(skills[0]);
    assert.equal(typeof entry.text, "string", "each skill carries a plain-text rendering (`text`)");
    const text = entry.text as string;

    assert.ok(text.includes(title), "the plain text includes the skill title");
    assert.ok(text.toLowerCase().includes("use this when"), "the plain text has a labelled 'use this when' line");
    assert.ok(text.includes(useThisWhen), "the plain text includes the use-this-when content");
    assert.ok(text.includes(body), "the plain text includes the skill body");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — only the signed-in person's rows are exported; a caller id cannot widen scope.
// ===========================================================================

test("buildExportDocument exports only the owner's rows — never another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const sa = sentinels("alice");
    const sb = sentinels("bob");
    await seedPerson(db, alice, dekA, sa);
    await seedPerson(db, bob, dekB, sb);

    const aliceDoc = JSON.stringify(await buildExportDocument(db, alice, dekA, clockAt(EXPORTED_AT)));

    // Alice's own content is present...
    for (const own of [sa.name, sa.memory, sa.ruleAddress, sa.taskTitle, sa.lifeField, sa.connLabel, sa.activityNote]) {
      assert.ok(aliceDoc.includes(own), `Alice's export carries her own value ${own}`);
    }
    // ...and NONE of Bob's content leaks into Alice's export.
    for (const other of [sb.name, sb.memory, sb.ruleAddress, sb.taskTitle, sb.lifeField, sb.connLabel, sb.activityNote]) {
      assert.ok(!aliceDoc.includes(other), `Alice's export never carries Bob's value ${other}`);
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// AC4 + AC5 — a handler exports the SESSION user and ignores a body-supplied id, and
// the boundary rejects bad input before any query. The handler is a TEST FIXTURE that
// exercises the modules (the intended usage) — NOT an implementation file.
// ---------------------------------------------------------------------------

function exportHandler(
  db: Db,
  dek: Uint8Array,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body is OPTIONAL and the only member scope is the SESSION's id — a `userId` in
  // the body is accepted by the shape but IGNORED (it must never widen the scope). The
  // size cap keeps an absurd body out before it is parsed.
  const schema = z.object({ userId: z.string().max(256).optional() });
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const doc = await buildExportDocument(db, sessionUserId, dek, clock);
      return new Response(JSON.stringify(doc), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler exports the SESSION user's data and ignores a user id supplied in the body", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice");
    const bob = await makeUser(db, "handler-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const sa = sentinels("halice");
    const sb = sentinels("hbob");
    await seedPerson(db, alice, dekA, sa);
    await seedPerson(db, bob, dekB, sb);

    // Alice's session; the body tries to pass BOB's id.
    const handler = exportHandler(db, dekA, clockAt(EXPORTED_AT), alice);
    const res = await handler(jsonRequest(JSON.stringify({ userId: bob })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const whole = JSON.stringify(await res.json());
    assert.ok(whole.includes(sa.memory), "the handler exports the session (Alice's) data");
    assert.ok(!whole.includes(sb.memory), "the body's user id is ignored — it never widens the scope");
  } finally {
    await db.close();
  }
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = exportHandler(db, freshDek(), clockAt(EXPORTED_AT), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = exportHandler(db, freshDek(), clockAt(EXPORTED_AT), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ filler: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("buildExportDocument binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE activity_entries; --";

  // The recording db returns no rows for every read; the builder may resolve with an
  // empty-ish document or reject — either way the queries it issued are recorded, and
  // every one must bind the probe rather than splice it.
  try {
    await buildExportDocument(db, probe, freshDek(), clockAt(EXPORTED_AT));
  } catch {
    // ignore — we assert on the recorded queries, not on the result.
  }

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe stored in a profile field round-trips through the export as inert data", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "Grace'); DROP TABLE identity_fields; --";
    await saveIdentityField(db, { userId, kind: "name", value: probe }, dek);

    const doc = await buildExportDocument(db, userId, dek, clockAt(EXPORTED_AT));

    assert.equal(await tableExists(db, "identity_fields"), true, "the table survives the export (the probe is data, not SQL)");
    assert.ok(JSON.stringify(asRecord(doc).profile).includes(probe), "the probe value round-trips verbatim as data in the profile");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC6 [obligation:secrets-from-env] (INV-103) — the builder runs from its INJECTED deps
// alone (db, userId, dek, clock): the content decrypts only under the injected DEK, so a
// different DEK cannot read it back; and a decoy secret in the environment never lands
// in the document.
// ===========================================================================

test("buildExportDocument cannot decrypt the owner's content with a different DEK (the key is injected)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "wrongdek");
    const realDek = freshDek();
    // Seed DEK-encrypted content, so a wrong DEK fails the GCM tag and the export rejects.
    await createSkill(db, { userId, title: "secret", useThisWhen: "x", fullText: "y", scope: "all" }, realDek);

    const wrongDek = freshDek();
    await assert.rejects(
      () => buildExportDocument(db, userId, wrongDek, clockAt(EXPORTED_AT)),
      "a DEK that did not encrypt the content cannot read it back",
    );
  } finally {
    await db.close();
  }
});

test("buildExportDocument folds no ambient env secret into the document: a decoy in the environment never appears", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "decoy");
    const dek = freshDek();
    const s = sentinels("decoy");
    await seedPerson(db, userId, dek, s);

    const doc = await buildExportDocument(db, userId, dek, clockAt(EXPORTED_AT));

    // The export works purely from the injected db / userId / dek / clock...
    assert.ok(JSON.stringify(doc).includes(s.memory), "the export runs from injected deps with no app env");
    // ...and no ambient env value is folded into it.
    assert.ok(!JSON.stringify(doc).includes(DECOY), "no ambient env value appears in the export document");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
