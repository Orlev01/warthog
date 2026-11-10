# Initial launch with SMS disabled

On 10 November 2026 the founder approved launching with email, Web Push and in-app
approvals while Twilio production onboarding is deferred. This explicitly replaces
the earlier first-release SMS requirement. Google/Microsoft connectors, strong
sign-in, encryption, database roles and singleton release controls are unchanged.

`SMS_ENABLED=false` disables number enrolment, verification, SMS opt-in, approval
fallback and account-reset SMS alerts. The production sender rejects direct SMS
calls before a Lookup request, database budget reservation or provider send.
Fallback jobs skip SMS before reading numbers or claiming a paid attempt, even
when an existing account has a verified number and saved SMS preference. Email
continues independently. The settings page shows SMS as unavailable and exposes
only the working email/push controls. Existing mobile data is not deleted; saving
preferences with SMS off stores an SMS opt-out. Re-enabling does not erase old
preferences, so review retained consent before a future activation.

The flag accepts only literal `true` or `false`. Omission preserves the previous
enabled behavior and its strict Twilio validation; a misspelling cannot silently
disable a release requirement. Email credentials, VAPID keys and connector setup
remain mandatory in production. No fake credentials or successful no-op sender
are used.

The Azure workload has an explicit boolean `smsEnabled`. False injects the runtime
flag, removes all SMS public settings and omits all three Twilio Key Vault references.
Nine core secret references remain. The parameter guard rejects SMS settings or
references in this mode, and rejects an enabled configuration missing them. Existing
installed Twilio credentials and scoped identity grants are retained for a separately
reviewed activation; this release does not expose them to the container.

Future SMS activation needs the reviewed AU/US/CA/GB routes, registrations,
two-way STOP behavior, redaction entitlement, complete pricing and per-message/
recipient controls in the [messaging decision](adr/global-messaging.md). It is a
configuration release, not an image-only update. No purchase or provider upgrade
is authorized by this launch decision.

Regression coverage exercises production readiness without any Twilio settings,
invalid flags, crafted settings calls, a legacy SMS opt-in, direct sender refusal,
account reset, email delivery and push registration/test delivery. Workload tests
cover both modes and preserve both approval flags. Azure's read-only Template
validation succeeds for the prepared SMS-off inputs; a local validation caught
and corrected the prepared CPU parameter from numeric `0.5` to the required string.
Validation used a clearly marked synthetic digest and does not authorize or create
an application. The subsequently approved [first release](first-app-release-2026-11-10.md)
now runs the exact verified image with SMS off. The subsequently approved app
DNS/certificate binding is verified; live acceptance remains outstanding.
