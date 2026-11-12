# Product review release — 12 November 2026

The functional product review fixes are deployed at
[app.warthog.com.au](https://app.warthog.com.au), together with the latest main's
consent improvements and MCP tool metadata. Application source is
`9f2ef12dbf6b1c8c75797b1c647d694cd4b3b7ee`.

The founder requested deployment with the latest main and authorized coordination
of one release. Main `5213e66` was merged into implementation commit `bdd1494`;
the resulting application tree is identical to the validated implementation.
The other agents held publication and cloud changes. Their older candidate was
superseded and was not deployed. Other worktrees were not edited by this release.

The [implementation record](product-review-2026-11-12/implementation.md) maps all
thirteen findings to changes and acceptance evidence. This release includes
granular tool/task/record controls, accurate failure and unknown outcomes,
durable execution attempts, administrative audit events, client provenance,
usable audit history and disputes, and large encrypted account transfers.

## Source and image verification

Both [main CI](https://github.com/Orlev01/warthog/actions/runs/43145757669) and
[pinned-image CI](https://github.com/Orlev01/warthog/actions/runs/43147500654)
passed **5,259 tests**, with zero failures, cancellations or skips across four
Linux shards. Each shard passed TypeScript, real PostgreSQL 16 verification,
production build, runtime packaging and the separate non-root AMD64 image checks.
Delivery safeguards, Terraform schemas and the reviewed cost profile also passed.
Local delivery and cost checks passed 29 and five tests respectively.

The immutable candidate is:

`crwarthogprodauee854.azurecr.io/warthog@sha256:fbed6cd350a371d5301a5a610ef3eb06fc49ad4dde94d32cc45691341b04a9da`

Independent inspection matched the exact source and pinned base labels, lockfile,
all **78 migration hashes** and **106 catalogue hashes**. Linux AMD64, UID 1000
and absence of setuid/setgid utility bits were verified. The base remains:

`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`

A fresh scanner database reports **219 OS package/advisory pairs**: one critical,
34 high, 95 medium, 85 low and four unknown. There are **zero non-OS findings**
in the final image; a separate production npm audit also reports none. This is
not a vulnerability-free image.

Compared with the preceding deployed image's scan, four entries are newly listed
for libc6/libc-bin: [CVE-2026-100290](https://security-tracker.debian.org/tracker/CVE-2026-100290)
and [CVE-2026-115819](https://security-tracker.debian.org/tracker/CVE-2026-115819).
The upstream advisories describe regex cleanup after particular allocation
failures and a one-byte null overflow in certain wide scanf conversions,
respectively, with CVSS 3.7 and 4.8. Debian lists no Bookworm fixed version.
Freshly retrieved upstream texts are retained with the private review evidence.

Inspection of this exact candidate's Node executable and four sharp/libvips ELF
files found no direct imports of the affected functions. This does not prove
complete unreachability through transitive libraries or dynamic lookup. The
remaining [OS applicability review](runtime-image-review-2026-11-10.md) remains
relevant. The founder received the updated findings before approving publication
and separately approved this exact production run in GitHub.

## Migration and maintenance scope

Two additive migrations, `0106_agent_evidence.sql` and `0107_chunked_import.sql`,
add encrypted client observations, resource controls and encrypted import staging.
All 76 existing migration files are unchanged. Existing resource permissions keep
their previous behavior until edited. No dependency, infrastructure or container
configuration change is included relative to the preceding deployed application.

Older images do not enforce the new controls. Additive schema compatibility does
not make those images authorization-compatible; rollback requires an explicit
policy and schema review. The release does not automatically reactivate an old
image. The approved maintenance restart discards pending in-memory releases;
those must be requested again if needed.

The existing 0.5-vCPU/1-GiB allocation, nine versioned secret references, managed
identity, hostname and SMS-disabled configuration were preserved. Read-only
preflight confirmed eligible Azure credits, PostgreSQL 16 readiness, private-only
database networking and seven-day backup retention. This is not a restore test
or a guarantee that credits impose a spending cap.

## Production verification

[Production workflow 43149429380](https://github.com/Orlev01/warthog/actions/runs/43149429380)
succeeded at 03:45 UTC on 12 November (14:45 Sydney). Both protected environments
remained main-only, required the founder's manual review and prohibited
administrator bypass. The production approval was independently read from the
GitHub approval record; it was not automated by an agent.

The workflow passed its stop, zero-replica, free ownership-lock, startup,
held ownership-lock and readiness checks. Independent Azure inspection at
03:46 UTC confirmed revision **`warthog--r43149429380a1`**, the exact candidate,
one healthy replica, explicit 100% traffic, zero old replicas and unchanged
configuration apart from image, revision suffix and traffic target. Startup
readiness follows migration completion; no separate production migration-table
query is claimed.

All **36 public checks** passed both before and after deployment: 20 entry,
marketing, CSP and session-boundary checks, plus 16 OAuth, MCP authentication,
receipt-authentication and legal-page checks. Acceptance did not read inbox
content, send provider messages or change production account settings.

The coordinated consent reviewer independently passed **24 public HTTP checks**
and **17 browser checks**. These overlap the public suite above and are not a
claim of 60 distinct HTTP checks. Browser coverage included the unavailable or
expired consent state and its recovery navigation, and access-key setup at 320,
390, 768 and 1440 pixels, light/dark appearance and simulated safe-area insets.
Custom opens editable groups; presets and unsaved connector/card choices update
the review; memory reading and saving remain independent; the example disclosure
works by pointer and keyboard. Checked mobile controls met 44-pixel targets and
16-pixel field text. No document overflow or captured warnings/errors remained.

No consent approval/refusal, key creation, account change or provider handshake
was performed. A fresh OAuth request was not initiated, so the active consent
form was not tested live; its shared editor was exercised through access-key
setup, with the original local consent coverage retained. Browser overrides were
reset and the reviewer's tab closed. The independent results and screenshots
were copied into the private release evidence directory.

## Runner cleanup

The release used the existing private B2als_v2 runner profile. Its exact saved
plan contained eleven creates and no deletions or replacements. Inspection
verified its immutable Ubuntu image, 32-GiB SSD, secure boot, no managed identity,
no public NIC address and deny-all inbound rule. Runner release archive checksums,
tooling, Key Vault TLS and private PostgreSQL DNS/certificate-verified TLS passed
before single-job registration. The connectivity probe used no database credential.

After terminal workflow success, the controller removed the runner. Independent
inspection at **03:48:39 UTC** verified the lease resource group, VM, disk, NIC,
NAT, egress IP and scoped role assignments were absent; the shared subnet NAT was
detached; and the GitHub runner was deregistered. The ephemeral SSH private key,
isolated registry credentials and temporary native-inspection/scanner files were
removed. Scan JSON, verification results and operational logs remain private.
Application resources were not part of this teardown.

## Verification boundaries

The local 67 MB account round trip, 100,000 historical entries and responsive
agent-control interactions are documented in the implementation record. They are
not claimed as a production restore or all-provider certification. The
[connector matrix](product-review-2026-11-12/connector-verification.json) retains
unverified live operations. Real-device notification delivery and coordinated
restore acceptance retain their existing boundaries. Warthog controls activity
through its own connection, not a provider's private conversations or other tools.

Operational evidence is retained under ignored `.delivery/product-review-release/`.
The documentation commit follows the deployed application source and does not
change the running application or require another deployment.
