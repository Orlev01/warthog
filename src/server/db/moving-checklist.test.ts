// E14-S05 — Moving checklist store (`src/server/db/moving-checklist.ts`,
// `db/migrations/0036_moving_checklist.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./moving-checklist` fails and `freshDb()` has no `moving_checklist` table — every test here
// fails until the builder adds them. That absence IS the point of test-first; do NOT implement
// anything to make these pass — the builder writes the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored item, the owner
// list-all read, the DEK-encrypted label that round-trips only under the owner's key, the
// plaintext source-kind / source-reference / done metadata, the idempotent seed, who may
// read/change what, what a handler rejects, that every value is bound as a parameter), never the
// source text of the module or the SQL file — a later rename that preserves behaviour must not
// redden them.
//
// WHY this exists (task E14-S05; brief §"Moving-house helper": when the person adds a new address
// with a moving date, Warthog creates a moving checklist of places that hold the OLD address —
// connected services, the subscriptions and renewal records on file, and the person's own
// additions — each of which can be ticked off or handed to an agent as a task). A checklist item's
// LABEL is PERSONAL CONTENT, so it is stored only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1):
// the row id is generated up front so each envelope's associated data binds the ciphertext to its
// exact (table, column, row), and the plaintext label never lands in a column. The SOURCE KIND
// (connection | subscription | renewal | own), the SOURCE REFERENCE, the DONE flag and the optional
// LINKED TASK id stay PLAINTEXT metadata (design §4.1) so the owner list and the idempotent seed can
// filter / dedupe WITHOUT decrypting another person's data. Seeding must be IDEMPOTENT on
// (user, source kind, source reference) so re-running the moving-house helper never duplicates
// items (and never resets an item the person already ticked off).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type ChecklistSourceKind =                 // PLAINTEXT metadata — where the item came from
//     "connection" | "subscription" | "renewal" | "own";
//
//   interface SeedItem {                       // one place that holds the old address, to seed
//     label: string;                           // the human label — stored DEK-ENCRYPTED
//     sourceKind: ChecklistSourceKind;         // PLAINTEXT metadata
//     sourceReference: string;                 // opaque ref to the source row/service — PLAINTEXT metadata
//   }
//
//   interface SeedItemsInput {                 // what seedItems records
//     userId: string;                          // the OWNER (the session's / connection's id, NEVER a client value)
//     items: SeedItem[];                        // the sources to seed (deduped on kind+reference per user)
//   }
//
//   interface ChecklistItem {                  // an item as handed back to its owner
//     id: string; userId: string;
//     label: string;                           // decrypted on read
//     sourceKind: ChecklistSourceKind; sourceReference: string;  // PLAINTEXT metadata
//     done: boolean;                           // PLAINTEXT metadata
//     linkedTaskId: string | null;             // PLAINTEXT metadata — the task it was handed off as, or null
//   }
//
//   seedItems(db, input: SeedItemsInput, dek): Promise<...>
//     • IDEMPOTENT on (user, source kind, source reference): stores each item's label DEK-encrypted
//       plus the plaintext metadata (source kind/reference, done defaulting to false). A second seed
//       over the SAME (kind, reference) for the same user adds NOTHING and changes nothing (it does
//       not reset an item already ticked off, nor overwrite its label). The id is generated up front
//       so the label envelope binds to the row. The return value is NOT pinned (verified via the list
//       read).
//   listForUser(db, userId, dek): Promise<ChecklistItem[]>
//     • ALL of `userId`'s checklist items (member-scoped: user_id bound), each label DECRYPTED under
//       the owner's `dek`; never another person's. Empty array when the person has none.
//   toggleDone(db, input: { userId, id }): Promise<boolean>
//     • MEMBER-SCOPED (WHERE id AND user_id bound): FLIPS the owner's own item's done flag. DEK-FREE
//       (done is plaintext metadata, so the label is never touched). Returns true when it toggled one,
//       false when none matched — so one person can never tick off another's item.
//   linkTask(db, input: { userId, id, taskId }): Promise<boolean>
//     • MEMBER-SCOPED (WHERE id AND user_id bound): records the task id the owner's item was handed
//       off as. DEK-FREE (the linked task id is plaintext metadata). Returns true when it linked one,
//       false when none matched — so one person can never alter another's item.
//   addOwnItem(db, input: { userId, label }, dek): Promise<ChecklistItem>
//     • the person's OWN addition: stores the label DEK-encrypted with sourceKind "own" and a FRESH
//       source reference (so two own additions never collide under the seed's idempotency key), done
//       false, no linked task. Returns the created item assembled from its inputs.
//
// Acceptance criteria → tests:
//   AC1 "Items store their label DEK-encrypted with the source kind/reference and done flag as
//        plaintext, and listForUser returns the owner's checklist." — a seeded item's label never
//        appears in a raw column (encrypted at rest) yet round-trips under the owner's DEK; the
//        source kind/reference and done flag ARE plaintext metadata; listForUser returns all of the
//        owner's items decrypted.
//   AC2 "seedItems is idempotent on (user, source kind, source reference): a second seed over the
//        same sources adds nothing, while toggleDone and linkTask update an item." — re-seeding the
//        same sources leaves the count (and a ticked item's state, and its label) unchanged; a new
//        reference adds one; toggleDone flips done; linkTask records the task id.
//   AC3 "A user cannot read or change another user's checklist (filtered by session user id)." — B
//        never sees A's items in the list; toggleDone / linkTask on A's item under B's id change
//        nothing and report false; a handler takes the owner from the SESSION, so a userId smuggled
//        in the body never writes under another person; seeding is per-user (same source for two
//        people does not collide).
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the `../http/validate`
//        boundary rejects malformed / oversized / missing / mis-typed input with a 4xx before any
//        query runs; a SQL-injection probe routed through the repo travels as a BOUND value
//        (placeholders, never concatenation) and cannot drop the table. The handler below is a test
//        fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes `db` and
//        the `dek` as injected dependencies, holds no key and reads no `process.env`. Shown
//        behaviourally: the label is encrypted under the INJECTED dek (a different dek cannot read it
//        back — not a baked-in secret), and a decoy secret planted in the environment never lands in
//        a stored or returned item.
//   Migration: the `moving_checklist` relation exists after the project migrations and a second run
//        of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests share
// no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  seedItems,
  listForUser,
  toggleDone,
  linkTask,
  addOwnItem,
} from "./moving-checklist";
import { createTask } from "./tasks";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer up; this
// repo only ever receives the already-unwrapped bytes.
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
// reached the query layer and HOW (bound value vs. spliced text). It returns no rows and satisfies
// the `Db` shape structurally (query + close).
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

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the relation
// name when it exists and NULL when it does not — a non-throwing probe scoped to the one table
// under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text, scoped to
// each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// A structural view of a returned item, so the helpers below do not depend on the (absent) module's
// exported types at the point they run.
interface ItemLike {
  readonly id: string;
  readonly userId: string;
  readonly label: string;
  readonly sourceKind: string;
  readonly sourceReference: string;
  readonly done: boolean;
  readonly linkedTaskId: string | null;
}

