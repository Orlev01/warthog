# Preserve agent budget meaning after currency changes

Accepted for local implementation in the comprehensive audit, 9 November 2026.

An agent budget can change currency while its earlier card releases retain the
currency in which they were approved. The existing raw sum treats USD 60 as AUD 60
after changing the budget to AUD. The same incorrect figure feeds policy, release
checks, Home and Spending. Home additionally labels every amount as Australian.

Use one server-side agent-spending read for all four paths. Group approved releases
by their stored currency and convert each subtotal to the current budget currency
with the latest available daily reference rate, as the household spending read
already does. Never rewrite historical releases or count agent-reported amounts.
Preserve member/connection scope and period filtering. A missing or unusable rate
makes the total incomplete: policy and the locked release transaction refuse new
card releases, and UI explicitly says the total is unavailable rather than showing
a partial total as the full budget usage. Keep individual release currencies visible.

The Home view receives the budget currency and displays its ISO code. Existing
single-currency behavior remains unchanged except that currency labels are explicit.
This does not solve the separate historical time-zone bucket semantics; that issue
remains under review rather than being hidden inside a currency fix.

Regression plan: persist an earlier USD release with an AUD budget; verify correct
converted totals in policy/Spending/Home and refusal at release when that total is
over budget. Remove the reference rate and verify refusal plus an incomplete-total
message. Verify same-currency behavior and owner isolation with existing tests.
