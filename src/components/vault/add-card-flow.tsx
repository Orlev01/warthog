"use client";

import * as React from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SensitiveNotice } from "@/components/ui/sensitive-notice";
import {
  deriveWrappingKeyFromPrf,
  deriveWrappingKeyFromPassphrase,
} from "@/client/vault/derive";
import { createVaultKey, wrapVaultKey, unwrapVaultKey } from "@/client/vault/key";
import { sealCard, type CardSubmission, type VaultAddress } from "./cards-view";

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
//     ciphertext plus plaintext metadata (brand, last four, expiry, nickname, billing
//     address) to the page's addCard action.
// The security code is NEVER collected here (it is typed only at release time, E11-S17).
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
// `working` while the device flow runs, then `added` or `error`.
export type AddCardStatus = "idle" | "working" | "added" | "error";

export interface AddCardState {
  number: string;
  nickname: string;
  expiryMonth: string;
  expiryYear: string;
  billingAddressId: string;
  usePassphrase: boolean;
  passphrase: string;
  status: AddCardStatus;
  error?: string;
}

// The passkey PRF assertion the OS prompt returns — the PRF output is base64url in
// clientExtensionResults.prf.results.first; a dismissed prompt REJECTS.
export type PasskeyAssertion = {
  clientExtensionResults?: { prf?: { results?: { first?: string } } };
};

export interface AddCardFlowDeps {
  // The billing-address picker's choices (used to default the chosen address).
  readonly billingAddresses?: readonly VaultAddress[];
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
  setExpiryMonth(value: string): void;
  setExpiryYear(value: string): void;
  setBillingAddressId(value: string): void;
  setUsePassphrase(value: boolean): void;
  setPassphrase(value: string): void;
  submit(): Promise<void>;
}

// The methods' wire names (a STRICTER set than the store's enum): the device-unlock
// methods the endpoints serve.
const UNLOCK_MATERIAL_BASE = "/api/vault/unlock-material";
const UNLOCK_METHOD_URL = "/api/vault/unlock-method";

// Plain-English failure copy — a real sentence a person can act on, with no crypto /
// protocol jargon and never the card number or the passphrase (brief design_ux.copy;
// constitution INV-22). A cancelled passkey prompt or an unreachable endpoint surfaces the
// setup copy; a server-side refusal surfaces the save copy (never the raw machine reason).
const SETUP_FAILED_COPY =
  "We couldn't unlock your vault on this device, so your card wasn't saved. Check your passkey and try again.";
const SAVE_FAILED_COPY = "We couldn't save your card just now. Please try again.";

// Review fix G12 — the card is checked on the device before anything leaves it (a repeat
// Confirm after a save, with the number already cleared, stores nothing), and a vault
// passphrase must be long enough to resist offline guessing: the server holds its salt
// and the passphrase-wrapped vault key, so a short one would let a database holder brute
// force the vault.
const MIN_PASSPHRASE_LENGTH = 12;
const NUMBER_COPY = "Type the card number (12 to 19 digits) before you confirm.";
const EXPIRY_COPY = "Check the expiry: a month from 1 to 12 and a four-digit year.";
const NICKNAME_COPY = "Give this card a name so you can tell it apart, then confirm.";
const BILLING_COPY = "Choose a billing address for this card, then confirm.";
const PASSPHRASE_COPY = `Choose a vault passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters, or untick the passphrase option.`;

// The server's non-secret unlock material for a method (design §4.2 getUnlockMaterial):
// the wrapped VK envelope (null when none is set), the method's public params and, for a
// passkey, the assertion options whose PRF extension is eval'd with the person's salt.
type ServerUnlockMaterial = {
  readonly wrapped: string | null;
  readonly params?: Record<string, unknown> | null;
  readonly options?: unknown;
};

// WebCrypto base64 helpers (browser `btoa`/`atob`, never Node's Buffer). The salt is
// stored as standard base64; a WebAuthn PRF result is base64url.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
  if (state.billingAddressId.length === 0) return BILLING_COPY;
  if (state.usePassphrase && state.passphrase.length < MIN_PASSPHRASE_LENGTH) return PASSPHRASE_COPY;
  return null;
}

