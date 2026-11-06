-- 0034_receipt_files — the encrypted receipt-file store (task E14-S03; design
-- §4.1 "receipt files (encrypted before upload)"; design §2 "Storage account
-- (blob), private container, no public access … files are encrypted by the app
-- before upload").
--
-- Receipt files are PERSONAL CONTENT. The app encrypts a file's bytes with the
-- person's 256-bit DEK (AES-256-GCM, a random 96-bit nonce per file) BEFORE it
-- hands the ciphertext to the blob seam, so the blob holds only ciphertext — the
-- plaintext file lands in no store Warthog operates. This row keeps only the
-- PLAINTEXT metadata needed to fetch and decrypt the bytes back:
--   * `record_id` is the life-admin record this receipt belongs to.
--   * `blob_key` is the opaque key the ciphertext lives under in the blob seam.
--   * `nonce` is the per-file 96-bit GCM nonce (base64); the ciphertext + its
--     authentication tag live in the blob, so only the owner's DEK can read the
--     bytes back and a tampered or truncated blob fails the GCM check.
--   * `content_type` is the file's MIME type; `size` is the PLAINTEXT byte length.
--
-- `user_id` binds the row to its owner and cascades on account deletion; every
-- read/write is member-scoped by this id — the session's / connection's id, never
-- an id from the client — so one person can never read, add or remove another's
-- receipt files. `record_id` cascades when its life-admin record is removed, so a
-- deleted record leaves no orphaned receipt rows.

CREATE TABLE receipt_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_id    uuid NOT NULL REFERENCES life_admin_records(id) ON DELETE CASCADE,
  blob_key     text NOT NULL,
  nonce        text NOT NULL,
  content_type text NOT NULL,
  size         integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Reads are member-scoped (WHERE user_id = $1 [AND id = $2]), so index the
-- member-scope filter.
CREATE INDEX receipt_files_user_idx ON receipt_files (user_id);
