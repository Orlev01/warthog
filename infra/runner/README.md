# Private ephemeral delivery runner

Secret/database bootstrap uses a separate temporary VM. Destroy it after setup;
never register that VM as a GitHub runner. Protected Run Command parameters may
remain in the guest agent's cache, and Docker jobs have root-equivalent access.
The controller refuses registration when any prior Run Command other than
`prepare` exists. Each actual release uses a fresh disk/VM with no bootstrap-secret
history; its only credentials are the transient job/JIT credentials.

Each authorized release gets a fresh Ubuntu 24.04 x64 B2als_v2 VM in the existing
`private-bootstrap` subnet. The VM has no public NIC address, no inbound traffic,
no Azure identity, no cloud-init credentials and no persistent GitHub PAT.
Outbound traffic uses a short-lived NAT/public IP. The founder's personal token
is used locally only to obtain the single-job JIT registration configuration.

`../../scripts/delivery/runner.py` operates isolated owner-only state under
`.delivery/`. Its separate `plan`, `apply`, `prepare`, `register` and `destroy`
commands never dispatch or approve an app release. Supply an inspected immutable
Canonical image version, exact runner release SHA-256, generated SSH public key, cleanup principal and UTC lease
expiry no more than four hours away. No inbound SSH is opened; Azure Run Command
installs tools. This VM is dedicated to one job, not a build/test worker.

Example operator sequence, using an absolute ignored directory:

For a release, first dispatch the approved workflow and wait for its hosted `gate`
job to pass. Use that run ID as the lease ID; provision no VM for a rejected input.

```sh
python3 scripts/delivery/runner.py plan --directory /path/to/repo/.delivery/runner-LEASE
# Inspect plan.json; save the printed hash. Review expiry and exact resources.
python3 scripts/delivery/runner.py apply --directory /path/to/repo/.delivery/runner-LEASE --reviewed-plan-sha256 SHA256
python3 scripts/delivery/runner.py prepare --directory /path/to/repo/.delivery/runner-LEASE
python3 scripts/delivery/runner.py register --directory /path/to/repo/.delivery/runner-LEASE --run-id APPROVED_GITHUB_RUN_ID
# Always tear down, including failure, cancellation or a job that never starts.
python3 scripts/delivery/runner.py destroy --directory /path/to/repo/.delivery/runner-LEASE
```

`approved.tfvars.json` contains `lease_id`, `expires_at`, `ssh_public_key`,
`ubuntu_version`, `cleanup_principal_id`; the lease ID must equal the release run
ID. Adjacent `runner-release.json` contains `version` and `sha256`, with Azure CLI core Container Apps commands (no preview extension). All
inputs/state/evidence stay private.
The unique `warthog-run-<run-id>` label prevents another release using the runner.
JIT registration permits one job, then GitHub deregisters it. Labels alone are not
an access-control boundary: retain main-only environments, fork-run approvals,
trusted source review and per-release approval. A registration without `--run-id`
is only a connectivity rehearsal; it cannot match the normal release job.

Before the first use, the operator creates an empty `runner-subnet.lock` blob in
private `runner-locks` using Entra authentication and `overwrite=false`. Only the
founder and cleanup identity can lease that container; it contains no plans or
state. Every operator command and sweep acquires its renewable 60-second lease.
Mutating subprocesses are stopped on renewal loss. Teardown manually detaches
only its own observed NAT and removes the shared association from local state,
so stale Terraform refresh cannot adopt and delete a newer lease's association.

The independent GitHub-hosted `azure-runner-cleanup.yml` checks expired leases
hourly, detaches only their observed NAT and requests deletion of the entire
lease group. Its identity has no app/secret/provisioning access. Azure's separate
VM auto-shutdown caps compute if the controller disappears. Hosted schedules can
be delayed; **neither shutdown nor a cleanup request proves resources are gone**.
Verify group deletion, subnet detachment, absence of orphan disks/IPs/NAT and
GitHub deregistration after every release. A stopped VM still has billable disk
and networking. Retain private runner diagnostics before removal when needed.

No deployment is permitted merely because the runner is online. Verify private
PostgreSQL DNS/TLS and the least-privilege ownership login after the database is
approved/created. Root CA trust uses Ubuntu's maintained CA bundle and
`sslmode=verify-full`; never open PostgreSQL publicly or disable verification.

References: [GitHub ephemeral runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners),
[JIT registration](https://docs.github.com/en/rest/actions/self-hosted-runners),
[protected Azure Run Command parameters](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command-managed).