// Find the one listed item carrying this exact source reference (list order is not pinned).
function itemByRef(items: ItemLike[], reference: string): ItemLike | undefined {
  return items.find((i) => i.sourceReference === reference);
}
// Find the one listed item carrying this exact decrypted label.
function itemByLabel(items: ItemLike[], label: string): ItemLike | undefined {
  return items.find((i) => i.label === label);
}

// A handful of sources the moving-house helper would seed (the three non-"own" kinds).
function sampleSources() {
  return [
    { label: "Gmail account", sourceKind: "connection" as const, sourceReference: "conn-gmail-1" },
    { label: "Netflix subscription", sourceKind: "subscription" as const, sourceReference: "sub-netflix-7" },
    { label: "Car rego renewal", sourceKind: "renewal" as const, sourceReference: "ren-rego-3" },
  ];
}

// A placeholder owner id that belongs to nobody in these tests (for "wrong owner" probes).
const ABSENT_USER = "11111111-1111-1111-1111-111111111111";

// ===========================================================================
// AC1 — items store the label DEK-encrypted with the source kind/reference and done flag as
// plaintext metadata; listForUser returns all of the owner's items decrypted.
// ===========================================================================

test("seedItems stores items that listForUser returns with their label, source and done flag", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    await seedItems(db, { userId, items: sampleSources() }, dek);

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(items.length, 3, "all three seeded sources are listed");
    for (const i of items) {
      assert.equal(i.userId, userId, "every listed item belongs to the owner");
      assert.equal(i.done, false, "a freshly seeded item starts not done");
      assert.equal(i.linkedTaskId, null, "a freshly seeded item has no linked task");
      assert.equal(typeof i.id, "string", "each item has an id");
      assert.ok(i.id.length > 0, "the id is non-empty");
    }

    const gmail = itemByRef(items, "conn-gmail-1");
    assert.ok(gmail, "the connection source is listed");
    assert.equal(gmail!.label, "Gmail account", "its label decrypts back to what was seeded");
    assert.equal(gmail!.sourceKind, "connection", "its source kind round-trips");

    const sub = itemByRef(items, "sub-netflix-7");
    assert.equal(sub!.sourceKind, "subscription", "the subscription source kind round-trips");
    assert.equal(sub!.label, "Netflix subscription", "the subscription label decrypts");

    const ren = itemByRef(items, "ren-rego-3");
    assert.equal(ren!.sourceKind, "renewal", "the renewal source kind round-trips");
  } finally {
    await db.close();
  }
});

