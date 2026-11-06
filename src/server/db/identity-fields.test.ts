// E11-S02 — Low-tier identity fields store (`src/server/db/identity-fields.ts`,
// `db/migrations/0022_identity_fields.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./identity-fields` throws and `freshDb()` has no `identity_fields` table — every test
// here fails until the builder adds them. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes the module and the migration
// afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored field, the
// list-all read, the DEK-encrypted value that round-trips only under the owner's key, the
// optional moving-on date, who may read/write what, what a handler rejects, that every
// value is bound as a parameter), never the source text of the module or the SQL file — a
// later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E11-S02; brief §"Identity vault": low tier is "name, preferred
// name, email addresses, phone numbers, postal addresses with a 'moving on' date, language,
// time zone and general preferences", shared freely with permitted agents via get_context).
// Low-tier identity is PERSONAL CONTENT, so each value is stored only DEK-ENCRYPTED
// (`../crypto/envelope`, design §4.1 — "every personal-content column … low-tier vault
// fields, preferences"): the row id is generated up front so the envelope's associated data
// binds the ciphertext to its exact (table, column, row) — the plaintext never lands in a
// column. Each field is readable ONLY for its owner (design §4.1; the store filters by the
// session's user id). High-tier details live in the device-held vault (design §4.2), NOT
// here — this store holds the low tier.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type IdentityFieldKind =        // the low-tier structured field kinds (brief)
//     | "name" | "preferred_name" | "email" | "phone"
//     | "postal_address" | "language" | "time_zone" | "preference";
//
//   interface NewIdentityField {    // what saveIdentityField records
//     userId: string;               // the OWNER (the session's id, NEVER a client value)
//     kind: IdentityFieldKind;      // which low-tier field this is
//     value: string;                // the field's value — stored DEK-encrypted
//     movingOn?: string | null;     // optional "moving on" date (postal address only), ISO
//   }                               //   calendar date e.g. "2027-03-01"; absent ⇒ null
//
//   interface IdentityField {       // a field as handed back to its owner (decrypted)
//     id: string;                   // the field id (generated on save)
//     userId: string;               // the owner
//     kind: IdentityFieldKind;
//     value: string;                // decrypted on read
//     movingOn: Date | string | null;  // the moving-on date stored alongside, or null
//   }
//
//   saveIdentityField(db, input: NewIdentityField, dek): Promise<IdentityField>
//     • generates the id up front (so the value's envelope binds to the row), stores the
//       value DEK-encrypted plus the optional moving-on date, and returns the IdentityField
//       assembled from its inputs (it does not depend on a RETURNING read). A person may
//       hold several fields of the same kind (brief: "email addresses", "phone numbers",
//       "postal addresses" are plural) — each save is its own row.
//   listIdentityFields(db, userId, dek): Promise<IdentityField[]>
//     • ALL of `userId`'s fields (member-scoped: WHERE user_id bound), each value DECRYPTED
//       under the owner's `dek`; never another person's. Empty array when the person has
//       none.
//
// Acceptance criteria → tests:
//   AC1 "Saving a low-tier field stores its value DEK-encrypted and listIdentityFields
//        returns the owner's low-tier fields decrypted." — saveIdentityField returns an id
//        and the recorded kind/value; the plaintext value never appears in a raw column
//        (encrypted at rest) yet round-trips under the owner's DEK via listIdentityFields,
//        which returns every one of the owner's fields decrypted.
//   AC2 "A postal address carries an optional moving-on date stored alongside it." — a
//        postal_address saved WITH a moving-on date returns that date from the list; one
//        saved WITHOUT a moving-on date returns null for it.
//   AC3 "A user cannot read or write another user's identity fields (filtered by session
//        user id)." — B never sees A's fields in a list; a handler takes the owner from the
//        SESSION, so a userId smuggled in the body never writes under another person; the
//        user id is bound as a param.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through the
//        repo travels as a BOUND value (placeholders, never concatenation) and cannot drop
//        the table. The handler below is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes
//        `db` and the `dek` as injected dependencies, holds no key and reads no
//        `process.env` (config flows from `src/server/config.ts` alone). Shown
//        behaviourally: the value is encrypted under the INJECTED dek (a different dek cannot
//        read it back — not a baked-in secret), the field reads/writes purely from the
//        injected db with no app env configured, and a decoy secret planted in the
//        environment never lands in the stored or returned field.
//   Migration: the `identity_fields` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { saveIdentityField, listIdentityFields } from "./identity-fields";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer up;
// this repo only ever receives the already-unwrapped bytes.
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

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). It returns no rows and
// satisfies the `Db` shape structurally (query + close).
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
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to the
// one table under test (behaviour, not source text).
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

