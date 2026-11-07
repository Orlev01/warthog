// E16-S01 — Export/import document schema (`src/server/export/schema.ts`).
//
// RED-first: the module does NOT exist yet, so importing it fails and every test
// below fails. That is intentional (test-first) — the builder writes the schema
// AFTERWARDS to turn these green. Do NOT add the module to make them pass; the
// builder does that. These tests pin BEHAVIOUR (what the schema ACCEPTS and what
// it REJECTS, and for a rejection WHICH field the error names), never the source
// text of the module, so a later rename or refactor that preserves behaviour must
// not redden them.
//
// WHY one shared schema: export and import must agree on ONE documented, versioned
// shape so a file produced by export is accepted by import (brief "Export and
// portability" / "Import"). This module is that single contract; both sides parse
// against it, which is why it lives on its own and is tested in isolation here.
//
// NOTE on the deviceProtected section and the redaction rule: the device-protected
// section legitimately carries the person's DECRYPTED high-tier values and card
// numbers — the brief says they are "decrypted on the device" for export and
// "re-protected on the importing device during import". This test PARSES such a
// document (a pure, in-memory operation); it never writes those values to activity,
// logs or metrics, so the CLAUDE.md redaction rule is not engaged here. The schema
// only defines the shape; producing/redacting is a different task.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (the builder implements EXACTLY this surface):
//
//   // The zod schema for one Warthog export document. Exported so both the export
//   // producer and the import reader validate against the same shape.
//   const exportDocumentSchema: z.ZodType<ExportDocument>;   // has .safeParse / .parse
//   type  ExportDocument = z.infer<typeof exportDocumentSchema>;
//
// The envelope shape (task "a versioned envelope"):
//
//   version          REQUIRED — the export-format version number (current: 1).
//                    A document missing it is rejected.
//   exportedAt       REQUIRED — when the export was produced (ISO 8601 string).
//   profile          REQUIRED object — who the person is (low-tier identity).
//   preferences      REQUIRED object — tone / length / language / units / etc.
//   skills           REQUIRED array
//   memory           REQUIRED array
//   rules            REQUIRED array
//   tasks            REQUIRED array
//   lifeAdmin        REQUIRED array
//   connections      REQUIRED array (the connection list, without secrets)
//   activity         REQUIRED array (the activity history)
//   deviceProtected  OPTIONAL object — high-tier values + cards, present only after
//                    a step-up device decrypt; a SERVER-ONLY export omits it.
//
// Design choices this test FIXES as the contract (the tests are the spec):
//   - `version` is the NUMBER 1 (a versioned envelope's incrementing version), not
//     a string. Only its ABSENCE is pinned as a rejection; the exact numeric
//     constraint (literal vs number) is the builder's.
//   - Each array section may be EMPTY (a brand-new account exports empty sections);
//     the schema must not impose a non-empty minimum.
//   - A "wrong-typed section" means the top-level section carries the wrong KIND
//     (an array section given a non-array, an object section given a non-object).
//     The per-element internals beyond the representative fields asserted below are
//     the builder's to shape; this is an ENVELOPE schema.
//
// Order of issues is NOT pinned — rejections are located by their `path`, never by
// position, and the human-readable `message` text is never asserted.

import { test } from "node:test";
import assert from "node:assert/strict";

import { exportDocumentSchema, type ExportDocument } from "./schema";

// ---------------------------------------------------------------------------
// Fixtures & helpers.
// ---------------------------------------------------------------------------

