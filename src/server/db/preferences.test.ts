// E13-S01 — Preferences store
// (`src/server/db/preferences.ts`, `db/migrations/0030_preferences.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./preferences` throws and `freshDb()` has no `preferences` table — every test here
// fails until the builder adds them. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes the module and the
// migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the one-per-person
// profile an upsert stores and overwrites in place, the DEK-encrypted fields that
// round-trip only under the owner's key, who may read/change whose profile, what a
// handler rejects, that every value is bound as a parameter), never the source text of
// the module or the SQL file — a later rename that preserves behaviour must not redden
// them.
//
// WHY this exists (task E13-S01; brief §"Skills, preferences and shared memory": "a
// communication-style and preferences profile (tone, length, language, units, time
// zone, how they like to be taught or briefed)"). The preferences profile is PERSONAL
// CONTENT shared freely with permitted agents via get_context, so each field is stored
// only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1 — "every personal-content
// column — low-tier vault fields, preferences, …"): the plaintext never lands in a
// column. The profile is readable ONLY for its owner (design §4.1; the store filters by
// the session's user id). One profile per person (upsert in place), unlike the low-tier
// identity store (`identity-fields`), where a person may hold several fields per kind.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface PreferencesProfile {   // the profile as handed back to its owner (decrypted)
//     userId: string;                // the person this profile belongs to
//     tone: string;                  // communication tone (e.g. "warm, direct")
//     length: string;                // preferred length (e.g. "concise")
//     language: string;              // preferred language (e.g. "en-AU")
//     units: string;                 // preferred units (e.g. "metric")
//     timeZone: string;              // preferred time zone (e.g. "Australia/Sydney")
//     briefing: string;              // how they like to be taught or briefed (free text)
//   }
//
//   interface SavePreferencesInput { // what savePreferences records
//     userId: string;                // the OWNER (the SESSION's id, NEVER a client value)
//     tone: string;
//     length: string;
//     language: string;
//     units: string;
//     timeZone: string;
//     briefing: string;              // each field is stored DEK-encrypted
//   }
//
//   savePreferences(db, input: SavePreferencesInput, dek): Promise<PreferencesProfile>
//     • upserts the ONE row for input.userId (one profile per person): a second save
//       OVERWRITES in place and never duplicates. Each field is stored DEK-encrypted;
//       the returned profile is assembled from the inputs (it does not depend on a
//       RETURNING read). Member-scoped: the user id is bound, so a save writes the
//       caller's OWN row and leaves every other person's untouched.
//   getPreferences(db, userId, dek): Promise<PreferencesProfile | null>
//     • member-scoped (WHERE user_id bound). Returns the owner's profile with every
//       field DECRYPTED under the owner's `dek`, or null when the person has saved none.
//       Never another person's profile. A wrong DEK fails the GCM tag and rejects.
//
// Acceptance criteria → tests:
//   AC1 "Upserting the preferences profile stores its fields DEK-encrypted and reading
//        returns them for the owner." — savePreferences returns the recorded fields; the
//        plaintext of every field never appears in a raw column (encrypted at rest) yet
//        round-trips under the owner's DEK via getPreferences. A second save overwrites
//        the same single row (no duplicate). A person with no profile reads null.
//   AC2 "A user cannot read or change another user's preferences (filtered by session
//        user id)." — B never sees A's profile; B's save never changes A's; a handler
//        takes the owner from the SESSION, so a userId smuggled in the body never writes
//        under another person; the user id is bound as a param.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through the
//        repo travels as a BOUND value (placeholders, never concatenation) and cannot
//        drop the table. The handler below is a test fixture (the intended usage), not an
//        implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes
//        `db` and the `dek` as injected dependencies, holds no key and reads no
//        `process.env`. Shown behaviourally: a field is encrypted under the INJECTED dek (a
//        different dek cannot read it back — not a baked-in secret), the profile reads/writes
//        purely from the injected db with no app env configured, and a decoy secret planted
//        in the environment never lands in the stored or returned profile.
//   Migration: the `preferences` relation exists after the project migrations and a second
//        run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { savePreferences, getPreferences } from "./preferences";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased
// at runtime (and test files are excluded from `tsc`), so a rename cannot break these
// tests; the runtime assertions below are what actually gate behaviour.
import type { PreferencesProfile, SavePreferencesInput } from "./preferences";
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

// A structural view of a profile's settable fields, so helpers below do not depend on
// the (absent) module's exported type at the point they run.
interface ProfileFields {
  readonly tone: string;
  readonly length: string;
  readonly language: string;
  readonly units: string;
  readonly timeZone: string;
  readonly briefing: string;
}

// A sample profile; override individual fields per test. Distinct values per field so a
// round-trip proves each field is stored and read independently (not collapsed).
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

