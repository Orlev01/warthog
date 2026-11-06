// E14-S03 — Encrypted receipt-file store (`src/server/storage/receipt-files.ts`,
// `db/migrations/0034_receipt_files.sql`).
//
// RED-first: neither the store module nor the migration exists yet, so importing
// `./receipt-files` throws and `freshDb()` has no `receipt_files` table — every test
// here fails until the builder adds them. That absence IS the point of test-first; do
// NOT implement anything to make these pass — the builder writes the module and the
// migration afterwards.
//
// These tests pin BEHAVIOUR (what the store DOES: encrypts a file's bytes under the
// owner's DEK before the blob put so the blob holds only ciphertext, round-trips the
// exact plaintext to the owner, rejects a tampered/truncated/wrong-key blob rather than
// returning bad bytes, scopes every read/add/remove to the session's user id, binds
// every value as a parameter, and leaks no secret) — never the source text of the
// module or the SQL file, so a later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E14-S03; design §4.1 — "receipt files (encrypted before upload)",
// §2 — "Storage account (blob), private container, no public access … files are encrypted
// by the app before upload"): receipt files are PERSONAL CONTENT. The app encrypts a file's
// bytes with the person's 256-bit DEK (AES-256-GCM) BEFORE handing the ciphertext to the
// blob seam (`./blob`), so the blob holds only ciphertext — the plaintext file lands in no
// store Warthog operates. A row keeps the PLAINTEXT metadata needed to fetch and decrypt it
// (which record it belongs to, the blob key, the per-file nonce, the content type, the
// plaintext size), scoped to its owner. Only the owner's DEK can read the bytes back, and a
// tampered or truncated blob fails the GCM check and throws.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface NewReceiptFile {        // what saveReceiptFile records
//     userId: string;                 // the OWNER (the session's / connection's id, NEVER a client value)
//     recordId: string;               // the life-admin record this receipt belongs to — PLAINTEXT metadata
//     contentType: string;            // the file's MIME type — PLAINTEXT metadata
//     bytes: Uint8Array;              // the plaintext file bytes — ENCRYPTED before the blob put
//   }
//
//   interface ReceiptFileMeta {       // a stored receipt file's metadata (no bytes)
//     id: string; userId: string; recordId: string;
//     blobKey: string;                // the opaque key the ciphertext lives under in the blob seam
//     contentType: string;
//     size: number;                   // the PLAINTEXT byte length
//   }
//
//   interface ReceiptFile extends ReceiptFileMeta {   // a downloaded, decrypted receipt file
//     bytes: Uint8Array;              // the decrypted plaintext bytes
//   }
//
//   saveReceiptFile(db, blob, input: NewReceiptFile, dek): Promise<ReceiptFileMeta>
//     • generates the id + the blob key up front, ENCRYPTS the bytes with the owner's DEK
//       (AES-256-GCM, a random 96-bit nonce per file), PUTS the CIPHERTEXT through the blob
//       seam, and inserts a row (id, user_id, record_id, blob_key, nonce, content_type, size).
//       Returns the metadata, assembled from its inputs (no dependency on a RETURNING read).
//   getReceiptFile(db, blob, { userId, id }, dek): Promise<ReceiptFile | null>
//     • MEMBER-SCOPED (WHERE id AND user_id bound): reads the row, fetches the ciphertext from
//       the blob by its stored key, DECRYPTS it with the owner's DEK + the stored nonce, and
//       returns the decrypted bytes + metadata. Returns null when no such file belongs to this
//       user (so another person's file — or an absent id — is invisible). A tampered or
//       truncated blob (or a wrong DEK) fails the GCM check and THROWS rather than returning
//       bad bytes.
//   deleteReceiptFile(db, blob, { userId, id }): Promise<boolean>
//     • MEMBER-SCOPED: removes BOTH the row AND the blob only when the file belongs to this
//       user; returns true when it removed one, false when none matched — so one person can
//       never remove another's file, and a deleted file leaves no orphaned ciphertext.
//
// Acceptance criteria → tests:
//   AC1 "Saving a receipt file encrypts the bytes with the owner's DEK before the blob put, so
//        the blob stores only ciphertext and never the plaintext file." — saveReceiptFile
//        returns the id/metadata; the stored blob is ciphertext (the plaintext marker never
//        appears in it, and it is not the plaintext) yet round-trips under the owner's DEK; a
//        random nonce per file makes two saves of identical bytes store different ciphertext.
//   AC2 "Downloading returns the decrypted bytes to the owner, and a tampered or truncated blob
//        fails the GCM check and throws rather than returning bad bytes." — getReceiptFile
//        round-trips the exact plaintext/content-type/size; corrupting or truncating the stored
//        blob makes it reject; a wrong DEK rejects.
//   AC3 "A user cannot read, add or remove another user's receipt file (filtered by session user
//        id)." — B's getReceiptFile on A's file id returns null; B's deleteReceiptFile on A's
//        file returns false and leaves A's file + blob intact; a handler takes the owner from
//        the SESSION, so a userId smuggled in the body never adds under another person.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//        with a 4xx before any query or blob write runs; a SQL-injection probe routed through
//        the store travels as a BOUND value (placeholders, never concatenation) and cannot drop
//        the table. The handler below is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the store takes
//        `db`, the `blob` seam and the `dek` as injected dependencies, holds no key and reads no
//        `process.env`. Shown behaviourally: the bytes are encrypted under the INJECTED dek (a
//        different dek cannot read them back — not a baked-in secret), and a decoy secret planted
//        in the environment never lands in a stored row, the blob, or a returned file.
//   Migration: the `receipt_files` relation exists after the project migrations and a second run
//        of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations) and its own
// `createInMemoryBlobStore()`, so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";

