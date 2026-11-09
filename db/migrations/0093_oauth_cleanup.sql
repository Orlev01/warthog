ALTER TABLE oauth_clients ADD COLUMN first_used_at timestamptz;
-- Historical code rows are consumed on use, so absence cannot establish that a
-- pre-migration client was unused. Preserve existing registrations conservatively.
UPDATE oauth_clients SET first_used_at = created_at;
CREATE INDEX oauth_unused_dcr ON oauth_clients(created_at)
  WHERE registration = 'dcr' AND first_used_at IS NULL;
CREATE INDEX oauth_codes_expiry ON oauth_auth_codes(expires_at);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);
CREATE INDEX oauth_tokens_connection_expiry ON oauth_tokens(connection_id, kind, expires_at);

CREATE FUNCTION mark_oauth_client_used() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE oauth_clients SET first_used_at = NEW.created_at
    WHERE client_id = NEW.client_id AND first_used_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER oauth_client_used AFTER INSERT ON oauth_auth_codes
  FOR EACH ROW EXECUTE FUNCTION mark_oauth_client_used();
