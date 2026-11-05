-- 0019_connector_requests — the connector-request store (brief "Request a connector",
-- design §7). A *connection* is a person's connected service and a *connector* is a
-- catalogue entry (CLAUDE.md vocabulary); a connector REQUEST is a person asking for a
-- service that is not yet in the catalogue.
--
-- A request is recorded 'requested' for the person who asked; when a catalogue entry
-- whose name or aliases match is LATER added, the match-notify marks it 'matched' and
-- records WHICH catalogue entry satisfied it, then tells the person. An unmatched
-- request stays 'requested'.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- member-scoped read/write is scoped by this id (never an id from the client); the
-- system-wide pending scan the match-notify runs is NOT member-scoped. `service_name`
-- is the free text the person typed, stored VERBATIM (bound by value, never spliced —
-- INV-102 — so a value shaped like SQL is data, not a statement). `status` is
-- constrained to the two values a request can hold. `matched_connector_id` is the
-- catalogue slug that satisfied the request (design §7 — TEXT, not a uuid; the
-- catalogue is a data file, not a table), NULL until matched. Time is clock-driven in
-- application code (never SQL now()), so `requested_at` is set at create time and
-- `matched_at` when the request is marked matched, NULL until then.

CREATE TABLE connector_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_name         text NOT NULL,
  status               text NOT NULL CHECK (status IN ('requested', 'matched')),
  requested_at         timestamptz NOT NULL,
  matched_connector_id text,
  matched_at           timestamptz
);

-- listConnectorRequestsForUser reads every request for a person (WHERE user_id = $1),
-- so index user_id.
CREATE INDEX connector_requests_user_idx ON connector_requests (user_id);
