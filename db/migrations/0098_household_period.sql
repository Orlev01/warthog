-- Personal budget buckets are not a shared household clock. Preserve them and
-- add an independent UTC month. Legacy rows without an owned approval timestamp
-- stay unresolved; the application refuses capped spending when they may overlap.
ALTER TABLE card_spend_ledger ADD COLUMN household_period_month text;

UPDATE card_spend_ledger AS ledger
   SET household_period_month = to_char(approval.released_at AT TIME ZONE 'UTC', 'YYYY-MM')
  FROM approvals AS approval
 WHERE approval.id = ledger.approval_id
   AND approval.user_id = ledger.user_id
   AND approval.released_at IS NOT NULL;

CREATE INDEX card_spend_ledger_household_month_idx
  ON card_spend_ledger (household_id, household_period_month);
