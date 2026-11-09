# Recheck household budgets when releasing a card

Accepted for local implementation, 9 November 2026. No deployment or spending approval.

The household display already converts per-currency ledger subtotals using the latest stored daily reference rates. The request policy instead sums raw amounts, and release rechecks only the agent's budget. Several approved requests can therefore exceed household or member limits.

Use the existing converted household report for both the display and policy. Household limits count releases recorded against that household, across its members' agents, and preserve the existing ledger period conventions. Missing rates must make a relevant budget check fail closed, including a same-currency new request with unconvertible past spend. Unset limits remain uncapped; zero remains a zero cap. Do not obtain paid exchange-rate data.

At release, lock the current household and requesting membership, then the agent and its permission row. Read current permissions, limits and totals after acquiring locks and check them before marking the approval released or recording spend. Household locking serializes releases across different agents/members; member locking coordinates limit changes and removal. The stored approval supplies the approved account-currency amount, never a request-body amount. That amount remains the ledger basis; household checks convert that same ledger amount so the added amount agrees with the report.

Keep all locks, refusal, approval state and ledger writes within one database transaction; only place plaintext in memory after commit. Household totals use the ledger's captured instant even if transaction work crosses month-end. No schema change is needed. This fixes currency mixing and stale approval limits; the existing personal period buckets/time-zone cutover behavior is retained and must be documented, not silently changed into a new household time-zone policy.

Verification: failing regressions first for mixed-currency policy, missing-rate refusal, lower limits and several outstanding approvals; existing household/view/policy/release tests; full suite and production build. Real PostgreSQL concurrent-release validation belongs in the isolated local harness and remains unverified until that environment can run.
