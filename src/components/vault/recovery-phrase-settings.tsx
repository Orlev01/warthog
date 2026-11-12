"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { createConfirmItsYou } from "@/components/ui/confirm-its-you";
import { createDeviceVault, type DeviceVault, type PasskeyAssertion } from "@/client/vault/device-vault";
import { startVaultAuthentication } from "@/client/vault/prf-ceremony";
import {
  createVaultKeyStep,
  PHRASE_NOT_SAVED_COPY,
  RecoveryPhraseReveal,
  VaultUnlockChoice,
  type VaultKeyStepState,
} from "./vault-key-step";

// Review fix W1 — the Vault page's recovery-phrase panel (brief "Vault unlock methods";
// design §4.2). It says whether a vault recovery phrase exists and offers to create one or
// replace it:
//   unlock the vault on this device (passkey, vault passphrase or the current phrase)
//   → show a new phrase once (Copy, Download, "I've saved it")
//   → for a REPLACEMENT, "Confirm it's you" (a security change; the server also refuses to
//     overwrite the 'recovery' method without a fresh step-up)
//   → seal the vault key under the new phrase and save it, which replaces the old one.
// It never sets up a new vault: before a vault exists there is nothing to protect, and the
// first card or protected detail shows the phrase anyway.
//
// Split as the repo's render-testable-AND-interactive pattern: createRecoveryPhraseSettings
// is the framework-free controller; RecoveryPhraseSettings is a thin Client Component over
// it with real browser defaults. Colour comes from the design tokens — never a raw hex.

export type RecoveryPhraseSettingsStatus = "idle" | "unlocking" | "working" | "phrase" | "done" | "error";

export interface RecoveryPhraseSettingsState {
  readonly status: RecoveryPhraseSettingsStatus;
  readonly hasRecoveryPhrase: boolean;
  readonly error?: string;
}

export interface RecoveryPhraseSettingsDeps {
  readonly vault: DeviceVault;
  readonly hasRecoveryPhrase: boolean;
  // "Confirm it's you": resolves true once the session holds a fresh step-up.
  readonly confirmItsYou: () => Promise<boolean>;
  readonly onChange?: () => void;
}

export interface RecoveryPhraseSettingsController {
  getState(): RecoveryPhraseSettingsState;
  getStepState(): VaultKeyStepState;
  // Open the unlock choice (no secret is asked for until the person picks how).
  open(): void;
  setUnlockMethod: ReturnType<typeof createVaultKeyStep>["setMethod"];
  setUnlockPassphrase(value: string): void;
  setRecoveryPhrase(value: string): void;
  setPhraseSaved(value: boolean): void;
  // Unlock and show the new phrase.
  start(): Promise<void>;
  // Save the new phrase (confirming it's you first when one is being replaced).
  confirm(): Promise<void>;
  cancel(): void;
}

const UNLOCK_FAILED_COPY = "We couldn't unlock your vault on this device. Check how you unlocked it, then try again.";
const CONFIRM_FAILED_COPY = "We couldn't check it's you, so your vault recovery phrase wasn't changed. Please try again.";
const SAVE_FAILED_COPY = "We couldn't save your new vault recovery phrase just now. Please try again.";

