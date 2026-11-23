// E14-S10 — Life-admin page-data read (list-all) (`src/server/life-admin/page-data.ts`).
//
// RED-first: the module does not exist yet, so importing `./page-data` throws and every
// test here fails (and `tsc --noEmit` reddens on the missing module) until the builder
// writes the minimum code to pass. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes `page-data.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the read DOES: the records grouped by kind for the
// session person, each receipt flagged as having an attached file WITHOUT its bytes, the
// moving-checklist items, the shared tasks, whose data it reads, what a handler rejects,
// that the person id reaches the db as a BOUND parameter), never the source text of the
// module — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E14-S10; brief §"Life admin" + §"Tasks and hand-offs" +
// §"Moving-house helper"; design §4.1): the Life Admin page needs ONE owner-scoped read
// that sees EVERY record, checklist item and task regardless of state — distinct from the
// agent-facing reads and never returning another person's data. It composes the
// already-built, tested stores — `listRecordsForUser` (life-admin records, fields
// DEK-decrypted), the moving-checklist `listForUser`, the `listTasksForUser` read — plus a
// member-scoped look-up of which of the person's receipt records carry an attached file
// (the `receipt_files` metadata only — never the encrypted file BYTES). It adds no crypto
// of its own, takes the person's `dek` INJECTED (holds no key, reads no `process.env`,
// INV-103), and is member-scoped by the session's `userId`, never a client value (INV-102;
// project rule: every member-scoped read takes userId from the session).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface LifeAdminPageRecord {   // one life-admin record as the page shows it
//     id: string;                     // the record's opaque id
//     userId: string;                 // the OWNER (the session's id)
//     kind: RecordKind;               // "subscription" | "receipt_warranty" | "renewal_appointment"
//     fields: Record<string, unknown>;// the record's content — DECRYPTED under the owner's dek
//     dueDate: string | Date | null;  // the due/next date (or null) — plaintext metadata
//     status: string;                 // the status word — plaintext metadata
//     reminderOffsets: number[];      // the per-record offsets — plaintext metadata
//     sentOffsets: number[];          // offsets already reminded — plaintext metadata
//     source: RecordSource;           // person | agent — plaintext metadata
//     hasAttachedFile: boolean;       // TRUE for a receipt that carries a saved receipt file;
//                                     //   the FILE BYTES are never part of this read.
//   }
//
//   interface LifeAdminPageData {     // the owner-scoped list-all the Life Admin page renders
//     subscriptions: LifeAdminPageRecord[];  // kind "subscription"
//     receipts: LifeAdminPageRecord[];        // kind "receipt_warranty" (with the attached-file flag)
//     renewals: LifeAdminPageRecord[];        // kind "renewal_appointment"
//     checklist: ChecklistItem[];             // the moving-checklist items (exactly listForUser)
//     tasks: Task[];                          // the shared tasks (exactly listTasksForUser)
//   }
//
//   lifeAdminPageData(db, userId, dek): Promise<LifeAdminPageData>
//     • reads ALL of `userId`'s records (member-scoped), each fields-blob DECRYPTED under
//       the owner's `dek`, groups them by kind, flags each receipt that carries a saved
//       receipt file (member-scoped `receipt_files` metadata, NEVER the bytes), and
//       returns the owner's moving-checklist items and shared tasks alongside. Every read
//       is member-scoped by `userId` (the session's id, NEVER a client value).
//
// Acceptance criteria → tests:
//   AC1 "Returns the owner's records grouped by kind, the moving checklist items, and the
//        tasks, with receipts flagged as having an attached file without returning the file
//        bytes." — one record of each kind lands in its own group with its fields decrypted;
//        a receipt WITH a saved file is flagged `hasAttachedFile`, one WITHOUT is not; the
//        flagged receipt's file BYTES never appear in the assembled data; the checklist
//        items and tasks come back; a person with nothing gets empty collections.
//   AC2 "It reads data only for the session user (filtered by session user id)." — with two
//        people each holding records, checklist items and tasks, the read for one returns
//        only that person's data, never the other's; and the attached-file flag is itself
//        member-scoped (another person's receipt file never flags your receipt).
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-typed input with a
//        4xx before the read runs, and takes the user id from the session, never the body; a
//        SQL-injection probe routed through the read travels as a BOUND value (placeholders,
//        never concatenation) and cannot alter a query or drop a table. The handler below is
//        a TEST FIXTURE (the intended usage), not an implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the read runs purely from its injected
//        inputs (db + userId + dek) and reads no `process.env`, so a decoy secret planted in
//        the environment never lands in the assembled data.
//
// Database tests use `freshDb()` (an isolated in-memory PGlite with the real migrations)
// and a `recordingDb` that captures what reached the query layer; each real-db handle is
// closed in a `finally`. Receipt files go through the in-memory blob store. Tests touch no
// network and no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { lifeAdminPageData, recordPhases } from "./page-data";
import { BUILT_IN } from "../../domain/life-admin/catalogue";
import { createRecord } from "../db/life-admin-records";
import { addOwnItem } from "../db/moving-checklist";
import { createTask } from "../db/tasks";
import { saveReceiptFile } from "../storage/receipt-files";
import { createInMemoryBlobStore } from "../storage/blob";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this read only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this read never reads it).
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

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (a bound value vs. spliced text). It returns no rows
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

