// E11-S03 — High-tier identity fields store (`src/server/db/high-tier-fields.ts`,
// `db/migrations/0023_high_tier_fields.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./high-tier-fields` throws and `freshDb()` has no `high_tier_fields` table — every test
// here fails until the builder adds them. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes the module and the migration
// afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the metadata a save records,
// the metadata-only list-all read, the owner-only ciphertext read that round-trips the device
// blob verbatim, who may read/write what, what a handler rejects, that every value is bound as
// a parameter), never the source text of the module or the SQL file — a later rename that
// preserves behaviour must not redden them.
//
// WHY this exists (task E11-S03; brief §"Identity vault" + §"Device-held protection", design
// §4.2 "Device-held vault"). High-tier identity details — date of birth, passport, driver
// licence, car registration and any custom field the person marks high — are PERSONAL CONTENT
// at the top sensitivity tier, released only after an approved, stepped-up request. Unlike the
// LOW-tier store (E11-S02), which the server DEK-encrypts itself, high-tier values are
// encrypted IN THE BROWSER with the device-held vault key (VK) BEFORE they leave the device
// (design §4.2). THE SERVER STORES CIPHERTEXT ONLY: it holds no vault key, never decrypts, and
// hands a value back to the owner's own device solely so the device can decrypt it locally for
// a release. So this module takes NO `dek` and imports NO crypto — it is pure opaque-ciphertext
// storage plus plaintext metadata (label, type, tier), exactly like the wrapped-key store
// (`vault-unlock-methods`).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type HighTierFieldType =       // the high-tier field types (brief: the defaults + custom)
//     | "date_of_birth" | "passport" | "driver_licence" | "car_registration" | "custom";
//
//   interface NewHighTierField {   // what saveHighTierField records
//     userId: string;              // the OWNER (the session's id, NEVER a client value)
//     type: HighTierFieldType;     // which high-tier field this is
//     label: string;               // plaintext metadata label (e.g. "Passport", "Work car")
//     ciphertext: string;          // the OPAQUE device-produced ciphertext (VK-encrypted in the
//   }                              //   browser); the server stores it verbatim and never decrypts
//
//   interface HighTierFieldMetadata {  // what a read hands back — METADATA ONLY, NEVER the value
//     id: string;                  // the field id (generated on save)
//     userId: string;              // the owner
//     type: HighTierFieldType;
//     label: string;               // the plaintext label
//     tier: "high";                // every row in this store is high tier
//   }
//
//   saveHighTierField(db, input: NewHighTierField): Promise<HighTierFieldMetadata>
//     • generates the id up front, stores ONLY the opaque ciphertext + the metadata (label,
//       type), and returns the field's METADATA (no ciphertext) assembled from its inputs. A
//       person may hold several fields of the same type (two passports, several custom fields) —
//       each save is its own row with a distinct id.
//   listHighTierFields(db, userId): Promise<HighTierFieldMetadata[]>
//     • ALL of `userId`'s fields as METADATA ONLY (label, type, tier) — NEVER the ciphertext or
//       any value. Member-scoped (WHERE user_id bound); never another person's. Empty array when
//       the person has none.
//   getHighTierCiphertext(db, userId, fieldId): Promise<string | null>
//     • the stored ciphertext for ONE field, returned ONLY to its owner (WHERE id AND user_id
//       both bound) so the owner's device can decrypt it locally for a release. `null` when the
//       field does not exist OR belongs to someone else — a non-owner learns nothing.
//
// Acceptance criteria → tests:
//   AC1 "Saving a high-tier field stores only the device ciphertext and its label/type; no
//        plaintext value is ever written." — saveHighTierField returns metadata (id, type,
//        label, tier) and NO value; the opaque ciphertext is stored (round-trips verbatim via
//        getHighTierCiphertext) while the metadata read never exposes it. The API accepts only
//        ciphertext — there is no plaintext parameter, so no plaintext can reach a column.
//   AC2 "listHighTierFields returns field metadata (label, type, tier) without any value, while
//        getHighTierCiphertext returns the stored ciphertext only to the owner for local
//        decryption." — the list carries label/type/tier and NO ciphertext/value on any item;
//        getHighTierCiphertext hands back the exact stored blob, and only to the owner.
//   AC3 "A user cannot read or write another user's high-tier fields (filtered by session user
//        id)." — B never sees A's fields in a list and getHighTierCiphertext for A's field under
//        B returns null; a handler takes the owner from the SESSION, so a userId smuggled in the
//        body never writes under another person; the user id is bound as a param.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//        with a 4xx before any query runs; a SQL-injection probe routed through the repo travels
//        as a BOUND value (placeholders, never concatenation) and cannot drop the table. The
//        handler below is a test fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes `db`
//        as an injected dependency, holds no key (it never encrypts — the browser does) and
//        reads no `process.env` (config flows from `src/server/config.ts` alone). Shown
//        behaviourally: the field reads/writes purely from the injected db with no app env
//        configured, and a decoy secret planted in the environment never lands in the stored or
//        returned field.
//   Migration: the `high_tier_fields` relation exists after the project migrations and a second
//        run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { saveHighTierField, listHighTierFields, getHighTierCiphertext } from "./high-tier-fields";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it). The DEK
// belongs to the low-tier/server-side store — the HIGH-tier store never touches it, since
// high-tier values are encrypted on the device with the vault key, not the server DEK.
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