// Normalise a moving-on date (a calendar date) to a YYYY-MM-DD string regardless of whether
// the driver hands it back as a Date (pg `date` ⇒ local-midnight Date) or an ISO string —
// either is a reasonable representation and must not redden a test.
function dateOnly(value: Date | string | number): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// Find the one listed field with this exact decrypted value (the list order is not pinned).
function fieldWithValue(fields: IdentityFieldLike[], value: string): IdentityFieldLike | undefined {
  return fields.find((f) => f.value === value);
}

// A structural view of a returned field, so the helpers above do not depend on the (absent)
// module's exported type at the point they run.
interface IdentityFieldLike {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly value: string;
  readonly movingOn?: Date | string | null;
}

// ===========================================================================
// AC1 — saving records a field and stores its value DEK-encrypted;
// listIdentityFields returns all of the owner's fields decrypted.
// ===========================================================================

test("saveIdentityField returns a field with an id and the recorded kind and value", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    const saved = await saveIdentityField(
      db,
      { userId, kind: "name", value: "Oren Levy" },
      dek,
    );

    assert.equal(typeof saved.id, "string", "saveIdentityField returns an id string");
    assert.ok(saved.id.length > 0, "the returned id is non-empty");
    assert.equal(saved.userId, userId, "the field belongs to the saving person");
    assert.equal(saved.kind, "name", "the kind is recorded");
    assert.equal(saved.value, "Oren Levy", "the value is recorded");
  } finally {
    await db.close();
  }
});

test("saveIdentityField gives each field a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = await saveIdentityField(db, { userId, kind: "email", value: "a@example.com" }, dek);
    const two = await saveIdentityField(db, { userId, kind: "email", value: "b@example.com" }, dek);
    assert.notEqual(one.id, two.id, "two saved fields have different ids");
  } finally {
    await db.close();
  }
});

test("the value is stored DEK-encrypted: the plaintext never appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    const value = "LEAKCHECK_identity_9x7Q unit 4, 12 Example St";

    await saveIdentityField(db, { userId, kind: "postal_address", value }, dek);

    // Scan every cell of the one table under test. The value is personal content that MUST
    // be encrypted (AC1), and this value is unique, so any raw occurrence is a genuine
    // plaintext leak. Scoped to `identity_fields` alone — the same value may legitimately
    // live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM identity_fields");
    assert.ok(all.rows.length >= 1, "the field row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(
            !cell.includes(value),
            "the plaintext value must never be written to a column",
          );
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("listIdentityFields round-trips the stored value decrypted under the owner's DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-roundtrip");
    const dek = freshDek();

    await saveIdentityField(db, { userId, kind: "preferred_name", value: "Oz" }, dek);

    const fields = await listIdentityFields(db, userId, dek);
    assert.equal(fields.length, 1, "the owner's one field is listed");
    assert.equal(fields[0]!.kind, "preferred_name", "the kind round-trips");
    assert.equal(fields[0]!.value, "Oz", "the value decrypts back to exactly what was stored");
  } finally {
    await db.close();
  }
});