// Assert a returned profile carries exactly the given fields (and belongs to `userId`).
function assertProfileEquals(
  profile: PreferencesProfileLike | null,
  userId: string,
  fields: ProfileFields,
): void {
  assert.ok(profile, "a profile was returned");
  assert.equal(profile!.userId, userId, "the profile belongs to the owner");
  assert.equal(profile!.tone, fields.tone, "tone round-trips");
  assert.equal(profile!.length, fields.length, "length round-trips");
  assert.equal(profile!.language, fields.language, "language round-trips");
  assert.equal(profile!.units, fields.units, "units round-trips");
  assert.equal(profile!.timeZone, fields.timeZone, "timeZone round-trips");
  assert.equal(profile!.briefing, fields.briefing, "briefing round-trips");
}

// A structural view of a returned profile, decoupled from the (absent) module's type.
interface PreferencesProfileLike {
  readonly userId: string;
  readonly tone: string;
  readonly length: string;
  readonly language: string;
  readonly units: string;
  readonly timeZone: string;
  readonly briefing: string;
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
// AC1 — upserting stores the profile DEK-encrypted; getPreferences returns it for the
// owner, decrypted; a second save overwrites the one row; an unset person reads null.
// ===========================================================================

test("savePreferences returns a profile with the owner and the recorded fields", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const fields = sampleProfile();

    const saved = await savePreferences(db, { userId, ...fields }, freshDek());

    assert.equal(saved.userId, userId, "the profile belongs to the saving person");
    assert.equal(saved.tone, fields.tone, "tone is recorded");
    assert.equal(saved.length, fields.length, "length is recorded");
    assert.equal(saved.language, fields.language, "language is recorded");
    assert.equal(saved.units, fields.units, "units is recorded");
    assert.equal(saved.timeZone, fields.timeZone, "timeZone is recorded");
    assert.equal(saved.briefing, fields.briefing, "briefing is recorded");
  } finally {
    await db.close();
  }
});

test("getPreferences round-trips every field decrypted under the owner's DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-roundtrip");
    const dek = freshDek();
    const fields = sampleProfile();

    await savePreferences(db, { userId, ...fields }, dek);

    const profile = await getPreferences(db, userId, dek);
    assertProfileEquals(profile, userId, fields);
  } finally {
    await db.close();
  }
});

test("every field is stored DEK-encrypted: no field's plaintext appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    // A unique sentinel in EACH field, so any raw occurrence is a genuine plaintext leak
    // of that specific field (proves all six are encrypted, not just one).
    const fields = sampleProfile({
      tone: "LEAKCHECK_tone_9x7Q",
      length: "LEAKCHECK_length_9x7Q",
      language: "LEAKCHECK_language_9x7Q",
      units: "LEAKCHECK_units_9x7Q",
      timeZone: "LEAKCHECK_tz_9x7Q",
      briefing: "LEAKCHECK_briefing_9x7Q teach me step by step",
    });

    await savePreferences(db, { userId, ...fields }, dek);

    // Scan every cell of the one table under test. Scoped to `preferences` alone — the
    // same value could legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM preferences");
    assert.ok(all.rows.length >= 1, "the profile row was stored");
    const sentinels = [fields.tone, fields.length, fields.language, fields.units, fields.timeZone, fields.briefing];
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          for (const sentinel of sentinels) {
            assert.ok(
              !cell.includes(sentinel),
              `the plaintext of a field (${sentinel}) must never be written to a column`,
            );
          }
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("a second save overwrites the profile in place — one row per person, no duplicate", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-upsert");
    const dek = freshDek();

    await savePreferences(db, { userId, ...sampleProfile() }, dek);
    const updated = sampleProfile({
      tone: "formal",
      length: "detailed",
      language: "en-GB",
      units: "imperial",
      timeZone: "Europe/London",
      briefing: "Give me the full reasoning, then the summary",
    });
    await savePreferences(db, { userId, ...updated }, dek);

    // The read reflects the SECOND save (overwrite, not an additional profile).
    const profile = await getPreferences(db, userId, dek);
    assertProfileEquals(profile, userId, updated);

    // Exactly one row for this person — the upsert replaced, never appended.
    const rows = await db.query("SELECT user_id FROM preferences WHERE user_id = $1", [userId]);
    assert.equal(rows.rows.length, 1, "a second save keeps exactly one profile row for the person");
  } finally {
    await db.close();
  }
});

test("getPreferences returns null for a person who has saved no profile", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const profile = await getPreferences(db, userId, freshDek());
    assert.equal(profile, null, "a person with no saved profile reads null");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 (shown here alongside AC1) — a field is bound to the owner's OWN DEK: a different
// DEK fails the GCM tag and the read rejects (not a baked-in/ambient key).
// ===========================================================================

test("getPreferences cannot decrypt the profile with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac4-wrongdek");
    const dek = freshDek();
    await savePreferences(db, { userId, ...sampleProfile() }, dek);

    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await getPreferences(db, userId, wrongDek);
      },
      "the profile is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — ownership: a second signed-in person can never read or change another's profile.
