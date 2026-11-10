# Global messaging — approved local integration, 9 November 2026

**10 November launch decision:** the founder explicitly approved proceeding with
SMS disabled while Twilio production onboarding remains unresolved. This supersedes
the earlier requirement to ship real SMS in the first release. Use `SMS_ENABLED=false`
(`smsEnabled=false` in the Azure workload); retain email, push and in-app approvals.
SMS settings, verification, fallback and reset alerts are unavailable in this mode,
including for previously saved opt-ins. The country/provider/cap contract below
still applies to any later SMS activation. No sender purchase or plan upgrade is
authorized by deferring SMS.

The founder approved Twilio SMS and Resend email, including overseas processing,
and explicitly confirmed that Warthog is a global product. This supersedes the
Australia-only processing rule and the AU-only pilot suggestion in the earlier
exception proposal. Azure Australia East remains the primary application region.
It does not authorize credentials, accounts, purchases, deployment, DNS or spend.

## Implementation contract

- No geographic restriction on account creation. SMS is optional; email, passkeys,
  the in-app approvals screen and supported push devices remain usable without it.
- Accept explicitly international E.164 phone numbers, with harmless formatting
  normalized. Never infer Australia or the US from a national-format input.
- Twilio Basic Lookup v2 resolves number validity and ISO country before sending.
  No paid Lookup fields. Shared calling codes do not grant permission to all their
  countries. A valid numbering range does not prove reachability or SMS capability.
- First-release sender pools must support replies/STOP. One-way sender strategies
  remain gated; China SMS is explicitly blocked because approval links violate
  published content restrictions. SMS alerts require explicit, withdrawable consent.
- A country-to-Messaging-Service map is the explicit SMS allowlist. No default
  countries and no wildcard. Each enabled country requires a reviewed sender,
  content/use-case restrictions, opt-out handling, quote and real delivery test.
- The initial adapter supports Twilio US1 explicitly, with fixed HTTPS endpoints,
  an API key instead of the master auth token, no redirects and no automatic retry.
  Other Twilio regions require a separately tested endpoint/credential contract.
- Reserve persistent global month/day segment counts, recipient/hour segments and
  recipient/day message counts before dispatch. Enforce a per-message segment cap.
  Ambiguous failures consume the reservation. Persist one SMS attempt per approval
  before dispatch so background retries cannot duplicate paid SMS. Limits are mandatory configuration,
  not implied spending authorization; segment caps are not currency caps.
- Request Twilio message-body redaction; retain phone-number handling needed for
  provider opt-out suppression. Never disable STOP filtering for redaction. No
  claim of complete erasure: carriers and compliance storage have separate rules.
- Resend receives only transactional recipient, generic subject, body and optional
  link. No tracking, attachments, tags or user-entered connector requests. Opaque
  request idempotency key; no automatic retries or provider-payload logging.
- Privacy copy must describe international providers, message codes/links, mobile
  carriers, Google/Microsoft and push services, retention and deletion limitations.

## Release acceptance

All tests use synthetic data and injected transports. Real provider acceptance,
country registrations, sender permissions, delivery, bounces, STOP/START, retention,
DNS alignment and privacy/contact review remain pre-launch gates. A country absent
from the reviewed configuration cannot send SMS. Overseas approval is not a
worldwide delivery promise. See `../global-messaging-launch.md` for the country matrix.