test("listIdentityFields returns every one of the owner's fields, across kinds, decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();

    // Several kinds, including two of the SAME kind — the brief's "email addresses" /
    // "phone numbers" / "postal addresses" are plural, so a person may hold several.
    await saveIdentityField(db, { userId, kind: "name", value: "Oren Levy" }, dek);
    await saveIdentityField(db, { userId, kind: "email", value: "oren@example.com" }, dek);
    await saveIdentityField(db, { userId, kind: "email", value: "oren.work@example.com" }, dek);
    await saveIdentityField(db, { userId, kind: "phone", value: "+61400000000" }, dek);
    await saveIdentityField(db, { userId, kind: "language", value: "en-AU" }, dek);
    await saveIdentityField(db, { userId, kind: "time_zone", value: "Australia/Sydney" }, dek);
    await saveIdentityField(db, { userId, kind: "preference", value: "Brief me in plain English" }, dek);

    const fields = await listIdentityFields(db, userId, dek);
    assert.equal(fields.length, 7, "all seven of the owner's fields are listed");
    for (const field of fields) {
      assert.equal(field.userId, userId, "every listed field belongs to the owner");
    }

    // Every stored value comes back decrypted (not ciphertext, not dropped).
    const values = new Set(fields.map((f) => f.value));
    for (const expected of [
      "Oren Levy",
      "oren@example.com",
      "oren.work@example.com",
      "+61400000000",
      "en-AU",
      "Australia/Sydney",
      "Brief me in plain English",
    ]) {
      assert.ok(values.has(expected), `the field "${expected}" is listed decrypted`);
    }

    // Both same-kind email addresses survive (not collapsed into one).
    assert.equal(
      fields.filter((f) => f.kind === "email").length,
      2,
      "a person may hold several fields of the same kind",
    );
  } finally {
    await db.close();
  }
});

test("listIdentityFields returns an empty array for a person with no fields", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const fields = await listIdentityFields(db, userId, freshDek());
    assert.deepEqual(fields, [], "a person with no identity fields gets an empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a postal address carries an optional moving-on date stored alongside it.
// ===========================================================================

test("a postal address stores and returns its optional moving-on date", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-moving");
    const dek = freshDek();

    const saved = await saveIdentityField(
      db,
      { userId, kind: "postal_address", value: "12 Example St, Sydney NSW 2000", movingOn: "2027-03-01" },
      dek,
    );
    assert.equal(dateOnly(saved.movingOn as Date | string), "2027-03-01", "save returns the moving-on date");

    const fields = await listIdentityFields(db, userId, dek);
    const address = fieldWithValue(fields, "12 Example St, Sydney NSW 2000");
    assert.ok(address, "the postal address is listed");
    assert.equal(address!.kind, "postal_address", "it is a postal address");
    assert.equal(
      dateOnly(address!.movingOn as Date | string),
      "2027-03-01",
      "the moving-on date is stored alongside the address and round-trips",
    );
  } finally {
    await db.close();
  }
});

