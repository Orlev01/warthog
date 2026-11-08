-- 0061_activity_feed_index — serve the newest-first activity feed from an index.
--
-- The Activity page, the Home feed and the agent's get_context read a person's entries
-- newest first (ORDER BY occurred_at DESC, seq DESC), now in bounded pages
-- (src/server/activity/list.ts). The primary key (user_id, seq) cannot serve that order,
-- so every read sorted the person's whole record first. This index walks one person's
-- entries in exactly the feed's order, so a page reads only the rows it returns.
-- Additive (a new index only); safe on existing data.

CREATE INDEX activity_entries_feed_idx ON activity_entries (user_id, occurred_at DESC, seq DESC);
