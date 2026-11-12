"use client";

import * as React from "react";
import { Lock, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { SensitiveNotice } from "@/components/ui/sensitive-notice";
import { createVaultKey } from "@/client/vault/key";
import { createDeviceVault } from "@/client/vault/device-vault";
import { startVaultAuthentication } from "@/client/vault/prf-ceremony";
import { sealHighTierDetail, type HighTierFieldType } from "./identity-view";
import {
  createVaultKeyStep,
  PHRASE_NOT_SAVED_COPY,
  RecoveryPhraseReveal,
  VaultUnlockChoice,
  type UnlockChoice,
  type VaultKeyStepState,
} from "./vault-key-step";

// E11-S20 — Add a high-tier detail on this device (brief "Identity vault" /
// "Device-held protection"; design §4.2 device-held vault; constitution 17/19 — the
// server holds no vault key and no staff role can read vault contents; INV-103).
//
// The identity screen (<IdentityView/>, E11-S13) renders an "Add a high-tier detail"
// control and a per-field "Raise to high tier" control that never reach the device
// encryption step, so a licence / passport / date of birth can never be saved for
// release. This module is the self-wired CLIENT flow behind BOTH controls. On this
// device it:
//   • on FIRST use creates the vault key in the browser (createVaultKey) and wraps it
//     under the person's passkey PRF, saving the wrapped key via POST
//     /api/vault/unlock-method;
//   • on LATER use unlocks the EXISTING vault key through the unlock-material endpoint
//     (GET /api/vault/unlock-material/passkey_prf) — no new key is created;
//   • ADD mode: seals the entered value on the device (sealHighTierDetail) and submits
//     ONLY the ciphertext plus plaintext metadata (type, label) to the page's
//     saveHighTierField action;
//   • RAISE mode: re-seals the EXISTING low-tier field's value on the device and submits
//     the ciphertext + metadata together with that field's id to the page's
//     raiseFieldToHighTier action (whose server side removes the plaintext low-tier
//     value).
// The plaintext value is NEVER collected into a request body, storage or the console.
// Review fix W1: the vault key is obtained through the shared vault-key step
// (./vault-key-step) — a passkey, the vault passphrase or the vault recovery phrase — and a
// vault with no recovery phrase shows a new one once and saves it before the detail is.
//
// It exports the TWO seams the repo's render-testable-AND-interactive pattern uses
// (SignupView + createSignupFlow; ReleaseApprove + createReleaseApproveFlow; AddCardFlow
// + createAddCardFlow):
//   1. HighTierFlow — the Client Component <IdentityView/> mounts for both controls:
//      closed it is the live "Add a high-tier detail" / "Raise to high tier" control;
//      open it is the sensitive-moment explainer, a live value field (ADD mode) and the
//      live confirm that runs the device flow. The device seams are defaulted to the real
//      client/vault + WebAuthn wiring, so the control is LIVE BY CONSTRUCTION.
//   2. createHighTierFlow(deps) — the framework-free, injectable controller behind the
//      live confirm: set up or unlock the vault key on this device, seal the value, submit
//      only the ciphertext + metadata. Reports every outcome and never leaks the value.
//
// Colour comes from the design tokens (globals.css) — never a raw hex.

// ─── the controller contract this task introduces ─────────────────────────────────────

export type HighTierMode = "add" | "raise";

// The control's own status alongside the person's entries: idle until they confirm,
// `working` while the device flow runs, `phrase` while a new vault recovery phrase waits
// for the person to save it (review fix W1), then `saved` or `error`.
export type HighTierStatus = "idle" | "working" | "phrase" | "saved" | "error";

export interface HighTierState {
  type: string;
  label: string;
  value: string;
  status: HighTierStatus;
  error?: string;
}

// The low-tier field a RAISE flow re-seals — its id and current DECRYPTED value (and the
// human label to carry as the new high-tier field's metadata).
export interface RaiseField {
  id: string;
  value: string;
  label?: string;
}

// The passkey PRF assertion the OS prompt returns — the PRF output is base64url in
// clientExtensionResults.prf.results.first; a dismissed prompt REJECTS.
export type PasskeyAssertion = {
  clientExtensionResults?: { prf?: { results?: { first?: string } } };
};

// What ADD mode submits (the page's saveHighTierField server action).
export type SaveHighTierFieldAction = (submission: {
  type: string;
  label: string;
  ciphertext: string;
}) => Promise<{ ok: boolean; reason?: string }>;

// What RAISE mode submits (the page's raiseFieldToHighTier server action).
export type RaiseFieldToHighTierAction = (submission: {
  fieldId: string;
  type: string;
  label: string;
  ciphertext: string;
}) => Promise<{ ok: boolean; reason?: string }>;

export interface HighTierFlowDeps {
  // Which control this flow is behind.
  readonly mode: HighTierMode;
  // RAISE mode: the existing low-tier field being raised.
  readonly field?: RaiseField;
  // GET /api/vault/unlock-material/<method>, POST /api/vault/unlock-method.
  readonly fetch: typeof fetch;
  // The WebAuthn PRF assertion (OS passkey prompt); a dismissed prompt REJECTS.
  readonly startAuthentication: (opts: { optionsJSON: unknown }) => Promise<PasskeyAssertion>;
  // Fresh vault-key entropy; called ONLY on first use (no envelope yet).
  readonly createVaultKey: () => Uint8Array;
  // ADD mode submit — stores the sealed submission.
  readonly saveHighTierField?: SaveHighTierFieldAction;
  // RAISE mode submit — stores the sealed submission and removes the low-tier value.
  readonly raiseFieldToHighTier?: RaiseFieldToHighTierAction;
  // Optional: re-render notifier (the component wires it) and a one-shot completion signal.
  readonly onChange?: () => void;
  readonly onSaved?: () => void;
}

export interface HighTierController {
  getState(): HighTierState;
  setType(value: string): void;
  setLabel(value: string): void;
  setValue(value: string): void;
  submit(): Promise<void>;
  // The shared unlock step (review fix W1): how to unlock, and the once-only reveal of a
  // new vault recovery phrase that must be saved before the detail is.
  getUnlockState(): VaultKeyStepState;
  setUnlockMethod(method: UnlockChoice): void;
  setUnlockPassphrase(value: string): void;
  setRecoveryPhrase(value: string): void;
  setPhraseSaved(value: boolean): void;
  confirmRecoveryPhrase(): Promise<void>;
}

// A high-tier detail with no chosen type is saved as a "custom" detail (the store enum's
// catch-all); the person names it with a label. A render test does not force a type
// picker, so the flow always submits a valid high-tier type.
const DEFAULT_TYPE: HighTierFieldType = "custom";

// Plain-English failure copy — a real sentence a person can act on, with no crypto /
// protocol jargon and never the value (brief design_ux.copy; constitution INV-22). A
// cancelled passkey prompt or an unreachable endpoint surfaces the setup copy; a
// server-side refusal surfaces the save copy (never the raw machine reason).
const SETUP_FAILED_COPY =
  "We couldn't unlock your vault on this device, so your detail wasn't saved. Check your passkey and try again.";
const SAVE_FAILED_COPY = "We couldn't save your detail just now. Please try again.";
const LABEL_MISSING_COPY = "Say what this detail is, for example Passport.";
const VALUE_MISSING_COPY = "Type the detail you want to protect.";
const PHRASE_FAILED_COPY =
  "We couldn't save your recovery phrase, so your detail wasn't saved. Please try again.";

export function createHighTierFlow(deps: HighTierFlowDeps): HighTierController {
  let state: HighTierState = {
    type: DEFAULT_TYPE,
    // RAISE mode starts with the existing field's label and value; ADD mode is empty.
    label: deps.field?.label ?? "",
    value: deps.field?.value ?? "",
    status: "idle",
  };

  function set(patch: Partial<HighTierState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // The device vault over the unlock endpoints, and the shared unlock step over it: a
  // passkey sets the vault up on first use or unlocks the EXISTING key; a passphrase or
  // the recovery phrase unlocks it too; and a vault with no recovery phrase pauses for
  // one before anything is sealed (review fix W1).
  const vault = createDeviceVault({
    fetch: deps.fetch,
    startAuthentication: deps.startAuthentication,
    createVaultKey: deps.createVaultKey,
  });
  const step = createVaultKeyStep({ vault, createIfMissing: true, onChange: () => deps.onChange?.() });

  // Submit the sealed detail to the mode's action: RAISE carries the low-tier field's id;
  // ADD carries only the sealed metadata.
  async function submitSealed(submission: {
    type: string;
    label: string;
    ciphertext: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    if (deps.mode === "raise") {
      if (!deps.raiseFieldToHighTier) throw new Error("no raise action is wired");
      return deps.raiseFieldToHighTier({ fieldId: deps.field?.id ?? "", ...submission });
    }
    if (!deps.saveHighTierField) throw new Error("no save action is wired");
    return deps.saveHighTierField(submission);
  }

  // Seal the value under the unlocked vault key and submit ONLY the ciphertext + metadata.
  async function sealAndSubmit(vaultKey: Uint8Array<ArrayBuffer>): Promise<void> {
    let submission: { type: HighTierFieldType; label: string; ciphertext: string };
    try {
      submission = await sealHighTierDetail(vaultKey, {
        type: state.type as HighTierFieldType,
        label: state.label,
        value: state.value,
      });
    } catch {
      set({ status: "error", error: SETUP_FAILED_COPY });
      return;
    }

    // A refusal comes back with its own machine reason, which we never surface raw —
    // plain copy instead.
    let result: { ok: boolean; reason?: string };
    try {
      result = await submitSealed(submission);
    } catch {
      set({ status: "error", error: SAVE_FAILED_COPY });
      return;
    }

    if (result.ok) {
      set({ status: "saved", error: undefined });
      deps.onSaved?.();
    } else {
      set({ status: "error", error: SAVE_FAILED_COPY });
    }
  }

  async function submit(): Promise<void> {
    if (state.status === "working" || state.status === "phrase") return; // no double confirm
    // A new detail needs a name and a value (spaces alone don't count); say which, before
    // the vault is unlocked or anything is sealed.
    if (deps.mode === "add") {
      if (state.label.trim() === "") {
        set({ status: "error", error: LABEL_MISSING_COPY });
        return;
      }
      if (state.value.trim() === "") {
        set({ status: "error", error: VALUE_MISSING_COPY });
        return;
      }
    }
    set({ status: "working", error: undefined });

    // 1. Unlock (or set up) the vault key on this device. A cancelled prompt, an
    //    unreachable endpoint, a wrong secret or a tampered envelope lands here: the
    //    person is told in plain words and nothing leaves the device.
    let vaultKey: Uint8Array<ArrayBuffer>;
    try {
      const got = await step.obtain();
      if (got.kind === "reveal") {
        // A vault with no recovery phrase: show the new phrase and wait for the person to
        // save it before the detail is sealed.
        set({ status: "phrase" });
        return;
      }
      vaultKey = got.vaultKey;
    } catch {
      set({ status: "error", error: SETUP_FAILED_COPY });
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
    setType: (value) => set({ type: value }),
    setLabel: (value) => set({ label: value }),
    setValue: (value) => set({ value }),
    submit,
    getUnlockState: () => step.getState(),
    setUnlockMethod: (method) => step.setMethod(method),
    setUnlockPassphrase: (value) => step.setPassphrase(value),
    setRecoveryPhrase: (value) => step.setRecoveryPhrase(value),
    setPhraseSaved: (value) => step.setPhraseSaved(value),
    confirmRecoveryPhrase,
  };
}

// ─── the real device seams (the thin browser wiring the component defaults to) ─────────

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

// The real WebAuthn PRF ceremony, adapted to the controller's opaque-options seam (the
// controller never inspects the options — it echoes the endpoint's verbatim).
const defaultStartAuthentication = async (opts: {
  optionsJSON: unknown;
}): Promise<PasskeyAssertion> => startVaultAuthentication(opts.optionsJSON);

// ─── copy (plain Australian English; no protocol jargon) ───────────────────────────────

// The sensitive-moment explainer: HOW the detail is protected (encrypted on this device, so
// Warthog stores only a copy it can't read) and WHO can read it (an agent, only when the
// person approves that one request). It states the release mechanism as it is — the value
// passes through Warthog once, for that approval — rather than an absolute "never"
// (content-31; matches the privacy page).
const PROTECTION_EXPLAINER =
  "This detail is encrypted on this device before it's saved, so Warthog stores only a locked copy it can't read. It's released only when you approve a request: then it's unlocked on your device and passed through Warthog once, to that one agent, and not kept.";

// ─── the client component (a thin binding over the controller) ─────────────────────────

export interface HighTierFlowProps {
  // Which control this flow is behind.
  mode: HighTierMode;
  // RAISE mode: the existing low-tier field being raised (id + current decrypted value).
  field?: RaiseField;
  // The page's server actions that store the device-sealed submission. The page always
  // supplies the one matching the mode; a prop-driven render (a preview, a render test)
  // may omit it, in which case nothing is stored.
  saveHighTierField?: SaveHighTierFieldAction;
  raiseFieldToHighTier?: RaiseFieldToHighTierAction;
  // Selects the panel's initial state (the sibling `draft`/`addingHighTier` idiom):
  // defaults to CLOSED (just the live control).
  initialOpen?: boolean;
  // The device seams, with real client/vault + WebAuthn defaults so the control is live
  // by construction. Optional overrides let the flow be driven with fakes.
  fetch?: typeof fetch;
  startAuthentication?: HighTierFlowDeps["startAuthentication"];
  createVaultKey?: () => Uint8Array;
  // Called once on a completed save (the page refreshes the list).
  onSaved?: () => void;
}

export function HighTierFlow(props: HighTierFlowProps): React.ReactElement {
  const [open, setOpen] = React.useState<boolean>(props.initialOpen ?? false);
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<HighTierController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createHighTierFlow({
      mode: props.mode,
      field: props.field,
      fetch: props.fetch ?? defaultFetch,
      startAuthentication: props.startAuthentication ?? defaultStartAuthentication,
      createVaultKey: props.createVaultKey ?? createVaultKey,
      saveHighTierField: props.saveHighTierField,
      raiseFieldToHighTier: props.raiseFieldToHighTier,
      onChange: () => forceUpdate(),
      onSaved: props.onSaved,
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const unlock = flow.getUnlockState();
  const isRaise = props.mode === "raise";

  // Call every hook unconditionally (rules of hooks), even though the closed panel uses none.
  const labelId = React.useId();
  const valueId = React.useId();

  // Everyday and protected are the two tiers' names everywhere (content-09); "Add a detail"
  // is the page's main action, so adding a protected one is the secondary.
  if (!open) {
    return (
      <div className="flex">
        <Button
          variant="secondary"
          size={isRaise ? "sm" : "md"}
          type="button"
          onClick={() => setOpen(true)}
        >
          {isRaise ? (
            <Lock aria-hidden={true} className="h-4 w-4 shrink-0" />
          ) : (
            <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
          )}
          {isRaise ? "Make protected" : "Add a protected detail"}
          {isRaise && props.field?.label ? <span className="sr-only"> {props.field.label}</span> : null}
        </Button>
      </div>
    );
  }

  return (
    <Card className="flex w-full basis-full flex-col gap-4">
      <h3 className="wh-group-title">
        {isRaise ? "Make this a protected detail" : "Add a protected detail"}
      </h3>
      {isRaise ? (
        <p className="text-sm text-fg-muted">
          Agents will have to ask you each time they need your {props.field?.label ? props.field.label.toLowerCase() : "detail"}.
        </p>
      ) : null}

      {isRaise ? null : (
        <>
          <Field
            label="What is it?"
            id={labelId}
            placeholder="For example, Passport"
            width="text"
            value={state.label}
            onChange={(event) => flow.setLabel(event.target.value)}
          />
          <Field
            label="The detail"
            id={valueId}
            autoComplete="off"
            placeholder="Type the detail to protect"
            width="text"
            value={state.value}
            onChange={(event) => flow.setValue(event.target.value)}
          />
        </>
      )}

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
      {state.status === "saved" ? (
        <p role="status" className="text-sm text-success">
          Your detail is saved.
        </p>
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
          continueLabel="Save the phrase and my detail"
        />
      ) : state.status === "saved" ? null : (
        <SensitiveNotice
          explanation={PROTECTION_EXPLAINER}
          confirmLabel={isRaise ? "Save as protected" : "Save protected detail"}
          pending={state.status === "working"}
          pendingLabel="Saving…"
          onConfirm={() => {
            void flow.submit();
          }}
        />
      )}

      {/* A way back out before anything is saved. Not offered while the vault is being
          unlocked or a new vault recovery phrase is on screen (that step finishes or is
          retried on its own). */}
      {state.status !== "working" && state.status !== "phrase" && unlock.newPhrase === null ? (
        <div className="flex">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              // A fresh flow next time: nothing typed lingers, and a saved add can't be
              // confirmed a second time.
              flowRef.current = null;
              setOpen(false);
            }}
          >
            {state.status === "saved" ? "Close" : "Cancel"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export default HighTierFlow;
