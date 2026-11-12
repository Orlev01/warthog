# Agent evidence, granular controls and portable imports

Decision: 12 November 2026. Implements the functional product review on the
isolated `codex/warthog-product-review` branch. This amends the original design's
execution/audit and import details. The implementation and verification record is
[the product follow-up](../audit/product-review-2026-11-12/implementation.md).

## Evidence and outcomes

A credential identifies one Warthog agent connection. Display names and platforms
are owner supplied; protocol client observations are client supplied. Neither
establishes the human, model, conversation or worker identity. Shared credentials
remain shared attribution. Connected means access authorised, not a heartbeat.

The request pipeline assigns correlation identifiers and records the policy
result, a fingerprint of the evaluated policy, duration, safe request arguments,
the selected account and a structural response summary. Response summaries keep
status, counts, bounded resource references and truncation, not raw inbox or
provider-response content. Agent reasons and outcome reports remain labelled as
supplied claims. Legacy entries retain their original hashes and missing evidence.

HTTP and provider errors are failures. Changing calls persist an attempt before
execution. A thrown change has an unknown outcome: a provider might have acted
before its response was lost. An audit outage before the attempt prevents the
change. An outage after execution leaves the attempt available for investigation.
No generic exactly-once guarantee or automatic replay is offered. Approved holds
remain single-claim, and an old unfinished claim is reported as unknown.

The activity reader shares one event formatter with home and agent views. Search
is explicitly bounded to the displayed page, with continuation to earlier pages.
Cursors resolve the exact stored timestamp by owner-scoped sequence, retaining
PostgreSQL timestamp precision. Direct links can load an old entry independently
of the first page. Disputes are displayed alongside the immutable entry and travel
with it in exports/imported history.

Integrity verifies the consistency of the retained chain. The application role
cannot update/delete its rows. Without an independently protected checkpoint,
privileged tail truncation is outside this check's guarantee; "intact" does not
certify completeness or business success.

## Controls and provenance

Account ownership stays separate from agent access. Optional per-service tool
allowlists use the exact namespaced tool name. Null/absent means all current and
future tools; an array means only those tools, including an empty deny-all list.
The same policy gates discovery, direct calls and held execution. Existing grants
keep their previous behavior until edited. Unknown API/provider semantics receive
conservative rule treatment instead of bypassing message/recipient/amount rules.

Tasks and records can be read-only. Selected-record access includes checked
records and records created by that agent; it cannot expose another account's
records. Resource controls default to legacy behavior. Context reports these
permissions, the current connection, selected account labels and the house
instructions. Skill retrieval does not certify instruction adherence.

Client implementation metadata is bounded and encrypted. Optional run references
are client-reported correlation only. Per-agent performance describes a bounded
sample of recorded calls, with missing historical evidence excluded. Aggregate
operational metrics do not include personal agent identifiers or request content.

## Large transfers

The device preserves supporting package files and agent-setting reference data in
exports. Protected values are decrypted only on the device and re-encrypted before
upload. Large ordinary documents are divided into schema-valid parts instead of
being rejected at 16 MiB. Packages restore their constituent skills once.

A staged import is member-scoped and encrypted, has one pending session per
account, accepts immutable indexed parts and requires every part before commit.
All parts restore inside one transaction. Failed commits roll back restored data;
completed identifiers make a repeated commit idempotent. Staging and retry records
expire after 24 hours and the hourly cleanup removes them. New imports supersede
an abandoned pending upload. Agents, credentials and assignments are never restored.

The browser still parses the chosen JSON backup locally; available device memory
is a practical bound. Per-item and per-request limits remain, and a part cannot
silently omit an oversized item. This is not a new 100,000-event performance
certification or an unlimited-memory guarantee.
Legacy prepared imports retain the existing 26 MiB wire limit. New multipart
payloads are limited to 12 MiB and normally target 4 MiB; the outer wire cap stays
26 MiB to support older clients during an update.

## Compatibility and deployment

Migrations 0106 and 0107 are additive. Older application images do not enforce
new tool or resource restrictions: do not roll back automatically. Apply the
existing singleton release procedure and verify runtime-role access, migration
idempotence and backups before a release. This decision does not approve a new
provider, paid service, external message or deployment.

Catalogue setup availability is distinct from live verification. The recorded
Claude/Gmail search/read acceptance does not certify sending, all provider OAuth
flows, refresh, revocation, device notifications or integrations without credentials.
