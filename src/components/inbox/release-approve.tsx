"use client";

import * as React from "react";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ShieldAlert } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { unlockVault, type UnlockRequest } from "@/client/vault/unlock";
import { decryptValue } from "@/client/vault/values";
import { postRelease } from "@/client/vault/release";
import { createDeviceVault } from "@/client/vault/device-vault";
import { startVaultAuthentication } from "@/client/vault/prf-ceremony";
import { generateRecoveryPhrase } from "@/client/vault/recovery-phrase";
import { RecoveryPhraseReveal } from "@/components/vault/vault-key-step";
import {
  createReleaseFlow,
  type ReleaseFlow,
  type PendingRequestView,
  type SavedCardView,
  type CardCheckoutDetails,
} from "./inbox-view";

// E11-S17 — Approve and release: the on-device card / high-tier release control
// (brief "High-tier release" / "Card requests"; design §4.2 "Release"; constitution 17
// "no readable card numbers or security codes on Warthog's side" + 18 "approvals only
// inside the signed-in app").
//
// The inbox used to render a card / high-tier release's "Approve and release" DISABLED
// with a reason, because a signed-in server page cannot hand a React client a callback,
// so its on-device flow was never wired. This module is that self-wired CLIENT control.
// On this device it unlocks the vault key (passkey PRF, a vault passphrase or — review fix
// W1 — the vault recovery phrase), decrypts
// the chosen saved card number or the requested high-tier value LOCALLY (the existing
// `src/client/vault` modules), and posts it to the existing approval release endpoint so
// the agent collects it once (collect_release). The plaintext never reaches the server
// except in that one-time release (design §4.2: only ciphertext at rest server-side).
//
// It exports the TWO seams the repo's render-testable-AND-interactive pattern uses
// (SignupView + createSignupFlow; SigninView + createSigninFlow; InboxView +
// createReleaseFlow):
//
//   1. ReleaseApprove — the Client Component InboxView mounts for a card / high-tier
//      release: the sensitive-moment explainer, (for a card) the saved-card picker and
//      the security-code field, the unlock-method choice, and the LIVE control that runs
//      the device hand-over. It wires the device seams below to the real `client/vault`
//      derivations; a release is LIVE BY CONSTRUCTION.
//   2. createReleaseApproveFlow(deps) — the framework-free, injectable controller behind
//      the live control (like createSignupFlow / createSigninFlow): choose the card,
//      enter the code, gather the unlock material by the chosen method, then run the
//      unlock → decrypt → post hand-over through the injected `releaseFlow` (the
//      createReleaseFlow core, already pinned by inbox-view.test.tsx). It reports every
//      outcome and never leaks the released value, the code or the passphrase.
//
// Colour comes from the design tokens (globals.css) — never a raw hex.

// ─── the controller contract this task introduces ────────────────────────────────────

// Review fix W1: the vault recovery phrase is a third way to unlock.
export type ReleaseMethod = "passkey" | "passphrase" | "recovery";

// What runs after a completed release (review fix W1), with the same unlock material: a
// recovery-phrase unlock re-seals the vault key under this device's passkey (a note says
// how it went), and a vault with no recovery phrase is handed a new one to save.
export interface AfterRelease {
  readonly notice?: string;
  readonly phrase?: { readonly value: string; readonly save: () => Promise<void> };
}

// The control's own status alongside the person's entries: idle until they submit,
// `working` while the hand-over runs, then `released` or `error`.
export type ReleaseStatus = "idle" | "working" | "released" | "error";

export interface ReleaseApproveState {
  method: ReleaseMethod;
  passphrase: string;
  // The recovery phrase typed to unlock (cleared once used).
  recoveryPhrase: string;
  // A new vault recovery phrase on screen after the release, its tick and any error.
  newPhrase: string | null;
  phraseSaved: boolean;
  phraseError?: string;
  cardId?: string;
  // The saved high-tier detail chosen for a high-tier release.
  highTierFieldId?: string;
  securityCode: string;
  status: ReleaseStatus;
  error?: string;
  // True when the release was refused because the step-up has lapsed: the control then
  // offers the shared "Confirm it's you" control (the step-up ceremony) inline — never a
  // dead end.
  confirmRequired: boolean;
  // A plain, non-error note (e.g. "confirmed — approve and release again").
  notice?: string;
}