// A well-formed SERVER-ONLY export document: every required section present and
// populated, and NO deviceProtected section (AC3 — a server-only export validates).
// Built as `Record<string, unknown>` so a malformed-case test can freely delete a
// key or set a wrong type without fighting the type checker. Fresh every call.
function baseDocument(): Record<string, unknown> {
  return {
    version: 1,
    exportedAt: "2026-11-07T03:21:00.000Z",
    profile: {
      name: "Ada Lovelace",
      email: "ada@example.com",
    },
    preferences: {
      tone: "warm",
      language: "en-AU",
    },
    skills: [
      { id: "sk_1", title: "Book flights" },
      { id: "sk_2", title: "Draft emails" },
    ],
    memory: [{ id: "mem_1", content: "Prefers aisle seats" }],
    rules: [{ id: "ru_1", kind: "ask_first" }],
    tasks: [{ id: "ta_1", title: "Renew passport" }],
    lifeAdmin: [{ id: "la_1", kind: "subscription" }],
    connections: [{ id: "cn_1", connectorId: "gmail", accountLabel: "ada@gmail.com" }],
    activity: [
      { seq: 1, kind: "tool_call" },
      { seq: 2, kind: "approval" },
    ],
  };
}

// The device-protected section: the decrypted high-tier values and card data that a
// step-up device export carries (and that import re-protects). Fresh every call.
function deviceProtectedSection(): Record<string, unknown> {
  return {
    highTierFields: [{ type: "passport", label: "Passport", value: "PA1234567" }],
    cards: [{ brand: "visa", lastFour: "4242", nickname: "Everyday", number: "4242424242424242" }],
  };
}

// A well-formed FULL export document — every section PLUS the optional
// deviceProtected block. Used to prove the full field set is accepted and preserved.
function fullDocument(): Record<string, unknown> {
  return { ...baseDocument(), deviceProtected: deviceProtectedSection() };
}

// The eight required ARRAY sections and the two required OBJECT sections, named so
// the type-corruption tests can iterate them.
const ARRAY_SECTIONS = [
  "skills",
  "memory",
  "rules",
  "tasks",
  "lifeAdmin",
  "connections",
  "activity",
] as const;
const OBJECT_SECTIONS = ["profile", "preferences"] as const;

// A field-shaped issue: a path (array of keys) and a human-readable message.
type Issue = { path: (string | number)[]; message: string };

// Normalise a zod SafeParse failure into field-shaped issues (path + message),
// mapping any symbol path segment to a string so paths compare cleanly.
function issuesOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): Issue[] {
  return error.issues.map((i) => ({
    path: i.path.map((segment) => (typeof segment === "symbol" ? segment.toString() : (segment as string | number))),
    message: i.message,
  }));
}

// `accept` fails loudly (showing the issues) if a document we expect to be valid is
// rejected; `reject` fails if a document we expect to be malformed slips through.
function accept(input: unknown): ExportDocument {
  const r = exportDocumentSchema.safeParse(input);
  if (!r.success) {
    assert.fail(`expected a valid export document, but it was rejected with: ${JSON.stringify(issuesOf(r.error))}`);
  }
  return r.data;
}
function reject(input: unknown): Issue[] {
  const r = exportDocumentSchema.safeParse(input);
  if (r.success) {
    assert.fail("expected the document to be rejected, but it validated");
  }
  return issuesOf(r.error);
}

const sameArr = (a: readonly unknown[], b: readonly unknown[]): boolean => JSON.stringify(a) === JSON.stringify(b);

// Does some issue name exactly this field path? (A "field-level error".)
function hasFieldError(issues: readonly Issue[], path: readonly unknown[]): boolean {
  return issues.some((i) => sameArr(i.path, path));
}

// Assert the document is rejected AND the rejection names the given field path.
function assertRejectedAt(input: unknown, path: readonly unknown[]): void {
  const issues = reject(input);
  for (const i of issues) {
    assert.ok(Array.isArray(i.path), "each issue carries a field path (an array)");
    assert.equal(typeof i.message, "string", "each issue carries a human-readable message");
  }
  assert.ok(
    hasFieldError(issues, path),
    `expected a field-level error at ${JSON.stringify(path)}, got ${JSON.stringify(issues.map((i) => i.path))}`,
  );
}

// Treat an unknown parsed value as an indexable record for field reads.
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const asArray = (v: unknown): unknown[] => v as unknown[];