// A device-produced ciphertext stand-in: an OPAQUE blob the browser made by encrypting the real
// value with the vault key. The server stores it verbatim and cannot read it. A distinctive,
// unique token so a leak-scan can recognise it if it ever escapes into a metadata read.
function deviceCiphertext(tag: string): string {
  return `v1:vkgcm:CIPHERTEXT_${tag}_${"A1b2C3d4E5f6".repeat(2)}==`;
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

// A structural view of a returned metadata item, so the helpers below do not depend on the
// (absent) module's exported type at the point they run.
interface MetadataLike {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly label: string;
  readonly tier: string;
}

// Find the one listed field with this exact label (the list order is not pinned).
function fieldWithLabel(fields: MetadataLike[], label: string): MetadataLike | undefined {
  return fields.find((f) => f.label === label);
}

// Assert a metadata item carries ONLY the metadata and NO stored value: no ciphertext under the
// contract key, nor a generic value/cipher key. Scoped to the one item — the ciphertext
// legitimately exists elsewhere (via getHighTierCiphertext), just never in a metadata read.
function assertNoValueOnMetadata(item: Record<string, unknown>): void {
  for (const forbidden of ["ciphertext", "value", "cipher"]) {
    assert.ok(
      !(forbidden in item),
      `metadata must not carry the stored value (unexpected "${forbidden}" key)`,
    );
  }
}

// ===========================================================================
// AC1 — saving records metadata + stores only the opaque device ciphertext (no value).
// ===========================================================================

test("saveHighTierField returns metadata with an id, type, label and tier 'high' — and no value", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");

    const saved = await saveHighTierField(db, {
      userId,
      type: "passport",
      label: "Australian passport",
      ciphertext: deviceCiphertext("ac1"),
    });

    assert.equal(typeof saved.id, "string", "saveHighTierField returns an id string");
    assert.ok(saved.id.length > 0, "the returned id is non-empty");
    assert.equal(saved.userId, userId, "the field belongs to the saving person");
    assert.equal(saved.type, "passport", "the type is recorded");
    assert.equal(saved.label, "Australian passport", "the label is recorded");
    assert.equal(saved.tier, "high", "every field in this store is high tier");
  } finally {
    await db.close();
  }
});

test("saveHighTierField gives each field a distinct id (several of the same type)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const one = await saveHighTierField(db, {
      userId,
      type: "custom",
      label: "Medicare number",
      ciphertext: deviceCiphertext("one"),
    });
    const two = await saveHighTierField(db, {
      userId,
      type: "custom",
      label: "Tax file number",
      ciphertext: deviceCiphertext("two"),
    });
    assert.notEqual(one.id, two.id, "two saved fields have different ids");
  } finally {
    await db.close();
  }
});