export interface ReleaseApproveFlowDeps {
  // The card / high_tier release being decided.
  readonly request: PendingRequestView;
  // The approval to release for (defaults to request.id).
  readonly approvalId?: string;
  // A card release's picker cards (each carries its device-decryptable ciphertext).
  readonly savedCards?: readonly SavedCardView[];
  // A high_tier release's stored value ciphertext (the server holds only this).
  readonly highTierCiphertext?: string;
  // The createReleaseFlow core: unlock → decrypt → post. Driven once at submit.
  readonly releaseFlow: ReleaseFlow;
  // Gather the opaque unlock material by the chosen method. A cancelled passkey prompt
  // (or an unusable passphrase) REJECTS → nothing released, plain copy.
  readonly unlockByPassphrase: (passphrase: string) => UnlockRequest | Promise<UnlockRequest>;
  readonly unlockByPasskey: () => Promise<UnlockRequest>;
  // The vault recovery phrase's unlock material (review fix W1). Optional so a host that
  // predates it still works; the component always supplies the real one.
  readonly unlockByRecoveryPhrase?: (phrase: string) => Promise<UnlockRequest>;
  // Optional follow-up after a completed release (see AfterRelease). It never turns a
  // completed release into an error.
  readonly afterRelease?: (unlockRequest: UnlockRequest) => Promise<AfterRelease>;
  // Optional: re-render notifier (the component wires it) and a one-shot completion signal.
  readonly onChange?: () => void;
  readonly onReleased?: () => void;
}

export interface ReleaseApproveController {
  getState(): ReleaseApproveState;
  setMethod(method: ReleaseMethod): void;
  setPassphrase(value: string): void;
  setRecoveryPhrase(value: string): void;
  setPhraseSaved(value: boolean): void;
  // Save the new recovery phrase shown after a release, once "I've saved it" is ticked.
  confirmRecoveryPhrase(): Promise<void>;
  setCardId(cardId: string): void;
  setHighTierFieldId(fieldId: string): void;
  setSecurityCode(value: string): void;
  submit(): Promise<void>;
  // The shared "Confirm it's you" control reports a fresh confirmation after a release
  // was refused for a lapsed step-up. It never releases on its own: the person approves
  // and releases again (the unlock and the security code need their own fresh tap).
  confirmed(): void;
}

// Plain-English failure copy for a unlock the device could not gather — a real sentence a
// person can act on, with no crypto / protocol jargon and never the released value, the
// security code or the passphrase (brief design_ux.copy; constitution 18 / INV-22). A
// failure that happens INSIDE releaseFlow already carries its own plain copy, surfaced
// unchanged.
const UNLOCK_FAILED_COPY =
  "We couldn't unlock your vault on this device. Check how you unlocked it, then try again.";
const CONFIRMED_NOTICE = "Thanks, that's confirmed. Approve and release again to hand it over.";
const PHRASE_NOT_SAVED_COPY = "Tick the box once you've saved your recovery phrase.";
const PHRASE_FAILED_COPY = "We couldn't save your recovery phrase just now. Please try again.";
const PHRASE_SAVED_NOTICE = "Your vault recovery phrase is saved.";

// The release refusal reason that "Confirm it's you" resolves.
const STEP_UP_REQUIRED = "step_up_required";

