-- 0116_contact_messages — "Contact us" in the app (docs/adr/requests-for-members.md). A person
-- signed in to the app can send the operator a message: a question, a problem, a privacy
-- request, an idea or something else. It is a third kind of request ('contact') beside a
-- service request and Google early access, so it reaches the admin portal's Requests page with
-- who asked, and the operator replies by email.
--
-- `topic` is one of five fixed values and `message` is the person's text, already cleaned and
-- redacted by the application (invisible characters stripped, sign-in codes and card numbers
-- masked) and capped. Both are set for a message and absent for every other kind. A message is
-- never matched against the catalogue.

ALTER TABLE connector_requests DROP CONSTRAINT connector_requests_kind_check;

ALTER TABLE connector_requests
  ADD CONSTRAINT connector_requests_kind_check CHECK (kind IN ('service', 'google_early_access', 'contact')),
  ADD COLUMN topic text CHECK (topic IN ('question', 'problem', 'privacy', 'idea', 'other')),
  ADD COLUMN message text CHECK (char_length(message) <= 4000);

ALTER TABLE connector_requests
  ADD CONSTRAINT connector_requests_contact_shape
    CHECK ((kind = 'contact') = (topic IS NOT NULL) AND (kind = 'contact') = (message IS NOT NULL));

-- 0094's table-wide grant to warthog_app already covers the new columns.
