"use client";

import * as React from "react";
import { CreditCard, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { encryptValue } from "@/client/vault/values";
import { AddCardFlow } from "./add-card-flow";
import { VaultNav } from "./vault-nav";

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
// This is the render-testable, prop-driven VIEW (a Client Component in the app). The
// live on-device "Add a card" flow — holding the unlocked vault key, sealing the number
// and POSTing the sealed submission — is E11-S19's <AddCardFlow/>, which this view mounts
// for the add panel (its device behaviour is pinned by add-card-flow.test.tsx). A PROP
// (`addingCard`) selects the panel's initial open/closed state, exactly the `draft` idiom
// of the sibling identity / rules / consent / notifications views.
//
// The one off-device obligation — "the number is sealed with the vault key on the
// device before save (only ciphertext leaves), and the security code is never
// stored" — is the exported pure `sealCard` below, which the flow calls.
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
  // The name on the card (review fix W6), or null for a card saved before names were kept.
  // Optional so a prop-driven render that predates it still type-checks.
  cardholderName?: string | null;
  billingAddressId: string;
};

// A vault postal address the add-card billing picker chooses from.
export type VaultAddress = {
  id: string;
  value: string;
};

// The page's addCard server action that stores a sealed submission (the device flow's
// output). Reports success or a refusal reason; never a silent success.
export type AddCardAction = (
  submission: CardSubmission,
) => Promise<{ ok: boolean; reason?: string }>;

export type CardsViewProps = {
  cards: ReadonlyArray<SavedCard>;
  billingAddresses: ReadonlyArray<VaultAddress>;
  // Selects the initial state of the "add a card" panel. When true the panel is
  // OPEN (explainer + security-code note + billing picker + card-number field +
  // confirm); defaults to CLOSED.
  addingCard?: boolean;
  // The person's saved name from About you, which pre-fills the add form's "Name on card"
  // (review fix W6). Empty or omitted when they have not saved one.
  defaultCardholderName?: string;
  // The submit seam the now-live on-device add flow (AddCardFlow) posts to. The page
  // always supplies the real server action; a prop-driven render (a preview, a render
  // test) may omit it, in which case nothing is stored.
  addCard?: AddCardAction;
  // The page's removeCard server action (review fix G12 — Remove used to be a dead
  // button). Omitted by a prop-driven render, in which case nothing is removed.
  removeCard?: RemoveCardAction;
};

// The page's removeCard server action: member-scoped to the session person server-side.
export type RemoveCardAction = (input: { cardId: string }) => Promise<{ ok: boolean; reason?: string }>;

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
  // The name on the card — printed on it, so plaintext metadata like the expiry (W6).
  cardholderName: string;
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
    cardholderName: typeof input.cardholderName === "string" ? input.cardholderName.trim() : "",
    billingAddressId: String(input.billingAddressId),
    numberCiphertext,
  };
}

// Render-only defaults for the optional submit seams (above): the page always wires the
// real addCard / removeCard server actions, so these are reached only by a prop-driven
// render.
const noopAddCard: AddCardAction = async () => ({ ok: true });
const noopRemoveCard: RemoveCardAction = async () => ({ ok: true });

// --- removing a saved card (review fix G12) ------------------------------------------
//
// A framework-free controller behind each card's Remove: ask (a confirm step names what
// will happen), then confirm (calls removeCard once with that card's id — a double tap
// never sends twice) or back out. Every outcome is reported in plain words.

export type RemoveCardStage = "idle" | "confirming" | "working" | "removed" | "error";

export interface RemoveCardState {
  readonly stage: RemoveCardStage;
  readonly error?: string;
}

export interface RemoveCardController {
  getState(): RemoveCardState;
  ask(): void;
  cancel(): void;
  confirm(): Promise<void>;
}

const REMOVE_FAILED_COPY = "We couldn't remove that card just now. Please try again.";