export function createReleaseApproveFlow(deps: ReleaseApproveFlowDeps): ReleaseApproveController {
  const isCard = deps.request.release === "card";

  let state: ReleaseApproveState = {
    method: "passkey",
    passphrase: "",
    recoveryPhrase: "",
    newPhrase: null,
    phraseSaved: false,
    cardId: deps.savedCards?.[0]?.id,
    highTierFieldId: deps.request.highTierFields?.[0]?.id,
    securityCode: "",
    status: "idle",
    confirmRequired: false,
  };

  function set(patch: Partial<ReleaseApproveState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // Gather the opaque unlock material for the chosen method; the controller passes it
  // straight to releaseFlow and never inspects it.
  function gatherUnlock(): UnlockRequest | Promise<UnlockRequest> {
    if (state.method === "passkey") return deps.unlockByPasskey();
    if (state.method === "recovery") {
      if (!deps.unlockByRecoveryPhrase) throw new Error("no recovery-phrase unlock is wired");
      return deps.unlockByRecoveryPhrase(state.recoveryPhrase);
    }
    return deps.unlockByPassphrase(state.passphrase);
  }

  // The follow-up after a completed release (review fix W1). Best effort: whatever it
  // does, the release already happened and stays reported as done.
  let pendingPhraseSave: (() => Promise<void>) | null = null;
  async function followUp(unlockRequest: UnlockRequest): Promise<void> {
    if (!deps.afterRelease) return;
    try {
      const after = await deps.afterRelease(unlockRequest);
      if (after.phrase) {
        pendingPhraseSave = after.phrase.save;
        set({ newPhrase: after.phrase.value, phraseSaved: false, phraseError: undefined });
      }
      if (after.notice) set({ notice: after.notice });
    } catch {
      // Nothing to report: the release itself succeeded.
    }
  }

  async function confirmRecoveryPhrase(): Promise<void> {
    if (state.newPhrase === null || pendingPhraseSave === null) return;
    if (!state.phraseSaved) {
      set({ phraseError: PHRASE_NOT_SAVED_COPY });
      return;
    }
    try {
      await pendingPhraseSave();
    } catch {
      set({ phraseError: PHRASE_FAILED_COPY });
      return;
    }
    pendingPhraseSave = null;
    set({ newPhrase: null, phraseSaved: false, phraseError: undefined, notice: PHRASE_SAVED_NOTICE });
  }

  // The stored ciphertext this release decrypts: a card release decrypts the CHOSEN saved
  // card (defaulting to the first offered when the picker is untouched); a high-tier
  // release decrypts the requested value's ciphertext.
  function chosenCard(): SavedCardView | undefined {
    const cards = deps.savedCards ?? [];
    return cards.find((card) => card.id === state.cardId) ?? cards[0];
  }
  function ciphertextToRelease(): string {
    if (!isCard) {
      const fields = deps.request.highTierFields ?? [];
      const chosen = fields.find((field) => field.id === state.highTierFieldId) ?? fields[0];
      return chosen?.ciphertext ?? deps.highTierCiphertext ?? "";
    }
    return chosenCard()?.ciphertext ?? "";
  }

  // The chosen card's non-secret checkout details, handed over with the number and the
  // typed security code so the agent can complete the checkout (review fix W6). They are
  // never shown here: the picker shows only brand and last four.
  function cardDetailsToRelease(): CardCheckoutDetails | undefined {
    const card = chosenCard();
    if (!card) return undefined;
    return {
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      cardholderName: card.cardholderName,
      billingAddress: card.billingAddress,
    };
  }

  async function submit(): Promise<void> {
    set({ status: "working", error: undefined, notice: undefined });

    // 1. Gather the unlock material by the chosen method. A cancelled passkey prompt (or
    //    an unusable passphrase) rejects here: nothing is released and the person is told
    //    in plain words — the request stays on the screen.
    let unlockRequest: UnlockRequest;
    try {
      unlockRequest = await gatherUnlock();
    } catch {
      // Nothing was released; the secrets entered for this attempt are not kept.
      set({ status: "error", error: UNLOCK_FAILED_COPY, passphrase: "", recoveryPhrase: "", securityCode: "" });
      return;
    }

    // 2. Run the device hand-over (unlock → decrypt → post) through the release core. It
    //    never rejects: a wrong secret / tampered value / refused post comes back as a
    //    plain failure, which we surface as-is without claiming a release happened.
    const result = await deps.releaseFlow.release({
      approvalId: deps.approvalId ?? deps.request.id,
      unlockRequest,
      ciphertext: ciphertextToRelease(),
      securityCode: isCard ? state.securityCode : undefined,
      card: isCard ? cardDetailsToRelease() : undefined,
    });

    // Whatever the outcome, the passphrase and security code entered for this attempt are
    // cleared from state at once (a retry asks for them again).
    if (result.ok) {
      set({
        status: "released",
        error: undefined,
        passphrase: "",
        recoveryPhrase: "",
        securityCode: "",
        confirmRequired: false,
      });
      deps.onReleased?.();
      await followUp(unlockRequest);
    } else {
      // A lapsed step-up is resolved right here ("Confirm it's you"), not by signing out.
      set({
        status: "error",
        error: result.error,
        passphrase: "",
        recoveryPhrase: "",
        securityCode: "",
        confirmRequired: result.reason === STEP_UP_REQUIRED,
      });
    }
  }

  function confirmed(): void {
    set({ status: "idle", confirmRequired: false, error: undefined, notice: CONFIRMED_NOTICE });
  }

  return {
    getState: () => state,
    setMethod: (method) => set({ method }),
    setPassphrase: (value) => set({ passphrase: value }),
    setRecoveryPhrase: (value) => set({ recoveryPhrase: value }),
    setPhraseSaved: (value) => set({ phraseSaved: value }),
    confirmRecoveryPhrase,
    setCardId: (cardId) => set({ cardId }),
    setHighTierFieldId: (fieldId) => set({ highTierFieldId: fieldId }),
    setSecurityCode: (value) => set({ securityCode: value }),
    submit,
    confirmed,
  };
}

// ─── the real device seams (the thin browser wiring the component defaults to) ────────
//
// The gather seams compose the existing `client/vault` derivations with the browser's
// WebAuthn PRF ceremony, exactly as SigninFlow defaults to the real `startAuthentication`
// and `fetch`. They are the injection points the controller tests fake; the inbox mounts
// the control with its data props and these defaults run. Each resolves the opaque
// UnlockRequest the release core consumes, or rejects (→ the plain unlock-failed copy).

// The server exposes the person's non-secret unlock material for a method (design §4.2
// `getUnlockMaterial`): the wrapped VK envelope, the method's public params (the
// passphrase salt) and, for a passkey, the assertion options whose PRF extension is
// eval'd with the person's PRF salt. The wrapped key is opaque; no secret is returned.
const UNLOCK_MATERIAL_BASE = "/api/vault/unlock-material";

type ServerUnlockMaterial = {
  readonly wrapped: string | null;
  readonly params?: Record<string, unknown> | null;
  readonly options?: PublicKeyCredentialRequestOptionsJSON | null;
};

// Standard / URL-safe base64 → bytes (the salt is standard base64; a WebAuthn PRF result
// is base64url). WebCrypto, never Node's Buffer, so every byte round-trips.
function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return base64ToBytes(b64 + padding);
}