test("the label is stored DEK-encrypted while the source reference stays plaintext metadata", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    // A unique marker placed INSIDE the encrypted label (personal content). The source reference is
    // deliberately PLAINTEXT metadata (so the seed can dedupe and the list can filter without
    // decrypting), so it must be a distinct, non-secret value that we EXPECT to see in the clear.
    const labelSecret = "LEAKCHECK_move_label_9x7Q my accountant Jane at 12 Rivett St";
    const plaintextRef = "conn-xero-PLAINTEXTREF-123";

    await seedItems(
      db,
      { userId, items: [{ label: labelSecret, sourceKind: "connection", sourceReference: plaintextRef }] },
      dek,
    );

    // Scan every cell of the one table under test. The label marker is unique and lives only in an
    // encrypted column, so any raw occurrence is a genuine plaintext leak. Scoped to
    // `moving_checklist` alone — the same value may legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM moving_checklist");
    assert.ok(all.rows.length >= 1, "the item row was stored");
    let sawPlaintextRef = false;
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(labelSecret), "the plaintext label must never be written to a column");
          if (cell.includes(plaintextRef)) sawPlaintextRef = true;
        }
      }
    }
    assert.ok(
      sawPlaintextRef,
      "the source reference is stored as PLAINTEXT metadata (so seeding can dedupe without decrypting)",
    );

    // ...yet the label round-trips under the owner's DEK.
    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(items[0]!.label, labelSecret, "the label decrypts back to what was seeded");
  } finally {
    await db.close();
  }
});

test("listForUser returns an empty array for a person with no checklist", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const items = await listForUser(db, userId, freshDek());
    assert.deepEqual(items, [], "a person with no checklist gets an empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — seedItems is idempotent on (user, source kind, source reference); toggleDone and linkTask
// update an item.
// ===========================================================================

test("re-seeding the same sources adds nothing (idempotent on user + source kind + reference)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-idempotent");
    const dek = freshDek();

    await seedItems(db, { userId, items: sampleSources() }, dek);
    assert.equal((await listForUser(db, userId, dek)).length, 3, "the first seed stores three items");

    // A second seed over the SAME sources must add nothing — re-running the helper never duplicates.
    await seedItems(db, { userId, items: sampleSources() }, dek);
    assert.equal(
      (await listForUser(db, userId, dek)).length,
      3,
      "a second seed over the same sources adds nothing",
    );
  } finally {
    await db.close();
  }
});

test("seeding a NEW reference adds exactly that one item (same kind, different reference)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-newref");
    const dek = freshDek();

    await seedItems(db, { userId, items: sampleSources() }, dek);
    // Same kind ("connection") but a reference not yet seen → a new item; the already-seen ones are
    // left alone.
    await seedItems(
      db,
      {
        userId,
        items: [
          ...sampleSources(),
          { label: "Dropbox account", sourceKind: "connection", sourceReference: "conn-dropbox-9" },
        ],
      },
      dek,
    );

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(items.length, 4, "only the genuinely new reference was added");
    assert.ok(itemByRef(items, "conn-dropbox-9"), "the new reference is present");
    assert.equal(itemByRef(items, "conn-dropbox-9")!.label, "Dropbox account", "with its label");
  } finally {
    await db.close();
  }
});

