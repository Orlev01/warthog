-- 0051_release_once — a release is handed over, and counted, exactly once (design
-- §4.2 "Release", §8 step 4; brief "Card requests": "the release, approved amount and
-- merchant are recorded and counted against budgets").
--
-- `approvals.released_at` is stamped (from the injected clock, never SQL now()) the one
-- time a card / high-tier approval's value is released; the release endpoint sets it
-- with a compare-and-swap (`WHERE status = 'approved' AND released_at IS NULL`), so a
-- retried, raced or replayed release of the same approval is refused.
--
-- `card_spend_ledger.approval_id` links each recorded card release to the approval it
-- came from (plaintext metadata, like the rest of the ledger row), and the partial
-- UNIQUE index lets an approval count at most once against a budget. Rows written
-- before this migration (no approval) are unaffected.
--
-- Additive and safe on existing rows: nullable columns with no default, and a unique
-- index over only the non-NULL values.

ALTER TABLE approvals ADD COLUMN released_at timestamptz;

ALTER TABLE card_spend_ledger ADD COLUMN approval_id uuid;
CREATE UNIQUE INDEX card_spend_ledger_approval_once_idx
  ON card_spend_ledger (approval_id) WHERE approval_id IS NOT NULL;