import {
  saveReceiptFile,
  getReceiptFile,
  deleteReceiptFile,
} from "./receipt-files";
// Documentary type anchors — the names/shapes the implementation exports. Erased at runtime, so
// a rename that preserves behaviour cannot redden the run for the wrong reason; the runtime
// assertions below are what gate behaviour.
import type { NewReceiptFile, ReceiptFileMeta, ReceiptFile } from "./receipt-files";
import { createInMemoryBlobStore } from "./blob";
import type { BlobStore } from "./blob";
import { createUser } from "../db/users";
import { createRecord } from "../db/life-admin-records";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "../db/index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer up;
// this store only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return new Uint8Array(randomBytes(DEK_BYTES));
}

// A stand-in wrapped DEK for createUser (opaque base64; this store never reads it).
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

// Create a life-admin receipt_warranty record for this person and return its id, so a saved
// receipt file references a REAL record id — the test passes whether or not the store adds a
// foreign key to `life_admin_records`.
async function makeRecord(db: Db, userId: string, dek: Uint8Array): Promise<string> {
  const rec = (await createRecord(
    db,
    {
      userId,
      kind: "receipt_warranty",
      fields: { merchant: "Bunnings", item: "Drill", amount: "129.00" },
      dueDate: "2026-12-20",
      status: "under_warranty",
      source: { kind: "person" },
    },
    dek,
  )) as { id: string };
  return rec.id;
}

// A few plaintext "file" bytes with a distinctive, long marker so a raw occurrence in the stored
// blob would be a genuine plaintext leak (GCM ciphertext is pseudo-random — a 50+ byte marker
// cannot appear by chance).
const MARKER = "LEAKCHECK_receipt_9x7Q merchant=Bunnings amount=$129.00 card_ending=4242";
function markerBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(MARKER, "utf8"));
}
function receiptPlaintext(): Uint8Array {
  return new Uint8Array(Buffer.from(`%PDF-1.7 receipt — ${MARKER} — thank you\n%%EOF`, "utf8"));
}
function freshBytes(n = 96): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

