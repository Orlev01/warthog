# Twilio response and pricing review — 10 November 2026

The founder supplied a follow-up from Twilio's automated sales representative.
The public base rates below were independently checked against Twilio's pages.
The response explicitly leaves pay-as-you-go redaction eligibility, Editions
pricing and account-specific sender approval unanswered. It is not an approved
quote, service activation or permission to purchase numbers.

The current Warthog limit remains **200 outbound segments/month and 10/day** across
AU/US/CA/GB. The email's earlier 200–1,000 exploration does not increase that cap.
The existing A$20 monthly target is unchanged; it is not a provider spending cap.

## Published base prices

| Proposed route | Outbound USD/segment | Rental USD/month | Source |
| --- | ---: | ---: | --- |
| Australian mobile | 0.0515 | 8.25 | [Australia pricing](https://www.twilio.com/en-us/sms/pricing/au) |
| UK mobile | 0.0560 | 2.50 | [UK pricing](https://www.twilio.com/en-us/sms/pricing/gb) |
| One verified US toll-free sender serving US/Canada | 0.0083 | 2.15 | [US pricing](https://www.twilio.com/en-us/sms/pricing/us), [Canada pricing](https://www.twilio.com/en-us/sms/pricing/ca) |

Rentals total US$12.90/month. At 200 outbound segments, retaining all three numbers
gives the following **base-cost illustrations**, calculated from those rates:

| Destination mix | USD/month | Approx. AUD/month |
| --- | ---: | ---: |
| Rentals only | 12.90 | 18.71 |
| All 200 segments to US/Canada | 14.56 | 21.12 |
| 50 segments each to AU, GB, US and CA | 19.105 | 27.71 |
| All 200 segments to GB | 24.10 | 34.96 |

Conversion uses the 9 November 2026 reference rate returned on 10 November:
US$1 = A$1.4505. [Reproducible rate query](https://api.frankfurter.dev/v1/2026-11-09?base=USD&symbols=AUD),
[API documentation](https://frankfurter.dev/v1/). Actual billing FX can differ.
The equal-mix USD value retains the half-cent for transparent arithmetic.

Carrier surcharges, inbound/STOP replies, failed-message processing, registration,
tax, FX/payment fees and any redaction subscription are excluded. Consequently,
the full three-number plan at 200 segments already exceeds A$20 before those
extras. This is a calculation, not a new spending authorization. Twilio is a
separate provider bill from the Azure credit-funded infrastructure; the Azure
estimate and A$440 budget were not changed.

## Redaction and integration findings

Twilio documents Message Redaction as an Editions feature but does not establish
this subaccount's pay-as-you-go entitlement. The per-message
`ContentRetention=discard` parameter is a request, not proof that an account has
the feature. The [Editions page](https://www.twilio.com/en-us/editions) provides
sales contact rather than a public minimum price.

Body and phone-number redaction are independent. The STOP conflict concerns
retaining phone numbers for suppression; Warthog must preserve provider STOP
filtering and seek body-only redaction. Redaction removes access through the
Console/API/support tools, while production access can persist for up to 24 hours
and separate limited-access compliance storage remains. This is not immediate
erasure from every system. [Twilio redaction documentation](https://www.twilio.com/docs/messaging/guides/privacy-message-redaction).

The existing adapter already requests `ContentRetention=discard`, retains number
handling and never retries without redaction. Approval messages contain secure
links; Warthog does not process SMS replies as approval decisions or mirror STOP
events through a webhook. No application change follows merely from this email.

The existing restricted key matches the documented Messaging and Lookup support.
[Restricted API keys](https://www.twilio.com/docs/iam/api-keys/restricted-api-keys).
UK mobile-number business addresses may be outside the UK; actual stock, bundle
approval and account eligibility remain separate.
[UK requirements](https://www.twilio.com/en-us/guidelines/gb/regulatory).
US/Canada toll-free sending requires completed verification; purchasing a number
alone does not clear that gate.
[Toll-free verification](https://help.twilio.com/hc/en-us/articles/20212966914075-Toll-Free-Verification-and-Developers-Navigating-the-New-Restrictions).

Twilio Verify is a separate product, with a published US$0.05 successful-verification
fee plus channel charges. It is not adopted by this review and does not supply the
existing approval-alert sender plan.
[Verify pricing](https://www.twilio.com/en-us/verify/pricing).

## Next concrete decision

Obtain a human Messaging/privacy specialist's written confirmation of body-only
redaction entitlement and its minimum recurring/setup/commitment costs, plus a
complete quote and sender eligibility for the exact Warthog subaccount. Include
carrier, inbound, registration and tax treatment at the actual 200-segment cap.
Only then review a complete budget or an explicitly changed sender/market plan.
Do not silently drop approved markets, raise limits, disable redaction/STOP,
switch to Verify, upgrade or purchase a sender.

An information-only follow-up draft and the original correspondence are retained
privately under `.delivery/activation-2026-11-10/`. No follow-up message, feature
request, account change, number purchase or live test was submitted in this review.
