# OAuth consent bound to the request on screen — 23 November 2026

Application source `e3a6015f382b697288019093b191e7361ba3198f` is live as revision
`warthog--r45118618704a1`. It carries PR #45.

## Why

The 23 November review ([review](life-admin-profile-review-2026-11-23.md)) found a **High**
"consent swap".

**The flaw.** The consent decision acted on whichever pending request the `__Host-wh_consent`
cookie named when Approve was submitted.

**The attack.** A hostile page could:
1. show Claude's real consent screen in a popup;
2. load its own `/oauth/authorize` at the top level, which replaces the cookie;
3. wait for the person to press Approve on Claude's screen, which then issued a code to the
   attacker's client.

After PR #44 was released, the founder asked to "continue for me", and then to "merge and release
all three" (PR #45 and the two that follow it).

## What shipped (PR #45)

- **The consent form is bound to the request it shows.**
  - It carries a domain-separated SHA-256 tag of the pending handle it rendered.
  - Approve and Deny act only while the cookie still names that request. Otherwise nothing is
    consumed or connected, and the person sees the request now in progress with a plain notice.
- **Approving asks the person to confirm it's them.**
  - A step-up within 5 minutes is required, as making an access key already does. A passkey
    sign-in counts.
  - The screen confirms and connects without a second Approve.
  - Nothing is consumed while it waits.
  - Deny never needs it.
- **No other changes.** No migrations (still 89), and no configuration, package or infrastructure
  changes.

## Verification

- **Locally:**
  - 6,512 of 6,512 tests, typecheck clean, production build and boot passed.
  - A real-Chromium check with a virtual passkey covered: the swap, Approve after 5 minutes
    showing "Confirm it's you" and then connecting, the code exchange, `get_context` over `/mcp`,
    and hostile authorize requests still getting the 400 page.
- **PR checks.** [45114376025](https://github.com/Orlev01/warthog/actions/runs/45114376025) passed
  on tree `65bafde`, including the full suite on PostgreSQL 16. The merge commit has the same tree.
- **Image.**
  - **Run 45118257586** reused the checks. The image is `…@sha256:d90e8b36…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, and the deletion-journal label. The
    source, lockfile, 89 migrations, 107 catalogue entries and 81 brand marks all match the source
    hashes.
  - **Scan:** no advisories in application dependencies, and no change against the PR #44 image.
- **Production.**
  - **Run:** [45118618704](https://github.com/Orlev01/warthog/actions/runs/45118618704) succeeded
    on a fresh private B2als_v2 runner. The runner's plan was reviewed (11 creates, no deletes).
    Before it was registered for this run only, the live VM was checked and private PostgreSQL DNS
    and TLS were confirmed.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `0c389aa6…`.
  - **Health:** the database reports ok.
  - **Probe:** 69/69, including 3 new consent checks: `/oauth/consent` asks a signed-out visitor to
    sign in, and an empty or hostile `/oauth/authorize` gets Warthog's own 400 page, never a
    redirect.
  - **Runner:** destroyed. The cleanup check found no group, resources, grants, subnet NAT or
    GitHub runner left.

## Follow-ups

- **PR #43** (`claude/default-services`) has been rebased onto this release by its own session.
- **Still open from the review:** two Highs, being fixed on `claude/security-highs`: expensive key
  work before rate limiting, and email addresses that outlive account deletion.