// Does `haystack` contain `needle` as a contiguous byte subsequence? Used to prove a plaintext
// marker is ABSENT from the one stored blob under test (the exact unit — the same bytes could
// legitimately live, encrypted, in another file's blob, which this never inspects).
function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
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

// A BlobStore that records every put/delete (over a real in-memory backend), so a test can prove
// that a REJECTED request never reaches the blob, and inspect exactly what was written.
interface RecordingBlob extends BlobStore {
  readonly puts: { key: string; bytes: Uint8Array }[];
  readonly deletes: string[];
}
function recordingBlob(): RecordingBlob {
  const backing = createInMemoryBlobStore();
  const puts: { key: string; bytes: Uint8Array }[] = [];
  const deletes: string[] = [];
  return {
    puts,
    deletes,
    async put(key, bytes) {
      puts.push({ key, bytes: Uint8Array.from(bytes) });
      await backing.put(key, bytes);
    },
    get(key) {
      return backing.get(key);
    },
    async delete(key) {
      deletes.push(key);
      await backing.delete(key);
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

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text, scoped
// to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// A structural view of the returned metadata / file, so the helpers below do not depend on the
// (absent) module's exported types at the point they run.
interface ReceiptMetaLike {
  readonly id: string;
  readonly userId: string;
  readonly recordId: string;
  readonly blobKey: string;
  readonly contentType: string;
  readonly size: number;
}
interface ReceiptFileLike extends ReceiptMetaLike {
  readonly bytes: Uint8Array;
}

// ===========================================================================
// AC1 — saving a receipt file encrypts the bytes with the owner's DEK BEFORE the
// blob put, so the blob holds only ciphertext and never the plaintext file.
// ===========================================================================

test("saveReceiptFile returns metadata with an id, the owner, record, blob key, content type and plaintext size", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac1-meta");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);
    const bytes = receiptPlaintext();

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: "application/pdf", bytes },
      dek,
    )) as ReceiptMetaLike;

    assert.equal(typeof meta.id, "string", "saveReceiptFile returns an id string");
    assert.ok(meta.id.length > 0, "the returned id is non-empty");
    assert.equal(meta.userId, userId, "the file belongs to the saving person");
    assert.equal(meta.recordId, recordId, "the referenced life-admin record is recorded");
    assert.equal(typeof meta.blobKey, "string", "the blob key is recorded");
    assert.ok(meta.blobKey.length > 0, "the blob key is non-empty");
    assert.equal(meta.contentType, "application/pdf", "the content type is recorded");
    assert.equal(meta.size, bytes.length, "the recorded size is the PLAINTEXT byte length");
  } finally {
    await db.close();
  }
});

test("the blob stores only CIPHERTEXT: the plaintext file bytes never appear in the stored blob", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac1-ciphertext");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);
    const plaintext = receiptPlaintext();

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: "application/pdf", bytes: plaintext },
      dek,
    )) as ReceiptMetaLike;

    // Inspect the one blob this file was written under (the exact unit under test).
    const stored = await blob.get(meta.blobKey);
    assert.ok(stored instanceof Uint8Array, "the ciphertext was put through the blob seam");
    assert.ok(
      !containsSubsequence(stored, markerBytes()),
      "the plaintext marker must never appear in the stored blob — it holds ciphertext only",
    );
    assert.notDeepEqual(
      [...stored],
      [...plaintext],
      "the stored bytes are the encrypted form, not the plaintext file",
    );
  } finally {
    await db.close();
  }
});