// ===========================================================================
// AC1 — a well-formed export document parses successfully and preserves every
// section.
// ===========================================================================

test("a well-formed server-only document parses and preserves the envelope metadata", () => {
  const doc = accept(baseDocument());
  const r = asRecord(doc);
  assert.equal(r.version, 1, "the version number survives the parse");
  assert.equal(r.exportedAt, "2026-11-07T03:21:00.000Z", "exportedAt survives the parse");
});

test("every top-level section survives the parse (object sections present, array sections intact)", () => {
  const r = asRecord(accept(baseDocument()));

  // Object sections come through as objects with their content.
  assert.ok(r.profile && typeof r.profile === "object" && !Array.isArray(r.profile), "profile is an object");
  assert.equal(asRecord(r.profile).name, "Ada Lovelace", "profile content survives");
  assert.ok(r.preferences && typeof r.preferences === "object" && !Array.isArray(r.preferences), "preferences is an object");
  assert.equal(asRecord(r.preferences).tone, "warm", "preferences content survives");

  // Array sections keep every element (no section is dropped or truncated).
  assert.equal(asArray(r.skills).length, 2, "skills keeps both entries");
  assert.equal(asArray(r.memory).length, 1, "memory keeps its entry");
  assert.equal(asArray(r.rules).length, 1, "rules keeps its entry");
  assert.equal(asArray(r.tasks).length, 1, "tasks keeps its entry");
  assert.equal(asArray(r.lifeAdmin).length, 1, "lifeAdmin keeps its entry");
  assert.equal(asArray(r.connections).length, 1, "connections keeps its entry");
  assert.equal(asArray(r.activity).length, 2, "activity keeps both entries");
});

test("the content of each array section survives (representative fields are preserved)", () => {
  const r = asRecord(accept(baseDocument()));

  assert.equal(asRecord(asArray(r.skills)[0]).id, "sk_1", "a skill keeps its id");
  assert.equal(asRecord(asArray(r.skills)[0]).title, "Book flights", "a skill keeps its title");
  assert.equal(asRecord(asArray(r.memory)[0]).content, "Prefers aisle seats", "a memory keeps its content");
  assert.equal(asRecord(asArray(r.rules)[0]).id, "ru_1", "a rule keeps its id");
  assert.equal(asRecord(asArray(r.tasks)[0]).title, "Renew passport", "a task keeps its title");
  assert.equal(asRecord(asArray(r.lifeAdmin)[0]).id, "la_1", "a life-admin record keeps its id");
  assert.equal(asRecord(asArray(r.connections)[0]).connectorId, "gmail", "a connection keeps its connector id");
  assert.equal(asRecord(asArray(r.activity)[0]).seq, 1, "an activity entry keeps its sequence number");
});

test("a well-formed full document (with deviceProtected) parses and keeps every section", () => {
  const r = asRecord(accept(fullDocument()));
  // All the required sections are still there.
  for (const section of [...ARRAY_SECTIONS]) {
    assert.ok(Array.isArray(r[section]), `${section} survives as an array`);
  }
  for (const section of [...OBJECT_SECTIONS]) {
    assert.ok(r[section] && typeof r[section] === "object", `${section} survives as an object`);
  }
  // ...and so is the optional device-protected block.
  assert.ok(r.deviceProtected && typeof r.deviceProtected === "object", "deviceProtected survives as an object");
});

test("an export with every array section EMPTY still validates (a brand-new account)", () => {
  const doc = baseDocument();
  for (const section of ARRAY_SECTIONS) {
    doc[section] = [];
  }
  const r = asRecord(accept(doc));
  for (const section of ARRAY_SECTIONS) {
    assert.deepEqual(r[section], [], `${section} is accepted as an empty array`);
  }
});

test("ExportDocument is the inferred type of the schema (the type contract exists)", () => {
  const r = exportDocumentSchema.safeParse(baseDocument());
  assert.equal(r.success, true);
  if (r.success) {
    // Compiles under tsc ONLY if `ExportDocument` is exported and equals the
    // schema's inferred type; a no-op at runtime (tsx strips the annotation).
    const typed: ExportDocument = r.data;
    assert.ok(typed, "the parsed document is typed as ExportDocument");
  }
});