// A structural view of the assembled data, so the helpers/assertions do not depend on the
// (absent) module's exported types at the point they run.
interface PageRecordLike {
  readonly id: string;
  readonly kind: string;
  readonly fields: Record<string, unknown>;
  readonly hasAttachedFile?: boolean;
  readonly userId?: string;
}
interface ChecklistItemLike {
  readonly id: string;
  readonly label: string;
  readonly userId?: string;
}
interface TaskLike {
  readonly id: string;
  readonly title: string;
  readonly userId?: string;
}
interface PageDataLike {
  readonly subscriptions: PageRecordLike[];
  readonly receipts: PageRecordLike[];
  readonly renewals: PageRecordLike[];
  readonly checklist: ChecklistItemLike[];
  readonly tasks: TaskLike[];
}

// Find the one grouped record carrying this exact decrypted field value (group order and
// list order are not pinned).
function byField(records: PageRecordLike[], key: string, value: string): PageRecordLike | undefined {
  return records.find((r) => r.fields?.[key] === value);
}

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

// ===========================================================================
// AC1 — the read groups the owner's records by kind, flags receipts with an attached file
// (never the bytes), and returns the checklist items and tasks.
// ===========================================================================

test("records come back grouped by kind, each with its fields DECRYPTED", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const userId = await makeUser(db, "ac1-groups");

    await createRecord(
      db,
      {
        userId,
        kind: "subscription",
        fields: { service: "Netflix", cost: "15.99", billingCycle: "monthly" },
        status: "active",
        source: { kind: "person" },
      },
      dek,
    );
    await createRecord(
      db,
      {
        userId,
        kind: "receipt_warranty",
        fields: { merchant: "JB Hi-Fi", item: "Headphones", amount: "199.00" },
        status: "kept",
        source: { kind: "person" },
      },
      dek,
    );
    await createRecord(
      db,
      {
        userId,
        kind: "renewal_appointment",
        fields: { what: "Passport renewal", where: "Passport office" },
        status: "upcoming",
        source: { kind: "person" },
      },
      dek,
    );

    const data = (await lifeAdminPageData(db, userId, dek)) as PageDataLike;

    assert.equal(data.subscriptions.length, 1, "one subscription grouped");
    assert.equal(data.receipts.length, 1, "one receipt/warranty grouped");
    assert.equal(data.renewals.length, 1, "one renewal/appointment grouped");

    assert.equal(data.subscriptions[0]!.fields.service, "Netflix", "the subscription's fields are decrypted");
    assert.equal(data.receipts[0]!.fields.merchant, "JB Hi-Fi", "the receipt's fields are decrypted");
    assert.equal(data.renewals[0]!.fields.what, "Passport renewal", "the renewal's fields are decrypted");

    // Each record lands in exactly one group — the kinds never cross-contaminate.
    assert.equal(data.subscriptions[0]!.kind, "subscription", "the subscription group holds only subscriptions");
    assert.equal(data.receipts[0]!.kind, "receipt_warranty", "the receipts group holds only receipts/warranties");
    assert.equal(data.renewals[0]!.kind, "renewal_appointment", "the renewals group holds only renewals/appointments");
  } finally {
    await db.close();
  }
});

