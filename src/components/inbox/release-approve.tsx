"use client";

import * as React from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ShieldAlert } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { unlockVault, type UnlockRequest } from "@/client/vault/unlock";
import { decryptValue } from "@/client/vault/values";
import { postRelease } from "@/client/vault/release";
import {
  createReleaseFlow,
  type ReleaseFlow,
  type PendingRequestView,
  type SavedCardView,
} from "./inbox-view";

// E11-S17 — Approve and release: the on-device card / high-tier release control
// (brief "High-tier release" / "Card requests"; design §4.2 "Release"; constitution 17
// "no readable card numbers or security codes on Warthog's side" + 18 "approvals only
// inside the signed-in app").
//
// The inbox used to render a card / high-tier release's "Approve and release" DISABLED
// with a reason, because a signed-in server page cannot hand a React client a callback,
// so its on-device flow was never wired. This module is that self-wired CLIENT control.
// On this device it unlocks the vault key (passkey PRF, or a vault passphrase), decrypts
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

export type ReleaseMethod = "passkey" | "passphrase";

// The control's own status alongside the person's entries: idle until they submit,
// `working` while the hand-over runs, then `released` or `error`.
export type ReleaseStatus = "idle" | "working" | "released" | "error";

export interface ReleaseApproveState {
  method: ReleaseMethod;
  passphrase: string;
  cardId?: string;
  securityCode: string;
  status: ReleaseStatus;
  error?: string;
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
  // Optional: re-render notifier (the component wires it) and a one-shot completion signal.
  readonly onChange?: () => void;
  readonly onReleased?: () => void;
}

export interface ReleaseApproveController {
  getState(): ReleaseApproveState;
  setMethod(method: ReleaseMethod): void;
  setPassphrase(value: string): void;
  setCardId(cardId: string): void;
  setSecurityCode(value: string): void;
  submit(): Promise<void>;
}

// Plain-English failure copy for a unlock the device could not gather — a real sentence a
// person can act on, with no crypto / protocol jargon and never the released value, the
// security code or the passphrase (brief design_ux.copy; constitution 18 / INV-22). A
// failure that happens INSIDE releaseFlow already carries its own plain copy, surfaced
// unchanged.
const UNLOCK_FAILED_COPY =
  "We couldn't unlock your vault on this device. Check how you unlocked it, then try again.";

export function createReleaseApproveFlow(deps: ReleaseApproveFlowDeps): ReleaseApproveController {
  const isCard = deps.request.release === "card";

  let state: ReleaseApproveState = {
    method: "passkey",
    passphrase: "",
    cardId: deps.savedCards?.[0]?.id,
    securityCode: "",
    status: "idle",
  };

  function set(patch: Partial<ReleaseApproveState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // Gather the opaque unlock material for the chosen method; the controller passes it
  // straight to releaseFlow and never inspects it.
  function gatherUnlock(): UnlockRequest | Promise<UnlockRequest> {
    return state.method === "passkey"
      ? deps.unlockByPasskey()
      : deps.unlockByPassphrase(state.passphrase);
  }

  // The stored ciphertext this release decrypts: a card release decrypts the CHOSEN saved
  // card (defaulting to the first offered when the picker is untouched); a high-tier
  // release decrypts the requested value's ciphertext.
  function ciphertextToRelease(): string {
    if (!isCard) return deps.highTierCiphertext ?? "";
    const cards = deps.savedCards ?? [];
    const chosen = cards.find((card) => card.id === state.cardId) ?? cards[0];
    return chosen?.ciphertext ?? "";
  }

  async function submit(): Promise<void> {
    set({ status: "working", error: undefined });

    // 1. Gather the unlock material by the chosen method. A cancelled passkey prompt (or
    //    an unusable passphrase) rejects here: nothing is released and the person is told
    //    in plain words — the request stays on the screen.
    let unlockRequest: UnlockRequest;
    try {
      unlockRequest = await gatherUnlock();
    } catch {
      // Nothing was released; the secrets entered for this attempt are not kept.
      set({ status: "error", error: UNLOCK_FAILED_COPY, passphrase: "", securityCode: "" });
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
    });

    // Whatever the outcome, the passphrase and security code entered for this attempt are
    // cleared from state at once (a retry asks for them again).
    if (result.ok) {
      set({ status: "released", error: undefined, passphrase: "", securityCode: "" });
      deps.onReleased?.();
    } else {
      set({ status: "error", error: result.error, passphrase: "", securityCode: "" });
    }
  }

  return {
    getState: () => state,
    setMethod: (method) => set({ method }),
    setPassphrase: (value) => set({ passphrase: value }),
    setCardId: (cardId) => set({ cardId }),
    setSecurityCode: (value) => set({ securityCode: value }),
    submit,
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

async function fetchUnlockMaterial(method: "passkey_prf" | "passphrase"): Promise<ServerUnlockMaterial> {
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
  const assertion = await startAuthentication({ optionsJSON: material.options });
  const prf = (
    assertion as { clientExtensionResults?: { prf?: { results?: { first?: string } } } }
  ).clientExtensionResults?.prf?.results?.first;
  if (typeof prf !== "string") {
    throw new Error("this passkey can't unlock your vault");
  }
  return { method: "prf", material: { wrapped: material.wrapped }, secret: base64UrlToBytes(prf) };
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
  onReleased?: () => void;
}

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
      onChange: () => forceUpdate(),
      onReleased: props.onReleased,
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  const isCard = request.release === "card";
  const cards = savedCards ?? [];
  const cardFieldId = React.useId();
  const codeFieldId = React.useId();
  const passphraseFieldId = React.useId();
  const methodName = React.useId();

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

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.status === "released" ? (
        <p role="status" className="text-sm text-success">
          Handed over — the agent can collect it once.
        </p>
      ) : null}

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
    </div>
  );
}

export default ReleaseApprove;
