-- 0077_totp_attempts — limit authenticator-app sign-in attempts and make each code single
-- use (review fix W3.5).
--
-- `failed_attempts` counts the presentations inside the current window, which began at
-- `failed_window_start`; once 5 have failed within 15 minutes, further attempts are refused
-- until the window ends (the brief's "slow further attempts"). `last_step` is the 30-second
-- TOTP step of the last accepted code: a code from that step or an earlier one is refused,
-- so a code cannot be replayed inside its ±1-step window. Additive and safe on existing
-- rows: they start with no failures and no used step.
ALTER TABLE totp_secrets
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN failed_window_start timestamptz,
  ADD COLUMN last_step bigint;
