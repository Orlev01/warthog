# Bug-bash release — 11 November 2026

Status: integrated on main, deployed and verified in production. Temporary runner cleanup is complete and independently verified.

The founder requested independent reviews of security, correctness, design,
mobile/desktop UX and operational practices, implementation of worthwhile fixes,
integration on current main, and deployment. Three reviewers and the coordinator
recorded findings and dispositions in the [bug-bash report](bug-bash-2026-11-11/coordinator.md).

## Source and validation

Application source: `9a7de2e58e9ed3bede61d65bbb9716d0a2214900`, based on latest
main `5882213b21fd7047f014596ef04ba027aa6f0ff6`. The earlier admin console,
agent-first and skills-library work is preserved.

The fixes address reset/recovery races, OAuth refresh client binding, unbounded
push sends, stale/duplicate reminder delivery, invalid scheduling metadata,
notification destinations, honest Calendar Undo outcomes, duplicate form work,
mobile targets and asynchronous dialog/focus behavior. Shared design patterns
remain consistent with the existing neutral admin console.

The complete local Linux suite passed **5,225 tests**, with no failures,
cancellations or skips. Optimized build, TypeScript, real PostgreSQL16 role,
contention and migration checks, 29 delivery-safety tests and five cost-model
tests passed. Runtime staging contains 76 migrations and 106 catalogue entries.
Both full and production-only npm audits reported zero findings.

[Main CI](https://github.com/Orlev01/warthog/actions/runs/42949839977) completed
successfully with all six jobs and all 5,225 tests across four shards.
The [pinned-base image workflow](https://github.com/Orlev01/warthog/actions/runs/42951446384)
also passed all 5,225 tests, with zero failures, cancellations or skips.

Local browser validation covered 97 route/width/theme combinations, plus real
synthetic create/edit, reminder validation, delayed-save, focus-return and
navigation interactions. No document overflow or application console errors
were observed. Hardware passkeys, assistive-technology speech, real provider
receipt and destructive production flows are outside this verification.

## Migration and compatibility

Migration 0105 adds the nullable OAuth client-binding column. Historical refresh
tokens cannot be safely backfilled and require reauthorization; current access
tokens remain valid until normal expiry. The consent flow creates a new agent
connection, so review/reapply custom permissions and remove the obsolete entry
after the replacement works. Static access keys and provider credentials are
unaffected. The additive schema remains readable by the preceding runtime, but
rollback restores the binding defect and can issue new unbound tokens. See the
[migration decision](../adr/oauth-refresh-client-binding.md).

## Published image

The founder approved `azure-images` and image publication completed successfully.
The immutable candidate is
`crwarthogprodauee854.azurecr.io/warthog@sha256:9a0a5f05f0ad1ef20d485236609cb65071feb9971e25d57bb72558a7c8fd5856`.

Independent inspection verified source/base labels, Linux AMD64, UID 1000 and
no setuid/setgid utility bits. The lockfile, all 76 migration hashes and all 106
catalogue hashes match the source. The approved base remains
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.

A fresh Trivy 0.76.2 scan with the 10 November 19:01 UTC database retains exactly
215 OS package/advisory pairs: 1 critical, 34 high, 95 medium and 85 low. No pairs
were added or removed and there are no non-OS findings. The scanner reports no
fixed Bookworm versions for these retained entries. Dependency, base and native
runtime packaging are unchanged; this release adds no native upload processing
or OS utility execution. The existing [OS applicability review](runtime-image-review-2026-11-10.md)
and native-code reachability limits still apply. This is not a vulnerability-free
image claim. Production approval includes these retained findings.

The Azure login action emitted a version-parsing warning during publication;
login, account verification, registry publication and all checks succeeded.

## Production outcome

The founder separately approved `azure-production` for this source and exact
image, including the OAuth compatibility impact, retained OS findings and brief
maintenance. [Production workflow 42954727454](https://github.com/Orlev01/warthog/actions/runs/42954727454)
completed successfully at 04:02 UTC. [Warthog](https://app.warthog.com.au) serves
revision `warthog--r42954727454a1`.

Independent Azure inspection at 04:04 UTC verified the exact image, one healthy
replica, explicit 100% traffic and zero replicas for every older revision.
Application configuration is unchanged apart from image, revision suffix and
traffic target. The existing 0.5-vCPU/1-GiB allocation and SMS-disabled setting
remain. The workflow enforced stop, zero replicas, free database ownership lock,
start, held lock and readiness. Readiness follows startup migrations; no separate
production migration-table query is claimed. There is no automatic rollback.

All 16 public checks passed: readiness/liveness, signed-out access, MCP
method/origin/authentication boundaries, exact OAuth loopback callback and state,
PKCE/resource rejection, receipt-download authentication and terms.

Read-only authenticated Chrome checks covered Home at 1440px; Life admin at
390px; the receipt tab with its scheduling form expanded at 320px; Skills at
390px; and Import & create at 320px. All five cases had a page heading, no
document overflow and no application error. The native optional date input and
status field were present; receipt and skill tabs selected the right panels.
Escape closed the mobile navigation and restored focus to Open navigation.
Browser warning/error logs were empty. No production records, account settings
or permissions were changed. The temporary viewport override was reset and the
tab closed.

## Cleanup and operational limits

The fresh private B2als_v2 runner used the reviewed Ubuntu image, a 32-GiB SSD,
no managed identity, no public NIC address and no inbound access. Tooling,
Key Vault TLS and private PostgreSQL DNS/certificate-verified TLS 1.3 passed
before its one-job registration. Azure credits and the subscription's billing
profile were rechecked before the paid stage.

After the workflow reached terminal success, the controller destroyed the runner.
Independent checks at 04:04 UTC verified the lease group, VM, disk, NIC, NAT,
egress IP and scoped role assignments were absent; the shared subnet NAT was
detached and the GitHub runner deregistered. Ephemeral SSH keys and local registry
credentials were removed. Local preview/test databases, containers, network,
build output, candidate image and downloaded scanner/runner caches were removed.
Private evidence remains; shared Docker caches, dependencies and other agents'
worktrees were left intact.

This release does not establish fresh real-provider notification receipt,
hardware-passkey acceptance, assistive-technology speech or coordinated restore
acceptance. The earlier provider boundaries and deliberately retained delivery
limits remain in the individual review reports.

Operational snapshots, raw logs and scan evidence remain in ignored private
`.delivery/bug-bash-2026-11-11/`. The release-outcome documentation commit follows
the deployed source and does not itself require another deployment.
