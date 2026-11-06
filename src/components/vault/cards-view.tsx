"use client";

import * as React from "react";
import { CreditCard, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Label } from "@/components/ui/field";
import { SensitiveNotice } from "@/components/ui/sensitive-notice";
import { encryptValue } from "@/client/vault/values";

// E11-S14 — Vault cards view component (brief "Identity vault"; constitution §17
// "No readable card numbers or security codes"; design §4.2 device-held vault).
//
// The cards page is the "Add a card" journey surface. It renders the saved cards
// FROM PROPS and never contradicts the device-held-vault rule:
//   - every saved card is shown as BRAND + LAST FOUR with its nickname and expiry,
//     and NEVER a full number or a security code (the view is only ever handed card
//     METADATA — E11-S12 loadVaultPageData.cards — never the number, its ciphertext
//     or a CVV);
//   - each card gets a Remove control;
//   - an "Add a card" control opens, at that sensitive moment, the plain
//     sensitive-notice explainer AND the explicit "security code is never stored"
//     note, offers a billing-address picker drawn from the vault, and seals the card
//     NUMBER with the vault key ON THE DEVICE so only ciphertext ever leaves.
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app).
// Holding the unlocked vault key, POSTing the sealed submission and the server
// action that stores it are wired by a LATER task; here the controls are native and
// a PROP (`addingCard`) selects the initial state of the add panel, exactly the
// `draft` idiom of the sibling identity / rules / consent / notifications views.
//
// The one off-device obligation — "the number is sealed with the vault key on the
// device before save (only ciphertext leaves), and the security code is never
// stored" — is the exported pure `sealCard` below.
//
// Colour comes from the design tokens (globals.css) — never a raw hex.

// --- prop shapes (declared locally so this client VIEW never couples to the server
// db modules; these mirror VaultPageData.cards / CardMetadata and the vault addresses) --

// A saved card as its owner is handed it back: METADATA ONLY — no number, no
// ciphertext, no security code.
export type SavedCard = {
  id: string;
  userId: string;
  brand: string;
  lastFour: string;
  expiryMonth: number;
  expiryYear: number;
  nickname: string;
  billingAddressId: string;
};

// A vault postal address the add-card billing picker chooses from.
export type VaultAddress = {
  id: string;
  value: string;
};

export type CardsViewProps = {
  cards: ReadonlyArray<SavedCard>;
  billingAddresses: ReadonlyArray<VaultAddress>;
  // Selects the initial state of the "add a card" panel. When true the panel is
  // OPEN (explainer + security-code note + billing picker + card-number field +
  // confirm); defaults to CLOSED.
  addingCard?: boolean;
};

// The card a person enters in the add panel, before the number is sealed on the
// device. Read loosely (the entered form values): a `securityCode` may be present
// but is deliberately NEVER carried into the submission (§17 — no security code in
// any form), and the full `number` is replaced by its sealed ciphertext + last four.
export type CardInput = Record<string, unknown>;

// What leaves the device for the server to store (the NewCard-minus-userId shape the
// server action stores verbatim): the plaintext metadata plus the derived last four
// and ONLY the sealed `v1:` number ciphertext — never the full number, never a
// security code (the server holds no key and stores no security code in any form).
export type CardSubmission = {
  brand: string;
  lastFour: string;
  expiryMonth: number;
  expiryYear: number;
  nickname: string;
  billingAddressId: string;
  numberCiphertext: string;
};

// --- the device-seal step (the one off-device obligation) --------------------------
//
// Seal `input.number` under the in-memory vault key and return the submission the
// server stores. The number is encrypted IN THE BROWSER with the vault key (the
// `v1:` envelope that round-trips under the SAME key via decryptValue); only that
// ciphertext, the derived last four and the plaintext metadata leave the device. The
// full number and any security code are never carried — they are simply never read
// onto the submission.
export async function sealCard(
  vaultKey: Uint8Array<ArrayBuffer>,
  input: CardInput,
): Promise<CardSubmission> {
  const number = String(input.number);
  const numberCiphertext = await encryptValue(vaultKey, number);
  return {
    brand: String(input.brand),
    lastFour: number.slice(-4),
    expiryMonth: Number(input.expiryMonth),
    expiryYear: Number(input.expiryYear),
    nickname: String(input.nickname),
    billingAddressId: String(input.billingAddressId),
    numberCiphertext,
  };
}