test("saveReceiptFile uses a random nonce per file: two saves of identical bytes store different ciphertext", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac1-nonce");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);
    const bytes = receiptPlaintext();

    const one = (await saveReceiptFile(db, blob, { userId, recordId, contentType: "application/pdf", bytes }, dek)) as ReceiptMetaLike;
    const two = (await saveReceiptFile(db, blob, { userId, recordId, contentType: "application/pdf", bytes }, dek)) as ReceiptMetaLike;

    assert.notEqual(one.id, two.id, "two saved files get distinct ids");
    assert.notEqual(one.blobKey, two.blobKey, "two saved files get distinct blob keys");

    const a = await blob.get(one.blobKey);
    const b = await blob.get(two.blobKey);
    assert.ok(a && b, "both blobs were stored");
    // A fixed/reused nonce would make identical plaintext encrypt to identical ciphertext — a
    // catastrophic GCM failure. A fresh nonce per file makes the two ciphertexts differ.
    assert.notDeepEqual([...a!], [...b!], "identical bytes encrypt to different ciphertext (a fresh nonce per file)");

    // ...and both still round-trip to the same plaintext for the owner.
    const backA = (await getReceiptFile(db, blob, { userId, id: one.id }, dek)) as ReceiptFileLike | null;
    const backB = (await getReceiptFile(db, blob, { userId, id: two.id }, dek)) as ReceiptFileLike | null;
    assert.deepEqual([...backA!.bytes], [...bytes], "the first file decrypts back to the exact plaintext");
    assert.deepEqual([...backB!.bytes], [...bytes], "the second file decrypts back to the exact plaintext");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — downloading returns the decrypted bytes to the owner; a tampered or
// truncated blob fails the GCM check and throws rather than returning bad bytes.
// ===========================================================================

test("getReceiptFile round-trips the exact plaintext bytes, content type and size under the owner's DEK", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac2-roundtrip");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);
    const plaintext = freshBytes(512); // arbitrary binary — not just text

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: "image/png", bytes: plaintext },
      dek,
    )) as ReceiptMetaLike;

    const back = (await getReceiptFile(db, blob, { userId, id: meta.id }, dek)) as ReceiptFileLike | null;
    assert.ok(back, "the owner can download their file");
    assert.equal(back!.id, meta.id, "the downloaded file is the one that was saved");
    assert.equal(back!.contentType, "image/png", "the content type round-trips");
    assert.equal(back!.size, plaintext.length, "the plaintext size round-trips");
    assert.deepEqual([...back!.bytes], [...plaintext], "the decrypted bytes equal the stored plaintext, exactly");
  } finally {
    await db.close();
  }
});

test("getReceiptFile returns null for an id that does not exist (for this user)", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac2-missing");
    const dek = freshDek();
    const back = await getReceiptFile(db, blob, { userId, id: randomUUID() }, dek);
    assert.equal(back, null, "an unknown file id resolves to null, not a throw");
  } finally {
    await db.close();
  }
});

test("a TAMPERED blob fails the GCM check: getReceiptFile rejects rather than returning bad bytes", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac2-tamper");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);
    const plaintext = receiptPlaintext();

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: "application/pdf", bytes: plaintext },
      dek,
    )) as ReceiptMetaLike;

    // Flip a byte in the stored ciphertext. GCM is authenticated: any single-byte change makes
    // the tag fail to verify, so decryption must throw — not return the original or garbled bytes.
    const stored = (await blob.get(meta.blobKey))!;
    const tampered = Uint8Array.from(stored);
    tampered[0] = tampered[0] ^ 0xff;
    await blob.put(meta.blobKey, tampered);

    await assert.rejects(
      async () => {
        await getReceiptFile(db, blob, { userId, id: meta.id }, dek);
      },
      "a tampered blob must fail the GCM check and throw, never return bad bytes",
    );
  } finally {
    await db.close();
  }
});