test("the opaque ciphertext is stored verbatim and the API never receives plaintext", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-store");
    const ciphertext = deviceCiphertext("verbatim");

    const saved = await saveHighTierField(db, {
      userId,
      type: "date_of_birth",
      label: "DOB",
      ciphertext,
    });

    // The server stores what the device handed it, byte for byte, and hands the SAME bytes back
    // to the owner for local decryption — it never transforms or decrypts (it holds no key).
    const stored = await getHighTierCiphertext(db, userId, saved.id);
    assert.equal(stored, ciphertext, "the stored ciphertext round-trips verbatim to its owner");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — list returns metadata only (label, type, tier) with NO value;
// getHighTierCiphertext returns the ciphertext only, to the owner.
// ===========================================================================

test("listHighTierFields returns metadata (label, type, tier) and never the ciphertext/value", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-meta");
    const ciphertext = deviceCiphertext("LEAKCHECK_passport");

    await saveHighTierField(db, {
      userId,
      type: "passport",
      label: "Australian passport",
      ciphertext,
    });

    const fields = await listHighTierFields(db, userId);
    assert.equal(fields.length, 1, "the owner's one field is listed");
    const item = fields[0]!;
    assert.equal(item.type, "passport", "the type is in the metadata");
    assert.equal(item.label, "Australian passport", "the label is in the metadata");
    assert.equal(item.tier, "high", "the tier is in the metadata");

    // No value on the item under any plausible key …
    assertNoValueOnMetadata(item as unknown as Record<string, unknown>);
    // … and the distinctive ciphertext token appears NOWHERE in the list output. Scoped to the
    // list's own serialisation — the ciphertext is legitimately reachable via
    // getHighTierCiphertext, just never through a metadata read.
    assert.ok(
      !JSON.stringify(fields).includes(ciphertext),
      "the ciphertext must never appear in a metadata list",
    );
    assert.ok(
      !JSON.stringify(fields).includes("LEAKCHECK_passport"),
      "no fragment of the stored value leaks into the list",
    );
  } finally {
    await db.close();
  }
});

test("listHighTierFields returns every one of the owner's fields, across types", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-list");

    await saveHighTierField(db, { userId, type: "date_of_birth", label: "DOB", ciphertext: deviceCiphertext("dob") });
    await saveHighTierField(db, { userId, type: "passport", label: "Passport", ciphertext: deviceCiphertext("pp") });
    await saveHighTierField(db, { userId, type: "driver_licence", label: "Licence", ciphertext: deviceCiphertext("dl") });
    await saveHighTierField(db, { userId, type: "car_registration", label: "Rego", ciphertext: deviceCiphertext("rego") });
    await saveHighTierField(db, { userId, type: "custom", label: "Medicare", ciphertext: deviceCiphertext("mc") });
    await saveHighTierField(db, { userId, type: "custom", label: "TFN", ciphertext: deviceCiphertext("tfn") });

    const fields = await listHighTierFields(db, userId);
    assert.equal(fields.length, 6, "all six of the owner's fields are listed");
    for (const field of fields) {
      assert.equal(field.userId, userId, "every listed field belongs to the owner");
      assert.equal(field.tier, "high", "every listed field is high tier");
      assertNoValueOnMetadata(field as unknown as Record<string, unknown>);
    }

    const labels = new Set(fields.map((f) => f.label));
    for (const expected of ["DOB", "Passport", "Licence", "Rego", "Medicare", "TFN"]) {
      assert.ok(labels.has(expected), `the field "${expected}" is listed`);
    }
    // Two custom fields survive as distinct rows (not collapsed on type).
    assert.equal(
      fields.filter((f) => f.type === "custom").length,
      2,
      "a person may hold several fields of the same type",
    );
  } finally {
    await db.close();
  }
});

test("listHighTierFields returns an empty array for a person with no fields", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-empty");
    const fields = await listHighTierFields(db, userId);
    assert.deepEqual(fields, [], "a person with no high-tier fields gets an empty list");
  } finally {
    await db.close();
  }
});

