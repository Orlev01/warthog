-- 0041_household_shared_address — the household's ONE shared postal address plus
-- each member's follow choice (brief "Household sharing"; design §4.1).
--
-- A household can share one postal address every member may edit (the owner has no
-- special standing here — any member edits it, and each edit notifies the OTHER
-- members). A member then chooses either to FOLLOW the shared address (their vault
-- postal address follows the shared one, including any upcoming address and moving
-- date) or to keep their own.
--
-- The address is PERSONAL CONTENT, so `current` and `upcoming` are stored only
-- DEK-ENCRYPTED (design §4.1 lists "household shared address" among the DEK-encrypted
-- columns): each column holds a `v1:` envelope (AES-256-GCM under the household's data
-- key) whose associated data binds the ciphertext to its exact (table, column, row) —
-- the plaintext never lands in a column. `moving_on` is the optional moving-on date a
-- move carries — a bare calendar date (plaintext metadata for the date-swap, like a
-- vault postal address's moving-on date), NULL when no move is planned.
--
-- ONE shared address per household: `household_id` is the PRIMARY KEY (so a later edit
-- upserts in place and never duplicates) and REFERENCES households(id), cascading when
-- the household is closed.
CREATE TABLE household_shared_address (
  household_id uuid PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  current      text NOT NULL,
  upcoming     text,
  moving_on    date
);

-- Each member's follow choice: one row per (household, person). `follow` is true when
-- the member opts in to the household address (their effective postal address then
-- follows the shared one) and false to keep their own. One row per member
-- (`PRIMARY KEY (household_id, user_id)`, so a set upserts in place); both ids cascade
-- (household close / account deletion). A member who has never chosen has NO row and
-- the default (keep own, false) is assembled in code, never read from a column default.
-- Every read/write is member-scoped by `user_id` — the session's id, never a client
-- value — so one person can never read or change another's choice.
CREATE TABLE household_follow_choice (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  follow       boolean NOT NULL,
  PRIMARY KEY (household_id, user_id)
);

-- getFollowChoice / getEffectivePostalAddress read a member's own choice
-- (WHERE user_id = $2), so index that member-scope filter.
CREATE INDEX household_follow_choice_user_idx ON household_follow_choice (user_id);