test("exportDocumentSchema.parse returns the document for a well-formed input", () => {
  const parsed = asRecord(exportDocumentSchema.parse(baseDocument()));
  assert.equal(parsed.version, 1, "parse returns the validated document");
});

// ===========================================================================
// AC2 — a document missing `version`, or with a wrong-typed section, is rejected
// with a validation error (a field-level error naming the offender).
// ===========================================================================

test("a document missing the version field is rejected at [version]", () => {
  const doc = baseDocument();
  delete doc.version;
  assertRejectedAt(doc, ["version"]);
});

test("each required ARRAY section given a non-array is rejected at that section", () => {
  for (const section of ARRAY_SECTIONS) {
    const doc = baseDocument();
    doc[section] = "not an array"; // wrong kind for a list section
    assertRejectedAt(doc, [section]);
  }
});

test("each required OBJECT section given a non-object is rejected at that section", () => {
  for (const section of OBJECT_SECTIONS) {
    const doc = baseDocument();
    doc[section] = "not an object"; // wrong kind for a structured section
    assertRejectedAt(doc, [section]);
  }
});

test("exportDocumentSchema.parse THROWS on a document missing version", () => {
  const doc = baseDocument();
  delete doc.version;
  assert.throws(() => exportDocumentSchema.parse(doc), "parse rejects a malformed document by throwing");
});

// ===========================================================================
// AC3 — the deviceProtected section is OPTIONAL.
// ===========================================================================

test("a server-only export (no deviceProtected) validates", () => {
  const doc = asRecord(baseDocument());
  assert.equal(doc.deviceProtected, undefined, "the base fixture has no deviceProtected section");
  const parsed = asRecord(accept(doc));
  assert.equal(parsed.deviceProtected, undefined, "a server-only export validates without a deviceProtected section");
});

test("a document WITH deviceProtected validates and preserves its high-tier values and cards", () => {
  const r = asRecord(accept(fullDocument()));
  const dp = asRecord(r.deviceProtected);

  const highTier = asArray(dp.highTierFields);
  assert.equal(highTier.length, 1, "the high-tier field survives");
  assert.equal(asRecord(highTier[0]).label, "Passport", "the high-tier field label survives");
  assert.equal(asRecord(highTier[0]).value, "PA1234567", "the decrypted high-tier value survives (the point of this section)");

  const cards = asArray(dp.cards);
  assert.equal(cards.length, 1, "the card survives");
  assert.equal(asRecord(cards[0]).lastFour, "4242", "the card's last four survives");
  assert.equal(asRecord(cards[0]).number, "4242424242424242", "the decrypted card number survives (the point of this section)");
});

test("a deviceProtected section of the wrong type (not an object) is rejected at [deviceProtected]", () => {
  const doc = baseDocument();
  doc.deviceProtected = "not an object";
  assertRejectedAt(doc, ["deviceProtected"]);
});

// ===========================================================================
// Robustness — the schema is SAFE (returns a result, never throws) under
// safeParse, even for non-object input, and a rejection always carries an issue.
// ===========================================================================

test("safeParse never throws and rejects a non-object input", () => {
  for (const bad of [null, undefined, 42, "x", [], true]) {
    let result: ReturnType<typeof exportDocumentSchema.safeParse> | undefined;
    assert.doesNotThrow(() => {
      result = exportDocumentSchema.safeParse(bad as unknown);
    }, `validating ${String(bad)} must not throw`);
    assert.ok(result && result.success === false, `${String(bad)} is rejected`);
  }
});

test("a rejected document always carries at least one field-level issue", () => {
  const doc = baseDocument();
  delete doc.version;
  const issues = reject(doc);
  assert.ok(issues.length >= 1, "a rejection reports at least one issue");
});