test("a TRUNCATED blob fails the GCM check: getReceiptFile rejects", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac2-truncate");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);
    const plaintext = receiptPlaintext();

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: "application/pdf", bytes: plaintext },
      dek,
    )) as ReceiptMetaLike;

    // Drop the last few bytes — the authentication tag (or ciphertext) is now incomplete, so
    // verification must fail.
    const stored = (await blob.get(meta.blobKey))!;
    const truncated = stored.subarray(0, Math.max(0, stored.length - 3));
    await blob.put(meta.blobKey, Uint8Array.from(truncated));

    await assert.rejects(
      async () => {
        await getReceiptFile(db, blob, { userId, id: meta.id }, dek);
      },
      "a truncated blob must fail the GCM check and throw",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second person can never read, add or remove another's file.
// ===========================================================================

test("getReceiptFile never returns another person's file (member-scoped by session user id)", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");
    const aliceDek = freshDek();
    const bobDek = freshDek();
    const recordId = await makeRecord(db, alice, aliceDek);
    const plaintext = receiptPlaintext();

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId: alice, recordId, contentType: "application/pdf", bytes: plaintext },
      aliceDek,
    )) as ReceiptMetaLike;

    // Bob asks for Alice's file id. The row is scoped by user_id, so Bob gets null — before any
    // blob fetch or decrypt (his DEK is irrelevant; the file simply isn't his).
    const bobView = await getReceiptFile(db, blob, { userId: bob, id: meta.id }, bobDek);
    assert.equal(bobView, null, "Bob cannot read Alice's file — it is invisible to him");

    // Alice still reads her own file unharmed.
    const aliceView = (await getReceiptFile(db, blob, { userId: alice, id: meta.id }, aliceDek)) as ReceiptFileLike | null;
    assert.deepEqual([...aliceView!.bytes], [...plaintext], "Alice still downloads her own file");
  } finally {
    await db.close();
  }
});

test("deleteReceiptFile refuses to remove another person's file and leaves it (and its blob) intact", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const alice = await makeUser(db, "del-alice");
    const bob = await makeUser(db, "del-bob");
    const aliceDek = freshDek();
    const recordId = await makeRecord(db, alice, aliceDek);
    const plaintext = receiptPlaintext();

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId: alice, recordId, contentType: "application/pdf", bytes: plaintext },
      aliceDek,
    )) as ReceiptMetaLike;

    // Bob tries to delete Alice's file under his own user id — member scope must refuse.
    const removed = await deleteReceiptFile(db, blob, { userId: bob, id: meta.id });
    assert.equal(removed, false, "deleting another person's file removes nothing (returns false)");

    // Alice's file is untouched: the row is still readable AND the ciphertext blob is still there.
    const aliceView = (await getReceiptFile(db, blob, { userId: alice, id: meta.id }, aliceDek)) as ReceiptFileLike | null;
    assert.ok(aliceView, "Alice's file still exists after Bob's delete attempt");
    assert.deepEqual([...aliceView!.bytes], [...plaintext], "and its bytes are unchanged");
    assert.notEqual(await blob.get(meta.blobKey), null, "the ciphertext blob was not removed by Bob");
  } finally {
    await db.close();
  }
});