test("re-seeding does NOT reset an item already ticked off, nor overwrite its label", async () => {
  // The idempotency key makes a repeat seed a no-op for an existing source: it must NOT reset the
  // person's done flag (they already ticked it), nor overwrite the stored label. This is the
  // difference between "do nothing on conflict" and a blind upsert.
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-preserve");
    const dek = freshDek();

    await seedItems(
      db,
      { userId, items: [{ label: "Gmail account", sourceKind: "connection", sourceReference: "conn-gmail-1" }] },
      dek,
    );
    const seeded = (await listForUser(db, userId, dek)) as ItemLike[];
    const toggled = await toggleDone(db, { userId, id: seeded[0]!.id });
    assert.equal(toggled, true, "the owner ticks the item off");

    // Re-seed the SAME (kind, reference) but with a DIFFERENT label — a blind upsert would reset
    // done and clobber the label; idempotent seeding must leave the existing row untouched.
    await seedItems(
      db,
      { userId, items: [{ label: "CHANGED LABEL", sourceKind: "connection", sourceReference: "conn-gmail-1" }] },
      dek,
    );

    const after = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(after.length, 1, "still exactly one item");
    assert.equal(after[0]!.id, seeded[0]!.id, "it is the same row");
    assert.equal(after[0]!.done, true, "the ticked-off state survives the re-seed");
    assert.equal(after[0]!.label, "Gmail account", "the original label is NOT overwritten by the re-seed");
  } finally {
    await db.close();
  }
});

test("toggleDone flips the owner's item done flag and reports it matched one", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-toggle");
    const dek = freshDek();
    await seedItems(db, { userId, items: sampleSources() }, dek);
    const target = itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "sub-netflix-7")!;
    assert.equal(target.done, false, "it starts not done");

    const first = await toggleDone(db, { userId, id: target.id });
    assert.equal(first, true, "toggleDone reports it toggled an item");
    assert.equal(
      itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "sub-netflix-7")!.done,
      true,
      "the item is now done",
    );

    // Toggling again flips it back (toggle, not set).
    const second = await toggleDone(db, { userId, id: target.id });
    assert.equal(second, true, "toggleDone again reports it toggled an item");
    assert.equal(
      itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "sub-netflix-7")!.done,
      false,
      "the item is not done again (toggle flips, it does not force a fixed value)",
    );
  } finally {
    await db.close();
  }
});

test("toggleDone reports false and changes nothing for an item that does not belong to the user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-toggle-absent");
    const dek = freshDek();
    await seedItems(db, { userId, items: sampleSources() }, dek);
    const target = itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "conn-gmail-1")!;

    const marked = await toggleDone(db, { userId: ABSENT_USER, id: target.id });
    assert.equal(marked, false, "toggling under a different user matches nothing");
    assert.equal(
      itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "conn-gmail-1")!.done,
      false,
      "the owner's item is untouched",
    );
  } finally {
    await db.close();
  }
});

test("linkTask records the task the owner's item was handed off as, and reports it matched one", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-link");
    const dek = freshDek();
    await seedItems(db, { userId, items: sampleSources() }, dek);
    const target = itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "ren-rego-3")!;
    assert.equal(target.linkedTaskId, null, "it starts with no linked task");

    // The item is handed to an agent as a real task; link it by id.
    const handoff = await createTask(
      db,
      { userId, title: "Update car rego address", assignee: "any", createdBy: { kind: "person" } },
      dek,
    );

    const linked = await linkTask(db, { userId, id: target.id, taskId: handoff.id });
    assert.equal(linked, true, "linkTask reports it linked an item");

    const after = itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "ren-rego-3")!;
    assert.equal(after.linkedTaskId, handoff.id, "the item now carries the handed-off task id");
  } finally {
    await db.close();
  }
});