test("a receipt with a saved file is flagged hasAttachedFile; one without is not", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const userId = await makeUser(db, "ac1-flag");
    const blob = createInMemoryBlobStore();

    const withFile = await createRecord(
      db,
      {
        userId,
        kind: "receipt_warranty",
        fields: { merchant: "With-File Merchant" },
        status: "kept",
        source: { kind: "person" },
      },
      dek,
    );
    await createRecord(
      db,
      {
        userId,
        kind: "receipt_warranty",
        fields: { merchant: "No-File Merchant" },
        status: "kept",
        source: { kind: "person" },
      },
      dek,
    );
    // A subscription can never carry a receipt file — it must not be flagged.
    await createRecord(
      db,
      {
        userId,
        kind: "subscription",
        fields: { service: "Spotify" },
        status: "active",
        source: { kind: "person" },
      },
      dek,
    );

    await saveReceiptFile(
      db,
      blob,
      {
        userId,
        recordId: withFile.id,
        contentType: "image/png",
        bytes: new TextEncoder().encode("a small receipt image"),
      },
      dek,
    );

    const data = (await lifeAdminPageData(db, userId, dek)) as PageDataLike;

    const flagged = byField(data.receipts, "merchant", "With-File Merchant");
    const unflagged = byField(data.receipts, "merchant", "No-File Merchant");
    const subscription = byField(data.subscriptions, "service", "Spotify");

    assert.ok(flagged, "the receipt with a file is listed");
    assert.ok(unflagged, "the receipt without a file is listed");
    assert.ok(subscription, "the subscription is listed");

    assert.equal(flagged!.hasAttachedFile, true, "the receipt with a saved file is flagged as having one");
    assert.ok(!unflagged!.hasAttachedFile, "the receipt without a file is NOT flagged");
    assert.ok(!subscription!.hasAttachedFile, "a subscription (which cannot hold a file) is NOT flagged");
  } finally {
    await db.close();
  }
});

test("a flagged receipt's file BYTES never appear in the assembled page data", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const userId = await makeUser(db, "ac1-nobytes");
    const blob = createInMemoryBlobStore();

    // A unique sentinel in the plaintext file bytes, used in no field — so any occurrence
    // in the output is a genuine leak of the file bytes under test (this read returns a
    // flag, never the bytes).
    const FILE_BYTES_SENTINEL = "RECEIPT_FILE_BYTES_SENTINEL_do_not_leak_7h3L";

    const receipt = await createRecord(
      db,
      {
        userId,
        kind: "receipt_warranty",
        fields: { merchant: "Sentinel Merchant" },
        status: "kept",
        source: { kind: "person" },
      },
      dek,
    );
    await saveReceiptFile(
      db,
      blob,
      {
        userId,
        recordId: receipt.id,
        contentType: "application/pdf",
        bytes: new TextEncoder().encode(`PDFHEADER ${FILE_BYTES_SENTINEL} PDFTRAILER`),
      },
      dek,
    );

    const data = (await lifeAdminPageData(db, userId, dek)) as PageDataLike;

    const flagged = byField(data.receipts, "merchant", "Sentinel Merchant");
    assert.ok(flagged, "the receipt is listed");
    assert.equal(flagged!.hasAttachedFile, true, "and it is flagged as having an attached file");

    // The decisive proof: the file bytes are nowhere in the assembled data — the read
    // reports a flag only, never fetches or inlines the bytes.
    assert.ok(
      !JSON.stringify(data).includes(FILE_BYTES_SENTINEL),
      "the receipt file bytes never appear in the page data",
    );
  } finally {
    await db.close();
  }
});

test("the moving-checklist items are returned for the owner", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const userId = await makeUser(db, "ac1-checklist");

    await addOwnItem(db, { userId, label: "Tell the bank" }, dek);
    await addOwnItem(db, { userId, label: "Redirect the mail" }, dek);

    const data = (await lifeAdminPageData(db, userId, dek)) as PageDataLike;

    const labels = new Set(data.checklist.map((i) => i.label));
    assert.equal(data.checklist.length, 2, "both of the owner's checklist items are returned");
    assert.ok(labels.has("Tell the bank"), "the first checklist label is decrypted and returned");
    assert.ok(labels.has("Redirect the mail"), "the second checklist label is decrypted and returned");
  } finally {
    await db.close();
  }
});

