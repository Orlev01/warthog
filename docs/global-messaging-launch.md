# Global messaging: implementation and launch gates

9 November 2026. The founder approved local Twilio SMS + Resend email integration
and overseas processing. Warthog is a global product. Primary hosting stays in
Azure Australia East; the decision does not authorize accounts, credentials,
purchases, production configuration, deployment, DNS or ongoing expenditure.

Subsequent founder choices supersede the earlier proposals: Resend Free; app origin
and RP ID `app.warthog.com.au`; sending domain `mail.warthog.com.au`, From
`notifications@mail.warthog.com.au`, reply-to/public contact `oren@nava-co.com`.
AU/US/CA/GB are approved as initial SMS markets subject to sender/registration/live
acceptance, with 200 segments/month and 10/day across all markets. SMS allowance is
A$20/month; no complete quote fits that allowance yet. Provider keys, exact DNS,
purchases and paid upgrades remain separate gates. The founder confirmed sending
the technical redaction questions in the sales email follow-up; await the answer.

## What the application now does

- Accounts do not require an Australian address or phone. SMS is optional. Email,
  in-app approvals, passkeys and supported push devices do not depend on SMS country
  availability. Google connectors still have their separate named-user early-access
  restriction; global product intent does not remove that restriction.
- International phone input requires `+` and a country code; spaces, parentheses and
  hyphens are normalized. No national-format country inference. Twilio Basic Lookup
  v2 checks validity and returns an ISO destination country, including destinations
  sharing calling codes. This sends the number to Twilio but requests no paid data
  packages. Validity does not establish ownership, mobile capability or reachability;
  code verification establishes possession. [Lookup API](https://www.twilio.com/docs/lookup/v2-api)
- `SMS_COUNTRY_ROUTES_JSON` maps approved ISO country codes to dedicated Twilio
  Messaging Services. Missing countries cannot send. No wildcard or default route.
  The current integration explicitly supports US1 endpoints; this is not a claim
  that every carrier/subprocessor operates in the US or that all countries work.
- First-release routes must support two-way SMS and provider STOP suppression.
  Every text includes STOP instructions, counted in its segment reservation.
  Do not put alphanumeric, RCS, WhatsApp or other one-way senders into those pools.
  One-way routes need a separately reviewed consent/opt-out implementation and
  message copy. In-app SMS consent is off by default and can be withdrawn, with a
  timestamp recorded; a requested verification code is a separate explicit action.
  [Messaging policy](https://www.twilio.com/en-us/legal/messaging-policy)
- UTF-16 pairs and GSM extension characters count toward segments. The reservation
  conservatively uses the smaller US/Canada toll-free multipart capacities, including
  the appended STOP text and links. It may overcount other routes; it must not be
  described as an exact provider invoice. Smart Encoding is disabled in requests.
  [Encoding limits](https://www.twilio.com/docs/glossary/what-sms-character-limit)
- Database counters enforce global UTC month/day segments, recipient/hour segments,
  recipient/day messages, and a per-message ceiling. Reservations remain after
  ambiguous errors. An approval has one persisted SMS attempt, so worker retries or
  crashes cannot knowingly repeat that paid dispatch. A crash before dispatch may
  lose that text; the in-app request and independent email channel remain available.
- Provider rejection/timeout is visible without raw payloads, addresses, codes or
  secrets in error messages. No transport retries or redirected credential requests.
  Acceptance is not delivery. No new inbound/status webhook is exposed by this draft;
  provider dashboards are required for delivery/STOP/bounce acceptance evidence.
- Resend sends transactional plain-text email to international domains. Unicode
  domains are converted to IDNA ASCII at the sender boundary. Non-ASCII mailbox
  local parts (SMTPUTF8), quoted local parts and address literals are not supported
  by this adapter; use a conventional ASCII mailbox address. No country is inferred
  from a mailbox's top-level domain. Existing account normalization remains unchanged.

## Checkpoint 6 reconciliation

Read the [browser findings](../../warthog-checkpoint-6-findings.md) and
[engineering review](../../warthog-checkpoint-6-engineering-review.md). Body-redaction
entitlement/price remains the next commercial gate; the partial quotes exclude it.
Local public `/terms` and SMS opt-in disclosures are implemented, with separate policy links, message frequency/rates and STOP/HELP instructions. The drafts use the supplied company/contact and still need final review, publication and provider acceptance. The code also lacks country quiet-hour scheduling;
confirm permissible timing/use cases before enabling any market. Resend Free is now
selected; Tokyo sending region and the AU/GB mobile plus shared US/CA toll-free
sender pools still need actual account acceptance. The sales-contact form was
submitted once, and the founder subsequently confirmed sending the prepared
technical questions by email. No entitlement or price is established.

## Country-specific limitations found

This is a launch review matrix, **not a coverage list**. AU/US/CA/GB have founder
launch-scope approval, but no real sender route is configured or accepted yet.
All other destinations stay disabled until their own
row has reviewed sender type, provider availability, content/consent restrictions,
quote, account approval and successful live test. Recheck official guidance at
setup: carrier and regulatory rules can change.

| Destination | Findings and required decision before enabling SMS |
| --- | --- |
| Australia | SMS-capable mobile-number acquisition can require KYC. Alphanumeric IDs require registration; unregistered IDs are labelled Unverified under the 2026 regime. This implementation initially requires a reply-capable numeric route. Confirm number stock, two-way delivery and opt-outs. [Sender registration](https://help.twilio.com/articles/46266521342747-Help-with-registering-your-Alphanumeric-Sender-ID-via-Twilio-in-Australia), [SMS guidelines](https://www.twilio.com/en-us/guidelines/au/sms). |
| United States | Domestic 10DLC needs the applicable brand/campaign registration; toll-free has a different verification process. An Australian number or alpha sender is not a universal substitute. Non-US/Canada entities without a qualifying tax ID cannot use the sole-proprietor 10DLC path; investigate verified toll-free without purchasing. [10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc), [international-entity limits](https://help.twilio.com/articles/1260804728069-Limitations-of-A2P-10DLC-pilot-access). |
| Canada | `+1` is not permission to use a US-only route. Toll-free verification and Canadian content/consent rules apply. Confirm the particular sender and network; registration in the US alone is not evidence of Canadian delivery. [Canada](https://www.twilio.com/en-us/guidelines/ca/sms). |
| United Kingdom | Protected brand sender names need allowlisting; generic/special-character alpha IDs can be filtered. Use a confirmed reply-capable numeric sender for the current adapter. [UK](https://www.twilio.com/en-us/guidelines/gb/sms). |
| Singapore | SGNIC/SSIR registration, UEN eligibility and a compatible numeric route remain gates. The checkpoint report cites a post-transition blocking notice; the currently readable SGNIC FAQ also retains Likely-SCAM wording and describes blocking scenarios. Reconcile actual route behavior, and never treat an unregistered sender as a launch option. [SGNIC FAQ](https://www.sgnic.sg/faq/sms-sender-id-registry), [checkpoint 6 evidence](../../warthog-checkpoint-6-findings.md). |
| India | International and domestic paths differ. Twilio says international ILDO delivery does not require DLT and rewrites senders; domestic delivery requires company/sender DLT registration and approved use cases. Shortened links are prohibited. Neither path is assumed compatible with this release's two-way/STOP contract. Keep disabled pending a specific route and content review; a country allowlist entry is insufficient. [India](https://www.twilio.com/en-us/guidelines/in/sms). |
| China | Published restrictions disallow URLs, conflicting with Warthog's approval links; two-way SMS is not supported. `CN` is refused by startup validation and dispatch even if accidentally configured. No launch SMS support with this implementation. Other notification channels remain separate. [China](https://www.twilio.com/en-us/guidelines/cn/sms). |
| EEA and all other countries/territories | Review each destination individually, including sender registration, local entity/number requirements, quiet hours, permitted content, consent, language and opt-out rules. There is no single Europe-wide SMS sender approval. Do not configure all ISO codes or assume country-code validity means coverage. [International SMS guidance](https://www.twilio.com/docs/messaging/guides/sending-international-sms-guide). |

US toll-free supports replies in US/Canada but is one-way elsewhere. A sender pool
containing that number therefore cannot meet the current two-way contract for every
country. [Twilio toll-free coverage](https://help.twilio.com/articles/223181448)

## International email and privacy

Resend US storage applies to message content/logs, independently of sending region.
Standard-plan email/log retention is 30 days; individual email deletion has no API.
Early deletion requires an operator request through the provider. Provider backups
and statutory records are separate. Resend's DPA includes European transfer terms,
but it declines custom Brazil/Türkiye transfer contracts: assess applicable local
requirements before targeting those markets. This is not evidence that mail to those
countries is technically blocked. [Resend processing and retention](https://resend.com/security/gdpr)

No authoritative blanket list of Resend recipient-country coverage was established.
Account eligibility, export/sanctions restrictions, destination network filtering,
bounces and recipient mailbox policies must be checked. Successful API acceptance
is not proof of inbox delivery or permission to serve every jurisdiction. Do not
block users based on a guessed country from their email suffix. Confirm deliverability
to synthetic Gmail, Outlook and relevant local mailbox providers before launch.

The final processor inventory must also cover Resend's actual subprocessors. Its
[security information](https://resend.com/security) describes sampled spam/phishing
analysis by TypeSafe, distinct from optional dashboard AI. Avoiding dashboard AI does
not imply that message content never undergoes automated provider analysis.

The public privacy page now removes the false all-data-stays-in-Australia promise.
It describes Resend/Twilio/carriers, authentication codes and links, connected
Google/Microsoft accounts, push metadata, overseas access and retention limitations.
It retains the device-encrypted vault distinction. Account deletion does not recall
sent messages or instantly erase backups/provider records. The deletion email now
states that distinction too.

Before publishing, review the local draft operator/contact (RPR technologies pty ltd and oren@nava-co.com), confirm actual provider retention/account settings, record accepted DPAs and
subprocessors, assess applicable transfer/rights obligations for launch markets, and
review the final policy. Those facts are not invented or approved by this code change.
A provider's compliance claims alone do not establish Warthog's compliance.

## Data handling and operations

| System | Data crossing the boundary | Controls and remaining acceptance |
| --- | --- | --- |
| Azure Australia East | Application/database/receipt data and secrets | Existing TLS, managed identity, Key Vault, private database/blob and device-encrypted vault design retained. Confirm backups and restore behavior in the actual environment. |
| Twilio US1 Lookup | International phone number and API credentials | Fixed HTTPS host, API-key Basic auth, bounded request, no paid Fields, no response/URL logging. Country lookup is not proof of carrier service or consent. |
| Twilio SMS and carriers | Number, generic message, verification code or short-lived approval link, delivery metadata | Fixed HTTPS endpoint; country route; persistent counters/attempt claim; 120-second queue validity; body-redaction request; retain STOP suppression. Redaction does not erase restricted compliance/carrier storage. Confirm feature entitlement; do not silently retry without redaction or buy an add-on. |
| Resend and delivery chain | Address, generic subject, transactional text/code/link | Sending-only key restricted to the approved domain; no arbitrary connector-request text, attachments or provider metadata. Opaque idempotency key per request; disable dashboard click/open tracking. Key never reaches browser/build output. |
| Google/Microsoft | OAuth authorization, tokens exchanged server-side and data needed for authorized tools | Existing minimal per-connector scopes, PKCE, session-bound state, encrypted token storage, refresh/disconnect tests. Review provider/user tenant location and consent independently. |
| Push services/devices | Subscription endpoint and encrypted generic push payload/delivery metadata | Existing VAPID, endpoint validation, generic notifications, expired-device cleanup. Device/browser service availability varies by country and platform. |

Twilio body redaction has eligibility/configuration requirements and retains some
restricted compliance data. Do **not** disable STOP filtering to obtain phone-number
redaction. [Redaction](https://www.twilio.com/docs/messaging/guides/privacy-message-redaction)

Use a dedicated Warthog Twilio account/subaccount and Resend team/domain. Do not reuse
GameHub/Auxilium/client resources. Require MFA and minimum operator access. Real keys
require separate approval; then store directly in Key Vault with rotation ownership
and dates. Twilio restricted keys should allow only the needed Lookup read/Message
create operations where supported; verify actual endpoint permission support.
Resend supports a domain-restricted sending key. [Resend key permissions](https://resend.com/changelog/new-api-key-permissions)

Do not log provider request headers, bodies, Lookup paths, recipients, codes, links
or raw provider exceptions. Do not send customer content to provider dashboard AI
features. Monitor aggregate failures/limits, account suppression, delivery and billing;
there is no webhook-driven suppression mirror or delivery dashboard in this release.
Provider STOP remains authoritative and is never bypassed by a retry or sender change.

## Configuration and cost boundaries

The updated variable contract is in `production-release.md`. There are no active
routes or spend defaults. A missing credential, region, route or positive limit
prevents production readiness; dev tools continue to use the local outbox.

The previous A$475/534 illustrations assumed Australian SMS volumes and rates.
They are **not global messaging quotes**. Recalculate each approved country's sender
rental, registration/campaign fees, outbound and inbound segments, carrier charges,
failed-message charges, taxes and FX, then add Resend and Azure separately. Basic
Lookup without Fields is currently listed as free; confirm account terms before
credentials are introduced. [Lookup pricing](https://www.twilio.com/en-us/user-authentication-identity/pricing/lookup)

Segment limits do not bound currency spend across countries. SMS number rental,
inbound/STOP replies, provider retention options, Azure resources and other costs
continue independently. No global hard spending cap is implemented. The earlier
US$150/automatic-stop expectation and proposed AUD envelopes still need an explicit
spending decision. No purchase, paid plan or budget was created during integration.

## Acceptance checklist after separate approvals

1. Freeze/review a release commit and immutable Linux image; test real PostgreSQL 16
   migrations 0091–0096, runtime grants, persistent SMS counters and attempt claims.
2. Obtain approved market list, sender plan, exact quote and limits. Verify country
   Geo Permissions in Twilio match the application map. Keep all other countries off.
3. Verify provider account eligibility, two-way senders, registrations, redaction,
   STOP/START/HELP, sender identity and content rules. No alphanumeric or one-way pool
   fallback. Confirm actual SMS-only pool, Smart Encoding off and no link shortening.
4. Test code possession, opt-in/out, disabled/unsupported destinations, shared `+1`
   discrimination, limits, Unicode segmentation, failure sanitization and timeout
   ambiguity with consented synthetic identities. Confirm handset receipt and provider
   segment counts. Confirm no repeat SMS after worker restart/duplicate job.
5. Configure approved sending domain using exact new DNS records only. Preserve all
   existing GoDaddy records and inherited DMARC quarantine. Verify DKIM/SPF alignment,
   actual inbox arrival, bounce/suppression behavior and tracking disabled. Confirm
   actual account rate/monthly limits and leave paid overages off unless approved.
6. Validate account signup/recovery without a phone, every required connector and push
   on real browsers/devices. Confirm privacy copy matches the selected accounts and
   enabled markets before production launch. Report limitations, not universal coverage.

## Local disclosure review, 9 November 2026

The optional SMS choices now link separate public Terms and privacy pages and state the program purpose, frequency, message/data charges and STOP/HELP instructions. Verification remains separate from ongoing alert consent. The draft does not approve countries or establish provider acceptance. Review against [Twilio toll-free onboarding](https://help.twilio.com/hc/en-us/articles/13264118705051-Required-Information-for-Toll-Free-Verification). Actual sender HELP/START responses and suppression still need configuration and live testing.

The privacy draft also explains requested Google/Microsoft data, encrypted connection credentials, agent transfers and account revocation. Its Google commitments need operational review against the [Google API user-data policy](https://developers.google.com/terms/api-services-user-data-policy) and [Workspace policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), including restrictions on downstream transfers and general-purpose AI training. Named-user Testing is not a waiver of data-use policies or a verification claim.
