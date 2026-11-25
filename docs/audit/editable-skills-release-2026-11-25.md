# Warthog's skills, editable by the person, plus 14 default skills — 25 November 2026

Application source `7bf4df6c286caff9e971b063c91594a1ca643eb4` is live as revision
`warthog--r45519995876a1`. It carries PR #69 and migration 0126.

## Why

The founder asked for three things:
- people should be able to edit or delete Warthog's skills, not just see "Using Warthog" as
  read-only;
- a set of default skills every person gets out of the box;
- to know where the "Building a profile" skill lives.

They chose "Editable, fixed ground rules", and all three sets of defaults (see
docs/adr/editable-builtin-skills.md).

## What shipped

**How each Warthog skill is built.** Every Warthog skill now has three parts:
- **Guidance:** the person can edit it.
- **Rules:** fixed, under "Always".
- **Reference:** what Warthog generates (record kinds, searches, what the agent can read), not
  editable.

**What always reaches agents:**
- **House rules:** `get_context` `instructions` always carries "Using Warthog"'s rules, and its
  guidance only while that skill is given to the agent.
- **Life admin rules:** they move into `instructions` if the person switches "Life admin records"
  off for an agent that can still use Life admin.

**The skills and who gets them:**
- **Defaults:** 10 everyday skills, on to start, and 4 opt-in packs, off to start.
- **Gates:** each is given only to agents with the permissions it needs.

**On the Skills page,** a "Warthog's skills" section lets the person:
- edit a skill;
- switch it on or off;
- choose which agents get it;
- remove it, and restore Warthog's version;
- use Warthog's updated text or keep their own.

**Storage, names and export:**
- **Storage:** migration 0126 `builtin_skills`, where the person's wording is stored as `v1:`
  envelopes.
- **Titles:** Warthog's titles are reserved for new skills of the person's own.
- **Export:** includes the person's edits.

## Verification

- **Before merge:**
  - `npm test`: 7,020 of 7,021 pass. The one failure was the load-sensitive `verifyRecoveryCode`
    timing test, which passes alone.
  - `npm run typecheck` is clean.
  - An independent code review's findings were all fixed (a race, CRLF line breaks, reserved names,
    Life admin rules, offers, wording).
- **Browser check:** 17 of 17 against `next dev` with a Standard agent.
- **Image:** image run 45519532488 built `…@sha256:72118d44…` on `node:22-bookworm-slim@sha256:be979e55…`.
  - linux/amd64, UID 1000, no setuid or setgid, with the deletion-journal label;
  - 97 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching;
  - scan: no advisories added or removed, and none in application dependencies.
- **Production:**
  - **Release run:** [45519995876](https://github.com/Orlev01/warthog/actions/runs/45519995876)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes), the VM
    checked, and private PostgreSQL DNS and TLS confirmed without credentials.
  - **Result:** one healthy replica, 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `da67910c…`).
  - **Probe:** 92/92 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.
  - **On the founder's own account:** a read-only `get_context` returned the house rules under
    "Always" and 12 skills. Paying for something was absent because the agent has no card access;
    Inbox catch-up was present because it can read mail; the packs were off.