test("a postal address without a moving-on date returns null for it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-nomoving");
    const dek = freshDek();

    await saveIdentityField(
      db,
      { userId, kind: "postal_address", value: "99 Current Rd, Melbourne VIC 3000" },
      dek,
    );

    const fields = await listIdentityFields(db, userId, dek);
    const address = fieldWithValue(fields, "99 Current Rd, Melbourne VIC 3000");
    assert.ok(address, "the postal address is listed");
    assert.ok(
      address!.movingOn === null || address!.movingOn === undefined,
      "a postal address with no moving-on date carries no date",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read or write another's
// identity fields. The user id is bound from the session, never the client.
// ===========================================================================

test("listIdentityFields never returns another person's fields", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    await saveIdentityField(db, { userId: alice, kind: "name", value: "Alice A" }, dek);
    await saveIdentityField(db, { userId: alice, kind: "email", value: "alice@example.com" }, dek);
    await saveIdentityField(db, { userId: bob, kind: "name", value: "Bob B" }, dek);

    const aliceFields = await listIdentityFields(db, alice, dek);
    assert.equal(aliceFields.length, 2, "Alice sees exactly her own two fields");
    assert.ok(aliceFields.every((f) => f.userId === alice), "every field in Alice's list is hers");
    assert.ok(!aliceFields.some((f) => f.value === "Bob B"), "Bob's field never appears in Alice's list");

    const bobFields = await listIdentityFields(db, bob, dek);
    assert.equal(bobFields.length, 1, "Bob sees exactly his own field");
    assert.equal(bobFields[0]!.value, "Bob B", "Bob sees his own field");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("saveIdentityField binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE identity_fields; --";

  // The recording db returns no rows; saveIdentityField may read back a row — either way
  // the INSERT it issued must have BOUND the probe (here the owner id), which is checked below.
  try {
    await saveIdentityField(db, { userId: probe, kind: "name", value: "x" }, freshDek());
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listIdentityFields binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE identity_fields; --";

  const result = await listIdentityFields(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the value is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "Grace'); DROP TABLE identity_fields; --";

    await saveIdentityField(db, { userId, kind: "name", value: probe }, dek);

    assert.equal(
      await tableExists(db, "identity_fields"),
      true,
      "the identity_fields table must still exist (the probe was stored as data, not run as SQL)",
    );

    const fields = await listIdentityFields(db, userId, dek);
    assert.ok(fieldWithValue(fields, probe), "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value) and the injected
// dek. A rejected input maps to a 4xx Response and never reaches a query. This handler is a
// test fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

const KINDS = [
  "name",
  "preferred_name",
  "email",
  "phone",
  "postal_address",
  "language",
  "time_zone",
  "preference",
] as const;

function saveIdentityFieldHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the kind, the value and an optional moving-on date; the user id comes
  // from the session, never the body. Lengths are capped so an absurd value is rejected, but
  // generous enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    kind: z.enum(KINDS),
    value: z.string().min(1).max(4096),
    movingOn: z.string().min(1).max(32).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const saved = await saveIdentityField(
        db,
        { userId: sessionUserId, kind: body.kind, value: body.value, movingOn: body.movingOn },
        dek,
      );
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/identity-fields", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveIdentityFieldHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveIdentityFieldHandler(db, freshDek(), "session-user");

  // ~20 KiB value, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(JSON.stringify({ kind: "preference", value: "a".repeat(20 * 1024) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveIdentityFieldHandler(db, freshDek(), "session-user");

  // No value — an identity field must carry the value it stores.
  const res = await handler(jsonRequest(JSON.stringify({ kind: "name" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects an unknown kind with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveIdentityFieldHandler(db, freshDek(), "session-user");

  // "passport" is a high-tier detail (device vault), not a low-tier kind — out of the enum.
  const res = await handler(jsonRequest(JSON.stringify({ kind: "passport", value: "X1234567" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-enum kind must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveIdentityFieldHandler(db, freshDek(), "session-user");

  // value must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ kind: "name", value: 42 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and records the field for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = saveIdentityFieldHandler(db, dek, userId);

    const res = await handler(jsonRequest(JSON.stringify({ kind: "name", value: "Oren Levy" })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the stored field id");

    const fields = await listIdentityFields(db, userId, dek);
    assert.equal(fields.length, 1, "a valid body is persisted for the session user");
    assert.equal(fields[0]!.id, id, "the stored field matches the returned id");
    assert.equal(fields[0]!.kind, "name", "with the submitted kind");
    assert.equal(fields[0]!.value, "Oren Levy", "and the submitted value, decrypted");
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
    const handler = saveIdentityFieldHandler(db, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, kind: "name", value: "Oren Levy" })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listIdentityFields(db, sessionUser, dek)).length,
      1,
      "the field is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listIdentityFields(db, attacker, dek),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe value is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = saveIdentityFieldHandler(db, dek, userId);
    const probe = "oren'); DROP TABLE identity_fields; --";

    const res = await handler(jsonRequest(JSON.stringify({ kind: "name", value: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "identity_fields"), true, "the identity_fields table must still exist");

    const fields = await listIdentityFields(db, userId, dek);
    assert.ok(fieldWithValue(fields, probe), "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the value is encrypted under the INJECTED dek, not a baked-in secret (a different
// dek cannot read it back); the repo reads no process.env and holds no key (INV-103), shown
// behaviourally with a decoy secret in the environment.
// ===========================================================================

test("listIdentityFields cannot decrypt the value with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    await saveIdentityField(db, { userId, kind: "name", value: "Oren Levy" }, dek);

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes —
    // so reading the fields under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listIdentityFields(db, userId, wrongDek);
      },
      "the value is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in a field", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    await saveIdentityField(db, { userId, kind: "name", value: "Oren Levy" }, dek);

    const fields = await listIdentityFields(db, userId, dek);
    assert.equal(fields.length, 1, "the field reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(fields).includes(DECOY),
      "no ambient env value is folded into the returned fields",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM identity_fields");
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

test("the identity_fields migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "identity_fields"),
      true,
      "the identity_fields table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0022_identity_fields"),
      "db/migrations/0022_identity_fields.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0022's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
