// Per-person DEK envelope encryption (design §4.1). Every personal-content
// column is encrypted with the person's 256-bit data key (DEK) using
// AES-256-GCM with a random 96-bit nonce, written as a `v1:` versioned
// envelope. The associated data (AAD) binds a ciphertext to its exact row — the
// table name, the column name and the row id — so an envelope lifted into a
// different row, column or table fails to decrypt (the GCM tag won't verify).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const AES_GCM = "aes-256-gcm";
const NONCE_BYTES = 12; // 96-bit nonce per design §4.1
const TAG_BYTES = 16;
const VERSION = "v1";
const PREFIX = `${VERSION}:`;

// The AAD binds the ciphertext to its exact location. A JSON array is an
// unambiguous encoding of the three components: JSON escaping means no value
// can collide across the (table, column, rowId) boundaries.
function associatedData(table: string, column: string, rowId: string): Buffer {
  return Buffer.from(JSON.stringify([table, column, rowId]), "utf8");
}

// Produce a storable `v1:`-versioned envelope: v1:base64(nonce || ciphertext || tag).
export async function encrypt(
  dek: Uint8Array,
  table: string,
  column: string,
  rowId: string,
  plaintext: string,
): Promise<string> {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AES_GCM, dek, nonce);
  cipher.setAAD(associatedData(table, column, rowId));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([nonce, ciphertext, tag]).toString("base64");
}

// Recover the exact plaintext under the same DEK + AAD. Throws if the DEK, any
// AAD component, or the ciphertext differs — the GCM tag fails in decipher.final().
export async function decrypt(
  dek: Uint8Array,
  table: string,
  column: string,
  rowId: string,
  envelope: string,
): Promise<string> {
  if (!envelope.startsWith(PREFIX)) {
    throw new Error(`unrecognised envelope version, expected ${VERSION}`);
  }
  const b64 = envelope.slice(PREFIX.length);
  const bytes = Buffer.from(b64, "base64");
  // Node's base64 decoder silently DROPS anything after the padding, so bytes
  // appended to a stored envelope would otherwise decode to the SAME ciphertext and
  // verify — a tampered row must fail deliberately. Re-encoding the decoded bytes
  // yields the ONE canonical base64 for them; any mismatch means the stored string
  // was not the exact envelope that was written (trailing garbage, altered padding).
  if (bytes.toString("base64") !== b64) {
    throw new Error("malformed envelope encoding");
  }
  // Reject any envelope too short to hold a nonce plus a full tag BEFORE reaching
  // node:crypto, so a tampered/truncated row fails with a deliberate error rather
  // than a low-level TypeError from an undersized IV or a non-16 tag.
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("envelope too short to hold a nonce and a full tag");
  }
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const ciphertext = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  // Pin the tag length to a full 16 bytes: Node accepts truncated GCM tags by
  // default, so a shortened tag must never be allowed to verify.
  const decipher = createDecipheriv(AES_GCM, dek, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData(table, column, rowId));
  decipher.setAuthTag(tag);
  // final() throws if the tag does not match: wrong DEK, AAD mismatch or tamper.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
