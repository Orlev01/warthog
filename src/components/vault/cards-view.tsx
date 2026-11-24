"use client";

import * as React from "react";
import { CreditCard, Pencil, Trash2 } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { encryptValue } from "@/client/vault/values";
import { AddCardFlow } from "./add-card-flow";
import {
  BILLING_GONE_COPY,
  BillingAddressChoice,
  billingSelection,
  initialBillingKey,
  type BillingChoiceView,
  type BillingSelection,
} from "./billing-address-choice";

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
  // The billing reference: an About you postal address id or a card-only address id (never both).
  billingAddressId?: string | null;
  billingEntryId?: string | null;
  // The billing address it resolves to (docs/adr/card-billing-addresses.md), or null when the card
  // has none yet. Optional so a prop-driven render that predates it still type-checks.
  billing?: { text: string; source: "postal" | "billing" } | null;
};

// An address the card screens offer as a billing address: one of the person's About you postal
// addresses or one kept with their cards.
export type VaultAddress = BillingChoiceView;

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
  // The page's changeBillingAddress server action. Omitted by a prop-driven render.
  changeBillingAddress?: ChangeBillingAction;
  // A request in the Inbox the person came from to add a card ("Back to your request").
  returnTo?: string;
};

// The page's changeBillingAddress server action: member-scoped to the session person server-side.
export type ChangeBillingAction = (input: {
  cardId: string;
  billing: BillingSelection;
}) => Promise<{ ok: boolean; reason?: string }>;

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
  // The card's billing address: a saved address the person chose or one they typed
  // (docs/adr/card-billing-addresses.md). Not sealed with the vault key: like a postal address it
  // is kept encrypted under the person's data key on the server.
  billing: BillingSelection;
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
    billing: billingOf(input),
    numberCiphertext,
  };
}

// The billing choice on the entered card; a bare `billingAddressId` (an About you address id) is
// the older form.
function billingOf(input: CardInput): BillingSelection {
  const billing = input.billing as BillingSelection | undefined;
  if (billing && typeof billing === "object") {
    if (billing.source === "new") return { source: "new", value: String(billing.value) };
    return { source: billing.source === "billing" ? "billing" : "postal", id: String(billing.id) };
  }
  return { source: "postal", id: String(input.billingAddressId) };
}

// Render-only defaults for the optional submit seams (above): the page always wires the
// real addCard / removeCard server actions, so these are reached only by a prop-driven
// render.
const noopAddCard: AddCardAction = async () => ({ ok: true });
const noopRemoveCard: RemoveCardAction = async () => ({ ok: true });
const noopChangeBilling: ChangeBillingAction = async () => ({ ok: true });

// --- changing a saved card's billing address (docs/adr/card-billing-addresses.md) -----
//
// A framework-free controller behind each card's "Change": open with the card's current address
// chosen, pick another or type one, save (calls changeBillingAddress once — a double tap never
// sends twice) or keep the current one. Every outcome is reported in plain words.

export type ChangeBillingStage = "idle" | "editing" | "working" | "saved" | "error";

export interface ChangeBillingState {
  readonly stage: ChangeBillingStage;
  readonly key: string;
  readonly newValue: string;
  readonly error?: string;
}

export interface ChangeBillingController {
  getState(): ChangeBillingState;
  open(): void;
  cancel(): void;
  choose(key: string): void;
  setNewValue(value: string): void;
  save(): Promise<void>;
  setChoices(choices: readonly BillingChoiceView[]): void;
  // The card's address as the page now has it (after a save, the refresh moves it on).
  setCurrent(current: { source: "postal" | "billing"; id: string } | null): void;
}

const CHANGE_FAILED_COPY = "We couldn't change the billing address just now. Please try again.";