export function createRemoveCardFlow(deps: {
  cardId: string;
  removeCard: RemoveCardAction;
  onChange?: () => void;
}): RemoveCardController {
  let state: RemoveCardState = { stage: "idle" };
  function set(next: RemoveCardState): void {
    state = next;
    deps.onChange?.();
  }
  async function confirm(): Promise<void> {
    if (state.stage !== "confirming") return;
    set({ stage: "working" });
    try {
      const result = await deps.removeCard({ cardId: deps.cardId });
      set(result.ok ? { stage: "removed" } : { stage: "error", error: REMOVE_FAILED_COPY });
    } catch {
      set({ stage: "error", error: REMOVE_FAILED_COPY });
    }
  }
  return {
    getState: () => state,
    ask: () => set({ stage: "confirming" }),
    cancel: () => set({ stage: "idle" }),
    confirm,
  };
}

// The two-digit month and full year the saved card shows (e.g. 11/2029, 03/2028).
function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

// --- card rows ---------------------------------------------------------------------

// A saved card: brand + last four with its nickname and expiry, display only (never
// an editable value field), and a live Remove (with a confirm step). The view holds only
// metadata, so the full number and the security code are physically absent here.
function SavedCardRow({ card, removeCard }: { card: SavedCard; removeCard: RemoveCardAction }) {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<RemoveCardController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createRemoveCardFlow({ cardId: card.id, removeCard, onChange: () => forceUpdate() });
  }
  const flow = flowRef.current;
  const { stage, error } = flow.getState();

  if (stage === "removed") {
    return (
      <p role="status" className="text-sm text-fg-muted [overflow-wrap:anywhere]">
        {card.nickname} was removed from your vault.
      </p>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="flex min-w-0 items-start gap-3">
          <CreditCard aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-fg-muted" />
          <div className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
            <span className="font-medium text-fg">{card.nickname}</span>
            <span className="text-sm text-fg-muted">
              {card.brand} •••• {card.lastFour}
            </span>
            <span className="text-sm text-fg-muted">
              Expires {formatExpiry(card.expiryMonth, card.expiryYear)}
            </span>
          </div>
        </div>
        {stage === "idle" || stage === "error" ? (
          <Button
            variant="secondary"
            type="button"
            className="shrink-0"
            aria-label={`Remove ${card.nickname}`}
            onClick={() => flow.ask()}
          >
            <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
            Remove
          </Button>
        ) : null}
      </div>
      {stage === "confirming" || stage === "working" ? (
        <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-muted p-3">
          <p className="text-sm text-fg">
            Remove {card.nickname} ({card.brand} •••• {card.lastFour})? It is deleted from your
            vault, and agents can no longer ask to use it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              type="button"
              disabled={stage === "working"}
              onClick={() => {
                void flow.confirm();
              }}
            >
              {stage === "working" ? "Removing…" : "Yes, remove it"}
            </Button>
            <Button variant="secondary" type="button" disabled={stage === "working"} onClick={() => flow.cancel()}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

export function CardsView({
  cards,
  billingAddresses,
  addingCard = false,
  defaultCardholderName,
  addCard,
  removeCard,
}: CardsViewProps) {
  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-fg">Your cards</h1>
        <VaultNav current="cards" />
      </div>

      <div className="flex flex-col gap-3">
        {cards.length === 0 ? (
          <p className="text-sm text-fg-muted">No cards saved yet.</p>
        ) : (
          cards.map((card) => (
            <SavedCardRow key={card.id} card={card} removeCard={removeCard ?? noopRemoveCard} />
          ))
        )}

        {/* The live on-device add flow: closed it is the "Add a card" control, open it
            seals the number under the vault key and submits only ciphertext + metadata. */}
        <AddCardFlow
          billingAddresses={billingAddresses}
          defaultCardholderName={defaultCardholderName}
          addCard={addCard ?? noopAddCard}
          initialOpen={addingCard}
        />
      </div>
    </section>
  );
}

export default CardsView;