test("linkTask reports false and changes nothing for an item that does not belong to the user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-link-absent");
    const dek = freshDek();
    await seedItems(db, { userId, items: sampleSources() }, dek);
    const target = itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "conn-gmail-1")!;
    const handoff = await createTask(
      db,
      { userId, title: "A task", assignee: "any", createdBy: { kind: "person" } },
      dek,
    );

    const linked = await linkTask(db, { userId: ABSENT_USER, id: target.id, taskId: handoff.id });
    assert.equal(linked, false, "linking under a different user matches nothing");
    assert.equal(
      itemByRef((await listForUser(db, userId, dek)) as ItemLike[], "conn-gmail-1")!.linkedTaskId,
      null,
      "the owner's item still has no linked task",
    );
  } finally {
    await db.close();
  }
});

test("addOwnItem adds the person's own item with source kind 'own', and twice does not collide", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-own");
    const dek = freshDek();

    const first = (await addOwnItem(db, { userId, label: "Tell my book club" }, dek)) as ItemLike;
    assert.equal(first.sourceKind, "own", "an own addition has source kind 'own'");
    assert.equal(first.label, "Tell my book club", "the returned item carries its label");
    assert.equal(first.done, false, "it starts not done");
    assert.equal(first.linkedTaskId, null, "it starts with no linked task");
    assert.equal(first.userId, userId, "it belongs to the person");
    assert.ok(typeof first.sourceReference === "string" && first.sourceReference.length > 0, "it has a source reference");

    // A second own addition — even with the SAME label — must NOT be deduped away by the seed key
    // (own additions carry a fresh reference each time).
    const second = (await addOwnItem(db, { userId, label: "Tell my book club" }, dek)) as ItemLike;
    assert.notEqual(second.id, first.id, "a second own addition is a distinct item");
    assert.notEqual(
      second.sourceReference,
      first.sourceReference,
      "each own addition gets its own source reference, so they never collide",
    );

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(items.length, 2, "both own additions are listed");
    assert.ok(items.every((i) => i.sourceKind === "own"), "both are 'own' items");
  } finally {
    await db.close();
  }
});

test("addOwnItem items live alongside seeded items on one checklist", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-mixed");
    const dek = freshDek();

    await seedItems(db, { userId, items: sampleSources() }, dek);
    await addOwnItem(db, { userId, label: "Redirect post at the post office" }, dek);

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(items.length, 4, "three seeded plus one own addition");
    const own = itemByLabel(items, "Redirect post at the post office");
    assert.ok(own, "the own addition is listed");
    assert.equal(own!.sourceKind, "own", "with source kind 'own'");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Shared-row invariant (OBS-022): link + toggle + re-seed must not clobber the encrypted label or
// each other across a sequence of mutations.
// ===========================================================================

test("toggle, link and re-seed preserve the item's label and each other's effect (shared-row invariant)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "invariant");
    const dek = freshDek();

    await seedItems(
      db,
      { userId, items: [{ label: "Gmail account", sourceKind: "connection", sourceReference: "conn-gmail-1" }] },
      dek,
    );
    let item = (await listForUser(db, userId, dek))[0] as ItemLike;
    const handoff = await createTask(
      db,
      { userId, title: "Change Gmail recovery address", assignee: "agent-claude-1", createdBy: { kind: "person" } },
      dek,
    );

    await linkTask(db, { userId, id: item.id, taskId: handoff.id });
    await toggleDone(db, { userId, id: item.id });
    // A re-seed of the same source must not undo the link or the tick, nor change the label.
    await seedItems(
      db,
      { userId, items: [{ label: "SHOULD NOT REPLACE", sourceKind: "connection", sourceReference: "conn-gmail-1" }] },
      dek,
    );

    const all = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(all.length, 1, "still exactly one item through the whole sequence");
    item = all[0]!;
    assert.equal(item.label, "Gmail account", "the DEK-encrypted label survives link + toggle + re-seed");
    assert.equal(item.done, true, "the tick survives");
    assert.equal(item.linkedTaskId, handoff.id, "the link survives");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second person can never read or change another's checklist. Seeding is
// per-user, so the same source for two people does not collide.
// ===========================================================================

test("listForUser never returns another person's checklist items", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    await seedItems(db, { userId: alice, items: sampleSources() }, dek);
    await addOwnItem(db, { userId: bob, label: "Bob's own item" }, dek);

    const aliceItems = (await listForUser(db, alice, dek)) as ItemLike[];
    assert.equal(aliceItems.length, 3, "Alice sees exactly her own three items");
    assert.ok(aliceItems.every((i) => i.userId === alice), "every item in Alice's list is hers");
    assert.ok(!itemByLabel(aliceItems, "Bob's own item"), "Bob's item never appears in Alice's list");

    const bobItems = (await listForUser(db, bob, dek)) as ItemLike[];
    assert.equal(bobItems.length, 1, "Bob sees exactly his own item");
    assert.equal(bobItems[0]!.label, "Bob's own item", "Bob sees his own item");
  } finally {
    await db.close();
  }
});

