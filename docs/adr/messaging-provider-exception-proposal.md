> Superseded 9 November 2026: the founder approved the limited Twilio/Resend
> exception and local integration, explicitly for a **global** product. The AU-only
> suggestion and pending-approval language below are historical. Read
> [the accepted global messaging decision](global-messaging.md). Purchases,
> credentials, deployment, DNS and spending still need separate approval.

# Proposed exception: Twilio SMS and Resend transactional email

Status: **PROPOSED — NOT APPROVED**, 9 November 2026. This document does not change the project constitution, runtime configuration or production services. It is the concrete decision requested after browser checkpoint 5.

## Decision requested

Permit local implementation of Twilio Programmable SMS and Resend transactional email as narrowly scoped exceptions to the existing Azure/Australia East and no-billable-third-party requirements. Warthog's application, database, vault keys, encrypted blobs and application logs remain on the approved Azure architecture. Keep email, SMS, push and all six Google/Microsoft connectors in release one.

This exception would acknowledge overseas handling of delivery data: recipient addresses/numbers, authentication codes, notification/invitation links, message bodies and delivery/account metadata. Resend stores that data in the United States. Twilio SMS is not available in its published Australia region list; its actual supported SMS processing region and provider/account arrangements still need review before any production data is sent. A Sydney edge hostname or Australian phone number would not establish Australian data residency.

Approval of **this ADR only** authorizes local adapter/configuration/tests and privacy-text preparation. It does not authorize accounts, acceptance of terms, KYC transmission, purchases, credential creation, production consent, DNS changes, deployment or reuse of another application's resources. Those actions require their own concrete checkpoints under the founder's existing instructions.

## Why an explicit decision is necessary

The existing [constitution, rules 10–11](../../../warthog/.agent/constitution.md) requires “host every component and store every byte of user data on Microsoft Azure in the Australia East region” and “No third-party service that bills or can start billing.” Its sole messaging exception names founder-paid **Azure SMS**, not arbitrary SMS/email vendors. The [technical design](../design/technical-design.md) also excludes paid hosted messaging vendors. Requiring SMS in release one does not implicitly waive those rules.

