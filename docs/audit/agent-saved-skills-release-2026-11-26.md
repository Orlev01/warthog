# Agents save skills for the person to check — 26 November 2026

Application source `ac31577e8d42c0dd30bdc435fdbfa264a11bba8c` is live as revision
`warthog--r45783723441a1`. It carries PR #73.

## Why

ChatGPT told the founder that the Warthog connection "only exposes the ability to read existing
skills". So a skill written with ChatGPT, Claude or Gemini had to be copied into Warthog by hand.

## What shipped

- **`save_skill`:** an agent sends a whole SKILL.md, or a name, a "use this when" line and
  instructions, plus any extra files.
- **New skills are off until checked.** A new skill arrives switched off, and no agent can use it,
  the saving agent included. It shows in Skills › Library › "Waiting for you" until the person turns
  it on under Agent access.
- **Changes wait for the person.**
  - Until the person checks a skill, the agent that saved it may replace it.
  - After that, an agent's change is kept as a suggestion. The person sees a line diff and chooses
    "Use these changes" or "Keep mine". Agents keep the current text meanwhile.
- **Per-agent switch:** "Let it save skills" in each agent's Skills permissions. It is on unless
  turned off (`resource_controls.skillsWrite`). get_context reports `permissions.resources.skills.write`.
- **Refusals:**
  - a reserved Warthog skill name;
  - a name already in use (the agent is told to pass that skill's id instead);
  - passwords, TFNs, bank account numbers and government IDs;
  - more than 20 unchecked drafts from one agent.

  Card numbers are masked.
- **Website:** the "Memory & skills" card says a skill written with one AI can be saved by that AI
  and isn't used until checked.

Migration 0128 (99 in total) adds `skill_packages.saved_by_agent_id`, `awaiting_check` and the
`skill_suggestions` table. These are additive only, so the old revision kept working during the switch.

## Verification

- **Locally:**
  - `npm test` passed 7,138 of 7,138, and `npm run typecheck` was clean.
  - A Playwright browser check with a virtual passkey passed 29 of 29. It covered saving, a draft
    replaced, Read and check, a suggestion with its diff, both choices, the per-agent switch, 390 px
    dark mode and the console.
- **PR checks:** passed for tree `d0ec55cf` on `node:22-bookworm-slim@sha256:be979e55…`. Main's tree
  after the merge is the same.
- **Image:** image run 45783200913 built `…@sha256:e2324cda…`, reusing the PR's checks.
  - **Image checks:** 99 migrations, 107 catalogue entries and 81 brands; the source hashes match.
  - **Scan:** no package versions changed. The advisory database re-rated CVE-2026-124851 (libzstd1)
    from UNKNOWN to HIGH and added CVE-2026-40558 (perl-base, UNKNOWN). Neither has a fix yet.
- **Production:**
  - **Release run:** [45783723441](https://github.com/Orlev01/warthog/actions/runs/45783723441)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes) and the VM
    verified.
  - **Result:** one healthy replica, 100% traffic, zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `57c7861d…`). LinkedIn is
    still off.
  - **Probe:** 95/95 before. 96/96 after, with a new check for the website's skill sentence.
  - **Runner:** destroyed, and the cleanup check found nothing left.
- **Live:** get_context for the founder's Claude connection reports `skills.write: true`. No test
  skill was saved to the founder's account.
