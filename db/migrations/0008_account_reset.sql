-- 0008_account_reset — the account-reset state machine (design §5).
--
-- When every passkey AND the recovery code are lost, the account can still be
-- reset by email after a 7-day wait, during which every registered channel is
-- alerted and the reset can be cancelled from any signed-in device. This table
-- holds the ONE pending reset per person, so it hangs off `users(id)` as its
-- PRIMARY KEY (like recovery_codes): requesting records a 'pending' row,
-- cancelling moves it to 'cancelled', and the 7-day timer completes it to 'done'.
--
-- The table carries ONLY the state machine. The 7-day timer itself is a background
-- job on the `jobs` queue (its `run_at` is the completion deadline — one source of
-- truth). The cross-aggregate erase/revoke a completion performs acts on
-- aggregates built by much later tasks (the vault-unlock, agent and connection
-- stores), so it is driven from application code through an injected executor,
-- never written here.
--
-- `status` moves pending → cancelled | done and is the only thing a completion
-- checks, so a cancelled reset (or a stray, duplicate timer fire) completes
-- nothing. `requested_at` records when the wait began, from the injected clock
-- rather than SQL now(), so the moment is deterministic and testable.

CREATE TABLE account_resets (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL
);
