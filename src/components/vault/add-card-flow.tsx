"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SensitiveNotice } from "@/components/ui/sensitive-notice";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { createVaultKey } from "@/client/vault/key";
import { createDeviceVault, StepUpRequiredError } from "@/client/vault/device-vault";
import { startVaultAuthentication } from "@/client/vault/prf-ceremony";
import { sealCard, type CardSubmission, type VaultAddress } from "./cards-view";
import {
  createVaultKeyStep,
  PHRASE_NOT_SAVED_COPY,
  RecoveryPhraseReveal,
  VaultUnlockChoice,
  type UnlockChoice,
  type VaultKeyStepState,
} from "./vault-key-step";

// E11-S19 — Set up the vault and add a card on this device (brief "Saved cards" /
// "Device-held protection" / "Vault unlock methods"; design §4.2 device-held vault;
// constitution 17 "no readable card numbers or security codes on Warthog's side"; INV-103).
//
// The cards page used to render an "Add a card" button with NO behaviour, and `sealCard`
// was never called, so no card could be saved. This module is that self-wired CLIENT flow.
// On this device it:
//   • on FIRST use creates the vault key in the browser (createVaultKey) and wraps it under
//     the person's passkey PRF — and, when a vault passphrase is chosen, ALSO under that
//     passphrase — saving each wrapped key via POST /api/vault/unlock-method;
//   • on LATER use unlocks the EXISTING vault key through the unlock-material endpoint
//     (GET /api/vault/unlock-material/passkey_prf) — no new key is created;
//   • seals the entered card number on the device (sealCard) and submits ONLY the
//     ciphertext plus plaintext metadata (brand, last four, expiry, nickname, the name on
//     the card, billing address) to the page's addCard action. The name on the card is
//     pre-filled with the person's saved name from About you (review fix W6).
// The security code is NEVER collected here (it is typed only at release time, E11-S17).
// Review fix W1: the vault key is obtained through the shared vault-key step
// (./vault-key-step), so the vault unlocks with a passkey, the vault passphrase or the
// vault recovery phrase, and a vault with no recovery phrase (a new one, or one set up
// before phrases existed) shows a new phrase once and saves it before the card is sealed.
//
// It exports the TWO seams the repo's render-testable-AND-interactive pattern uses
// (SignupView + createSignupFlow; ReleaseApprove + createReleaseApproveFlow):
//   1. AddCardFlow — the Client Component CardsView mounts for the "Add a card" surface:
//      closed it is the live "Add a card" control; open it is the sensitive-moment
//      explainer, the "security code is never stored" note, the billing picker, a live
//      card-number field (plus nickname / expiry and an optional vault passphrase) and the
//      live confirm. It wires the device seams below to the real `client/vault` crypto, so
//      the flow is LIVE BY CONSTRUCTION.
//   2. createAddCardFlow(deps) — the framework-free, injectable controller behind the live
//      confirm: set up or unlock the vault key on this device, seal the number, submit only
//      the ciphertext + metadata. Reports every outcome and never leaks the number or the
//      passphrase.
//
// Colour comes from the design tokens (globals.css) — never a raw hex.

// ─── the controller contract this task introduces ─────────────────────────────────────

// The control's own status alongside the person's entries: idle until they confirm,
// `working` while the device flow runs, `phrase` while a new vault recovery phrase waits
// for the person to save it (review fix W1), then `added` or `error`.
export type AddCardStatus = "idle" | "working" | "phrase" | "added" | "error";

export interface AddCardState {
  number: string;
  nickname: string;
  cardholderName: string;
  expiryMonth: string;
  expiryYear: string;
  billingAddressId: string;
  usePassphrase: boolean;
  passphrase: string;
  status: AddCardStatus;
  error?: string;
  // True when replacing the vault passphrase was refused for a lapsed step-up: the panel
  // then offers "Confirm it's you" inline.
  confirmRequired: boolean;
}

// The passkey PRF assertion the OS prompt returns — the PRF output is base64url in
// clientExtensionResults.prf.results.first; a dismissed prompt REJECTS.
export type PasskeyAssertion = {
  clientExtensionResults?: { prf?: { results?: { first?: string } } };
};

