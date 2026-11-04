-- 0003_users — the person aggregate (one row per signed-in human).
--
-- This is the foundational aggregate every member-scoped table hangs off: the
-- `id` here is the `userId` the session carries and every later member-scoped
-- query is filtered by (never an id from the client).
--
-- Each person has a random 256-bit data key (DEK). Per design §4.1 the DEK is
-- stored only WRAPPED by the Key Vault KEK — `wrapped_dek` holds that wrapped
-- reference (opaque ciphertext to the app), never a readable key. `email` is
-- plaintext metadata (needed to look an account up); `role` is plaintext
-- metadata too, so a later admin app can report operational numbers with no path
-- to vault contents. It defaults to 'member', the role every open sign-up gets.

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  wrapped_dek text NOT NULL,
  role        text NOT NULL DEFAULT 'member'
);
