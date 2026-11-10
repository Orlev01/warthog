# Acceptance fixes release — 10 November 2026

Status: candidate preparation; production still runs the first release until the
release and post-deployment checks below are recorded as complete.

The founder instructed: “Please continue to fix all and then deploy.” This
release implements the observed acceptance findings and uses the existing
manual image and production review gates. It changes application code only;
there are no new migrations, production credentials, DNS records, service tiers
or external-message permissions. The existing singleton maintenance procedure
briefly stops the old replica before the new replica acquires database ownership.

## Changes

- Preserve the exact OAuth loopback callback query, and validate required Memory
  input in the browser (previously tested source, not yet deployed).
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
Full Linux/PostgreSQL CI, browser results and immutable image
verification will be recorded before deployment.

The reviewed Node base remains
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.
The [runtime image review](runtime-image-review-2026-11-10.md) describes retained
OS advisories and mitigations; this release does not claim a vulnerability-free
base. The published AMD64 candidate must be scanned and compared before release.

The workload remains one 0.5-vCPU/1-GiB replica, private PostgreSQL, 70 migrations,
SMS disabled and the existing Key Vault references. The existing Azure estimate
and A$440 usage alert remain unchanged. Startup-credit linkage is rechecked
privately before the temporary runner is provisioned. The runner uses the same
approved private, single-job profile and is removed after the release.

## Acceptance limits

A fresh production sign-in with email plus the founder's Authenticator passed.
Exactly one approved Chrome test push was reported sent; the founder is unsure
whether an OS notification appeared, so desktop delivery remains unconfirmed.
No repeat push is authorized by that result. The founder approved the initial Gmail connection and labels-only read test.
Google accepted consent, but the first app callback failed; a Google-style ID
response reproduces the issuer defect above. Live retry and labels verification
remain pending deployment. Other provider consents and isolated coordinated
recovery remain separate acceptance work; no real account is reset.

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
