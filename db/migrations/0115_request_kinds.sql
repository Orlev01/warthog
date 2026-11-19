-- 0115_request_kinds — the admin portal's Requests page (docs/adr/admin-portal.md, amendment
-- of 20 November 2026). Every request a person makes of the operator in the app is recorded
-- here and read in the portal; nothing is emailed any more. There are two kinds: a service that
-- isn't in the catalogue ('service', named in the person's own words) and Google early access
-- for a gated Google service ('google_early_access', naming the catalogue entry in
-- `connector_id`). Early-access requests used to be told apart only by a "Google early access: "
-- prefix on the name, so existing rows are backfilled from it and keep the bare service name.
--
-- `handled_at` is when the operator marked the request done in the portal (application clock,
-- never SQL now()), and NULL while it waits. The portal also treats a request as done once the
-- service is in the catalogue or the person is on the Google list, which it works out when it
-- reads, so nothing has to be stored for those.

ALTER TABLE connector_requests
  ADD COLUMN kind text NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'google_early_access')),
  ADD COLUMN connector_id text,
  ADD COLUMN handled_at timestamptz;

UPDATE connector_requests
   SET kind = 'google_early_access',
       service_name = substr(service_name, 22),
       connector_id = CASE service_name
         WHEN 'Google early access: Gmail' THEN 'google-gmail'
         WHEN 'Google early access: Google Calendar' THEN 'google-calendar'
         WHEN 'Google early access: Google Drive' THEN 'google-drive'
       END
 WHERE service_name LIKE 'Google early access: %';

-- The Requests page lists the newest first.
CREATE INDEX connector_requests_requested_idx ON connector_requests (requested_at DESC);

-- 0094's table-wide grant to warthog_app already covers the new columns.