export function createAddCardFlow(deps: AddCardFlowDeps): AddCardController {
  let state: AddCardState = {
    number: "",
    nickname: "",
    expiryMonth: "",
    expiryYear: "",
    billingAddressId: deps.billingAddresses?.[0]?.id ?? "",
    usePassphrase: false,
    passphrase: "",
    status: "idle",
  };

  function set(patch: Partial<AddCardState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // Read the person's passkey unlock material from the endpoint (the wrapped VK, if any,
  // and the assertion options). A read is not Origin-gated; an unreachable endpoint throws.
  async function fetchPasskeyMaterial(): Promise<ServerUnlockMaterial> {
    const response = await deps.fetch(`${UNLOCK_MATERIAL_BASE}/passkey_prf`, {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("vault unlock material is unavailable on this device");
    return (await response.json()) as ServerUnlockMaterial;
  }

  // Save a wrapped vault key for a method. The browser sets the Origin header itself (a
  // forbidden header JS cannot set), which the server checks before storing anything.
  async function saveUnlockMethod(body: {
    method: "passkey_prf" | "passphrase";
    wrapped: string;
    params?: Record<string, unknown>;
  }): Promise<void> {
    const response = await deps.fetch(UNLOCK_METHOD_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("could not save the vault unlock method");
  }

  // Run the OS passkey prompt with the endpoint's options and recover the PRF-derived
  // wrapping key. A dismissed prompt rejects here (nothing is created or saved).
  async function wrappingKeyFromPasskey(options: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const assertion = await deps.startAuthentication({ optionsJSON: options });
    const prf = assertion.clientExtensionResults?.prf?.results?.first;
    if (typeof prf !== "string") throw new Error("this passkey can't unlock your vault");
    return deriveWrappingKeyFromPrf(base64UrlToBytes(prf));
  }

  // Set up (first use) or unlock (later use) this device's vault key. On first use a fresh
  // key is created, wrapped under the passkey PRF (and, when chosen, under the vault
  // passphrase too) and saved; on later use the existing envelope is unwrapped — no new
  // key, no save. Either way the passkey ceremony runs so its PRF is available.
  // Also wrap `vaultKey` under the person's chosen passphrase and save that unlock method,
  // so "Use your vault passphrase" opens the SAME vault the passkey does.
  async function savePassphraseMethod(vaultKey: Uint8Array<ArrayBuffer>): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passphraseKey = await deriveWrappingKeyFromPassphrase(state.passphrase, salt);
    await saveUnlockMethod({
      method: "passphrase",
      wrapped: await wrapVaultKey(passphraseKey, vaultKey),
      params: { salt: toBase64(salt) },
    });
  }

  async function ensureVaultKey(): Promise<Uint8Array<ArrayBuffer>> {
    const material = await fetchPasskeyMaterial();
    const wrappingKey = await wrappingKeyFromPasskey(material.options);

    if (material.wrapped != null) {
      const vaultKey = await unwrapVaultKey(wrappingKey, material.wrapped);
      // The passphrase option used to be silently ignored once a vault existed (review
      // fix G12): honour it by wrapping the EXISTING vault key.
      if (state.usePassphrase) await savePassphraseMethod(vaultKey);
      return vaultKey;
    }

    // First use on this account: create the key and save it wrapped under the passkey.
    const vaultKey = deps.createVaultKey() as Uint8Array<ArrayBuffer>;
    await saveUnlockMethod({ method: "passkey_prf", wrapped: await wrapVaultKey(wrappingKey, vaultKey) });

    // Optionally also wrap it under a chosen vault passphrase, with a fresh public salt.
    if (state.usePassphrase) await savePassphraseMethod(vaultKey);

    return vaultKey;
  }

  async function submit(): Promise<void> {
    if (state.status === "working") return; // guard against a double confirm
    const problem = entryProblem(state);
    if (problem) {
      set({ status: "error", error: problem });
      return;
    }
    set({ status: "working", error: undefined });

    // 1. Set up / unlock the vault key, then seal the number — all on this device. A
    //    cancelled prompt, an unreachable endpoint or a tampered envelope lands here: the
    //    person is told in plain words and the secrets entered for this attempt are cleared.
    let submission: CardSubmission;
    try {
      const vaultKey = await ensureVaultKey();
      submission = await sealCard(vaultKey, {
        brand: brandFromNumber(state.number),
        number: state.number,
        expiryMonth: state.expiryMonth,
        expiryYear: state.expiryYear,
        nickname: state.nickname,
        billingAddressId: state.billingAddressId,
      });
    } catch {
      set({ status: "error", error: SETUP_FAILED_COPY, passphrase: "" });
      return;
    }

    // 2. Submit ONLY the ciphertext + metadata to the page's action. A refusal comes back
    //    with its own machine reason, which we never surface raw — plain copy instead.
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

  return {
    getState: () => state,
    setNumber: (value) => set({ number: value }),
    setNickname: (value) => set({ nickname: value }),
    setExpiryMonth: (value) => set({ expiryMonth: value }),
    setExpiryYear: (value) => set({ expiryYear: value }),
    setBillingAddressId: (value) => set({ billingAddressId: value }),
    setUsePassphrase: (value) => set({ usePassphrase: value }),
    setPassphrase: (value) => set({ passphrase: value }),
    submit,
  };
}

// ─── the real device seams (the thin browser wiring the component defaults to) ─────────

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

// The real WebAuthn PRF ceremony, adapted to the controller's opaque-options seam (the
// controller never inspects the options — it echoes the endpoint's verbatim).
const defaultStartAuthentication = async (opts: {
  optionsJSON: unknown;
}): Promise<PasskeyAssertion> =>
  (await startAuthentication({
    optionsJSON: opts.optionsJSON as PublicKeyCredentialRequestOptionsJSON,
  })) as PasskeyAssertion;

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

  // Call every hook unconditionally (rules of hooks), even though the closed panel uses none.
  const numberId = React.useId();
  const nicknameId = React.useId();
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

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.status === "added" ? (
        <p role="status" className="text-sm text-success">
          Your card is saved.
        </p>
      ) : null}

      {props.billingAddresses.length === 0 ? (
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