// The user id is bound from the session, never the client.
// ===========================================================================

test("getPreferences never returns another person's profile", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    const aliceFields = sampleProfile({ tone: "alice-tone", briefing: "alice-briefing" });
    await savePreferences(db, { userId: alice, ...aliceFields }, dek);

    // Bob has saved nothing — he reads null, never Alice's profile.
    assert.equal(await getPreferences(db, bob, dek), null, "Bob reads null, not Alice's profile");

    // Alice reads exactly her own.
    assertProfileEquals(await getPreferences(db, alice, dek), alice, aliceFields);
  } finally {
    await db.close();
  }
});

test("one person's save never changes another person's profile", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "change-alice");
    const bob = await makeUser(db, "change-bob");
    const dek = freshDek();

    const aliceFields = sampleProfile({ tone: "alice-tone" });
    await savePreferences(db, { userId: alice, ...aliceFields }, dek);
    await savePreferences(db, { userId: bob, ...sampleProfile({ tone: "bob-tone" }) }, dek);

    // Bob's save left Alice's profile untouched.
    assertProfileEquals(await getPreferences(db, alice, dek), alice, aliceFields);
  } finally {
    await db.close();
  }
});

test("savePreferences binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE preferences; --";

  // The recording db returns no rows; savePreferences assembles its result from the
  // inputs, so it need not throw — but tolerate either so the binding is asserted either way.
  try {
    await savePreferences(db, { userId: probe, ...sampleProfile() }, freshDek());
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("getPreferences binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "g'); DROP TABLE preferences; --";

  const result = await getPreferences(db, probe, freshDek());
  assert.equal(result, null, "the recording db returns no rows, so the read is null");

  assertBoundNotSpliced(db, probe);
});

// ===========================================================================
// AC3 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value) and the
// injected dek. A rejected input maps to a 4xx Response and never reaches a query. This
// handler is a test fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function savePreferencesHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the six profile fields; the user id comes from the session, never
  // the body. Lengths are capped so an absurd value is rejected, but generous enough that
  // a probe can still REACH the query to prove it is bound. All six keys are required
  // (the profile upserts as a unit), though a field may be an empty string.
  const schema = z.object({
    tone: z.string().max(200),
    length: z.string().max(200),
    language: z.string().max(100),
    units: z.string().max(100),
    timeZone: z.string().max(100),
    briefing: z.string().max(4096),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const saved = await savePreferences(
        db,
        { userId: sessionUserId, ...body },
        dek,
      );
      return new Response(JSON.stringify({ userId: saved.userId }), { status: 200 });
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
  return new Request("https://warthog.com.au/api/preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function fullBody(overrides: Partial<ProfileFields> = {}): string {
  return JSON.stringify(sampleProfile(overrides));
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = savePreferencesHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = savePreferencesHandler(db, freshDek(), "session-user");

  // ~20 KiB briefing, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(fullBody({ briefing: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = savePreferencesHandler(db, freshDek(), "session-user");

  // Omit `tone` — the profile upserts as a unit, so a missing field is a schema violation.
  const { tone: _omit, ...rest } = sampleProfile();
  const res = await handler(jsonRequest(JSON.stringify(rest)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = savePreferencesHandler(db, freshDek(), "session-user");

  // `tone` must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ ...sampleProfile(), tone: 42 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and records the profile for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = savePreferencesHandler(db, dek, userId);
    const fields = sampleProfile();

    const res = await handler(jsonRequest(fullBody()));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assertProfileEquals(await getPreferences(db, userId, dek), userId, fields);
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
    const handler = savePreferencesHandler(db, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, ...sampleProfile() })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.ok(await getPreferences(db, sessionUser, dek), "the profile is recorded under the SESSION user");
    assert.equal(
      await getPreferences(db, attacker, dek),
      null,
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe field is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = savePreferencesHandler(db, dek, userId);
    const probe = "Grace'); DROP TABLE preferences; --";

    const res = await handler(jsonRequest(fullBody({ tone: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "preferences"), true, "the preferences table must still exist");

    const profile = await getPreferences(db, userId, dek);
    assert.ok(profile, "the profile is readable after the probe");
    assert.equal(profile!.tone, probe, "the probe round-trips verbatim as data, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — the repo reads no process.env and holds no key (INV-103), shown behaviourally
// with a decoy secret in the environment.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a profile", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac4-decoy");
    const dek = freshDek();
    await savePreferences(db, { userId, ...sampleProfile() }, dek);

    const profile = await getPreferences(db, userId, dek);
    assert.ok(profile, "the profile reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(profile).includes(DECOY),
      "no ambient env value is folded into the returned profile",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the
    // same value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM preferences");
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

test("the preferences migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "preferences"),
      true,
      "the preferences table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0030_preferences"),
      "db/migrations/0030_preferences.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0030's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
