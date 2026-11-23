# Security and privacy answers on the front door, and "we never sell any data" — 23 November 2026

Application source `e8261f3c991d9f43888d42cdddd3cc9a89f85604` is live as revision
`warthog--r45124440998a1`. It carries PR #46 on top of PR #43's release and its record.

## Why

A prospective user liked Warthog but said: "I just don't know where the data gets stored and what
the permissions are, you know, how am I protected?" The founder asked for questions on the
website's FAQ that make people comfortable with how their data is kept safe, answered in plain
words rather than to that one person.

On review the founder decided: "We never sell any data." They also gave the exact wording for the
staff answer and asked that the public page not mention the admin portal. They then asked to
"merge and run the prod release".

## What shipped (PR #46)

- **Landing FAQ (`/#questions`)** now has two groups.
  - **Using Warthog:** the existing four questions.
  - **Security and privacy:** twelve new questions covering:
    - where data is stored, and how it's protected;
    - passport, licence and card details, and who decides what each agent can see;
    - staff access, email, and selling and AI training;
    - sign-in, the activity record, and households;
    - export and deletion, and who to contact.
  - The intro now mentions keeping information safe and links the privacy policy.
- **Privacy policy (`/privacy#never-sold`):** a new section, "We never sell your information".
  - It says Warthog doesn't sell, rent or trade any information, share it with advertisers or data
    brokers, or use it to train AI models.
  - It says there are no ads or third-party trackers, providers get only what they need, and
    information is disclosed when the law requires it.
  - The narrower Google and SMS statements stay.
- **Records:**
  - The brief records the founder's amendment.
  - `docs/design/public-front-door.md` records the claims the FAQ must never make: end-to-end or
    zero-knowledge, certifications or independent audits, all data in Australia, staff never
    reaching anything beyond the device-encrypted tier, a tamper-proof record, or deletion of
    everything in a set time.
  - A landing test fails if any of those words appear.
- **No other changes.** No migrations (still 90), and no configuration, package or infrastructure
  changes.

## Verification

- **Accuracy.** Every answer was checked against main and the privacy policy:
  - Azure Australia East, with a private database.
  - A per-person data key wrapped in Key Vault.
  - Device-encrypted high-tier details and cards.
  - Default permissions, including after PR #43, and approvals in the app only.
  - Admin reads limited to account facts.
  - Clean email copies, with no AI model and no third-party scripts.
  - Passkeys with user verification, plus step-up.
  - The insert-only, hash-chained activity record with its daily check.
  - Household reads, export and deletion.
- **Locally:**
  - 6,536 of 6,536 tests and a clean typecheck.
  - A browser check at 1440 px (light) and 390 px (dark): the groups render, there is no horizontal
    scroll, and `#never-sold` lands on the new section.
- **PR checks.** [45121842828](https://github.com/Orlev01/warthog/actions/runs/45121842828) passed
  on tree `b9d86fc`. Main's
  [45122692083](https://github.com/Orlev01/warthog/actions/runs/45122692083) passed on the merge
  commit `a955bc1`.
- **Image.**
  - **Run [45123309572](https://github.com/Orlev01/warthog/actions/runs/45123309572)** ran the full
    checks on main's tree `ab46394` (the merge plus PR #43's release record). The image is
    `…@sha256:52c365fd…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, and the deletion-journal label. The
    source, lockfile, 90 migrations, 107 catalogue entries and 81 brand marks all match the source
    hashes.
  - **Scan:** no advisories in application dependencies, and none added or removed against the
    PR #43 image.
- **Production.**
  - **Run:** [45124440998](https://github.com/Orlev01/warthog/actions/runs/45124440998) succeeded
    on a fresh private B2als_v2 runner. The runner's plan was reviewed (11 creates, no deletes).
    Before it was registered for this run only, the live VM was checked and private PostgreSQL DNS
    and TLS were confirmed.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `dcc213ef…`.
  - **Probe:** 71/71 after the release. Two new checks cover the landing page's Security and
    privacy group and the privacy page's no-sale section. Before the release it was 69/71, failing
    only those two.
  - **Runner:** destroyed. The cleanup check found no group, resources, grants, subnet NAT or
    GitHub runner left.

## Follow-ups

- **Next releases:** PRs #47 (security-highs) and #48 (Life admin redesign) are next, released by
  their own session. #47 also edits the privacy policy's deletion and retention wording. Its
  rebase over this release was clean and keeps the no-sale section.
- **Company sale:** the no-sale commitment has no exception for a company sale or merger. Add one to
  the policy if the founder wants it.
