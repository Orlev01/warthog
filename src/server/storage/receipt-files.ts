// The encrypted receipt-file store (task E14-S03; design §4.1 "receipt files
// (encrypted before upload)"; design §2 "files are encrypted by the app before
// upload"). Receipt files are PERSONAL CONTENT: this module encrypts a file's
// bytes with the person's 256-bit DEK (AES-256-GCM, a fresh 96-bit nonce per
// file) BEFORE it hands the ciphertext to the blob seam (`./blob`), so the blob
// holds only ciphertext — the plaintext file lands in no store Warthog operates.
//
// A row keeps the PLAINTEXT metadata needed to fetch and decrypt the bytes back
// (which record it belongs to, the blob key, the per-file nonce, the content
// type, the plaintext size), scoped to its owner. Only the owner's DEK can read
// the bytes back, and a tampered or truncated blob fails the GCM check and throws
// rather than returning bad bytes.
//
// The receipt bytes are BINARY and the nonce is stored in its own column
// (ciphertext + tag in the blob), so this module runs AES-256-GCM over buffers
// directly rather than through `../crypto/envelope`, which bundles a text
// plaintext with its nonce into one base64 string.
//
// Every statement is parameterized through the `Db` seam (INV-102): the id and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every
// read/write is member-scoped by the `userId` the caller passes — the session's /
// connection's id, never a client value — so one person can never read, add or
// remove another's files. The DEK is injected and this module reads no
// `process.env` and holds no key (INV-103).

import { dismissRecordRow } from "../db/life-admin-records";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type { BlobStore } from "./blob";
import { withTransaction, type Db, type Row } from "../db/index";

const AES_GCM = "aes-256-gcm";
const NONCE_BYTES = 12; // 96-bit nonce per design §4.1
const TAG_BYTES = 16;

// What saveReceiptFile records. `userId` is the OWNER (the session's / connection's
// id, never a client value); `bytes` is the plaintext file, encrypted before the
// blob put.
export interface NewReceiptFile {
  readonly userId: string;
  readonly recordId: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

// A stored receipt file's metadata (no bytes). `blobKey` is the opaque key the
// ciphertext lives under in the blob seam; `size` is the PLAINTEXT byte length.
export interface ReceiptFileMeta {
  readonly id: string;
  readonly userId: string;
  readonly recordId: string;
  readonly blobKey: string;
  readonly contentType: string;
  readonly size: number;
}

// A downloaded, decrypted receipt file: its metadata plus the decrypted plaintext.
export interface ReceiptFile extends ReceiptFileMeta {
  readonly bytes: Uint8Array;
}

// Which file to read / remove — member-scoped by the owner's id.
interface ReceiptFileRef {
  readonly userId: string;
  readonly id: string;
}

// Encrypt the plaintext under the DEK with a fresh nonce. The nonce is returned
// to be stored in its own column; the blob holds ciphertext || tag.
function encryptBytes(dek: Uint8Array, plaintext: Uint8Array): { nonce: Buffer; blob: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AES_GCM, dek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, blob: Buffer.concat([ciphertext, tag]) };
}