test("deleteReceiptFile removes the owner's own file and its ciphertext blob (no orphan left behind)", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "del-self");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: "application/pdf", bytes: receiptPlaintext() },
      dek,
    )) as ReceiptMetaLike;

    assert.notEqual(await blob.get(meta.blobKey), null, "the blob exists before delete");

    const removed = await deleteReceiptFile(db, blob, { userId, id: meta.id });
    assert.equal(removed, true, "deleting the owner's own file reports success");

    assert.equal(await getReceiptFile(db, blob, { userId, id: meta.id }, dek), null, "the file is gone (the row was removed)");
    assert.equal(await blob.get(meta.blobKey), null, "the ciphertext blob was removed too (no orphan)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input before any query
// or blob write, and every value reaches the query bound as a parameter.
//
// A route handler validates external input HERE (`parseBody`), then calls the store with the
// SESSION's user id (NEVER a body value), the injected blob seam and the injected dek. A rejected
// input maps to a 4xx Response and never reaches a query or the blob. This handler is a test
// fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

const CONTENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
const MAX_BODY_BYTES = 256 * 1024; // the handler's per-route body cap

function createReceiptFileHandler(
  db: Db,
  blob: BlobStore,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the record it belongs to, the content type and the file bytes as base64;
  // the user id comes from the session, never the body. Lengths are capped so an absurd value is
  // rejected, but generous enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    recordId: z.string().min(1).max(128),
    contentType: z.enum(CONTENT_TYPES),
    dataBase64: z.string().min(1).max(1_000_000),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: MAX_BODY_BYTES });
      const bytes = new Uint8Array(Buffer.from(body.dataBase64, "base64"));
      const saved = await saveReceiptFile(
        db,
        blob,
        { userId: sessionUserId, recordId: body.recordId, contentType: body.contentType, bytes },
        dek,
      );
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
  return new Request("https://warthog.com.au/api/receipt-files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function validBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recordId: "11111111-1111-1111-1111-111111111111",
    contentType: "application/pdf",
    dataBase64: Buffer.from("%PDF-1.7 small receipt %%EOF").toString("base64"),
    ...over,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query or the blob", async () => {
  const db = recordingDb();
  const blob = recordingBlob();
  const handler = createReceiptFileHandler(db, blob, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
  assert.equal(blob.puts.length, 0, "malformed input must never write a blob");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query or the blob", async () => {
  const db = recordingDb();
  const blob = recordingBlob();
  const handler = createReceiptFileHandler(db, blob, freshDek(), "session-user");

  // ~400 KiB of base64, well over the handler's 256 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ dataBase64: "a".repeat(400 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
  assert.equal(blob.puts.length, 0, "an oversized body must never write a blob");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const blob = recordingBlob();
  const handler = createReceiptFileHandler(db, blob, freshDek(), "session-user");

  // No dataBase64 — a receipt upload with no file bytes.
  const res = await handler(jsonRequest(JSON.stringify({ recordId: randomUUID(), contentType: "application/pdf" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
  assert.equal(blob.puts.length, 0, "a schema violation must never write a blob");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const blob = recordingBlob();
  const handler = createReceiptFileHandler(db, blob, freshDek(), "session-user");

  // dataBase64 must be a string — a number is a schema violation.
  const res = await handler(jsonRequest(validBody({ dataBase64: 12345 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
  assert.equal(blob.puts.length, 0, "a mis-typed field must never write a blob");
});

test("the handler rejects an out-of-allowlist content type with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const blob = recordingBlob();
  const handler = createReceiptFileHandler(db, blob, freshDek(), "session-user");

  const res = await handler(jsonRequest(validBody({ contentType: "application/x-evil" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-allowlist content type must never reach a query");
  assert.equal(blob.puts.length, 0, "an out-of-allowlist content type must never write a blob");
});

test("the handler accepts a well-formed body and stores the file for the SESSION user, round-tripping", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);
    const handler = createReceiptFileHandler(db, blob, dek, userId);

    const fileBytes = Buffer.from("%PDF-1.7 a valid little receipt %%EOF");
    const res = await handler(
      jsonRequest(validBody({ recordId, dataBase64: fileBytes.toString("base64") })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the stored file id");

    const back = (await getReceiptFile(db, blob, { userId, id }, dek)) as ReceiptFileLike | null;
    assert.ok(back, "a valid body is persisted for the session user");
    assert.equal(back!.contentType, "application/pdf", "with the submitted content type");
    assert.deepEqual([...back!.bytes], [...new Uint8Array(fileBytes)], "and the submitted bytes, decrypted");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body (no cross-user add)", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const recordId = await makeRecord(db, sessionUser, dek);
    const handler = createReceiptFileHandler(db, blob, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ recordId, userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    // The file is readable by the SESSION user, and invisible to the smuggled-in attacker id.
    assert.ok(await getReceiptFile(db, blob, { userId: sessionUser, id }, dek), "the file is stored under the SESSION user");
    assert.equal(
      await getReceiptFile(db, blob, { userId: attacker, id }, dek),
      null,
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("saveReceiptFile binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const blob = createInMemoryBlobStore();
  const probe = "r'); DROP TABLE receipt_files; --";

  // The recording db returns no rows; saveReceiptFile assembles its result from the inputs, so the
  // INSERT it issued must have BOUND the probe (here the record id), which is checked below.
  try {
    await saveReceiptFile(
      db,
      blob,
      { userId: "session-user", recordId: probe, contentType: "application/pdf", bytes: receiptPlaintext() },
      freshDek(),
    );
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("the handler cannot be SQL-injected: a probe record id travels to the query as a bound value", async () => {
  const db = recordingDb();
  const blob = recordingBlob();
  const handler = createReceiptFileHandler(db, blob, freshDek(), "session-user");
  const probe = "oren'); DROP TABLE receipt_files; --";

  // The probe is a valid-SHAPED record id, so it passes validation and reaches the store, where
  // it must be BOUND. The recording db returns no rows, so we assert only the binding (not the
  // handler's status — the end-to-end "stored as data, table survives" case is covered on a real
  // db by the content_type-probe test below).
  await handler(jsonRequest(validBody({ recordId: probe })));

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in a plaintext metadata field is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);
    // content_type is a plaintext metadata column — a probe here must be bound, not interpreted.
    const probe = "application/pdf'); DROP TABLE receipt_files; --";

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: probe, bytes: receiptPlaintext() },
      dek,
    )) as ReceiptMetaLike;

    assert.equal(
      await tableExists(db, "receipt_files"),
      true,
      "the receipt_files table must still exist (the probe was stored as data, not run as SQL)",
    );

    const back = (await getReceiptFile(db, blob, { userId, id: meta.id }, dek)) as ReceiptFileLike | null;
    assert.equal(back!.contentType, probe, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the bytes are encrypted under the INJECTED dek, not a baked-in secret (a different dek
// cannot read them back); the store reads no process.env and holds no key (INV-103), shown
// behaviourally with a decoy secret in the environment.
// ===========================================================================

test("getReceiptFile cannot decrypt the bytes with a different DEK", async () => {
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: "application/pdf", bytes: receiptPlaintext() },
      dek,
    )) as ReceiptMetaLike;

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes — so
    // reading the owner's own file under it rejects (the row is found; the decrypt is what fails).
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await getReceiptFile(db, blob, { userId, id: meta.id }, wrongDek);
      },
      "the bytes are bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the store reads no process.env: a decoy secret in the environment never lands in a row, the blob, or a returned file", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const blob = createInMemoryBlobStore();
  try {
    const userId = await makeUser(db, "ac5-decoy");
    const dek = freshDek();
    const recordId = await makeRecord(db, userId, dek);

    const meta = (await saveReceiptFile(
      db,
      blob,
      { userId, recordId, contentType: "application/pdf", bytes: receiptPlaintext() },
      dek,
    )) as ReceiptMetaLike;

    const back = (await getReceiptFile(db, blob, { userId, id: meta.id }, dek)) as ReceiptFileLike | null;
    assert.ok(back, "the file reads and writes purely from the injected db/blob/dek — no app env needed");
    assert.ok(
      !JSON.stringify({ ...back, bytes: [...back!.bytes] }).includes(DECOY),
      "no ambient env value is folded into the returned file",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same value
    // could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM receipt_files");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
        }
      }
    }

    // ...and not in the stored ciphertext blob either.
    const stored = (await blob.get(meta.blobKey))!;
    assert.ok(
      !containsSubsequence(stored, new Uint8Array(Buffer.from(DECOY, "utf8"))),
      "no ambient env value is written to the blob",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the receipt_files migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "receipt_files"),
      true,
      "the receipt_files table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0034_receipt_files"),
      "db/migrations/0034_receipt_files.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0034's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// Keep the imported type anchors referenced so an unused-import lint cannot strip them; they
// document the exact exported shapes the store must provide (erased at runtime).
export type __ReceiptFileContract = NewReceiptFile | ReceiptFileMeta | ReceiptFile;
