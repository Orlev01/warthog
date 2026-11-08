"use client";

import * as React from "react";
import { Copy, Download, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import type { DeviceVault } from "@/client/vault/device-vault";
import { generateRecoveryPhrase, recoveryPhraseFileText } from "@/client/vault/recovery-phrase";

// Review fix W1 — the shared "get the vault key on this device" step (brief "Vault unlock
// methods"; design §4.2). The add-card and high-tier flows run it before they seal
// anything, so both offer the same three ways to unlock and both make sure the vault has
// a recovery phrase:
//   • createVaultKeyStep(deps) — the framework-free controller over the DeviceVault seam:
//       obtain()       → unlock by the chosen method (a passkey sets the vault up on first
//                        use). A recovery-phrase unlock then re-seals the vault key under
//                        this device's passkey so the person is back to normal. If the
//                        vault has no recovery phrase yet (a new vault, or one set up
//                        before phrases existed) it PAUSES with a freshly generated phrase
//                        for the person to save — nothing is sealed until they have.
//       confirmPhrase() → once "I've saved it" is ticked, seal the vault key under the
//                        phrase, save it as method 'recovery', forget the phrase and hand
//                        the key back.
//   • VaultUnlockChoice — the unlock-method radios and the field the choice needs.
//   • RecoveryPhraseReveal — the phrase, shown once, with Copy, Download and the tick.
// The phrase never leaves the device; the typed passphrase and phrase are cleared once used.
// Colour comes from the design tokens (globals.css) — never a raw hex.

export type UnlockChoice = "passkey" | "passphrase" | "recovery";

export interface VaultKeyStepState {
  readonly method: UnlockChoice;
  // What the person typed to unlock with (cleared once used).
  readonly passphrase: string;
  readonly recoveryPhrase: string;
  // The newly generated recovery phrase while it is on screen; null otherwise.
  readonly newPhrase: string | null;
  // The "I've saved it" tick for the phrase on screen.
  readonly phraseSaved: boolean;
  // A plain note about what an unlock did (e.g. this passkey can now unlock the vault).
  readonly notice: string | null;
}

export type ObtainResult =
  | { readonly kind: "key"; readonly vaultKey: Uint8Array<ArrayBuffer> }
  | { readonly kind: "reveal" };

export interface VaultKeyStepDeps {
  readonly vault: DeviceVault;
  // Whether a passkey unlock may set up a brand-new vault (true when saving something).
  readonly createIfMissing: boolean;
  readonly onChange?: () => void;
}

export interface VaultKeyStep {
  getState(): VaultKeyStepState;
  setMethod(method: UnlockChoice): void;
  setPassphrase(value: string): void;
  setRecoveryPhrase(value: string): void;
  setPhraseSaved(value: boolean): void;
  // With `newPhrase`, always pause on a new phrase after unlocking (replacing the phrase).
  obtain(opts?: { newPhrase?: boolean }): Promise<ObtainResult>;
  confirmPhrase(): Promise<Uint8Array<ArrayBuffer>>;
  cancelPhrase(): void;
}

// Thrown by confirmPhrase when the "I've saved it" tick is missing.
export class PhraseNotSavedError extends Error {
  constructor() {
    super("Tick the box once you've saved your recovery phrase.");
    this.name = "PhraseNotSavedError";
  }
}

export const PHRASE_NOT_SAVED_COPY = "Tick the box once you've saved your recovery phrase.";
const ADOPTED_NOTICE = "This device's passkey can now unlock your vault, so you won't need the phrase here next time.";
const UNSUPPORTED_NOTICE =
  "This device's passkey can't unlock your vault, so use your recovery phrase or vault passphrase here.";
const ADOPT_FAILED_NOTICE =
  "Your vault is unlocked, but this passkey wasn't set up to unlock it. You can use your recovery phrase again next time.";

export function createVaultKeyStep(deps: VaultKeyStepDeps): VaultKeyStep {
  let state: VaultKeyStepState = {
    method: "passkey",
    passphrase: "",
    recoveryPhrase: "",
    newPhrase: null,
    phraseSaved: false,
    notice: null,
  };
  // The vault key waiting for its recovery phrase to be saved (never rendered).
  let pendingKey: Uint8Array<ArrayBuffer> | null = null;

  function set(patch: Partial<VaultKeyStepState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // After a recovery-phrase unlock, re-seal the vault key under this device's passkey
  // (one prompt that also confirms it's you). It never blocks the unlock: whatever
  // happens, the person carries on and is told plainly what to expect next time.
  async function adoptThisPasskey(vaultKey: Uint8Array<ArrayBuffer>): Promise<void> {
    try {
      const outcome = await deps.vault.adoptPasskey(vaultKey);
      set({ notice: outcome === "unsupported" ? UNSUPPORTED_NOTICE : ADOPTED_NOTICE });
    } catch {
      set({ notice: ADOPT_FAILED_NOTICE });
    }
  }

  async function unlock(): Promise<Uint8Array<ArrayBuffer>> {
    switch (state.method) {
      case "passkey":
        return (await deps.vault.unlockWithPasskey({ createIfMissing: deps.createIfMissing })).vaultKey;
      case "passphrase": {
        const passphrase = state.passphrase;
        set({ passphrase: "" });
        return deps.vault.unlockWithPassphrase(passphrase);
      }
      case "recovery": {
        const phrase = state.recoveryPhrase;
        set({ recoveryPhrase: "" });
        const vaultKey = await deps.vault.unlockWithRecoveryPhrase(phrase);
        await adoptThisPasskey(vaultKey);
        return vaultKey;
      }
    }
  }

  async function obtain(opts: { newPhrase?: boolean } = {}): Promise<ObtainResult> {
    set({ notice: null });
    const method = state.method;
    const vaultKey = await unlock();
    // Replacing the phrase always pauses on a new one. Otherwise a phrase unlock proves a
    // phrase exists; any other unlock checks, and a vault with none pauses here on a new
    // phrase before anything is sealed.
    const needsPhrase =
      opts.newPhrase === true || (method !== "recovery" && !(await deps.vault.hasRecoveryPhrase()));
    if (needsPhrase) {
      pendingKey = vaultKey;
      set({ newPhrase: generateRecoveryPhrase(), phraseSaved: false });
      return { kind: "reveal" };
    }
    return { kind: "key", vaultKey };
  }

  async function confirmPhrase(): Promise<Uint8Array<ArrayBuffer>> {
    const vaultKey = pendingKey;
    const phrase = state.newPhrase;
    if (vaultKey === null || phrase === null) throw new Error("there is no recovery phrase to save");
    if (!state.phraseSaved) throw new PhraseNotSavedError();
    // A refusal propagates with the phrase still on screen, so the person can try again.
    await deps.vault.saveRecoveryPhrase(vaultKey, phrase);
    pendingKey = null;
    set({ newPhrase: null, phraseSaved: false });
    return vaultKey;
  }

  function cancelPhrase(): void {
    pendingKey = null;
    set({ newPhrase: null, phraseSaved: false });
  }

  return {
    getState: () => state,
    setMethod: (method) => set({ method }),
    setPassphrase: (value) => set({ passphrase: value }),
    setRecoveryPhrase: (value) => set({ recoveryPhrase: value }),
    setPhraseSaved: (value) => set({ phraseSaved: value }),
    obtain,
    confirmPhrase,
    cancelPhrase,
  };
}

// ─── the views ─────────────────────────────────────────────────────────────────────────

export interface VaultUnlockChoiceProps {
  state: VaultKeyStepState;
  onMethod: (method: UnlockChoice) => void;
  onPassphrase: (value: string) => void;
  onRecoveryPhrase: (value: string) => void;
}

// The unlock-method choice and the one field it needs. A passkey needs no field.
export function VaultUnlockChoice(props: VaultUnlockChoiceProps): React.ReactElement {
  const { state } = props;
  const name = React.useId();
  const passphraseId = React.useId();
  const phraseId = React.useId();
  const options: { value: UnlockChoice; label: string }[] = [
    { value: "passkey", label: "Use your passkey" },
    { value: "passphrase", label: "Use your vault passphrase" },
    { value: "recovery", label: "Use your recovery phrase" },
  ];
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-fg">How would you like to unlock your vault?</legend>
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm text-fg">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={state.method === option.value}
              onChange={() => props.onMethod(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      {state.method === "passphrase" ? (
        <Field
          label="Vault passphrase"
          id={passphraseId}
          type="password"
          autoComplete="off"
          value={state.passphrase}
          onChange={(event) => props.onPassphrase(event.target.value)}
        />
      ) : null}
      {state.method === "recovery" ? (
        <Field
          label="Recovery phrase"
          id={phraseId}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ABCD-EFGH-…"
          value={state.recoveryPhrase}
          onChange={(event) => props.onRecoveryPhrase(event.target.value)}
        />
      ) : null}
    </div>
  );
}

export interface RecoveryPhraseRevealProps {
  phrase: string;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
  onContinue: () => void;
  // Disables Continue while the phrase is being saved.
  working?: boolean;
  error?: string;
  continueLabel?: string;
}

const REVEAL_EXPLAINER =
  "If you ever lose every passkey, this phrase is the only way back into your vault. Write it down or save it somewhere private. Warthog can't see it, and you'll only see it once.";

// Hand the phrase to the browser's download, as a small text file.
function downloadPhrase(phrase: string): void {
  const blob = new Blob([recoveryPhraseFileText(phrase)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "warthog-vault-recovery-phrase.txt";
  link.click();
  URL.revokeObjectURL(url);
}

// The phrase, shown once, with Copy, Download and the "I've saved it" tick.
export function RecoveryPhraseReveal(props: RecoveryPhraseRevealProps): React.ReactElement {
  const headingId = React.useId();
  const tickId = React.useId();
  const [copied, setCopied] = React.useState<"idle" | "copied" | "failed">("idle");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.phrase);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface-muted p-4"
    >
      <h4 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-fg">
        <KeyRound aria-hidden={true} className="h-4 w-4 shrink-0 text-accent" />
        Save your vault recovery phrase
      </h4>
      <p className="text-sm text-fg">{REVEAL_EXPLAINER}</p>
      <p className="break-words rounded-card border border-line bg-surface p-3 font-mono text-base tracking-wider text-fg">
        {props.phrase}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => void copy()}>
          <Copy aria-hidden={true} className="h-4 w-4 shrink-0" />
          Copy
        </Button>
        <Button type="button" variant="secondary" onClick={() => downloadPhrase(props.phrase)}>
          <Download aria-hidden={true} className="h-4 w-4 shrink-0" />
          Download
        </Button>
      </div>
      {copied === "copied" ? (
        <p role="status" className="text-sm text-fg">
          Copied. Paste it somewhere private, then clear your clipboard.
        </p>
      ) : null}
      {copied === "failed" ? (
        <p role="status" className="text-sm text-fg">
          We couldn&apos;t copy it here. Write it down or use Download instead.
        </p>
      ) : null}
      <label htmlFor={tickId} className="flex items-center gap-2 text-sm text-fg">
        <input
          id={tickId}
          type="checkbox"
          checked={props.saved}
          onChange={(event) => props.onSavedChange(event.target.checked)}
        />
        I&apos;ve saved my recovery phrase somewhere safe
      </label>
      {props.error ? (
        <p role="alert" className="text-sm text-danger">
          {props.error}
        </p>
      ) : null}
      <div className="flex">
        <Button type="button" variant="primary" disabled={props.working === true} onClick={props.onContinue}>
          {props.continueLabel ?? "Continue"}
        </Button>
      </div>
    </section>
  );
}