Checkpoint 5 found no number on the older GameHub ACS resource and disabled acquisition controls. No isolated Warthog SMS path is established. [Microsoft's lifecycle notice](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide) makes a new ACS dependency a transitional choice even if eligibility can be proven. Do not treat a resource's age as sufficient SMS eligibility.

## Recommendation and alternatives

Recommend this limited exception **if overseas transactional-message processing is acceptable to the founder**. It provides a concrete integration path without building a new dependency on a retiring email service. Begin with the smaller SMS allowance proposed below; raising a configured allowance later should be an explicit cost decision.

If overseas processing is unacceptable, retain the existing policy and investigate another compliant delivery architecture. No compliant alternative is established by this proposal. Self-hosting email does not by itself solve deliverability or the absence of an SMS carrier, and is not selected as a workaround. Transitional ACS Email plus a different SMS provider would still need a provider exception, current onboarding proof and a migration plan; it is not automatically approved.

## Data-handling conditions before launch

- Limit delivery content to required transactional messages. Providers necessarily see one-time verification codes and token-bearing links where the application sends them; never describe this as metadata-only or end-to-end encrypted delivery.
- Do not send vault contents/keys, raw card information, connector tokens, receipt contents, approval details or agent-supplied personal text. Replace the operator connector-request email's submitted service-name text with a generic notice; the operator reads the details after signing in.
- Keep click/open tracking disabled. Inbound SMS must never approve an action, cancel a reset or execute a command. Any inbound opt-out behavior must be verified with the provider without creating an application-command channel.
- Review the actual Twilio region, account separation, message redaction/retention options, subprocessor terms and supported Australian number. Do not promise immediate erasure or a retention period before validating the applicable account feature.
- Resend's published Pro behavior is US storage and 30-day message/log retention. There is no per-message deletion API; it describes support-assisted removal. Reconcile the deletion workflow and published privacy policy before launch rather than claiming Warthog's database deletion instantly erases provider copies. A region selected for sending does not relocate that storage. [Resend storage and retention](https://resend.com/security/gdpr), [Twilio regional matrix](https://www.twilio.com/docs/global-infrastructure/regional-product-and-feature-availability).
- Separate provider credentials belong in Key Vault. Reports contain only secret names/reference status and expiry/rotation metadata. No messaging credential may be reused as a Google/Microsoft OAuth secret. Do not create or transmit credentials under this ADR's local-work authorization.

## Proposed initial limits and cost treatment

These are separate proposals for approval, **not settings already selected**:

| Control | Proposed value |
| --- | --- |
| Destinations | Australian-format mobile numbers only (`+614` plus eight digits), subject to actual provider eligibility/deliverability; no landline/international fallback |
| Global outbound quota | 200 billable SMS segments per UTC month; 10 segments per UTC day |
| Per-recipient controls | Three attempted outbound messages per UTC day and three segments per UTC hour |
| Per-message ceiling | Two segments, calculated after adding the final link and accounting for encoding/concatenation |
| Retries | No automatic retry of an ambiguous paid send. Every explicit retry requires a new reservation and counts toward limits |
| Reservation behavior | Reserve global and recipient counters atomically before sending; retain reservations after ambiguous provider failure; no silent security-alert exception to the cost limits |
| Email | Resend Pro quote basis; optional overages disabled; no marketing, dedicated IP, AI, extra-domain or other add-ons |
| Planning envelope | A$600/month gross **before tax**, with actual/forecast alerts; this is not a guaranteed cap or authorization to spend |

At checkpoint 5's planning FX/rates, this is approximately **A$475.26/month gross**, comprising A$420.47 Azure plus **A$54.79/month separately paid messaging**, before tax, extra fees and unquoted setup/funding charges. Prices, account currency and number stock need checkout confirmation. [Twilio pricing](https://www.twilio.com/en-us/sms/pricing/au), [Resend pricing](https://resend.com/pricing).

The 1,000-segment alternative is approximately A$533.81 gross/A$113.34 separate messaging, with an A$675 proposed envelope. It is not selected. Existing sponsorship credit is shared and does not make third-party charges free. No amount here authorizes a payment or new recurring resource.

Changing the older US$150/automatic-stop requirement is a **separate explicit decision**. If a strict no-overrun ceiling remains mandatory, the release remains blocked on a viable, tested spending-control design. Notifications, prepaid balances and stopping compute alone cannot guarantee that all charges cease; inbound SMS, rental, storage/network and delayed billing can continue. This ADR does not silently replace that requirement with alerts.

## Engineering work after approval

1. Add separate Twilio and Resend adapters behind the existing sender interfaces, using the pinned runtime and HTTP seams where practical. Remove the ACS-only production requirement when the approved replacements are wired; never put replacement keys into ACS variables.
2. Define and test the final environment contract, timeouts, accepted-versus-delivered semantics, redacted failure handling, least-privilege credentials and provider-specific retry/idempotency behavior. Approval of the provider does not establish API behavior; verify current official API documentation during implementation.
3. Implement the selected SMS policy: the current code has monthly/daily/recipient-hour **segment** limits and broad calling-code matching. It does not yet have recipient-day **message** counts, the two-segment ceiling or Australian-mobile-only validation. Preserve database atomicity and include failed/ambiguous attempts conservatively.
4. Update privacy/help/operator text and relevant content tests to describe the approved exception accurately. Keep all application data in the approved Azure services. Public privacy changes still need review before publication.
5. Test safe synthetic email/mobile verification, notification fallbacks, limits, errors and delivery-status handling locally. Live tests, provider registration, number purchase and credential insertion occur only in later approved checkpoints.
6. Complete the independent clean image/real PostgreSQL/private-bootstrap/singleton/browser checks. Create the immutable release manifest only after those gates pass. Google/Microsoft project/app setup and all-six-connector acceptance remain required, not replaced by this messaging decision.

## Decisions that remain separate

Final app hostname/RP ID, sending domain/From address, monitored operator address, Google test accounts, provider account/KYC/payment actions, actual gross spending authorization, the older hard-stop requirement and exact additive DNS records. Proposed `app.warthog.com.au`, RP `warthog.com.au` and `mail.warthog.com.au` remain unapproved production settings.

The current Google/Microsoft audience decisions are already settled: named Google Testing users, and Microsoft multitenant plus personal accounts. Do not ask to re-decide those or silently defer connectors.

## Approval record

No approval received. When the founder responds, record exactly which provider/policy/local-work decisions were accepted. Keep unapproved spending, domains and external actions unapproved; do not convert a partial answer into blanket deployment permission.