async function fetchUnlockMaterial(
  method: "passkey_prf" | "passphrase" | "recovery",
): Promise<ServerUnlockMaterial> {
  const response = await globalThis.fetch(`${UNLOCK_MATERIAL_BASE}/${method}`, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error("vault unlock material is unavailable on this device");
  }
  return (await response.json()) as ServerUnlockMaterial;
}

// Vault passphrase → the PBKDF2 unlock material (derive.ts does the work inside
// unlockVault; here we only assemble the stored envelope + salt with the typed secret).
async function defaultUnlockByPassphrase(passphrase: string): Promise<UnlockRequest> {
  const material = await fetchUnlockMaterial("passphrase");
  const salt = material.params?.salt;
  if (material.wrapped == null || typeof salt !== "string") {
    throw new Error("no vault passphrase is set on this account");
  }
  return {
    method: "passphrase",
    material: { wrapped: material.wrapped, salt: base64ToBytes(salt) },
    secret: passphrase,
  };
}

// Passkey PRF → the PRF unlock material: run the WebAuthn assertion (the OS prompt; a
// dismissed prompt rejects here), read the PRF output from the extension results, and
// hand back the envelope + the PRF bytes.
async function defaultUnlockByPasskey(): Promise<UnlockRequest> {
  const material = await fetchUnlockMaterial("passkey_prf");
  if (material.wrapped == null || material.options == null) {
    throw new Error("no passkey that can unlock your vault is set");
  }
  const assertion = await startVaultAuthentication(material.options);
  const prf = assertion.clientExtensionResults?.prf?.results?.first;
  if (typeof prf !== "string") {
    throw new Error("this passkey can't unlock your vault");
  }
  return { method: "prf", material: { wrapped: material.wrapped }, secret: base64UrlToBytes(prf) };
}