// Recover the exact plaintext under the same DEK + stored nonce. Throws if the
// DEK is wrong or the blob was tampered with or truncated — the GCM tag fails in
// decipher.final(), so bad bytes are never returned.
function decryptBytes(dek: Uint8Array, nonceB64: string, blob: Uint8Array): Buffer {
  if (blob.length < TAG_BYTES) {
    throw new Error("receipt blob too short to hold an authentication tag");
  }
  const nonce = Buffer.from(nonceB64, "base64");
  const ciphertext = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  // Pin the tag length to a full 16 bytes: Node accepts truncated GCM tags by
  // default, so a shortened tag must never be allowed to verify.
  const decipher = createDecipheriv(AES_GCM, dek, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Save a receipt file for `input.userId`: generate the id + blob key up front,
// encrypt the bytes with the owner's DEK, PUT the ciphertext through the blob
// seam, then insert the plaintext-metadata row. The returned metadata is
// assembled from the inputs (no dependency on a RETURNING read).
export async function saveReceiptFile(
  db: Db,
  blob: BlobStore,
  input: NewReceiptFile,
  dek: Uint8Array,
): Promise<ReceiptFileMeta> {
  const id = randomUUID();
  const blobKey = randomUUID();
  const metadata: ReceiptFileMeta = {
    id, userId: input.userId, recordId: input.recordId, blobKey,
    contentType: input.contentType, size: input.bytes.length,
  };
  let storageAttempted = false;
  try {
    return await withTransaction(db, async (tx) => {
      // Serialize attachment with deletion; retain this lock until COMMIT.
      const owner = await tx.query(
        "SELECT id FROM life_admin_records WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.recordId, input.userId],
      );
      if (owner.rows.length === 0) throw new Error("Receipt record not found");
      const { nonce, blob: ciphertext } = encryptBytes(dek, input.bytes);
      // A failed PUT response may still have stored the ciphertext.
      storageAttempted = true;
      await blob.put(blobKey, ciphertext);
      await tx.query(
        `INSERT INTO receipt_files (id, user_id, record_id, blob_key, nonce, content_type, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, input.userId, input.recordId, blobKey, nonce.toString("base64"), input.contentType, input.bytes.length],
      );
      return metadata;
    });
  } catch (error) {
    if (storageAttempted) {
      try {
        const committed = await withTransaction(db, async (tx) => {
          // Wait for an ambiguous original transaction to finish before deciding
          // whether its row exists. Never delete a successfully committed file.
          await tx.query("SELECT id FROM life_admin_records WHERE id = $1 AND user_id = $2 FOR UPDATE", [input.recordId, input.userId]);
          const saved = await tx.query("SELECT id FROM receipt_files WHERE id = $1 AND user_id = $2 AND blob_key = $3", [id, input.userId, blobKey]);
          if (saved.rows.length > 0) return true;
          await blob.delete(blobKey);
          return false;
        });
        if (committed) return metadata;
      } catch {
        // Retain opaque references in private operator logs when neither outcome
        // can be confirmed. Do not expose content, keys or raw provider errors.
        console.error("[warthog receipt]", JSON.stringify({
          event: "receipt_upload_reconcile_required", fileId: id,
          recordId: input.recordId, blobKey,
        }));
      }
    }
    throw error;
  }
}

// Which of the owner's life-admin records carry a saved receipt file — the
// `receipt_files` PLAINTEXT METADATA only (the `record_id`s), NEVER the encrypted
// file bytes (no blob fetch, no decrypt). Member-scoped: `user_id` is bound, so
// another person's receipt file never appears here. The returned Set lets a caller
// flag a record as having an attached file without ever touching its bytes.
export async function listRecordIdsWithFileForUser(
  db: Db,
  userId: string,
): Promise<Set<string>> {
  const result = await db.query(
    `SELECT DISTINCT record_id FROM receipt_files WHERE user_id = $1`,
    [userId],
  );
  return new Set(result.rows.map((row) => row.record_id as string));
}

// Download and decrypt the owner's own receipt file (member-scoped: both id AND
// user_id are bound). Returns null when no such file belongs to this user — so
// another person's file, or an absent id, is invisible, before any blob fetch or
// decrypt. A tampered or truncated blob (or a wrong DEK) fails the GCM check and
// THROWS rather than returning bad bytes.
export async function getReceiptFile(
  db: Db,
  blob: BlobStore,
  ref: ReceiptFileRef,
  dek: Uint8Array,
): Promise<ReceiptFile | null> {
  const result = await db.query(
    `SELECT id, user_id, record_id, blob_key, nonce, content_type, size
     FROM receipt_files
     WHERE id = $1 AND user_id = $2`,
    [ref.id, ref.userId],
  );
  const row = result.rows[0] as Row | undefined;
  if (!row) return null;

  const blobKey = row.blob_key as string;
  const ciphertext = await blob.get(blobKey);
  if (ciphertext === null) {
    throw new Error("receipt file ciphertext is missing from the blob store");
  }

  const bytes = decryptBytes(dek, row.nonce as string, ciphertext);
  return {
    id: row.id as string,
    userId: row.user_id as string,
    recordId: row.record_id as string,
    blobKey,
    contentType: row.content_type as string,
    size: Number(row.size),
    bytes: new Uint8Array(bytes),
  };
}

// Remove the owner's own receipt file AND its ciphertext blob (member-scoped: both
// id AND user_id are bound). Returns true when it removed one, false when none
// matched — so one person can never remove another's file, and a deleted file
// leaves no orphaned ciphertext behind.
export async function deleteReceiptFile(
  db: Db,
  blob: BlobStore,
  ref: ReceiptFileRef,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const result = await tx.query(
      `SELECT blob_key FROM receipt_files WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [ref.id, ref.userId],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return false;

    await blob.delete(row.blob_key as string);
    await tx.query("DELETE FROM receipt_files WHERE id = $1 AND user_id = $2", [ref.id, ref.userId]);
    return true;
  });
}

// Delete blobs before their references so a storage failure keeps the keys
// available for an idempotent retry. A retry can encounter an already-deleted
// blob; BlobStore.delete treats that as success. The record lock excludes uploads.
export async function deleteRecordWithFiles(
  db: Db, blob: BlobStore, ref: { readonly userId: string; readonly recordId: string },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const owner = await tx.query("SELECT id FROM life_admin_records WHERE id = $1 AND user_id = $2 FOR UPDATE", [ref.recordId, ref.userId]);
    if (owner.rows.length === 0) return false;
    const files = await tx.query("SELECT blob_key FROM receipt_files WHERE record_id = $1 AND user_id = $2", [ref.recordId, ref.userId]);
    for (const file of files.rows) await blob.delete(file.blob_key as string);
    await tx.query("DELETE FROM life_admin_records WHERE id = $1 AND user_id = $2", [ref.recordId, ref.userId]);
    return true;
  });
}

// "Not mine": remove the record's files (blobs first, as deleteRecordWithFiles does) and
// leave the record as a tombstone that keeps only its type and match key, so an agent's
// later scan doesn't add the same thing again (docs/adr/life-admin-profile.md).
export async function dismissRecordWithFiles(
  db: Db, blob: BlobStore, ref: { readonly userId: string; readonly recordId: string }, dek: Uint8Array,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const owner = await tx.query("SELECT id FROM life_admin_records WHERE id = $1 AND user_id = $2 AND review_state <> 'dismissed' FOR UPDATE", [ref.recordId, ref.userId]);
    if (owner.rows.length === 0) return false;
    const files = await tx.query("SELECT blob_key FROM receipt_files WHERE record_id = $1 AND user_id = $2", [ref.recordId, ref.userId]);
    for (const file of files.rows) await blob.delete(file.blob_key as string);
    await tx.query("DELETE FROM receipt_files WHERE record_id = $1 AND user_id = $2", [ref.recordId, ref.userId]);
    return dismissRecordRow(tx, ref.userId, ref.recordId, dek);
  });
}
