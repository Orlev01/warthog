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

## Recent apps (amendment, 16 November 2026)

Measured on 16 November ([agent runs](agent-runs.md)): a 2026-07-28 client sends its
client information, capabilities and protocol version in `params._meta` on every request.
Warthog had read the top-level `_meta`, so it recorded app details only for 2025 clients
from their `initialize`. It now reads `params._meta`. A top-level `_meta` is still read
when the params carry none. The agent's own run reference (`app.warthog/runId`) is read
the same way.

One connection is often used from several apps. The founder's claude.ai connector
reported four: Claude Code, claude.ai chats (a Claude Code build), and two of claude.ai's
own checks. Comparing each report with only the last one would have recorded an entry
on every switch. So:
- **The agent's record keeps its recent apps.** `agents.client_observation_ct` holds the
  latest report at the top level (the shape earlier releases read) and `seen`, up to
  eight distinct reports (name, version, protocol and capabilities), latest first. A
  record from before this amendment counts as one seen app.
- **Activity records news only.** "Client information reported" is recorded for an app
  or version that is not in `seen`. A switch between known apps records nothing; an
  update records once.
  - Reports are compared after the same redaction the stored copy went through, including
    the person's released-value matcher. So a report that redaction changes still matches
    its stored copy.
  - An app pushed out of `seen` by eight newer reports counts as new if it comes back.
- **No cost per request.** Each dispatch remembers when it last wrote each agent's reports,
  for up to eight reports per agent, so one agent varying its report can't push other
  agents out. An unchanged report is written again at most every ten minutes. A repeat
  needs no database write and no key unwrap, so "last seen" can be up to ten minutes
  behind.
  - Simultaneous requests with the same report share one write.
  - A clock that steps back past the last write counts as due.
- **Never fatal.** A failure to remember the app is logged (`client_observation_failed`),
  retried a minute later rather than on every request, and never fails the agent's call.
- **Per entry.** Each tool entry from a current client names the app it came through
  ("Agent software (as it reported it)" in its technical details).

The agent's Overview lists every recent app under Technical details. These are client
claims, never identity. The column is unchanged, and there is no migration.

**Rollback.** An earlier image reads the new shape (it ignores `seen`). If it handles a 2025
`initialize` after a rollback, it records one extra "Client information reported" entry for
that agent and rewrites the record without `seen`. This image then reads it as one app.
An earlier image never records 2026-07-28 clients, because it reads the top-level `_meta`.
