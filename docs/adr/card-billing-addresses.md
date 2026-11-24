# Card billing addresses kept with the card

Decision date: 24 November 2026.

A person reported: "I can't add an address to cards… I added it via the personal details section,
which is not my billing address." A card's billing address could only be an About you postal
address, so the list on a new card was empty until they saved one there, and agents then read that
address as an everyday detail. Two more faults surfaced: adding a card never checked that the
reference was the person's own postal address, and "Make protected" left cards pointing at a row
that was gone, so the account could not import its own export.

## Decision

1. **A separate table, failing closed.** Card-only addresses live in `card_billing_addresses`
   (migration 0123), DEK-encrypted. Nothing that lists identity fields (get_context, About you,
   per-agent detail toggles, moving) sees them; an agent gets one only in an approved card release.
2. **Two typed references.** `cards.billing_address_id` is still an owner's postal identity field;
   `cards.billing_entry_id` is a card-only address, by a composite foreign key on (user_id, id)
   checked at commit. A card has one or neither, never both.
3. **Ownership and kind are checked on every write** (`src/server/vault/card-billing.ts`).
4. **It exists only while a card uses it**: deleted with its last card or when that card moves to
   another address. Vault reset erases them with the cards.
5. **Export and import** carry them in `profile.cardBillingAddresses` (with ids in the device
   export). Import creates one, with a new id, only when a restored card uses it. A reference the
   file doesn't carry imports as "no billing address"; a repeated id, a card with both references
   or a malformed value still rejects the whole import.
6. **"Make protected" refuses a postal address a card uses.**

## Rejected alternatives

- **A new identity_fields kind** fails open: get_context lists every kind under "All my details".
- **A DEK-encrypted column on cards** breaks the cards store's boundary (it does no crypto).
- **Sealing it with the device vault key** would need an unlock just to view or change it.

## Consequences

- An older build can't import a new export when a card has a card-only address or none.
- References cleared by migration 0123 show "No billing address yet" until the person picks one.
- Brief "Saved cards" is amended; technical-design.md §4.1 lists the table;
  [device-local portability](device-local-portability.md) is amended for missing references.