export function createChangeBillingFlow(deps: {
  cardId: string;
  current?: { source: "postal" | "billing"; id: string } | null;
  choices: readonly BillingChoiceView[];
  changeBillingAddress: ChangeBillingAction;
  onChange?: () => void;
}): ChangeBillingController {
  let choices = deps.choices;
  let current = deps.current ?? null;
  let state: ChangeBillingState = { stage: "idle", key: "", newValue: "" };
  function set(next: Partial<ChangeBillingState>): void {
    state = { ...state, ...next };
    deps.onChange?.();
  }
  async function save(): Promise<void> {
    if (state.stage !== "editing" && state.stage !== "error") return;
    const picked = billingSelection(state.key, state.newValue, choices);
    if (!picked.ok) {
      set({ stage: "error", error: picked.error });
      return;
    }
    set({ stage: "working", error: undefined });
    try {
      const result = await deps.changeBillingAddress({ cardId: deps.cardId, billing: picked.selection });
      if (result.ok) set({ stage: "saved" });
      else set({ stage: "error", error: result.reason === "billing_address_not_found" ? BILLING_GONE_COPY : CHANGE_FAILED_COPY });
    } catch {
      set({ stage: "error", error: CHANGE_FAILED_COPY });
    }
  }
  return {
    getState: () => state,
    open: () => set({ stage: "editing", key: initialBillingKey(choices, current), newValue: "", error: undefined }),
    cancel: () => set({ stage: "idle", error: undefined }),
    choose: (key) => set({ key, error: undefined, stage: state.stage === "error" ? "editing" : state.stage }),
    setNewValue: (value) => set({ newValue: value }),
    save,
    setChoices: (next) => {
      choices = next;
    },
    setCurrent: (next) => {
      current = next;
    },
  };
}

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

// Whether removing this card also deletes its billing address: it is kept with the cards only and
// no other card uses it.
export function removingDeletesBillingAddress(card: SavedCard, billingAddresses: ReadonlyArray<VaultAddress>): boolean {
  if (!card.billingEntryId) return false;
  const entry = billingAddresses.find((a) => a.source === "billing" && a.id === card.billingEntryId);
  return entry !== undefined && (entry.usedBy?.length ?? 0) <= 1;
}

// The two-digit month and full year the saved card shows (e.g. 11/2029, 03/2028).
function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

// --- card rows ---------------------------------------------------------------------

