-- One pending import per account; staged contents remain encrypted and invisible
-- until all parts restore in one transaction. Completed IDs prevent duplicate retry.
CREATE TABLE data_imports (
  id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  part_count integer NOT NULL CHECK (part_count BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX one_pending_data_import ON data_imports(user_id) WHERE status = 'pending';
CREATE TABLE data_import_parts (
  user_id uuid NOT NULL,
  import_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  content_ct text NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (user_id, import_id, seq),
  FOREIGN KEY (user_id, import_id) REFERENCES data_imports(user_id, id) ON DELETE CASCADE
);
GRANT SELECT, INSERT, UPDATE, DELETE ON data_imports, data_import_parts TO warthog_app;
