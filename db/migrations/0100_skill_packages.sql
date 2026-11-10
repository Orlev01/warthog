CREATE TABLE skill_packages (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_ct text NOT NULL,
  summary_ct text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (id, user_id)
);
CREATE INDEX skill_packages_owner_idx ON skill_packages(user_id);
ALTER TABLE skills ADD CONSTRAINT skills_id_owner_unique UNIQUE (id, user_id);
CREATE TABLE skill_package_members (
  package_id uuid NOT NULL,
  skill_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  FOREIGN KEY (package_id, user_id) REFERENCES skill_packages(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id, user_id) REFERENCES skills(id, user_id) ON DELETE CASCADE
);
CREATE INDEX skill_package_members_owner_idx ON skill_package_members(user_id, package_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_packages, skill_package_members TO warthog_app;