// Vault recovery phrase → the recovery unlock material (review fix W1): the envelope sealed
// under the phrase, with the typed phrase as the secret (unlockVault normalises it).
async function defaultUnlockByRecoveryPhrase(phrase: string): Promise<UnlockRequest> {
  const material = await fetchUnlockMaterial("recovery");
  if (material.wrapped == null) throw new Error("no vault recovery phrase is set");
  return { method: "recovery", material: { wrapped: material.wrapped }, secret: phrase };
}

// The follow-up after a completed release (review fix W1), over the shared device vault:
// recover the vault key from the same unlock material, then re-seal it under this device's
// passkey after a phrase unlock, or prepare a new recovery phrase when the vault has none.
const ADOPTED_NOTICE = "This device's passkey can now unlock your vault, so you won't need the phrase here next time.";
const UNSUPPORTED_NOTICE = "This device's passkey can't unlock your vault, so use your recovery phrase here.";
const ADOPT_FAILED_NOTICE = "This passkey wasn't set up to unlock your vault. You can use your recovery phrase again next time.";

async function defaultAfterRelease(unlockRequest: UnlockRequest): Promise<AfterRelease> {
  const vault = createDeviceVault({
    fetch: (...args) => globalThis.fetch(...args),
    startAuthentication: (opts) => startVaultAuthentication(opts.optionsJSON),
  });
  // Most vaults already have a phrase: check first, so the vault key is only re-derived
  // when there is something to do with it.
  if (unlockRequest.method !== "recovery" && (await vault.hasRecoveryPhrase())) return {};
  const vaultKey = await unlockVault(unlockRequest);
  if (unlockRequest.method === "recovery") {
    try {
      const outcome = await vault.adoptPasskey(vaultKey);
      return { notice: outcome === "unsupported" ? UNSUPPORTED_NOTICE : ADOPTED_NOTICE };
    } catch {
      return { notice: ADOPT_FAILED_NOTICE };
    }
  }
  const phrase = generateRecoveryPhrase();
  return { phrase: { value: phrase, save: () => vault.saveRecoveryPhrase(vaultKey, phrase) } };
}

// "Confirm it's you" — the release's step-up (design §5) is the shared <ConfirmItsYou>
// control (review fix W4.4; components/ui/confirm-its-you): it runs the passkey ceremony
// against the step-up endpoints and reports back once the session carries a fresh
// confirmation, with the same plain copy as every other screen. Shown only after a
// release was refused for a lapsed step-up.
const STEP_UP_EXPLANATION =
  "It's been a few minutes since you last confirmed it's you. Use your passkey to confirm, then approve and release again.";

export function ReleaseStepUp({ onConfirmed }: { onConfirmed: () => void }): React.ReactElement {
  return <ConfirmItsYou explanation={STEP_UP_EXPLANATION} onConfirmed={onConfirmed} />;
}