export interface AddCardFlowDeps {
  // The billing-address picker's choices (used to default the chosen address).
  readonly billingAddresses?: readonly VaultAddress[];
  // The person's saved name from About you: the "Name on card" field starts with it.
  readonly defaultCardholderName?: string;
  // GET /api/vault/unlock-material/<method>, POST /api/vault/unlock-method.
  readonly fetch: typeof fetch;
  // The WebAuthn PRF assertion (OS passkey prompt); a dismissed prompt REJECTS.
  readonly startAuthentication: (opts: { optionsJSON: unknown }) => Promise<PasskeyAssertion>;
  // Fresh vault-key entropy; called ONLY on first use (no envelope yet).
  readonly createVaultKey: () => Uint8Array;
  // The page's addCard server action — stores the sealed submission.
  readonly addCard: (
    submission: CardSubmission,
  ) => Promise<{ ok: boolean; reason?: string }>;
  // Optional: re-render notifier (the component wires it) and a one-shot completion signal.
  readonly onChange?: () => void;
  readonly onAdded?: () => void;
}

export interface AddCardController {
  getState(): AddCardState;
  setNumber(value: string): void;
  setNickname(value: string): void;
  setCardholderName(value: string): void;
  setExpiryMonth(value: string): void;
  setExpiryYear(value: string): void;
  setBillingAddressId(value: string): void;
  setUsePassphrase(value: boolean): void;
  setPassphrase(value: string): void;
  submit(): Promise<void>;
  // The shared unlock step (review fix W1): how to unlock, and the once-only reveal of a
  // new vault recovery phrase that must be saved before the card is.
  getUnlockState(): VaultKeyStepState;
  setUnlockMethod(method: UnlockChoice): void;
  setUnlockPassphrase(value: string): void;
  setRecoveryPhrase(value: string): void;
  setPhraseSaved(value: boolean): void;
  confirmRecoveryPhrase(): Promise<void>;
  // After "Confirm it's you" succeeds: clear the prompt so Confirm can be pressed again.
  clearConfirmRequired(): void;
}

// Plain-English failure copy — a real sentence a person can act on, with no crypto /
// protocol jargon and never the card number or the passphrase (brief design_ux.copy;
// constitution INV-22). A cancelled passkey prompt or an unreachable endpoint surfaces the
// setup copy; a server-side refusal surfaces the save copy (never the raw machine reason).
const SETUP_FAILED_COPY =
  "We couldn't unlock your vault on this device, so your card wasn't saved. Check your passkey and try again.";
const SAVE_FAILED_COPY = "We couldn't save your card just now. Please try again.";
const PHRASE_FAILED_COPY =
  "We couldn't save your recovery phrase, so your card wasn't saved. Please try again.";
const PASSPHRASE_STEP_UP_COPY =
  "You already have a vault passphrase. Confirm it's you to replace it, then confirm the card again.";

// Review fix G12 — the card is checked on the device before anything leaves it (a repeat
// Confirm after a save, with the number already cleared, stores nothing), and a vault
// passphrase must be long enough to resist offline guessing: the server holds its salt
// and the passphrase-wrapped vault key, so a short one would let a database holder brute
// force the vault.
const MIN_PASSPHRASE_LENGTH = 12;
const NUMBER_COPY = "Type the card number (12 to 19 digits) before you confirm.";
const EXPIRY_COPY = "Check the expiry: a month from 1 to 12 and a four-digit year.";
const NICKNAME_COPY = "Give this card a name so you can tell it apart, then confirm.";
// The name on the card, capped like the server's check (CARDHOLDER_NAME_MAX).
const CARDHOLDER_NAME_MAX = 256;
const CARDHOLDER_COPY = "Type the name on the card as it's printed, then confirm.";
const BILLING_COPY = "Choose a billing address for this card, then confirm.";
const PASSPHRASE_COPY = `Choose a vault passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters, or untick the passphrase option.`;

// The card brand, derived from the number's leading digits (the issuer BIN ranges). The
// full number is never stored; only this brand + the last four are kept in plaintext.
function brandFromNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (/^4/.test(digits)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "American Express";
  if (/^6(?:011|5)/.test(digits)) return "Discover";
  return "Card";
}

// The first problem with the person's entries, in plain words, or null when the card can
// be sealed and saved.
function entryProblem(state: AddCardState): string | null {
  const digits = state.number.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(digits)) return NUMBER_COPY;
  const month = Number(state.expiryMonth);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !/^\d{4}$/.test(state.expiryYear.trim())) {
    return EXPIRY_COPY;
  }
  if (state.nickname.trim().length === 0) return NICKNAME_COPY;
  const cardholderName = state.cardholderName.trim();
  if (cardholderName.length === 0 || cardholderName.length > CARDHOLDER_NAME_MAX) return CARDHOLDER_COPY;
  if (state.billingAddressId.length === 0) return BILLING_COPY;
  if (state.usePassphrase && state.passphrase.length < MIN_PASSPHRASE_LENGTH) return PASSPHRASE_COPY;
  return null;
}

