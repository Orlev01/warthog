# Combined release: app details, CI cost, read guard, approval cards — 17 November 2026

Application source `e8c9781511c4be6faf041376beb8b2337d9cdf18` is live as revision
`warthog--r43951592207a1`. It carries PRs #29–#32. The founder asked for one combined release
after making the repository public again.

## What shipped

- **#29: app details recorded once per app.** Warthog reads current clients' app details from
  `params._meta`, and logs a new app or version only. An unchanged report is skipped for 10 minutes
  per agent ([ADR](../adr/agent-evidence-and-controls.md)).
- **#30: CI cost and Traffic** ([ADR](../adr/ci-cost.md)).
  - Admin Traffic counts Azure's health probes in a Health checks tile of their own, outside the
    requests, page loads, breakdowns and today's hours.
  - CI checks each version of the source once. Test databases are copies of one migrated database.
  - The image build checks its approval reference first.
  - Documentation-only changes run nothing, and Dependabot runs monthly, grouped.
- **#31: read guard** (session warthog-email-agent-safety,
  [ADR](../adr/read-side-protection.md)). Every connector result reaches agents checked:
  - a one-line notice;
  - sign-in codes, reset links and cards hidden;
  - sign-in emails stubbed with an "open in Gmail" link;
  - Gmail is never read raw.
  The MCP server now sends `instructions`. Activity keeps counts only, and the new metric is
  `agent.read_guard`.
- **#32: approval cards show what's going out** (same session,
  [ADR](../adr/approval-card-truth.md)).
  - **Behaviour change:** existing `any_change`, `service_tool` and `specific_tool` rules with a
    recipient condition now also match calendar invitations that include those guests.
  - **New draft and send inputs:** Gmail and Outlook draft/send take plain `to`, `cc`, `bcc`,
    `subject` and `text`, plus `reply.id`.
    - The old `body`, `raw` and `html` input is refused, with a message that names the new fields.
      So an agent with a cached schema recovers on its next call.
    - A send held at deploy that carries the old body fails on approval. Approvals expire after 15
      minutes by default, so at most a handful are affected.

There are no migrations (still 84), and no configuration, hostname, infrastructure, package or
release-workflow changes. Two catalogue entries changed (`ntfy`, `vonage`), and `azure-image.yml`
gained the approval check and a read-only `actions` grant.

## Repository made public

The founder made `Orlev01/warthog` public again on 16 November, so hosted standard runners are free.
- **Secret scan before the switch:** it covered the 25 commits added while the repository was private
  and every branch. Trivy and a pattern scan found nothing; only test addresses and placeholders.
- **What GitHub changed:**
  - it restored the `Orlev01` reviewer rule on `azure-foundation-plan` and `azure-foundation-apply`;
  - outside contributors' pull-request workflows now wait for approval;
  - secret scanning and push protection are on.
- **Unchanged:** the other environments and their `main`-only policies.
- See [azure-delivery.md](../azure-delivery.md).

## Verification

- **Pull requests:** #30, #31 and #32 each passed every check before merging, all merged with merge
  commits.
- **Main:** run [43867590958](https://github.com/Orlev01/warthog/actions/runs/43867590958) ran the
  full checks once on the combined tree `a4b5306`. 6,222 tests passed, with zero failures,
  cancellations or skips.
- **Image:** run [43950975867](https://github.com/Orlev01/warthog/actions/runs/43950975867) reused
  that result for the same tree and base, and published in 2 minutes.
  - The image is `…@sha256:3615967a…`. It carries the exact source label and journal label `v1`.
  - It is linux/amd64, UID 1000, with no setuid/setgid.
  - All 84 migrations, 106 catalogue entries and 80 brands match by hash.
- **New Node base:** the `node:22-bookworm-slim` tag had moved, so the image uses
  `sha256:e9f565d3…` instead of `5ec23b7c…`. The checks ran on that same base.
- **Image scan:** 226 OS advisory pairs and none outside OS packages, against 227 for the previous
  image.
  - Nothing was added.
  - One was removed: CVE-2026-76844 (HIGH) in `zlib1g` `1:1.2.13.dfsg-1`, fixed by the newer base.
- **Production:**
  - Run [43951592207](https://github.com/Orlev01/warthog/actions/runs/43951592207) succeeded. Its
    release job ran 20:42–20:46Z on 16 November.
  - Expected configuration hash: `530ada4a…`, the same as after the
    [previous release](agent-runs-release-2026-11-16.md).
  - Independent inspection: one healthy replica running the exact image, explicit 100% traffic,
    zero old replicas, configuration unchanged apart from image and revision.
- **Production probe:** 62/62, the same website and app checks as the previous release.
- **Runner:** a fresh private lease (11 reviewed creates) was destroyed after the job. The cleanup
  check found no group, resources, grants, subnet NAT or GitHub runner left.

## CI cost, measured

All on public 4-core runners.

| | Runner-minutes |
|---|---|
| PR #30, full checks with database copies | 25.3 |
| PRs #31 and #32, full checks on the earlier workflow | 46.9, 45.5 |
| Main, full checks on the combined tree | 24.9 |
| Main push for #30's merge (reused) | 0.2 |
| Image build (reused, then publish) | 2.3, against about 110 before |

One change now costs one full run, about 25 minutes, instead of three.

## Follow-ups

- **Dependabot security alerts and security updates are off.** Turning them on is the founder's
  repository setting.
- **Branch protection is available again** now the repository is public. If it's turned on, accept
  only push and image-build evidence ([ADR](../adr/ci-cost.md)).
- The deferred items from the [previous release](agent-runs-release-2026-11-16.md) still stand.

## Coordination

- This session was the release operator.
- Session warthog-email-agent-safety owned #31 and #32, and stayed off both branches until they were
  merged.
- Main was frozen from the merges to the release dispatch. Afterwards that session merged #33–#35
  (main `102d77f`) for a following release.
