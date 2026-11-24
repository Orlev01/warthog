# Card billing addresses, and Life admin's Add tab — 24 November 2026

Application source `49a0af82fde1aad96c0e15990599f0507dfc7885` is live as revision
`warthog--r45311099130a1`. It carries PR #56 (card billing addresses) and PR #57 (the Life admin
Add tab), released together at the founder's request.

## Why

- **PR #56.** A member reported: "I can't add an address to cards… I added it via the personal
  details section, which is not my billing address." The billing address on a new card was a
  dropdown of About you postal addresses only: empty, and doing nothing, until one was saved there,
  and saving one made it an everyday detail agents read
  ([ADR](../adr/card-billing-addresses.md)).
- **PR #57.** The founder asked to keep what already has data apart from what is still to fill in:
  "Fill in the rest" and "Add something yourself" moved off Records to a tab of their own, named
  Add ([ADR amendment](../adr/life-admin-profile.md)).

## What shipped

**PR #56: a card's billing address kept with the card**

- **Storage.** New table `card_billing_addresses` (migration 0123), encrypted with the person's
  data key. A card points at one of the person's About you postal addresses or at a card-only
  address (a composite foreign key on the owner, checked at commit), never both. A card-only address
  exists only while a card uses it.
  - The migration clears card references that were never the owner's own postal address (already
    broken), keeping an uppercase form of a good one, lowercased.
- **Never an everyday detail.** Nothing that lists identity fields (get_context, About you, the
  per-agent detail choices) sees a card-only address; an agent receives it only in a card release
  the person approves.
- **Screens.**
  - Add a card: the person's addresses with where each comes from, plus "A different billing
    address". Nothing is preselected, and with nothing saved the field shows straight away.
  - Saved cards show their billing address with Change, or "No billing address yet" with Add one.
  - The Inbox "Add a card" link comes back to the request.
- **Checks.** Adding a card now checks the billing reference is the person's own address of the
  right kind. "Make protected" is refused while a card uses that postal address. A refused card
  save is reported instead of crashing the action.
- **Export, import, reset.** Exports carry card-only addresses; import re-links each card, and a
  reference the file doesn't carry becomes "no billing address" instead of failing the import. Reset
  erases card-only addresses.
- **Inbox passkey unlock.** The release used only the vault's unlabelled envelope, so for a vault
  set up on a device (its envelope saved per passkey) "Approve and release" with a passkey always
  failed. It now uses the envelope of the passkey that answered.

**PR #57: Life admin's Add tab**

- **Tabs.** Records | Add | Upcoming | History | Tasks. Records keeps what's on file, with "Add a
  record"; Add holds Fill in the rest (with Not for me) and Add something yourself.
- **Which tab opens.** Records, or Add while nothing is on file. The address names the tab shown
  whenever it isn't the default, and the shared tabs show the page's tab on load, so the server and
  the browser agree. Older addresses and reminder links map as before.
- **Links between tabs** open Add in place, so half-typed work in other tabs survives.

**Migrations:** 0123, making 94.

## Verification

- **Locally:**
  - #56: 6,769 of 6,769 after rebasing on #52 and #55, with a clean typecheck and build;
  - #57: 6,729 of 6,729, with a clean typecheck.
- **Browser checks against `next dev`** (Playwright, virtual passkey with PRF, 390px and 1280px,
  light and dark):
  - #56 on a fresh account with no postal address:
    - request_card, then the Inbox "Add a card" link carries the way back;
    - the billing field shows directly, an empty one is flagged on the field with focus moved
      there, and the card saves;
    - approving with the passkey releases the card, and collect_release returns the typed billing
      address;
    - the address is not in get_context or About you;
    - Change to an About you address deletes the typed one; Change back to a new typed address works.
  - #57: Life admin opens on Add with nothing on file. Records then holds only what's on file.
    Not for me returns to Add, a new record lands on Records, `?add=` without a tab and old
    `#new-record` links open Add, and a half-typed task survives "Add a record".
- **Code review:** both PRs reviewed; the fixes are in `728fd94` and `843c44e`. Follow-ups are
  listed on PR #56.
- **PR checks:** passed on PostgreSQL 16 for each PR.
- **Image:** run 45308702263 ran the full checks on the merged tree (`2ad981f1`). The image is
  `…@sha256:b4b7f607…`:
  - linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label;
  - 94 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching;
  - scan: no advisories in application dependencies, and none added or removed against the PRs
    #52 and #55 image.
- **Production:**
  - **A first run was refused safely.** Run
    [45309983621](https://github.com/Orlev01/warthog/actions/runs/45309983621) was dispatched with
    the bare `sha256:…` digest instead of the full repository reference. The job refused it at its
    first check, before stopping anything. Production was confirmed unchanged (same revision,
    configuration hash and traffic). Its runner was destroyed and the cleanup check found nothing
    left.
  - **Run:** [45311099130](https://github.com/Orlev01/warthog/actions/runs/45311099130) succeeded
    on a fresh private runner.
    - Its plan was reviewed: 11 creates, no deletes.
    - The VM was checked.
    - Private PostgreSQL DNS and TLS were confirmed without credentials.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `abf3f73a…`.
  - **Probe:** 87/87 before and after. Three new checks confirm that signed-out visitors to the
    Add tab, a kind to add, and the Cards return path are sent to sign-in.
  - **Runner:** destroyed, and the cleanup check found nothing left.

## Not checked in production

- **The 0123 clean-up in real data.** Covered by migration tests for every case; no database
  credentials were used. Cards whose billing reference was already broken now show "No billing
  address yet".
- **Adding a card and approving a release in a real account.** This waits on the member who
  reported the problem (or the founder) adding a card.