export function createRecoveryPhraseSettings(deps: RecoveryPhraseSettingsDeps): RecoveryPhraseSettingsController {
  let state: RecoveryPhraseSettingsState = { status: "idle", hasRecoveryPhrase: deps.hasRecoveryPhrase };

  function set(patch: Partial<RecoveryPhraseSettingsState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  const step = createVaultKeyStep({ vault: deps.vault, createIfMissing: false, onChange: () => deps.onChange?.() });

  async function start(): Promise<void> {
    if (state.status === "working") return;
    set({ status: "working", error: undefined });
    try {
      await step.obtain({ newPhrase: true });
      set({ status: "phrase" });
    } catch {
      set({ status: "error", error: UNLOCK_FAILED_COPY });
    }
  }

  async function confirm(): Promise<void> {
    if (state.status !== "phrase") return;
    if (!step.getState().phraseSaved) {
      set({ error: PHRASE_NOT_SAVED_COPY });
      return;
    }
    set({ status: "working", error: undefined });
    if (state.hasRecoveryPhrase) {
      let confirmed = false;
      try {
        confirmed = await deps.confirmItsYou();
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        set({ status: "phrase", error: CONFIRM_FAILED_COPY });
        return;
      }
    }
    try {
      await step.confirmPhrase();
    } catch {
      set({ status: "phrase", error: SAVE_FAILED_COPY });
      return;
    }
    set({ status: "done", hasRecoveryPhrase: true, error: undefined });
  }

  return {
    getState: () => state,
    getStepState: () => step.getState(),
    open: () => set({ status: "unlocking", error: undefined }),
    setUnlockMethod: (method) => step.setMethod(method),
    setUnlockPassphrase: (value) => step.setPassphrase(value),
    setRecoveryPhrase: (value) => step.setRecoveryPhrase(value),
    setPhraseSaved: (value) => step.setPhraseSaved(value),
    start,
    confirm,
    cancel: () => {
      step.cancelPhrase();
      set({ status: "idle", error: undefined });
    },
  };
}

// ─── the client component ───────────────────────────────────────────────────────────

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

const defaultStartAuthentication = async (opts: { optionsJSON: unknown }): Promise<PasskeyAssertion> =>
  startVaultAuthentication(opts.optionsJSON);

export interface RecoveryPhraseSettingsProps {
  // Whether the person has a vault recovery phrase, and any vault at all.
  hasRecoveryPhrase: boolean;
  hasVault: boolean;
  // Browser seams, overridable for tests.
  fetch?: typeof fetch;
  startAuthentication?: (opts: { optionsJSON: unknown }) => Promise<PasskeyAssertion>;
}

export function RecoveryPhraseSettings(props: RecoveryPhraseSettingsProps): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<RecoveryPhraseSettingsController | null>(null);
  if (flowRef.current === null) {
    const fetchImpl = props.fetch ?? defaultFetch;
    const start = props.startAuthentication ?? defaultStartAuthentication;
    const stepUp = createConfirmItsYou({
      fetch: fetchImpl,
      startAuthentication: async (opts) => (await start(opts)) as never,
    });
    flowRef.current = createRecoveryPhraseSettings({
      vault: createDeviceVault({ fetch: fetchImpl, startAuthentication: start }),
      hasRecoveryPhrase: props.hasRecoveryPhrase,
      confirmItsYou: () => stepUp.confirm(),
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const step = flow.getStepState();
  // The vault recovery phrase is not the account recovery code: the code gets the person
  // back into their account, the phrase unlocks their cards and protected details
  // (content-10). Each mention names which secret it means.
  const summary = !props.hasVault
    ? "When you add your first card or protected detail, you'll get a vault recovery phrase. It unlocks your cards and protected details if you ever lose every passkey. It's separate from your account recovery code, which gets you back into your account."
    : state.hasRecoveryPhrase
      ? "Your vault recovery phrase is set up. It unlocks your cards and protected details if you ever lose every passkey. It's separate from your account recovery code."
      : "Your vault has no recovery phrase yet. Without one, losing every passkey means your cards and protected details can't be unlocked.";

  const showUnlock = state.status === "unlocking" || state.status === "error" || (state.status === "working" && step.newPhrase === null);
  const hasBody = (props.hasVault && state.status === "idle") || showUnlock || step.newPhrase !== null || state.status === "done";

  // With nothing to do yet (no vault), the panel is its title and summary only.
  return (
    <WorkspacePanel title="Vault recovery phrase" icon={KeyRound} description={summary}>
      {hasBody ? (
        <div className="flex flex-col gap-4">
          {props.hasVault && state.status === "idle" ? (
            <div className="flex">
              <Button type="button" variant="secondary" onClick={() => flow.open()}>
                {state.hasRecoveryPhrase ? "Replace your vault recovery phrase" : "Create a vault recovery phrase"}
              </Button>
            </div>
          ) : null}

          {showUnlock ? (
            <div className="flex flex-col gap-3">
              {state.hasRecoveryPhrase ? (
                <p className="text-sm text-fg-muted">
                  A new phrase replaces the old one, which will stop working. First, unlock your vault on this device.
                </p>
              ) : null}
              <VaultUnlockChoice
                state={step}
                onMethod={(method) => flow.setUnlockMethod(method)}
                onPassphrase={(value) => flow.setUnlockPassphrase(value)}
                onRecoveryPhrase={(value) => flow.setRecoveryPhrase(value)}
              />
              {state.error ? (
                <p role="alert" className="text-sm text-danger">
                  {state.error}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="primary"
                  aria-disabled={state.status === "working" || undefined}
                  aria-busy={state.status === "working" || undefined}
                  onClick={() => {
                    // The controller ignores a second press while it's unlocking.
                    if (state.status !== "working") void flow.start();
                  }}
                >
                  {state.status === "working" ? "Unlocking…" : "Unlock and show a new phrase"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => flow.cancel()}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {step.newPhrase !== null ? (
            <RecoveryPhraseReveal
              phrase={step.newPhrase}
              saved={step.phraseSaved}
              onSavedChange={(saved) => flow.setPhraseSaved(saved)}
              onContinue={() => {
                void flow.confirm();
              }}
              working={state.status === "working"}
              error={state.error}
              continueLabel={state.hasRecoveryPhrase ? "Confirm it's you and replace it" : "Save my vault recovery phrase"}
            />
          ) : null}

          {state.status === "done" ? (
            <p role="status" className="text-sm text-success">
              Your new vault recovery phrase is saved. Any older phrase no longer works.
            </p>
          ) : null}
        </div>
      ) : null}
    </WorkspacePanel>
  );
}

export default RecoveryPhraseSettings;
