-- 0028_approval_links — the single-use approval-link store (design §10 Notifications,
-- brief "SMS fallback").
--
-- When an approval is still unopened at created_at + fallback_delay, the fallback job
-- sends ONE SMS and ONE email carrying a single-use link that opens the approval after
-- sign-in. That link carries a 256-bit token — a CREDENTIAL — so (project rule: tokens
-- and link tokens are stored only as hashes, SHA-256 or HMAC) this table holds ONLY the
-- token's SHA-256 hash (`token_hash`), never the raw value. The raw token is returned
-- once to the issuer, for the single message that delivers it, and appears in clear
-- nowhere else.
--
-- Unlike the member-scoped stores this one is CREDENTIAL-KEYED (like the oauth access
-- keys): a row is addressed by its token hash and bound to ONE approval, not a user_id.
-- The person clicks the link and signs in; the member-scope check (is this approval the
-- session user's?) happens a layer up, when the resolved approval is loaded through the
-- member-scoped approvals store — not here, so there is no user_id column.
--
-- `approval_id` is the one approval the link opens; it cascades when that approval is
-- deleted. Time is clock-driven in application code (not SQL now()), so `created_at` and
-- `expires_at` (created_at + 10 minutes) are the injected clock's instants; `used_at` is
-- stamped on the single redemption, enforcing single use.

CREATE TABLE approval_links (
  token_hash  text PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