test("seeding is per-user: the same source for two people does not collide", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "seed-alice");
    const bob = await makeUser(db, "seed-bob");
    const dek = freshDek();

    // Alice and Bob each seed a connection with the SAME (kind, reference) — the idempotency key is
    // scoped to the owner, so each gets their own item.
    const shared = [{ label: "Gmail account", sourceKind: "connection" as const, sourceReference: "conn-gmail-1" }];
    await seedItems(db, { userId: alice, items: shared }, dek);
    await seedItems(db, { userId: bob, items: shared }, dek);

    assert.equal((await listForUser(db, alice, dek)).length, 1, "Alice has her own copy");
    assert.equal((await listForUser(db, bob, dek)).length, 1, "Bob has his own copy");

    // And Bob re-seeding his own source is still idempotent for Bob.
    await seedItems(db, { userId: bob, items: shared }, dek);
    assert.equal((await listForUser(db, bob, dek)).length, 1, "a per-user re-seed is still idempotent");
  } finally {
    await db.close();
  }
});

test("toggleDone cannot tick off another person's item", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "toggle-alice");
    const bob = await makeUser(db, "toggle-bob");
    const dek = freshDek();
    await seedItems(db, { userId: alice, items: sampleSources() }, dek);
    const aliceItem = itemByRef((await listForUser(db, alice, dek)) as ItemLike[], "conn-gmail-1")!;

    const marked = await toggleDone(db, { userId: bob, id: aliceItem.id });
    assert.equal(marked, false, "Bob cannot toggle Alice's item");
    assert.equal(
      itemByRef((await listForUser(db, alice, dek)) as ItemLike[], "conn-gmail-1")!.done,
      false,
      "Alice's item is still not done",
    );
  } finally {
    await db.close();
  }
});