// --- plain copy --------------------------------------------------------------------

// The sensitive-moment explainer: adding a card slows down and says HOW the number
// is protected (sealed on the device, never readable by Warthog) — plain words.
const SEAL_EXPLAINER =
  "Adding a card is a sensitive step, so take a moment. Your card number is sealed on your device with your vault key before it is saved — only the locked version ever leaves, and Warthog can never read it.";

// The explicit note that the card security code is never stored (§17).
const SECURITY_CODE_NOTE =
  "Your card's security code (sometimes called the CVV) is never stored — not by Warthog, and not anywhere.";

// The two-digit month and full year the saved card shows (e.g. 11/2029, 03/2028).
function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

// --- card rows ---------------------------------------------------------------------

// A saved card: brand + last four with its nickname and expiry, display only (never
// an editable value field), and a Remove control. The view holds only metadata, so
// the full number and the security code are physically absent here.
function SavedCardRow({ card }: { card: SavedCard }) {
  return (
    <Card className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <CreditCard aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-fg-muted" />
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-fg">{card.nickname}</span>
          <span className="text-sm text-fg-muted">
            {card.brand} •••• {card.lastFour}
          </span>
          <span className="text-sm text-fg-muted">
            Expires {formatExpiry(card.expiryMonth, card.expiryYear)}
          </span>
        </div>
      </div>
      <Button variant="secondary" type="button" aria-label={`Remove ${card.nickname}`}>
        <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
        Remove
      </Button>
    </Card>
  );
}

// The "add a card" panel, shown at the sensitive moment: the plain seal explainer,
// the live fields (card number, a name for it, and expiry), the explicit
// "security code is never stored" note, a billing-address picker drawn from the
// vault, and the explicit confirm. The entered number is sealed on the device
// (sealCard) by the later wiring before anything leaves.
function AddCardPanel({ billingAddresses }: { billingAddresses: ReadonlyArray<VaultAddress> }) {
  const billingId = React.useId();
  return (
    <Card className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-fg">Add a card</h3>

      <Field label="Card number" inputMode="numeric" placeholder="Your card number" />
      <Field label="A name for this card" placeholder="e.g. Everyday spending" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Expiry month" type="number" inputMode="numeric" placeholder="MM" />
        <Field label="Expiry year" type="number" inputMode="numeric" placeholder="YYYY" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={billingId}>Billing address</Label>
        <select
          id={billingId}
          defaultValue={billingAddresses[0]?.id}
          className="min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {billingAddresses.map((address) => (
            <option key={address.id} value={address.id}>
              {address.value}
            </option>
          ))}
        </select>
      </div>

      <p className="text-sm text-fg-muted">{SECURITY_CODE_NOTE}</p>

      <SensitiveNotice explanation={SEAL_EXPLAINER} />
    </Card>
  );
}

export function CardsView({ cards, billingAddresses, addingCard = false }: CardsViewProps) {
  return (
    <section className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold text-fg">Your cards</h1>

      <div className="flex flex-col gap-3">
        {cards.length === 0 ? (
          <p className="text-sm text-fg-muted">No cards saved yet.</p>
        ) : (
          cards.map((card) => <SavedCardRow key={card.id} card={card} />)
        )}

        {addingCard ? (
          <AddCardPanel billingAddresses={billingAddresses} />
        ) : (
          <div className="flex">
            <Button variant="primary" type="button">
              <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
              Add a card
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

export default CardsView;
