# Deletion evidence outside database backups

Decision: 12 November 2026. Implementation is a candidate; Azure activation and
an isolated cloud restore require their separate resource/access/release approvals.

Clearing a live wrapped data key does not erase its older backup. PostgreSQL's
purge queue also disappears with the user. Recovery therefore needs independent
evidence of deletions made after the database restore point.

## Evidence and failure handling

The private `account-deletions` container stores two create-only JSON markers per
account UUID: `requested` before the SQL transaction commits and `completed`
afterward. Markers contain only version, opaque account UUID, event and UTC time.
They contain no contact information, content, tokens or encryption keys. A failed
intent write prevents deletion. A failed completion write leaves the committed
deletion inaccessible and queued; the purge sweep repairs evidence before removing
rows or receipt blobs. A prolonged storage outage delays physical purge and needs
operator attention to the existing job error logs and 24-hour purge requirement.

An unresolved intent deliberately blocks recovery: a failed SQL commit is not
silently classified as success or cancellation. Resolve such cases using separately
reviewed durable transaction evidence; no automatic override is provided.

After exclusive database ownership, startup conditionally creates `coverage.json`
before starting jobs or accepting requests. It is never overwritten or backdated.
Missing configuration or failed activation terminates production startup. A
restore point before this recorded coverage cannot be certified by this journal.
An older image must never resume deletion writes after activation: delivery rejects
images without the `io.warthog.deletion-journal=v1` label once configured.
Before stopping a healthy app, delivery also rejects a journal-required image
unless journal configuration already exists or explicit activation is selected.

## Azure protection and cost

The proposed container has a **locked 42-day container-level immutability policy**
and Terraform destroy protection. Locking cannot be undone and retention cannot be
shortened. The app receives only `blobs/add/action` at this container, with no read,
list or delete permission. Small markers use one conditional Put Blob; the exact
first-write/retry/overwrite-denial behavior must pass on Azure before activation.
Only HTTP 412 `ConditionNotMet` acknowledges an existing marker. Other errors fail
closed. [Put Blob permissions](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob#permissions).

Journal records **do not automatically expire**. Azure's lifecycle Delete action
is unsupported on immutable containers. Retain evidence until a separately
reviewed operator cleanup removes expired request/completion pairs together,
including any historical versions, after both have aged beyond 45 days. Preserve
coverage, unresolved intents and all evidence needed by any retained restore
point. Review actual creation times and retention locks, not just JSON timestamps;
an interrupted cleanup must keep recovery closed until the inventory is reconciled.
No app or delivery identity receives cleanup permission in this change.
[Lifecycle limitations](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview#known-issues-and-limitations).

At the recorded Australia East rates, 1,000 deletions mean about A$0.016 of marker
writes plus negligible metadata storage. This is variable usage, not a hard cap.
Receipt storage gains account versioning and 14-day blob/container soft deletion
for the current seven-day database backup window. A receipt-only lifecycle rule
deletes previous versions after 14 days; soft deletion can retain those versions
for another 14 days and lifecycle execution is asynchronous. With 10 GB/month of
changed or deleted receipt data, approximately A$0.27/month of extra storage is a
planning illustration, not a guaranteed retention deadline or bill. Existing
A$440/month usage alerts stay in place. Deleted blobs from before activation are
not retroactively recoverable. [Versioning](https://learn.microsoft.com/en-us/azure/storage/blobs/versioning-overview).

## Recovery contract

1. Stop all application writers and independently verify the original journal's
   identity, locked policy and complete listing. `scripts/capture-deletion-journal.ts`
   reads only the fixed original container, follows every page, bounds object size
   and writes a new private snapshot file. Its stopped-writers environment flag is
   an operator attestation, **not** an independent check of Azure replica state.
2. Use only an isolated database clone and separate receipt-copy destination. The
   operator must verify exact resource IDs, private networking, no public ingress,
   no app/background-job execution and a bounded cleanup lease before supplying
   those handles to `prepareIsolatedRestore`. No generic production-target restore
   CLI or HTTP/MCP endpoint is exposed.
3. Validate fresh journal coverage against the restore point; refuse ambiguous,
   malformed, stale, truncated or inconsistent evidence. Reconcile journal deletions
   and committed empty-key/deletion-queue rows already present in the snapshot.
   Historical household ownership needs explicit reconciliation before removal.
4. Remove deleted accounts' copied receipt blobs before their database rows. Purge
   restored authentication/service credentials, sessions, pending approvals and
   jobs. Disconnect agents. Keep traffic closed. Restored credential revocations
   cannot be inferred from an older snapshot, so surviving accounts need separately
   approved reenrollment; device-encrypted vault recovery may require the owner's
   retained device key and is not certified by this procedure.
5. Preserve the original versioned wrapping keys throughout the full database and
   blob recovery window. Prove exact ciphertext/associated-data decryption for
   synthetic receipts and refusal when the original key version is unavailable.

The local PG16 drill creates a real snapshot clone, deletes/purges a synthetic
account in the source, proves its resurrection in the clone, then reconciles it.
It verifies surviving ciphertext after synthetic KEK rotation and credential
invalidation. It deletes its disposable databases/network afterward. This validates
protocol and SQL behavior; it is **not** Azure PITR, actual Key Vault recovery or
authorization to reopen production. The cloud drill must be independently executed
and recorded after the storage/journal activation boundary.

## Release ordering

Review and apply security-anchor permissions, then the exact foundation plan.
Verify locked retention, private access, receipt version history, and the app's
add-only first-create/conditional-retry probe. Publish a tested immutable image.
The reviewed maintenance release may set `activate_deletion_journal=true` once;
this adds exactly `DELETION_JOURNAL_CONTAINER=account-deletions` during the existing
stop/zero-replica/free-lock/image-copy sequence. Fingerprint verification permits
only that setting plus the normal image/revision/traffic changes. Subsequent
releases are image-only. Do not deploy this candidate before its storage is ready.