// A saved card: brand + last four with its nickname and expiry, display only (never
// an editable value field), and a live Remove (with a confirm step). The view holds only
// metadata, so the full number and the security code are physically absent here.
function SavedCardRow({
  card,
  removeCard,
  changeBillingAddress,
  billingAddresses,
}: {
  card: SavedCard;
  removeCard: RemoveCardAction;
  changeBillingAddress: ChangeBillingAction;
  billingAddresses: ReadonlyArray<VaultAddress>;
}) {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<RemoveCardController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createRemoveCardFlow({ cardId: card.id, removeCard, onChange: () => forceUpdate() });
  }
  const flow = flowRef.current;
  const { stage, error } = flow.getState();
  const current = card.billingEntryId
    ? { source: "billing" as const, id: card.billingEntryId }
    : card.billingAddressId
      ? { source: "postal" as const, id: card.billingAddressId }
      : null;
  const changeRef = React.useRef<ChangeBillingController | null>(null);
  if (changeRef.current === null) {
    changeRef.current = createChangeBillingFlow({
      cardId: card.id,
      current,
      choices: billingAddresses,
      changeBillingAddress,
      onChange: () => forceUpdate(),
    });
  }
  const change = changeRef.current;
  change.setChoices(billingAddresses);
  change.setCurrent(current);
  const changing = change.getState();
  const deletesAddress = removingDeletesBillingAddress(card, billingAddresses);

  if (stage === "removed") {
    return (
      <li className="flex min-w-0 flex-col gap-1 border-b border-line py-4 last:border-0">
        <p role="status" className="text-sm text-fg-muted [overflow-wrap:anywhere]">
          {card.nickname} was removed from your vault.
        </p>
      </li>
    );
  }

  return (
    <li className="flex min-w-0 flex-col gap-3 border-b border-line py-4 last:border-0">
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
            {card.billing !== undefined ? (
              <span className="line-clamp-2 text-sm text-fg-muted">
                {card.billing ? `Billing address: ${card.billing.text}` : "No billing address yet"}
              </span>
            ) : null}
          </div>
        </div>
        {stage === "idle" || stage === "error" ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {card.billing !== undefined && (changing.stage === "idle" || changing.stage === "saved") ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={card.billing ? `Change the billing address for ${card.nickname}` : `Add a billing address for ${card.nickname}`}
                onClick={() => change.open()}
              >
                <Pencil aria-hidden={true} className="h-4 w-4 shrink-0" />
                {card.billing ? "Change" : "Add one"}
              </Button>
            ) : null}
            <Button
              variant="danger"
              size="sm"
              type="button"
              aria-label={`Remove ${card.nickname}`}
              onClick={() => flow.ask()}
            >
              <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {changing.stage === "editing" || changing.stage === "working" || changing.stage === "error" ? (
        <form
          aria-label={`Change billing address for ${card.nickname}`}
          className="flex flex-col gap-3 rounded-card bg-surface-muted p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void change.save();
          }}
        >
          <BillingAddressChoice
            choices={billingAddresses}
            selectedKey={changing.key}
            newValue={changing.newValue}
            onSelect={(key) => change.choose(key)}
            onNewValue={(value) => change.setNewValue(value)}
            error={changing.error}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              type="submit"
              aria-disabled={changing.stage === "working" || undefined}
              aria-busy={changing.stage === "working" || undefined}
            >
              {changing.stage === "working" ? "Saving…" : "Save billing address"}
            </Button>
            <Button
              variant="ghost"
              type="button"
              aria-disabled={changing.stage === "working" || undefined}
              onClick={() => {
                if (changing.stage !== "working") change.cancel();
              }}
            >
              Keep the current one
            </Button>
          </div>
        </form>
      ) : null}
      {changing.stage === "saved" ? (
        <p role="status" className="text-sm text-fg">
          Billing address updated.
        </p>
      ) : null}
      {stage === "confirming" || stage === "working" ? (
        <div className="flex flex-col gap-3 rounded-card bg-surface-muted p-4">
          <p className="text-sm text-fg">
            Remove {card.nickname} ({card.brand} •••• {card.lastFour})? It is deleted from your
            vault, and agents can no longer ask to use it.{deletesAddress ? " Its billing address is deleted too." : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger-solid"
              type="button"
              aria-disabled={stage === "working" || undefined}
              aria-busy={stage === "working" || undefined}
              onClick={() => {
                // The flow ignores a second press while it's removing.
                void flow.confirm();
              }}
            >
              {stage === "working" ? "Removing…" : "Yes, remove it"}
            </Button>
            <Button
              variant="ghost"
              type="button"
              aria-disabled={stage === "working" || undefined}
              onClick={() => {
                if (stage !== "working") flow.cancel();
              }}
            >
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
    </li>
  );
}

export function CardsView({
  cards,
  billingAddresses,
  addingCard = false,
  defaultCardholderName,
  addCard,
  removeCard,
  changeBillingAddress,
  returnTo,
}: CardsViewProps) {
  // The page heading band, then one panel: the saved cards as divider rows (or an inline
  // empty state) with the add flow closing the panel. The shell's section tabs (About you /
  // Cards) are the Vault's one tab row.
  return (
    <>
      <WorkspaceHeading
        title="Cards"
        description="Cards your agents can ask to use. You approve every purchase, and only each card's last four digits are shown."
      />
      <WorkspacePanel
        title="Saved cards"
        description="Each card number is encrypted on this device before it's saved."
      >
        <div className="flex flex-col gap-4">
          {cards.length === 0 ? (
            <EmptyState
              variant="inline"
              icon={CreditCard}
              heading="No cards saved yet."
              description="Add a card so an agent can ask to use it. It can only use the card for a purchase you approve."
            />
          ) : (
            <ul role="list" className="flex min-w-0 flex-col">
              {cards.map((card) => (
                <SavedCardRow
                  key={card.id}
                  card={card}
                  removeCard={removeCard ?? noopRemoveCard}
                  changeBillingAddress={changeBillingAddress ?? noopChangeBilling}
                  billingAddresses={billingAddresses}
                />
              ))}
            </ul>
          )}

          {/* The live on-device add flow: closed it is the "Add a card" control, open it
              seals the number under the vault key and submits only ciphertext + metadata. */}
          <div className="border-t border-line pt-4">
            <AddCardFlow
              billingAddresses={billingAddresses}
              defaultCardholderName={defaultCardholderName}
              addCard={addCard ?? noopAddCard}
              initialOpen={addingCard}
              returnTo={returnTo}
            />
          </div>
        </div>
      </WorkspacePanel>
    </>
  );
}

export default CardsView;
