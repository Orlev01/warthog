# Use one shared month for household budgets

Accepted for local implementation, 9 November 2026. Household budget enforcement
must not depend on which member reads or spends. Previously every release used
the member's personal time zone and each reader chose their own month. Near month
boundaries members could see and enforce different shared totals.

Use UTC calendar months for the shared monthly budget and member monthly limits,
and state that boundary in the household/spending interface. Keep personal agent
day/week/month buckets unchanged. New household releases explicitly record the
UTC month from the same frozen release instant used for the locked budget check.
The low-level ledger store still accepts explicit bucket keys for synthetic/import
fixtures; callers with personal-zone buckets must pass the separate household key.

Add a separate nullable household-period column. Existing rows are backfilled only
when a matching owned approval has a trustworthy released_at timestamp. Do not
invent a UTC month for legacy rows that only have a local date bucket. Leave their
original columns intact and their new month null. If such a row could overlap the
current UTC month (its old month is current or adjacent), show the household total
as incomplete and refuse further capped household spending pending reconciliation.
This should be empty at first production launch, but migration safety must not
depend on assuming an empty database. Reconciliation requires trustworthy evidence,
not guessed timestamps; no automatic production data rewrite is authorized.

Verify simultaneous Sydney/Los Angeles views around the UTC month boundary, mixed
member zones, unchanged personal buckets, missing legacy anchors and owner scoping.
Use the same existing household locks and fixed release clock.