test("the shared tasks are returned for the owner", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const userId = await makeUser(db, "ac1-tasks");

    await createTask(
      db,
      { userId, title: "Book the movers", assignee: "any", createdBy: { kind: "person" } },
      dek,
    );
    await createTask(
      db,
      { userId, title: "Compare travel options", assignee: "any", status: "done", createdBy: { kind: "person" } },
      dek,
    );

    const data = (await lifeAdminPageData(db, userId, dek)) as PageDataLike;

    const titles = new Set(data.tasks.map((t) => t.title));
    assert.equal(data.tasks.length, 2, "both of the owner's tasks are returned regardless of state");
    assert.ok(titles.has("Book the movers"), "an open task's title is decrypted and returned");
    assert.ok(titles.has("Compare travel options"), "a done task's title is decrypted and returned");
  } finally {
    await db.close();
  }
});

test("a person with nothing saved gets empty groups, checklist and tasks — not an error", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const userId = await makeUser(db, "ac1-empty");

    const data = (await lifeAdminPageData(db, userId, dek)) as PageDataLike;

    assert.deepEqual(data.subscriptions, [], "no subscriptions");
    assert.deepEqual(data.receipts, [], "no receipts/warranties");
    assert.deepEqual(data.renewals, [], "no renewals/appointments");
    assert.deepEqual(data.checklist, [], "no checklist items");
    assert.deepEqual(data.tasks, [], "no tasks");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — member scope: the read returns ONLY the session person's data, across every part,
// and the attached-file flag is itself member-scoped.
// ===========================================================================

test("the read returns only the session person's data, never another person's", async () => {
  const db = await freshDb();
  try {
    const dekA = freshDek();
    const dekB = freshDek();
    const a = await makeUser(db, "owner-a");
    const b = await makeUser(db, "owner-b");

    // A's data — content encrypted under A's own DEK.
    await createRecord(
      db,
      { userId: a, kind: "subscription", fields: { service: "A-Netflix" }, status: "active", source: { kind: "person" } },
      dekA,
    );
    await createRecord(
      db,
      { userId: a, kind: "receipt_warranty", fields: { merchant: "A-Merchant" }, status: "kept", source: { kind: "person" } },
      dekA,
    );
    await addOwnItem(db, { userId: a, label: "A-checklist-item" }, dekA);
    await createTask(db, { userId: a, title: "A-task", assignee: "any", createdBy: { kind: "person" } }, dekA);

    // B's data — DIFFERENT values, encrypted under B's own DEK.
    await createRecord(
      db,
      { userId: b, kind: "subscription", fields: { service: "B-Spotify" }, status: "active", source: { kind: "person" } },
      dekB,
    );
    await createRecord(
      db,
      { userId: b, kind: "renewal_appointment", fields: { what: "B-renewal" }, status: "upcoming", source: { kind: "person" } },
      dekB,
    );
    await addOwnItem(db, { userId: b, label: "B-checklist-item" }, dekB);
    await createTask(db, { userId: b, title: "B-task", assignee: "any", createdBy: { kind: "person" } }, dekB);

    const data = (await lifeAdminPageData(db, a, dekA)) as PageDataLike;

    // Only A's data, across every part.
    assert.equal(data.subscriptions.length, 1, "only A's one subscription");
    assert.equal(data.subscriptions[0]!.fields.service, "A-Netflix", "A's subscription value, decrypted");
    assert.equal(data.receipts.length, 1, "only A's one receipt");
    assert.equal(data.renewals.length, 0, "A has no renewals (B's renewal does not leak in)");
    assert.equal(data.checklist.length, 1, "only A's one checklist item");
    assert.equal(data.checklist[0]!.label, "A-checklist-item", "A's checklist label");
    assert.equal(data.tasks.length, 1, "only A's one task");
    assert.equal(data.tasks[0]!.title, "A-task", "A's task title");

    // None of B's data leaked in.
    const whole = JSON.stringify(data);
    assert.ok(!whole.includes("B-Spotify"), "B's subscription never appears");
    assert.ok(!whole.includes("B-renewal"), "B's renewal never appears");
    assert.ok(!whole.includes("B-checklist-item"), "B's checklist item never appears");
    assert.ok(!whole.includes("B-task"), "B's task never appears");
  } finally {
    await db.close();
  }
});

test("the attached-file flag is member-scoped — another person's receipt file never flags your receipt", async () => {
  const db = await freshDb();
  try {
    const dekA = freshDek();
    const dekB = freshDek();
    const a = await makeUser(db, "flag-a");
    const b = await makeUser(db, "flag-b");
    const blob = createInMemoryBlobStore();

    // A has a receipt WITH a file.
    const aReceiptRow = await createRecord(
      db,
      { userId: a, kind: "receipt_warranty", fields: { merchant: "A-Receipt" }, status: "kept", source: { kind: "person" } },
      dekA,
    );
    await saveReceiptFile(
      db,
      blob,
      { userId: a, recordId: aReceiptRow.id, contentType: "image/png", bytes: new TextEncoder().encode("a-file") },
      dekA,
    );

    // B has a receipt WITHOUT a file.
    await createRecord(
      db,
      { userId: b, kind: "receipt_warranty", fields: { merchant: "B-Receipt" }, status: "kept", source: { kind: "person" } },
      dekB,
    );

    const aData = (await lifeAdminPageData(db, a, dekA)) as PageDataLike;
    const bData = (await lifeAdminPageData(db, b, dekB)) as PageDataLike;

    const aReceipt = byField(aData.receipts, "merchant", "A-Receipt");
    const bReceipt = byField(bData.receipts, "merchant", "B-Receipt");
    assert.ok(aReceipt, "A's receipt is listed for A");
    assert.ok(bReceipt, "B's receipt is listed for B");
    assert.equal(aReceipt!.hasAttachedFile, true, "A's receipt is flagged — A owns the file");
    assert.ok(!bReceipt!.hasAttachedFile, "B's receipt is NOT flagged — the file belongs to A, not B");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 [validate-and-parameterize-input] — a handler on the validation boundary rejects
// bad input and takes the user id from the SESSION; the read binds the id as a parameter.
//
// A route handler validates the request HERE (`parseBody`), then reads the page for the
// SESSION's user id — NEVER a value from the request body. The handler is a TEST FIXTURE
// (the intended usage) — not an implementation file.
// ===========================================================================

function lifeAdminPageHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<{ status: number; reached: boolean; data: PageDataLike | null }> {
  // The list-all read takes no client filter, so the handler only validates the request
  // envelope: a well-formed JSON object within a size cap. An id smuggled in the body is
  // stripped and ignored — the owner is the SESSION's id, passed from the closure.
  const schema = z.object({});
  return async (req: Request) => {
    let reached = false;
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      reached = true;
      const data = (await lifeAdminPageData(db, sessionUserId, dek)) as PageDataLike;
      return { status: 200, reached, data };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, reached, data: null };
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test
      // sees the raw failure rather than a masked success.
      return { status: 500, reached, data: null };
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/life-admin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("[validate-and-parameterize-input] the handler rejects malformed JSON with a 4xx before the read runs", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "vp-malformed");
    const handler = lifeAdminPageHandler(db, freshDek(), userId);
    const res = await handler(jsonRequest("{ not valid json"));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "malformed input never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler rejects an oversized body with a 4xx before the read runs", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "vp-oversized");
    const handler = lifeAdminPageHandler(db, freshDek(), userId);
    // ~8 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
    const res = await handler(jsonRequest(JSON.stringify({ junk: "a".repeat(8 * 1024) })));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "an oversized body never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler rejects a mis-typed body (not an object) with a 4xx", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "vp-mistyped");
    const handler = lifeAdminPageHandler(db, freshDek(), userId);
    // A bare number is not the expected object shape — a schema violation, rejected before
    // the read.
    const res = await handler(jsonRequest(JSON.stringify(42)));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "a mis-typed body never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a well-formed request reaches the read and returns the session person's data", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    const userId = await makeUser(db, "vp-ok");
    await createRecord(
      db,
      { userId, kind: "subscription", fields: { service: "Session-Netflix" }, status: "active", source: { kind: "person" } },
      dek,
    );
    const handler = lifeAdminPageHandler(db, dek, userId);

    const res = await handler(jsonRequest(JSON.stringify({})));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(res.reached, true, "a valid body reaches the read");
    assert.equal(res.data!.subscriptions[0]!.fields.service, "Session-Netflix", "the session person's data is returned");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler takes the owner from the session — a userId smuggled in the body is ignored", async () => {
  const db = await freshDb();
  try {
    const dekSession = freshDek();
    const dekAttacker = freshDek();
    const session = await makeUser(db, "vp-session");
    const attacker = await makeUser(db, "vp-attacker");
    await createRecord(
      db,
      { userId: session, kind: "subscription", fields: { service: "Session-Owner-Sub" }, status: "active", source: { kind: "person" } },
      dekSession,
    );
    await createRecord(
      db,
      { userId: attacker, kind: "subscription", fields: { service: "Other-User-Sub" }, status: "active", source: { kind: "person" } },
      dekAttacker,
    );

    const handler = lifeAdminPageHandler(db, dekSession, session);

    // The body tries to redirect the read at another person. The handler validates the
    // envelope, strips the unknown key, and reads for the SESSION's id regardless.
    const res = await handler(jsonRequest(JSON.stringify({ userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(res.data!.subscriptions.length, 1, "exactly the session user's records");
    assert.equal(res.data!.subscriptions[0]!.fields.service, "Session-Owner-Sub", "the session user's data, not the body's");
    assert.ok(!JSON.stringify(res.data).includes("Other-User-Sub"), "the body-supplied user's data never appears");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the person id reaches the db as a BOUND value, never spliced into the SQL", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE life_admin_records; --";
  // The recording db returns no rows, so the read assembles empty collections — but every
  // member-scoped query it issued must have bound the probe, never spliced it.
  await lifeAdminPageData(db, probe, freshDek());
  assertBoundNotSpliced(db, probe);
});

test("[validate-and-parameterize-input] a SQL-injection person id cannot alter a query, drop a table, or leak another person's data", async () => {
  const db = await freshDb();
  try {
    const dek = freshDek();
    // A real owner with a full set of life-admin data; the probe must neither reach nor harm it.
    const owner = await makeUser(db, "probe-owner");
    const blob = createInMemoryBlobStore();
    const receipt = await createRecord(
      db,
      { userId: owner, kind: "receipt_warranty", fields: { merchant: "Real Merchant" }, status: "kept", source: { kind: "person" } },
      dek,
    );
    await saveReceiptFile(
      db,
      blob,
      { userId: owner, recordId: receipt.id, contentType: "image/png", bytes: new TextEncoder().encode("real-file") },
      dek,
    );
    await addOwnItem(db, { userId: owner, label: "Real Item" }, dek);
    await createTask(db, { userId: owner, title: "Real Task", assignee: "any", createdBy: { kind: "person" } }, dek);

    const probe = "p'); DROP TABLE life_admin_records; --";
    // Bound as a parameter, the probe is at worst a value the uuid-typed user_id column
    // rejects (OBS-049: an id-typed selector); it is NEVER executed as SQL. Either outcome —
    // the DB rejects it, or it simply matches nothing — proves the injection did not run.
    let rejectedOrEmpty = false;
    try {
      const data = (await lifeAdminPageData(db, probe, dek)) as PageDataLike;
      rejectedOrEmpty =
        data.subscriptions.length === 0 &&
        data.receipts.length === 0 &&
        data.renewals.length === 0 &&
        data.checklist.length === 0 &&
        data.tasks.length === 0;
    } catch {
      rejectedOrEmpty = true;
    }
    assert.ok(rejectedOrEmpty, "the probe is bound, not executed — it yields nothing or is rejected");

    // The decisive proof: every table and the real owner's whole set of data are intact.
    for (const table of ["life_admin_records", "receipt_files", "moving_checklist", "tasks", "users"]) {
      assert.equal(await tableExists(db, table), true, `the ${table} table is intact`);
    }
    const owned = (await lifeAdminPageData(db, owner, dek)) as PageDataLike;
    assert.equal(owned.receipts.length, 1, "the real owner's receipt survived the probe");
    assert.equal(owned.receipts[0]!.hasAttachedFile, true, "and its attached-file flag survived");
    assert.equal(owned.checklist.length, 1, "the real owner's checklist survived the probe");
    assert.equal(owned.tasks.length, 1, "the real owner's task survived the probe");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [secrets-from-env] — the read uses injected inputs only; no ambient env value lands
// in the assembled data, and it runs with no app env configured.
// ===========================================================================

test("[secrets-from-env] no ambient env secret appears in the assembled data; the read runs from its injected inputs alone", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  // Prove the read does not reach for an ambient database URL: point it at a decoy and rely
  // solely on the injected db seam.
  process.env.DATABASE_URL = `postgres://decoy:${DECOY}@127.0.0.1:1/decoy`;

  const db = await freshDb();
  try {
    const dek = freshDek();
    const userId = await makeUser(db, "env-user");
    const blob = createInMemoryBlobStore();
    const receipt = await createRecord(
      db,
      { userId, kind: "receipt_warranty", fields: { merchant: "Env Merchant" }, status: "kept", source: { kind: "person" } },
      dek,
    );
    await saveReceiptFile(
      db,
      blob,
      { userId, recordId: receipt.id, contentType: "image/png", bytes: new TextEncoder().encode("env-file") },
      dek,
    );
    await addOwnItem(db, { userId, label: "Env Item" }, dek);
    await createTask(db, { userId, title: "Env Task", assignee: "any", createdBy: { kind: "person" } }, dek);

    const data = (await lifeAdminPageData(db, userId, dek)) as PageDataLike;

    // The read worked purely from the injected db + userId + dek.
    assert.equal(data.receipts.length, 1, "the injected db supplied the receipt, not an ambient one");
    assert.equal(data.receipts[0]!.fields.merchant, "Env Merchant", "the read works from its injected inputs alone");
    assert.equal(data.receipts[0]!.hasAttachedFile, true, "the attached-file flag is computed from the injected db");
    assert.equal(data.checklist.length, 1, "the checklist came from the injected db");
    assert.equal(data.tasks.length, 1, "the tasks came from the injected db");
    assert.ok(!JSON.stringify(data).includes(DECOY), "no ambient env secret appears in the assembled data");
  } finally {
    await db.close();
    restoreEnv("WARTHOG_DECOY_SECRET", prevDecoy);
    restoreEnv("DATABASE_URL", prevDbUrl);
  }
});

// ===========================================================================
// recordPhases — where each record stands, from the one lifecycle module; a trip takes its
// dates from its bookings, any other anchor shows the span of its live bookings.
// ===========================================================================

test("recordPhases: each record's phase, a trip's span from the bookings that went ahead, an anchor's from its live bookings", () => {
  const now = new Date("2026-11-23T01:00:00.000Z");
  const zone = "Australia/Sydney";
  const base = { kind: "item" as const, status: "active", state: "confirmed", dueDate: null, parentId: null };
  const records = [
    { ...base, id: "trip", type: "travel.trip", fields: { name: "Tokyo" } },
    { ...base, id: "f1", type: "travel.flight", parentId: "trip", fields: { starts_at: "2026-12-03T09:00+11:00[Australia/Sydney]" }, dueDate: "2026-12-03" },
    { ...base, id: "f2", type: "travel.flight", parentId: "trip", fields: { starts_at: "2026-12-10T10:00+09:00[Asia/Tokyo]" }, dueDate: "2026-12-10" },
    { ...base, id: "f3", type: "travel.flight", parentId: "trip", status: "cancelled", state: "cancelled", fields: { starts_at: "2026-12-20T10:00+09:00[Asia/Tokyo]" }, dueDate: "2026-12-20" },
    { ...base, id: "bike", type: "vehicles.vehicle", fields: { name: "Honda" } },
    { ...base, id: "svc-old", type: "vehicles.booking", parentId: "bike", fields: { starts_at: "2026-08-01T09:00+10:00[Australia/Sydney]" }, dueDate: "2026-08-01" },
    { ...base, id: "svc-new", type: "vehicles.booking", parentId: "bike", fields: { starts_at: "2026-12-05T09:00+11:00[Australia/Sydney]" }, dueDate: "2026-12-05" },
    { ...base, id: "rego", type: "vehicles.registration", parentId: "bike", fields: {}, dueDate: "2026-12-14" },
  ];
  const phases = recordPhases(records, BUILT_IN, now, zone);
  const trip = phases.get("trip")!;
  assert.deepEqual([trip.phase, trip.starts?.toISOString(), trip.ends?.toISOString()], ["upcoming", "2026-12-02T22:00:00.000Z", "2026-12-10T05:00:00.000Z"], "from the first flight to the end of the last one that's going ahead");
  assert.equal(phases.get("f3")!.phase, "cancelled");
  const bike = phases.get("bike")!;
  assert.deepEqual([bike.phase, bike.starts?.toISOString()], ["current", "2026-12-04T22:00:00.000Z"], "a vehicle shows its live booking, not last August's service");
  assert.deepEqual([phases.get("svc-old")!.bucket, phases.get("rego")!.phase], ["finished", "due_soon"]);
});
