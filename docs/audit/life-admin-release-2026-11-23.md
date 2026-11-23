# Life admin: a typed profile, life areas, bookings and a hand-over journal — 23 November 2026

Application source `9edf3ec623daeac144881df66f37a0eaa5dd609b` is live as revision
`warthog--r45106611024a1`. It carries PR #44.

## Why

The founder wanted life admin that any agent can answer from without searching their email again.
That means the motorcycle's rego and insurer, the health fund, super, subscriptions and bookings.
It also had to be open-ended, since people's lives differ.

The founder also wanted any agent, from any provider, to be able to pick up live work with its
reasoning. The case that prompted this: Instinct handled the motorcycle insurance, and Muse
finished it with none of that context.

They then asked to "open a PR … merge the PR and then … deploy to production".

## What shipped (PR #44: two commits)

- **`949cd81`: life admin as a typed profile** ([ADR](../adr/life-admin-profile.md)).
  - **Typed records** that the person's own agent fills in from email. Warthog never reads mail or
    calls a model.
  - **Agents suggest; the person confirms.** An agent's change to a confirmed record waits for the
    person to accept it.
  - **No copies.** Saving the same thing again updates it instead of adding a copy.
  - **Values Warthog never keeps** are refused.
  - **A built-in "Life admin records" skill.**
  - **Fixes** from the six-perspective review ([review](life-admin-profile-review-2026-11-23.md)).
- **`e563647`: life areas, bookings and a hand-over journal**
  ([ADR](../adr/life-admin-journal.md)).
  - **A per-person catalogue:** 20 built-in categories in 8 life areas, hidden until used, plus
    categories agents suggest in a validated generic shape.
  - **Bookings and cases,** each live or finished, worked out when read.
  - **Generic anchors:** any kind can be a thing that others belong to.
  - **An append-only journal on every item,** handled automatically, with take-over between agents
    and a one-line hand-over for each live item in `get_context`.
  - **UI:** Upcoming and Bookings tabs, and an item page.
  - **Links:** Activity links each save to the items it touched (`?record=`), and tasks can be
    about an item.
- **Migrations.** 0117 (`life_admin_records`) and 0118 (categories, journal, activity links,
  `tasks.record_id`) only add tables and columns. That makes 89.
- **No other changes.** No configuration, package or infrastructure changes. Still 16 core MCP
  tools.

## Verification

- **Locally:**
  - 6,508 of 6,508 tests, typecheck clean, production build and boot passed.
  - A browser check with a virtual passkey and a dev agent: Your things, Upcoming, Bookings (live
    and past), the item page and Home. It covered 1280 px, 390 px (no horizontal scroll) and dark
    mode, with no console errors.
- **PR checks.** Run 45105287675 passed every check: the full suite on Node 22 with real PostgreSQL
  16 in four shards, delivery guards and Terraform. The tree is `6e96cf7d…` on
  `node:22-bookworm-slim@sha256:e9f565d3…`. The merge kept that tree, and main's run 45106200482
  reused the result.
- **Image.**
  - **Run 45106261926** reused the checks. The image is `…@sha256:117a7790…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, and the deletion-journal label. The
    source, lockfile, 89 migrations, 107 catalogue entries and 81 brand marks all match the source
    hashes.
  - **Scan:** no advisories in application dependencies. Against the 20 November image, the OS
    entries differ only by the advisory database: a libc entry re-scored from UNKNOWN to LOW, and
    seven new UNKNOWN `libseccomp2` temporary entries. The Node base digest is the same.
- **Production.**
  - **Run:** [45106611024](https://github.com/Orlev01/warthog/actions/runs/45106611024) succeeded
    on a fresh private B2als_v2 runner. The runner's plan was reviewed (11 creates, no deletes).
    Before it was registered for this run only, the live VM was checked and private PostgreSQL DNS
    and TLS 1.3 were confirmed.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `f4b60bbf…`.
  - **Health:** the database reports ok, so migrations 0117 and 0118 are applied.
  - **Probe:** 66/66, including 4 new Life admin checks. The Bookings tab, the item page (a uuid,
    and one that isn't a uuid) and `/activity?record=` all ask a signed-out visitor to sign in.
    Before the release, the item page was a 404.
  - **Runner:** destroyed. The cleanup check found no group, resources, grants, subnet NAT or
    GitHub runner left.

## Follow-ups

- **PR #43** (`claude/default-services`) also adds `0117_default_services.sql`. Renumber it (to
  0119) before it merges. Git reports no conflict because the filenames differ.
- **Still open from the review:** the High OAuth consent-swap finding.
- **Known limits:**
  - one mail account per service per agent;
  - PDFs aren't read;
  - no recurrence;
  - no parcels.