// The release core, wired to the real client/vault primitives: unlock the vault key from
// the opaque material, decrypt the stored ciphertext under it, and POST the plaintext to
// the approval's release endpoint — the single hand-over (the server stores only
// ciphertext at rest). Built lazily on first use (never at module load) so the
// release-approve ⇄ inbox-view import cycle never calls across a half-evaluated module.
let cachedReleaseFlow: ReleaseFlow | null = null;
function getDefaultReleaseFlow(): ReleaseFlow {
  if (cachedReleaseFlow === null) {
    cachedReleaseFlow = createReleaseFlow({
      unlock: (request) => unlockVault(request),
      decrypt: (vaultKey, ciphertext) => decryptValue(vaultKey as Uint8Array<ArrayBuffer>, ciphertext),
      postRelease,
    });
  }
  return cachedReleaseFlow;
}

// ─── styling (design tokens; no raw hex) ──────────────────────────────────────────────

const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
// Deliberately omits any `disabled:` utility variant so a LIVE control's class never
// reads as "disabled" to a markup scan; the native `disabled` attribute disables it.
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_PRIMARY_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;
const SELECT_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// The sensitive-moment explainer — a plain "slow down for this one moment" panel, in
// everyday words with no jargon, shown for every release (card and high-tier alike).
const RELEASE_EXPLAINER =
  "This is a sensitive step, so take a moment before it goes ahead. Check the details are right, then approve to hand the value over just once.";

// ─── the client component (a thin binding over the controller) ────────────────────────

export interface ReleaseApproveProps {
  request: PendingRequestView;
  approvalId?: string;
  savedCards?: readonly SavedCardView[];
  highTierCiphertext?: string;
  // The device seams, with real `client/vault` + WebAuthn defaults so the control is live
  // by construction. Optional overrides let the flow be driven with fakes.
  releaseFlow?: ReleaseFlow;
  unlockByPassphrase?: (passphrase: string) => UnlockRequest | Promise<UnlockRequest>;
  unlockByPasskey?: () => Promise<UnlockRequest>;
  unlockByRecoveryPhrase?: (phrase: string) => Promise<UnlockRequest>;
  afterRelease?: (unlockRequest: UnlockRequest) => Promise<AfterRelease>;
  onReleased?: () => void;
}

// Why a release has nothing to hand over (no dead control: the button is disabled and
// this one line says why).
const NO_CARD_REASON = "Add a card in your vault first, then approve and release.";
const NO_HIGH_TIER_REASON = "Save this detail in your vault first, then approve and release.";

