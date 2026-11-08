-- 0062_approval_fallback_sends — which fallback channels have actually gone out, per
-- approval (design §10 Notifications; brief "SMS fallback").
--
-- The approval fallback job sends one SMS and one email for an approval left unopened.
-- It used to treat "a single-use link has been issued" as "the fallback has fired", but
-- it issues the link BEFORE sending: one transient SMS failure made every retry return
-- early, so neither message ever went, and an email failure after a successful SMS was
-- never retried. Recording each channel only once its send succeeds lets a retry send
-- exactly the channels that have not gone yet (src/server/notify/fallback-job.ts).
--
-- Additive and safe on existing data: a new table, backfilled so an approval whose
-- fallback already fired under the old rule (it has a link) counts as sent on both
-- channels, exactly as the old rule treated it — nothing is re-sent.

CREATE TABLE approval_fallback_sends (
  approval_id uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('sms', 'email')),
  sent_at     timestamptz NOT NULL,
  PRIMARY KEY (approval_id, channel)
);

INSERT INTO approval_fallback_sends (approval_id, channel, sent_at)
SELECT l.approval_id, c.channel, min(l.created_at)
  FROM approval_links l
 CROSS JOIN (VALUES ('sms'), ('email')) AS c(channel)
 GROUP BY l.approval_id, c.channel;