export function createAddCardFlow(deps: AddCardFlowDeps): AddCardController {
  let state: AddCardState = {
    number: "",
    nickname: "",
    cardholderName: deps.defaultCardholderName ?? "",
    expiryMonth: "",
    expiryYear: "",
    billingAddressId: deps.billingAddresses?.[0]?.id ?? "",
    usePassphrase: false,
    passphrase: "",
    status: "idle",
    confirmRequired: false,
  };

  function set(patch: Partial<AddCardState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // The device vault over the unlock endpoints, and the shared unlock step over it: a
  // passkey sets the vault up on first use (no envelope yet) or unlocks the EXISTING key;
  // a passphrase or the recovery phrase unlocks it too; and a vault with no recovery
  // phrase pauses for one before anything is sealed (review fix W1).
  const vault = createDeviceVault({
    fetch: deps.fetch,
    startAuthentication: deps.startAuthentication,
    createVaultKey: deps.createVaultKey,
  });
  const step = createVaultKeyStep({ vault, createIfMissing: true, onChange: () => deps.onChange?.() });

  // A failure while getting the vault key ready: a lapsed step-up for replacing the
  // passphrase offers "Confirm it's you"; anything else is the plain setup copy. The
  // secrets entered for this attempt are cleared either way.
  function setupFailed(error: unknown, copy: string): void {
    if (error instanceof StepUpRequiredError) {
      set({ status: "error", error: PASSPHRASE_STEP_UP_COPY, passphrase: "", confirmRequired: true });
    } else {
      set({ status: "error", error: copy, passphrase: "" });
    }
  }

  // Seal the number under the unlocked vault key and submit ONLY the ciphertext +
  // metadata. The chosen vault passphrase (if any) is saved first, wrapping the SAME key,
  // so "Use your vault passphrase" opens the vault the passkey does (review fix G12).
  async function sealAndSubmit(vaultKey: Uint8Array<ArrayBuffer>): Promise<void> {
    let submission: CardSubmission;
    try {
      if (state.usePassphrase) await vault.savePassphrase(vaultKey, state.passphrase);
      submission = await sealCard(vaultKey, {
        brand: brandFromNumber(state.number),
        number: state.number,
        expiryMonth: state.expiryMonth,
        expiryYear: state.expiryYear,
        nickname: state.nickname,
        cardholderName: state.cardholderName.trim(),
        billingAddressId: state.billingAddressId,
      });
    } catch (error) {
      setupFailed(error, SETUP_FAILED_COPY);
      return;
    }

    // A refusal comes back with its own machine reason, which we never surface raw —
    // plain copy instead.
    let result: { ok: boolean; reason?: string };
    try {
      result = await deps.addCard(submission);
    } catch {
      set({ status: "error", error: SAVE_FAILED_COPY, passphrase: "" });
      return;
    }

    if (result.ok) {
      // Clear the card from the form the moment it is saved: the full number must not
      // stay on screen, and a repeat Confirm then has nothing to store twice.
      set({
        status: "added",
        error: undefined,
        number: "",
        nickname: "",
        cardholderName: deps.defaultCardholderName ?? "",
        expiryMonth: "",
        expiryYear: "",
        usePassphrase: false,
        passphrase: "",
      });
      deps.onAdded?.();
    } else {
      set({ status: "error", error: SAVE_FAILED_COPY, passphrase: "" });
    }
  }

  async function submit(): Promise<void> {
    if (state.status === "working" || state.status === "phrase") return; // no double confirm
    const problem = entryProblem(state);
    if (problem) {
      set({ status: "error", error: problem });
      return;
    }
    set({ status: "working", error: undefined, confirmRequired: false });

    // 1. Unlock (or set up) the vault key on this device. A cancelled prompt, an
    //    unreachable endpoint, a wrong secret or a tampered envelope lands here: the
    //    person is told in plain words and nothing is saved.
    let vaultKey: Uint8Array<ArrayBuffer>;
    try {
      const got = await step.obtain();
      if (got.kind === "reveal") {
        // A vault with no recovery phrase: show the new phrase and wait for the person to
        // save it before the card is sealed.
        set({ status: "phrase" });
        return;
      }
      vaultKey = got.vaultKey;
    } catch (error) {
      setupFailed(error, SETUP_FAILED_COPY);
      return;
    }

    // 2. Seal and submit.
    await sealAndSubmit(vaultKey);
  }

  async function confirmRecoveryPhrase(): Promise<void> {
    if (state.status !== "phrase") return;
    if (!step.getState().phraseSaved) {
      set({ error: PHRASE_NOT_SAVED_COPY });
      return;
    }
    set({ status: "working", error: undefined });
    let vaultKey: Uint8Array<ArrayBuffer>;
    try {
      vaultKey = await step.confirmPhrase();
    } catch {
      // The phrase stays on screen so the person can try again.
      set({ status: "phrase", error: PHRASE_FAILED_COPY });
      return;
    }
    await sealAndSubmit(vaultKey);
  }

  return {
    getState: () => state,
    setNumber: (value) => set({ number: value }),
    setNickname: (value) => set({ nickname: value }),
    setCardholderName: (value) => set({ cardholderName: value }),
    setExpiryMonth: (value) => set({ expiryMonth: value }),
    setExpiryYear: (value) => set({ expiryYear: value }),
    setBillingAddressId: (value) => set({ billingAddressId: value }),
    setUsePassphrase: (value) => set({ usePassphrase: value }),
    setPassphrase: (value) => set({ passphrase: value }),
    submit,
    getUnlockState: () => step.getState(),
    setUnlockMethod: (method) => step.setMethod(method),
    setUnlockPassphrase: (value) => step.setPassphrase(value),
    setRecoveryPhrase: (value) => step.setRecoveryPhrase(value),
    setPhraseSaved: (value) => step.setPhraseSaved(value),
    confirmRecoveryPhrase,
    clearConfirmRequired: () => set({ confirmRequired: false, error: undefined, status: "idle" }),
  };
}

// ─── the real device seams (the thin browser wiring the component defaults to) ─────────

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

// The real WebAuthn PRF ceremony, adapted to the controller's opaque-options seam (the
// controller never inspects the options — it echoes the endpoint's verbatim).
const defaultStartAuthentication = async (opts: {
  optionsJSON: unknown;
}): Promise<PasskeyAssertion> => startVaultAuthentication(opts.optionsJSON);

// ─── styling (design tokens; no raw hex) ──────────────────────────────────────────────

const SELECT_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// The sensitive-moment explainer: adding a card slows down and says HOW the number is
// protected (sealed on the device, never readable by Warthog) — plain words.
const SEAL_EXPLAINER =
  "Adding a card is a sensitive step, so take a moment. Your card number is sealed on your device with your vault key before it is saved — only the locked version ever leaves, and Warthog can never read it.";

// The explicit note that the card security code is never stored (§17). It lives in a
// paragraph, not a field label — no security code is ever collected here.
const SECURITY_CODE_NOTE =
  "Your card's security code (sometimes called the CVV) is never stored — not by Warthog, and not anywhere.";

// ─── the client component (a thin binding over the controller) ─────────────────────────

export interface AddCardFlowProps {
  billingAddresses: readonly VaultAddress[];
  // The person's saved name from About you, which pre-fills "Name on card".
  defaultCardholderName?: string;
  // The page's addCard server action that stores the sealed submission.
  addCard: (submission: CardSubmission) => Promise<{ ok: boolean; reason?: string }>;
  // Selects the panel's initial state (the sibling `draft`/`addingCard` idiom): defaults
  // to CLOSED (just the live "Add a card" control).
  initialOpen?: boolean;
  // The device seams, with real `client/vault` + WebAuthn defaults so the control is live
  // by construction. Optional overrides let the flow be driven with fakes.
  fetch?: typeof fetch;
  startAuthentication?: AddCardFlowDeps["startAuthentication"];
  createVaultKey?: () => Uint8Array;
  // Called once on a completed save (the page refreshes the list).
  onAdded?: () => void;
}

export function AddCardFlow(props: AddCardFlowProps): React.ReactElement {
  const [open, setOpen] = React.useState<boolean>(props.initialOpen ?? false);
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<AddCardController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createAddCardFlow({
      billingAddresses: props.billingAddresses,
      defaultCardholderName: props.defaultCardholderName,
      fetch: props.fetch ?? defaultFetch,
      startAuthentication: props.startAuthentication ?? defaultStartAuthentication,
      createVaultKey: props.createVaultKey ?? createVaultKey,
      addCard: props.addCard,
      onChange: () => forceUpdate(),
      onAdded: props.onAdded,
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const unlock = flow.getUnlockState();

  // Call every hook unconditionally (rules of hooks), even though the closed panel uses none.
  const numberId = React.useId();
  const nicknameId = React.useId();
  const cardholderNameId = React.useId();
  const monthId = React.useId();
  const yearId = React.useId();
  const billingId = React.useId();
  const passphraseToggleId = React.useId();
  const passphraseId = React.useId();

  if (!open) {
    return (
      <div className="flex">
        <Button variant="primary" type="button" onClick={() => setOpen(true)}>
          <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
          Add a card
        </Button>
      </div>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-fg">Add a card</h3>

      <Field
        label="Card number"
        id={numberId}
        inputMode="numeric"
        autoComplete="off"
        placeholder="Your card number"
        value={state.number}
        onChange={(event) => flow.setNumber(event.target.value)}
      />
      <Field
        label="A name for this card"
        id={nicknameId}
        placeholder="e.g. Everyday spending"
        value={state.nickname}
        onChange={(event) => flow.setNickname(event.target.value)}
      />
      <Field
        label="Name on card"
        id={cardholderNameId}
        autoComplete="off"
        placeholder="As printed on the card"
        required={true}
        maxLength={CARDHOLDER_NAME_MAX}
        value={state.cardholderName}
        onChange={(event) => flow.setCardholderName(event.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Expiry month"
          id={monthId}
          type="number"
          inputMode="numeric"
          placeholder="MM"
          value={state.expiryMonth}
          onChange={(event) => flow.setExpiryMonth(event.target.value)}
        />
        <Field
          label="Expiry year"
          id={yearId}
          type="number"
          inputMode="numeric"
          placeholder="YYYY"
          value={state.expiryYear}
          onChange={(event) => flow.setExpiryYear(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={billingId}>Billing address</Label>
        <select
          id={billingId}
          value={state.billingAddressId}
          onChange={(event) => flow.setBillingAddressId(event.target.value)}
          className={SELECT_CLASS}
        >
          {props.billingAddresses.map((address) => (
            <option key={address.id} value={address.id}>
              {address.value}
            </option>
          ))}
        </select>
      </div>

      <p className="text-sm text-fg-muted">{SECURITY_CODE_NOTE}</p>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={passphraseToggleId} className="flex items-center gap-2 text-sm text-fg">
          <input
            id={passphraseToggleId}
            type="checkbox"
            checked={state.usePassphrase}
            onChange={(event) => flow.setUsePassphrase(event.target.checked)}
          />
          Also protect your vault with a passphrase (optional)
        </label>
        {state.usePassphrase ? (
          <Input
            id={passphraseId}
            type="password"
            autoComplete="off"
            aria-label="Vault passphrase"
            value={state.passphrase}
            minLength={MIN_PASSPHRASE_LENGTH}
            onChange={(event) => flow.setPassphrase(event.target.value)}
          />
        ) : null}
        {state.usePassphrase ? (
          <p className="text-sm text-fg-muted">
            At least {MIN_PASSPHRASE_LENGTH} characters. A few unrelated words make a strong one.
          </p>
        ) : null}
      </div>

      <VaultUnlockChoice
        state={unlock}
        onMethod={(method) => flow.setUnlockMethod(method)}
        onPassphrase={(value) => flow.setUnlockPassphrase(value)}
        onRecoveryPhrase={(value) => flow.setRecoveryPhrase(value)}
      />

      {unlock.notice ? (
        <p role="status" className="text-sm text-fg">
          {unlock.notice}
        </p>
      ) : null}
      {state.error && state.status !== "phrase" ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.status === "added" ? (
        <p role="status" className="text-sm text-success">
          Your card is saved.
        </p>
      ) : null}
      {state.confirmRequired ? (
        <ConfirmItsYou
          explanation="Replacing your vault passphrase is a security change, so we need to check it's really you."
          onConfirmed={() => flow.clearConfirmRequired()}
        />
      ) : null}

      {unlock.newPhrase !== null ? (
        <RecoveryPhraseReveal
          phrase={unlock.newPhrase}
          saved={unlock.phraseSaved}
          onSavedChange={(saved) => flow.setPhraseSaved(saved)}
          onContinue={() => {
            void flow.confirmRecoveryPhrase();
          }}
          working={state.status === "working"}
          error={state.status === "phrase" ? state.error : undefined}
          continueLabel="Save the phrase and my card"
        />
      ) : props.billingAddresses.length === 0 ? (
        // No dead Confirm: a card needs a billing address, so say why and where to add one.
        <p className="text-sm text-fg">
          A card needs a billing address, and you haven&apos;t saved a postal address yet.{" "}
          <a href="/vault" className="font-medium text-accent underline underline-offset-2">
            Add a postal address in About you
          </a>
          , then come back to add your card.
        </p>
      ) : (
        <SensitiveNotice
          explanation={SEAL_EXPLAINER}
          onConfirm={() => {
            void flow.submit();
          }}
        />
      )}
    </Card>
  );
}

export default AddCardFlow;