export function ReleaseApprove(props: ReleaseApproveProps): React.ReactElement {
  const { request, approvalId, savedCards, highTierCiphertext } = props;
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<ReleaseApproveController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createReleaseApproveFlow({
      request,
      approvalId,
      savedCards,
      highTierCiphertext,
      releaseFlow: props.releaseFlow ?? getDefaultReleaseFlow(),
      unlockByPassphrase: props.unlockByPassphrase ?? defaultUnlockByPassphrase,
      unlockByPasskey: props.unlockByPasskey ?? defaultUnlockByPasskey,
      unlockByRecoveryPhrase: props.unlockByRecoveryPhrase ?? defaultUnlockByRecoveryPhrase,
      afterRelease: props.afterRelease ?? defaultAfterRelease,
      onChange: () => forceUpdate(),
      onReleased: props.onReleased,
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  const isCard = request.release === "card";
  const cards = savedCards ?? [];
  // A high-tier release offers the person's saved details (when the loader provided
  // them); none provided at all falls back to a directly supplied ciphertext.
  const highTierFields = request.highTierFields;
  const cardFieldId = React.useId();
  const codeFieldId = React.useId();
  const highTierFieldIdAttr = React.useId();
  const passphraseFieldId = React.useId();
  const recoveryPhraseFieldId = React.useId();
  const methodName = React.useId();
  // Nothing to hand over: no saved card for a card release, or no saved detail for a
  // high-tier one.
  const unavailableReason = isCard
    ? cards.length === 0
      ? NO_CARD_REASON
      : null
    : highTierFields !== undefined && highTierFields.length === 0
      ? NO_HIGH_TIER_REASON
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-card border border-line bg-surface-muted p-3 text-sm text-fg">
        <ShieldAlert aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <p>{RELEASE_EXPLAINER}</p>
      </div>

      {isCard ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={cardFieldId}>Which card</Label>
            <select
              id={cardFieldId}
              name="card"
              value={state.cardId ?? ""}
              onChange={(event) => flow.setCardId(event.target.value)}
              className={SELECT_CLASS}
            >
              {cards.map((card) => (
                <option key={card.id} value={card.id}>
                  {card.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={codeFieldId}>Security code</Label>
            <Input
              id={codeFieldId}
              name="securityCode"
              inputMode="numeric"
              autoComplete="off"
              value={state.securityCode}
              onChange={(event) => flow.setSecurityCode(event.target.value)}
            />
          </div>
        </>
      ) : null}

      {!isCard && highTierFields !== undefined && highTierFields.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={highTierFieldIdAttr}>Which detail</Label>
          <select
            id={highTierFieldIdAttr}
            name="highTierField"
            value={state.highTierFieldId ?? ""}
            onChange={(event) => flow.setHighTierFieldId(event.target.value)}
            className={SELECT_CLASS}
          >
            {highTierFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-fg">How would you like to unlock your vault?</legend>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="radio"
            name={methodName}
            value="passkey"
            checked={state.method === "passkey"}
            onChange={() => flow.setMethod("passkey")}
          />
          Use your passkey
        </label>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="radio"
            name={methodName}
            value="passphrase"
            checked={state.method === "passphrase"}
            onChange={() => flow.setMethod("passphrase")}
          />
          Use your vault passphrase
        </label>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="radio"
            name={methodName}
            value="recovery"
            checked={state.method === "recovery"}
            onChange={() => flow.setMethod("recovery")}
          />
          Use your recovery phrase
        </label>
      </fieldset>

      {state.method === "passphrase" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={passphraseFieldId}>Vault passphrase</Label>
          <Input
            id={passphraseFieldId}
            name="passphrase"
            type="password"
            autoComplete="off"
            value={state.passphrase}
            onChange={(event) => flow.setPassphrase(event.target.value)}
          />
        </div>
      ) : null}

      {state.method === "recovery" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={recoveryPhraseFieldId}>Recovery phrase</Label>
          <Input
            id={recoveryPhraseFieldId}
            name="recoveryPhrase"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ABCD-EFGH-…"
            value={state.recoveryPhrase}
            onChange={(event) => flow.setRecoveryPhrase(event.target.value)}
          />
        </div>
      ) : null}

      {state.error ? (
        <p role="alert" className="break-words text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="text-sm text-fg">
          {state.notice}
        </p>
      ) : null}
      {state.status === "released" ? (
        <p role="status" className="text-sm text-success">
          Handed over — the agent can collect it once.
        </p>
      ) : null}
      {state.newPhrase !== null ? (
        <RecoveryPhraseReveal
          phrase={state.newPhrase}
          saved={state.phraseSaved}
          onSavedChange={(saved) => flow.setPhraseSaved(saved)}
          onContinue={() => {
            void flow.confirmRecoveryPhrase();
          }}
          error={state.phraseError}
          continueLabel="Save my recovery phrase"
        />
      ) : null}

      {state.confirmRequired ? (
        <ReleaseStepUp onConfirmed={() => flow.confirmed()} />
      ) : unavailableReason !== null ? (
        <div className="flex flex-col gap-1">
          <button type="button" disabled className={BTN_PRIMARY_DISABLED}>
            Approve and release
          </button>
          <p className="text-xs text-fg-muted">{unavailableReason}</p>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={state.status === "working"}
            onClick={() => {
              void flow.submit();
            }}
          >
            Approve and release
          </button>
        </div>
      )}
    </div>
  );
}

export default ReleaseApprove;
