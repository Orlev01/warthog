# Isolated recovery drill cleanup

The manual `azure-recovery-cleanup.yml` workflow provides a cleanup supervisor for
the single reviewed recovery-drill resource group. Merging this workflow creates
no Azure resource or grant, starts no job and does not authorize a recovery drill.
The production application, its storage protections, fixture writes, journal
reader and temporary network exception retain their separate approvals.

## Exact authority

The script accepts only GET and DELETE of
`rg-warthog-pitr-drill-aue-20261112` in the existing personal Warthog subscription.
It uses the existing `azure-runner-cleanup` environment and cleanup managed
identity. Execution needs a separately approved, group-scoped assignment of the
existing resource-group read/delete role. It does not create that assignment,
enumerate resources, read application data, or operate on the production group.

Before dispatch, the operator must prove that this exact group is newly created,
empty and exclusively owned by the reviewed drill. Verify the exact temporary
assignment and preserve a private manifest containing the approved resource,
fixture, network, cost and cleanup scope. Do not use this group for unrelated work.
The supervisor cannot inspect children with its narrow role.

## Arming and handoff

Create only the approved empty group and cleanup assignment before arming. The
group must have these exact reviewed tags: `purpose=pitr-drill`,
`environment=isolated`, `owner=warthog`, the private `manifest_sha256`, and UTC
`created_at`, `cleanup_at`, `expires_at` values. Cleanup is exactly three hours
after creation; the deadline is exactly four hours after creation.

Dispatch manually from the reviewed main commit with `execution_approved=true`,
the manifest SHA-256, the exact workflow commit in `approved_workflow_sha`, the
SHA-256 of `scripts/ci/cleanup_recovery_drill.py` in `supervisor_sha256`, and the
three matching UTC timestamps in `started_at`, `cleanup_at` and `deadline_at`.
The default approval flag is false. Repository/owner IDs, personal dispatch
actor, workflow path, source bytes, token identity, group location and tags are
checked before any deletion. Arming more than 30 minutes after group creation
fails and must not be followed by billable provisioning.

The separate creator must verify the exact run's successful arm step and an
actively running supervisor before creating billable resources. Recheck that
handoff before each creation phase. A green arm proves authenticated access to
the matching group; it does not prove deletion permission by deleting the group.
Keep the local watchdog and a reachable operator available as additional controls.

## Cleanup and evidence

The hosted process checks the fixed group while waiting, then requests fresh
OIDC/ARM credentials at cleanup time. It rechecks the tags before each DELETE.
A deletion request or HTTP 202 is not completion: it polls until the group's GET
returns 404. The operator must independently verify child resources and the
temporary assignment are absent, and confirm the production source is unchanged.

Transient failures retry only the same fixed group. After hour four, the process
reports overdue cleanup and may continue cleanup observation for one further
hour. This is an emergency cleanup allowance, not an extension of the approved
experiment. If removal is still unverified, the job fails and the named operator
continues cleanup within the exact reviewed scope. The hosted job timeout is
330 minutes.

Cancellation handling is best effort. Forced termination, a GitHub outage or an
Azure outage can prevent cleanup; this is not a hard spending cap. Verify the
current hosted-runner terms and funding before dispatch. The workflow does not
remove source fixtures, receipt versions, immutable journal markers or a separate
operator reader/firewall exception. Those require their own reviewed cleanup and
retention evidence. It cannot certify a full coordinated recovery by itself.

Offline tests cover exact context/hash/identity checks, time/tag drift, fresh
authentication after the wait, actual absence versus accepted deletion, bounded
retries and secret-free failures. Live federation, effective permissions and
actual teardown remain acceptance checks for the approved drill.