test("getHighTierCiphertext returns null for a field that does not exist", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-missing");
    const missing = await getHighTierCiphertext(db, userId, "00000000-0000-0000-0000-000000000000");
    assert.equal(missing, null, "a non-existent field id yields null, not a throw");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read another's fields.
// The user id is bound from the session, never the client.
// ===========================================================================

test("listHighTierFields never returns another person's fields", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");

    await saveHighTierField(db, { userId: alice, type: "passport", label: "Alice passport", ciphertext: deviceCiphertext("a1") });
    await saveHighTierField(db, { userId: alice, type: "driver_licence", label: "Alice licence", ciphertext: deviceCiphertext("a2") });
    await saveHighTierField(db, { userId: bob, type: "passport", label: "Bob passport", ciphertext: deviceCiphertext("b1") });

    const aliceFields = await listHighTierFields(db, alice);
    assert.equal(aliceFields.length, 2, "Alice sees exactly her own two fields");
    assert.ok(aliceFields.every((f) => f.userId === alice), "every field in Alice's list is hers");
    assert.ok(!aliceFields.some((f) => f.label === "Bob passport"), "Bob's field never appears in Alice's list");

    const bobFields = await listHighTierFields(db, bob);
    assert.equal(bobFields.length, 1, "Bob sees exactly his own field");
    assert.equal(bobFields[0]!.label, "Bob passport", "Bob sees his own field");
  } finally {
    await db.close();
  }
});

