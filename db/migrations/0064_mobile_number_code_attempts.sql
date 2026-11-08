-- 0064_mobile_number_code_attempts — bound and consume mobile verification codes (review fix F5).
--
-- A verification code was matchable without limit and stayed valid after it verified the
-- number. `code_attempts` counts the presentations of the current code; verification increments
-- it atomically and refuses once it reaches the limit. A code that completes a verification is
-- consumed: `code_hmac` and `code_expires_at` are cleared, so the columns become nullable (a NULL
-- code_hmac means "no pending code"). Additive and safe on existing rows: they start at 0
-- attempts and keep their stored code.

ALTER TABLE mobile_numbers
  ADD COLUMN code_attempts integer NOT NULL DEFAULT 0,
  ALTER COLUMN code_hmac DROP NOT NULL,
  ALTER COLUMN code_expires_at DROP NOT NULL;
