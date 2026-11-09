# Separate passkey identity from the verified email sender

Accepted for local implementation following founder approval, 9 November 2026.

The founder approved `https://app.warthog.com.au` as the public origin and
`app.warthog.com.au` as the passkey RP ID. The narrower RP ID supersedes the
parent-domain proposal. Authentication continues to require the exact configured
origin. Do not broaden passkey scope to accommodate an email setting.

The approved sending domain is `mail.warthog.com.au`, with From
`notifications@mail.warthog.com.au`, display name Warthog, and reply-to/public
support/privacy contact `oren@nava-co.com`. A sender domain and a passkey RP ID
serve different purposes; the existing validator incorrectly couples them.

Require `RESEND_SENDING_DOMAIN` separately, with the normalized From domain
matching it exactly. Reject malformed domains, URLs, wildcards, suffix lookalikes,
subdomains that were not explicitly configured, and header injection. Require a
valid `RESEND_REPLY_TO_ADDRESS`; it may belong to a different domain. Keep all
mail identity settings server-side, and report variable names rather than values
on configuration failure. The Resend key must later be sending-only and restricted
to the provider-verified domain. Syntax checks do not establish domain ownership.

Use Resend's documented `from` display-name format and `reply_to` API field. Keep
plain-text content, no tracking metadata, no transport retries, sanitized errors,
and the existing opaque idempotency key. No dependency or schema change.
Reference: https://resend.com/docs/api-reference/emails/send-email

Resend Free is selected; paid upgrades and overages are unapproved. Its 100/day
and 3,000/month provider limits can interrupt email, including authentication.
Provider settings and actual delivery remain acceptance gates. This change does
not create accounts, credentials, DNS records or paid resources.

SMS retains the approved AU/US/CA/GB rollout and 200/month, 10/day segment caps,
subject to sender acceptance and a complete quote within A$20/month. These are not
proof of a currency cap. Twilio redaction entitlement and cost remain unresolved.

Validation: failing regressions for the sibling domain/RP configuration, invalid
sender/reply-to inputs and outbound mail headers; then affected tests, full suite,
TypeScript, production build and runtime staging. Linux/real PostgreSQL execution
remains a separate environment gate.