test("linkTask cannot alter another person's item", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "link-alice");
    const bob = await makeUser(db, "link-bob");
    const dek = freshDek();
    await seedItems(db, { userId: alice, items: sampleSources() }, dek);
    const aliceItem = itemByRef((await listForUser(db, alice, dek)) as ItemLike[], "conn-gmail-1")!;
    // Bob links with a real task of his own, so no FK (if any) is tripped — the member scope, not a
    // missing task, is what must refuse the write.
    const bobTask = await createTask(
      db,
      { userId: bob, title: "Bob's task", assignee: "any", createdBy: { kind: "person" } },
      dek,
    );

    const linked = await linkTask(db, { userId: bob, id: aliceItem.id, taskId: bobTask.id });
    assert.equal(linked, false, "Bob cannot link a task onto Alice's item");
    assert.equal(
      itemByRef((await listForUser(db, alice, dek)) as ItemLike[], "conn-gmail-1")!.linkedTaskId,
      null,
      "Alice's item still has no linked task",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("seedItems binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  // The probe is a source REFERENCE — plaintext metadata that reaches a query verbatim (the label
  // would be encrypted before binding, so it is not a parameterize probe).
  const probe = "ref'); DROP TABLE moving_checklist; --";

  try {
    await seedItems(
      db,
      { userId: "session-user", items: [{ label: "x", sourceKind: "connection", sourceReference: probe }] },
      freshDek(),
    );
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("addOwnItem binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE moving_checklist; --";

  try {
    await addOwnItem(db, { userId: probe, label: "x" }, freshDek());
  } catch {
    /* tolerate a no-row read: the binding is asserted regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("toggleDone binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "t'); DROP TABLE moving_checklist; --";

  const marked = await toggleDone(db, { userId: probe, id: "some-id" });
  assert.equal(marked, false, "the recording db matches no row, so nothing is toggled");

  assertBoundNotSpliced(db, probe);
});

test("linkTask binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE moving_checklist; --";

  const linked = await linkTask(db, { userId: probe, id: "some-id", taskId: "task-id" });
  assert.equal(linked, false, "the recording db matches no row, so nothing is linked");

  assertBoundNotSpliced(db, probe);
});

test("listForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "s'); DROP TABLE moving_checklist; --";

  const result = await listForUser(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in a source reference is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject-ref");
    const dek = freshDek();
    const probe = "ref'); DROP TABLE moving_checklist; --";

    await seedItems(db, { userId, items: [{ label: "x", sourceKind: "own", sourceReference: probe }] }, dek);

    assert.equal(
      await tableExists(db, "moving_checklist"),
      true,
      "the table must still exist (the probe was stored as data, not run as SQL)",
    );
    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.ok(itemByRef(items, probe), "the probe round-trips verbatim as a plaintext reference");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value) and the injected dek.
// A rejected input maps to a 4xx Response and never reaches a query. This handler is a test
// fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function addOwnItemHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries only the new item's label; the user id comes from the session, never the body.
  // The length is capped so an absurd value is rejected, but generous enough that a probe can still
  // REACH the query to prove it is bound.
  const schema = z.object({ label: z.string().min(1).max(500) });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const saved = await addOwnItem(db, { userId: sessionUserId, label: body.label }, dek);
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees the
      // raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/moving-checklist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function validBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ label: "Redirect post at the post office", ...over });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addOwnItemHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addOwnItemHandler(db, freshDek(), "session-user");

  // ~20 KiB label, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ label: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the label with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addOwnItemHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest(JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects an empty label with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addOwnItemHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest(validBody({ label: "" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an empty label must never reach a query");
});

test("the handler rejects a mis-typed label with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addOwnItemHandler(db, freshDek(), "session-user");

  // label must be a string — a number is a schema violation.
  const res = await handler(jsonRequest(validBody({ label: 12345 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and records the item for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = addOwnItemHandler(db, dek, userId);

    const res = await handler(jsonRequest(validBody()));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the stored item id");

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(items.length, 1, "a valid body is persisted for the session user");
    assert.equal(items[0]!.id, id, "the stored item matches the returned id");
    assert.equal(items[0]!.label, "Redirect post at the post office", "with the submitted label, decrypted");
    assert.equal(items[0]!.sourceKind, "own", "an item added through the handler is an 'own' item");
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
    const handler = addOwnItemHandler(db, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listForUser(db, sessionUser, dek)).length,
      1,
      "the item is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listForUser(db, attacker, dek),
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
    const dek = freshDek();
    const handler = addOwnItemHandler(db, dek, userId);
    const probe = "oren'); DROP TABLE moving_checklist; --";

    const res = await handler(jsonRequest(validBody({ label: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "moving_checklist"), true, "the table must still exist");

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.ok(itemByLabel(items, probe), "the probe label is stored verbatim (encrypted), not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the label is encrypted under the INJECTED dek, not a baked-in secret (a different dek
// cannot read it back); the repo reads no process.env and holds no key (INV-103), shown
// behaviourally with a decoy secret in the environment.
// ===========================================================================

test("listForUser cannot decrypt the label with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    await seedItems(
      db,
      { userId, items: [{ label: "Secret label", sourceKind: "connection", sourceReference: "conn-1" }] },
      dek,
    );

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes — so
    // reading the checklist under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listForUser(db, userId, wrongDek);
      },
      "the label is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in an item", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    await seedItems(
      db,
      { userId, items: [{ label: "A normal item", sourceKind: "own", sourceReference: "own-1" }] },
      dek,
    );

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(items.length, 1, "the item reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(items).includes(DECOY),
      "no ambient env value is folded into the returned items",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same value
    // could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM moving_checklist");
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

test("the moving_checklist migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "moving_checklist"),
      true,
      "the moving_checklist table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0036_moving_checklist"),
      "db/migrations/0036_moving_checklist.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0036's CREATE would throw "already exists", so an empty result AND no throw together prove the
    // migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
