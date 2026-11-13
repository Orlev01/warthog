-- 0112_admin_indexes — the time-range scans the admin portal reads
-- (docs/design/admin-portal.md §4). Additive; no data change.
--
-- The portal reads every metric name over one inclusive instant range (the existing index
-- is (name, recorded_at), which serves one name at a time), counts the people seen in a
-- window from sessions.last_seen_at (no session index existed beyond the token hash), and
-- counts activity per day across every account (the feed index 0061 is per person).
CREATE INDEX metric_events_recorded_idx ON metric_events (recorded_at);
CREATE INDEX sessions_last_seen_idx ON sessions (last_seen_at);
CREATE INDEX activity_entries_occurred_idx ON activity_entries (occurred_at);
