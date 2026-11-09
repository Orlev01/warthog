# Amount-rule currency

Accepted locally, 9 November 2026, for AUD-023.

`amount_over` conditions have no independent currency field. Their thresholds
therefore use the owner's account currency, which is now stated on the Rules
screen. An individual agent's budget can use a different currency and must not
change the meaning of those rules.

The context loader supplies separate rule and budget reference rates. The pure
policy evaluator converts only the rule comparison amount before matching an
applicable amount condition; the original request still reaches card and household
checks. An absent, invalid or mismatched rate refuses the request. Same-currency
rules need no rate. Non-amount conditions retain their existing behavior.

This fixes both under-enforcement (USD80 at AUD1.5 bypassing an AUD100 rule) and
over-enforcement (JPY120 at AUD0.01 incorrectly tripping the same threshold).
Changing the account currency changes account-denominated rule interpretation;
this remains an explicit account preference, not an implicit agent-budget effect.
Persisting a currency on each rule would be a separate product/schema decision.

Three failing regressions reproduced the original behavior. The affected policy,
context, pipeline and Rules loader/page group passes 95 tests. Live currency-feed
and production database acceptance remain part of the release gates.
