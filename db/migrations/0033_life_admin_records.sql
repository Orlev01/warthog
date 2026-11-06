-- 0033_life_admin_records — the life-admin records store (brief "Life admin";
-- design §4.1 "every personal-content column … life-admin records").
--
-- Life-admin records are the content a person and their agents both maintain,
-- in three kinds: subscriptions (service, cost, billing cycle, next renewal, how
-- to cancel, status), receipts and warranties (merchant, item, date, amount,
-- return-by, warranty end, receipt file), and renewals and appointments (what,
-- due date, where). Each record's FIELDS are PERSONAL CONTENT, so they are stored
-- only DEK-ENCRYPTED: `fields` holds the `v1:` envelope (AES-256-GCM under the
-- person's data key) of the record's content as one JSON blob — the plaintext
-- fields land in no column. The envelope's associated data binds the ciphertext
-- to this exact (table, column, row), so the row id is generated up front.
--
-- The KIND, the due/next DATE, the STATUS, the per-record reminder OFFSETS +
-- SENT-markers and the SOURCE stay PLAINTEXT metadata, so the reminders job and
-- the Life-admin page can filter WITHOUT decrypting another person's data:
--   * `kind` is one of the three record kinds (a CHECK guards it).
--   * `due_date` is the reminder anchor (the due/next date); NULL ⇒ no reminders.
--   * `status` is a free-form status word.
--   * `reminder_offsets` are the days-before-due to remind, defaulting to the
--     brief's 14 and 1 (so a record saved without offsets reminds 14 days and
--     1 day before); `sent_offsets` are the offsets whose reminder has already
--     been sent (the SENT-markers the reminders job sets so a reminder fires once).
--   * `source_kind` records who maintains the record (the person or an agent);
--     `source_agent_id` is the opaque agent id when an agent did, else NULL.
--
-- `user_id` binds the row to its owner and cascades on account deletion; every
-- read/write is member-scoped by this id — the session's / connection's id, never
-- an id from the client — so one person can never read or write another's records.

CREATE TABLE life_admin_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN (
                     'subscription', 'receipt_warranty', 'renewal_appointment')),
  fields           text NOT NULL,
  due_date         date,
  status           text NOT NULL,
  reminder_offsets int[] NOT NULL DEFAULT '{14,1}',
  sent_offsets     int[] NOT NULL DEFAULT '{}',
  source_kind      text NOT NULL CHECK (source_kind IN ('person', 'agent')),
  source_agent_id  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- listRecordsForUser / listRecordsByKind read a person's records (WHERE user_id =
-- $1), so index the member-scope filter.
CREATE INDEX life_admin_records_user_idx ON life_admin_records (user_id);