test("getHighTierCiphertext will not hand one person's ciphertext to another", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "cipher-alice");
    const bob = await makeUser(db, "cipher-bob");
    const aliceCiphertext = deviceCiphertext("alice-secret");

    const aliceField = await saveHighTierField(db, {
      userId: alice,
      type: "passport",
      label: "Alice passport",
      ciphertext: aliceCiphertext,
    });

    // The owner gets her own ciphertext back …
    assert.equal(
      await getHighTierCiphertext(db, alice, aliceField.id),
      aliceCiphertext,
      "the owner can read her own ciphertext",
    );
    // … but Bob, asking for Alice's field id, gets nothing (filtered by the session user id).
    assert.equal(
      await getHighTierCiphertext(db, bob, aliceField.id),
      null,
      "another person cannot read the owner's ciphertext",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("saveHighTierField binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE high_tier_fields; --";

  // The recording db returns no rows; saveHighTierField may read back a row — either way the
  // INSERT it issued must have BOUND the probe (here the owner id), which is checked below.
  try {
    await saveHighTierField(db, { userId: probe, type: "passport", label: "x", ciphertext: "y" });
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listHighTierFields binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE high_tier_fields; --";

  const result = await listHighTierFields(db, probe);
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("getHighTierCiphertext binds the user id and field id as parameters", async () => {
  const db = recordingDb();
  const userProbe = "g'); DROP TABLE high_tier_fields; --";
  const idProbe = "id'); DROP TABLE high_tier_fields; --";

  const result = await getHighTierCiphertext(db, userProbe, idProbe);
  assert.equal(result, null, "the recording db returns no rows, so no ciphertext is found");

  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(userProbe)), "the user id travels as a bound value");
  assert.ok(db.calls.some((c) => c.values.includes(idProbe)), "the field id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userProbe), "the user id is bound, never concatenated");
    assert.ok(!call.text.includes(idProbe), "the field id is bound, never concatenated");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in the label is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const probeLabel = "Grace'); DROP TABLE high_tier_fields; --";
    const ciphertext = deviceCiphertext("inject");

    const saved = await saveHighTierField(db, {
      userId,
      type: "custom",
      label: probeLabel,
      ciphertext,
    });

    assert.equal(
      await tableExists(db, "high_tier_fields"),
      true,
      "the high_tier_fields table must still exist (the probe was stored as data, not run as SQL)",
    );

    const fields = await listHighTierFields(db, userId);
    assert.ok(fieldWithLabel(fields, probeLabel), "the probe label round-trips verbatim as data");
    assert.equal(
      await getHighTierCiphertext(db, userId, saved.id),
      ciphertext,
      "and the ciphertext is still readable, unaffected",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value). A rejected input
// maps to a 4xx Response and never reaches a query. This handler is a test fixture that
// EXERCISES the modules — it is not an implementation file.
// ===========================================================================

const TYPES = ["date_of_birth", "passport", "driver_licence", "car_registration", "custom"] as const;

function saveHighTierFieldHandler(
  db: Db,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the type, the label and the device ciphertext; the user id comes from the
  // session, never the body. Lengths are capped so an absurd body is rejected, but generous
  // enough that a device ciphertext fits and a probe can still REACH the query to prove binding.
  const schema = z.object({
    type: z.enum(TYPES),
    label: z.string().min(1).max(256),
    ciphertext: z.string().min(1).max(16 * 1024),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 64 * 1024 });
      const saved = await saveHighTierField(db, {
        userId: sessionUserId,
        type: body.type,
        label: body.label,
        ciphertext: body.ciphertext,
      });
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees
      // the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/high-tier-fields", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveHighTierFieldHandler(db, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveHighTierFieldHandler(db, "session-user");

  // ~100 KiB ciphertext, well over the handler's 64 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(JSON.stringify({ type: "passport", label: "x", ciphertext: "a".repeat(100 * 1024) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveHighTierFieldHandler(db, "session-user");

  // No ciphertext — a high-tier field must carry the device ciphertext it stores.
  const res = await handler(jsonRequest(JSON.stringify({ type: "passport", label: "Passport" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects an unknown type with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveHighTierFieldHandler(db, "session-user");

  // "email" is a LOW-tier kind (its own store), not a high-tier type — out of the enum.
  const res = await handler(
    jsonRequest(JSON.stringify({ type: "email", label: "x", ciphertext: deviceCiphertext("bad") })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-enum type must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveHighTierFieldHandler(db, "session-user");

  // label must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(
    jsonRequest(JSON.stringify({ type: "passport", label: 42, ciphertext: deviceCiphertext("bad") })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and records the field for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const handler = saveHighTierFieldHandler(db, userId);
    const ciphertext = deviceCiphertext("handler-ok");

    const res = await handler(
      jsonRequest(JSON.stringify({ type: "passport", label: "Australian passport", ciphertext })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the stored field id");

    const fields = await listHighTierFields(db, userId);
    assert.equal(fields.length, 1, "a valid body is persisted for the session user");
    assert.equal(fields[0]!.id, id, "the stored field matches the returned id");
    assert.equal(fields[0]!.type, "passport", "with the submitted type");
    assert.equal(fields[0]!.label, "Australian passport", "and the submitted label");
    assert.equal(
      await getHighTierCiphertext(db, userId, id),
      ciphertext,
      "and the submitted ciphertext is stored for the owner",
    );
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body (no cross-user write)", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = saveHighTierFieldHandler(db, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({
        userId: attacker,
        type: "passport",
        label: "Passport",
        ciphertext: deviceCiphertext("smuggle"),
      })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listHighTierFields(db, sessionUser)).length,
      1,
      "the field is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listHighTierFields(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe label is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const handler = saveHighTierFieldHandler(db, userId);
    const probeLabel = "oren'); DROP TABLE high_tier_fields; --";

    const res = await handler(
      jsonRequest(JSON.stringify({ type: "custom", label: probeLabel, ciphertext: deviceCiphertext("probe") })),
    );

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) label is accepted");
    assert.equal(await tableExists(db, "high_tier_fields"), true, "the high_tier_fields table must still exist");

    const fields = await listHighTierFields(db, userId);
    assert.ok(fieldWithLabel(fields, probeLabel), "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the module reads no process.env and holds no key (INV-103), shown behaviourally with a
// decoy secret in the environment. (The module never encrypts — the browser does — so it has no
// key at all, a stronger position than the low-tier server-side store.)
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a field", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    await saveHighTierField(db, {
      userId,
      type: "passport",
      label: "Passport",
      ciphertext: deviceCiphertext("ac5"),
    });

    const fields = await listHighTierFields(db, userId);
    assert.equal(fields.length, 1, "the field reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(fields).includes(DECOY),
      "no ambient env value is folded into the returned metadata",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM high_tier_fields");
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

test("the high_tier_fields migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "high_tier_fields"),
      true,
      "the high_tier_fields table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0023_high_tier_fields"),
      "db/migrations/0023_high_tier_fields.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0023's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
