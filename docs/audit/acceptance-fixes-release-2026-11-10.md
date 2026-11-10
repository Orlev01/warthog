# Acceptance fixes release — 10 November 2026

Status: deployed and healthy at [app.warthog.com.au](https://app.warthog.com.au).
Application source: `09e13608110ef6419d6dd876faba17582b291596`.
Revision: `warthog--r42799281150a1`, one healthy replica, explicit 100% traffic.
Image: `crwarthogprodauee854.azurecr.io/warthog@sha256:509b1ea586342ead5a1bad51f4c04088e440a72d3869b65a4356041857b8880b`.

The founder instructed: “Please continue to fix all and then deploy.” This
release implements the observed acceptance findings and uses the existing
manual image and production review gates. It changes application and delivery checks;
there are no new migrations, production credentials, DNS records, service tiers
or external-message permissions. The existing singleton maintenance procedure
briefly stops the old replica before the new replica acquires database ownership.

## Changes

- Preserve the exact OAuth loopback callback query, and validate required Memory
  input in the browser.
- Show whether the current person has an Authenticator app, without reading its
  secret; describe recovery for both Authenticator and passkey users.
- Confirm agent disconnection in an accessible in-page dialog with explicit
  cancellation, replacing the native confirmation that blocked UI acceptance.
- Link Privacy and Terms from public entry pages and correct the Terms title.
- Use Google's published issuer (`https://accounts.google.com`) for its exact
  token endpoint instead of assuming the token-server origin is the issuer.
  Realistic identity-token tests reproduce the failure and cover completion,
  refresh and rejection of wrong issuer/audience claims. Provider account labels
  still come from authenticated userinfo. Callback failures log only safe phase,
  error-code and claim-name diagnostics, without raw errors or identity values.
  Source: [Google discovery metadata](https://accounts.google.com/.well-known/openid-configuration).
- Enforce receipt file limits in the browser and server; reject declared upload
  envelopes above 26 MiB with HTTP 413 before Next's generic multipart error.
  The framework streaming limit remains in place for undeclared/chunked bodies.
  Provide owner-only
  authenticated downloads as attachments with private/no-store headers.
- Add explicit record-and-attachment deletion. Serialize uploads and record
  deletion with a parent-row lock; delete blobs before removing their metadata
  so failed storage deletion retains references for retry. Blob and database
  changes are not a distributed transaction: a failed multi-file deletion may
  already have removed some files, and retry completes the remaining cleanup.
- Reconcile failed uploads after the transaction ends, including ambiguous
  commit and PUT responses. Reacquire the parent lock before reading metadata;
  preserve committed files and remove only confirmed-unreferenced ciphertext.
  Unresolved failures emit an opaque `receipt_upload_reconcile_required` event
  to private operator logs for follow-up (no file content or encryption keys).

## Validation and release contract

Focused regressions cover ownership isolation, exact downloaded plaintext,
non-inline untrusted content, upload limits, deletion retry, Authenticator
status and confirmation decisions. A clean Node 22/Linux build and 63 focused
Linux tests pass. Real PostgreSQL 16 role and lock checks also pass, including
upload-first and delete-first receipt contention with no orphaned blobs.
[Pinned-base publication CI](https://github.com/Orlev01/warthog/actions/runs/42796225675)
passes all six jobs and 5,092 application tests with zero failures. Each shard
checks real PostgreSQL 16, role restrictions, runtime builds and migrations.
Delivery guards, cost checks and Terraform provider schemas pass. Local browser
tests cover the disconnect dialog (Cancel and Confirm), Authenticator copy,
policy links and receipt lifecycle, including exact near-limit download bytes.

The reviewed Node base remains
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.
The [runtime image review](runtime-image-review-2026-11-10.md) describes retained
OS advisories and mitigations; this release does not claim a vulnerability-free
base. The exact published AMD64 image passes its runtime contract (UID 1000,
no setuid/setgid files). Its scan has the same 215 OS package/advisory pairs as
the previously reviewed image: one critical, 34 high, 95 medium and 85 low;
no Node findings and no added or removed OS findings.

The workload remains one 0.5-vCPU/1-GiB replica, private PostgreSQL, 70 migrations,
SMS disabled and the existing Key Vault references. The existing Azure estimate
and A$440 usage alert remain unchanged. Startup-credit linkage is rechecked
privately before the temporary runner was provisioned. The runner used the same
approved private, single-job profile. Independent inventory confirms its group,
VM, disk, NIC, NAT, egress IP and grants are removed; the shared subnet has no
NAT association and the GitHub runner is absent.

## Deployment guard failure and operator continuation

[Release run 42799281150](https://github.com/Orlev01/warthog/actions/runs/42799281150)
failed after the candidate became healthy: Azure serialized nine secret-backed
environment entries with an additional empty `value`. The strict configuration
hash interpreted that representation as drift. The workflow stopped the
candidate, verified zero replicas and a free database ownership lock, and
retained the maintenance outage. The run remains failed; it is not recorded as
a successful automated deployment.

The corrected comparison removes only an empty `value` beside a nonempty
`secretRef`, using a copy so the input is unchanged. Nonempty literals, changed
references, ordinary empty literals, domains and other configuration still
participate in the hash. All 29 delivery tests pass, including the actual
copy/health/traffic path with Azure's representation. The tooling correction is
commit `7cae752`; it does not change the deployed application image.
[Final CI on that tooling commit](https://github.com/Orlev01/warthog/actions/runs/42802425805)
passes all six jobs: 5,092 application tests, 29 delivery tests, cost checks and
Terraform schemas. Subsequent commits update documentation only.

Before operator continuation, live configuration was independently matched to
the reviewed snapshot with only the intended image, suffix and traffic changes.
Both revisions were inactive with zero replicas, and the failed workflow's
completed database-free proof was retained. The operator activated only the
same reviewed candidate, without rollback or configuration changes. At
10:48:55 UTC, both default-host and custom-host HTTPS readiness returned 200;
the new revision had one replica and 100% traffic, and the old revision remained
inactive with zero replicas. Subsequent runtime checks confirmed 70 migrations,
PostgreSQL TLS 1.3, UID 1000, SMS off and exactly one ownership lock.

All 16 post-release public checks pass, including exact loopback callback/state,
wrong callback/resource/PKCE rejection, MCP authentication/origin/method
boundaries, receipt download authentication and the Terms title.

Production browser checks pass for enrolled Authenticator presentation, required
Memory input, public policy links and the Terms title. A 1,024-byte receipt and
a 26,213,376-byte receipt (25 MiB minus 1 KiB) upload and download byte-for-byte
correctly. A 25-MiB-plus-one-byte file is rejected by browser validation before
submission. The single synthetic record and both files are removed afterward.

## Acceptance limits

A fresh production sign-in with email plus the founder's Authenticator passed.
Exactly one approved Chrome test push was reported sent; the founder is unsure
whether an OS notification appeared, so desktop delivery remains unconfirmed.
No repeat push is authorized by that result. The approved Gmail connection now
succeeds after the issuer fix. Its labels-only request returns HTTP 200; no
message content was read and no mail was sent or modified. Google remains in
Testing mode. Other provider consents and isolated coordinated recovery remain
separate acceptance work; no real account is reset.

## Receipt reconciliation operations

A `receipt_upload_reconcile_required` log records `fileId`, `recordId` and the
opaque `blobKey`. It means storage or database availability prevented a definite
cleanup result; it does not mean the upload failed to commit. Retain the event
until resolution. With the application/database healthy, inspect those exact
identifiers under a transaction holding the parent record lock. If matching
receipt metadata exists, preserve the blob and verify its availability. If no
matching metadata exists after the lock is acquired, delete only that exact blob
idempotently. A missing parent is safe only after the original transaction has
finished. Never bulk-delete blobs from an uncoordinated storage listing. Record
the resolved identifiers and outcome privately. This is an operator recovery
path, not an automatic retry service or a distributed-transaction guarantee.
