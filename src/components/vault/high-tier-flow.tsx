"use client";

import * as React from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ArrowUp, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { SensitiveNotice } from "@/components/ui/sensitive-notice";
import { deriveWrappingKeyFromPrf } from "@/client/vault/derive";
import { createVaultKey, wrapVaultKey, unwrapVaultKey } from "@/client/vault/key";
import { sealHighTierDetail, type HighTierFieldType } from "./identity-view";

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
// `working` while the device flow runs, then `saved` or `error`.
export type HighTierStatus = "idle" | "working" | "saved" | "error";

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
}

// The unlock endpoints (the device-unlock methods the endpoints serve).
const UNLOCK_MATERIAL_BASE = "/api/vault/unlock-material";
const UNLOCK_METHOD_URL = "/api/vault/unlock-method";

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

// The server's non-secret unlock material for a method (design §4.2 getUnlockMaterial):
// the wrapped VK envelope (null when none is set), the method's public params and the
// passkey assertion options whose PRF extension is eval'd with the person's salt.
type ServerUnlockMaterial = {
  readonly wrapped: string | null;
  readonly params?: Record<string, unknown> | null;
  readonly options?: unknown;
};

// WebCrypto base64url → bytes (browser `atob`, never Node's Buffer). A WebAuthn PRF
// result is base64url.
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
    method: "passkey_prf";
    wrapped: string;
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
  // key is created, wrapped under the passkey PRF and saved; on later use the existing
  // envelope is unwrapped — no new key, no save. Either way the passkey ceremony runs so
  // its PRF is available.
  async function ensureVaultKey(): Promise<Uint8Array<ArrayBuffer>> {
    const material = await fetchPasskeyMaterial();
    const wrappingKey = await wrappingKeyFromPasskey(material.options);

    if (material.wrapped != null) {
      return unwrapVaultKey(wrappingKey, material.wrapped);
    }

    // First use on this account: create the key and save it wrapped under the passkey.
    const vaultKey = deps.createVaultKey() as Uint8Array<ArrayBuffer>;
    await saveUnlockMethod({ method: "passkey_prf", wrapped: await wrapVaultKey(wrappingKey, vaultKey) });
    return vaultKey;
  }

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

  async function submit(): Promise<void> {
    if (state.status === "working") return; // guard against a double confirm
    set({ status: "working", error: undefined });

    // 1. Set up / unlock the vault key, then seal the value — all on this device. A
    //    cancelled prompt, an unreachable endpoint or a tampered envelope lands here: the
    //    person is told in plain words and nothing leaves the device.
    let submission: { type: HighTierFieldType; label: string; ciphertext: string };
    try {
      const vaultKey = await ensureVaultKey();
      submission = await sealHighTierDetail(vaultKey, {
        type: state.type as HighTierFieldType,
        label: state.label,
        value: state.value,
      });
    } catch {
      set({ status: "error", error: SETUP_FAILED_COPY });
      return;
    }

    // 2. Submit ONLY the ciphertext + metadata to the page's action. A refusal comes back
    //    with its own machine reason, which we never surface raw — plain copy instead.
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

  return {
    getState: () => state,
    setType: (value) => set({ type: value }),
    setLabel: (value) => set({ label: value }),
    setValue: (value) => set({ value }),
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

// ─── copy (plain Australian English; no protocol jargon) ───────────────────────────────

// The sensitive-moment explainer: HOW the detail is protected (locked on the device,
// never readable by Warthog) and WHO can ever read it (only the person, only when they
// approve a release).
const PROTECTION_EXPLAINER =
  "This detail is locked on your device with your vault key before it is saved — only the sealed version ever leaves, and Warthog can never read it. It is released only when you approve it for one agent at one moment; no one else, not even Warthog's team, can ever see it.";

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
  const isRaise = props.mode === "raise";

  // Call every hook unconditionally (rules of hooks), even though the closed panel uses none.
  const labelId = React.useId();
  const valueId = React.useId();

  if (!open) {
    return (
      <div className="flex">
        <Button
          variant={isRaise ? "secondary" : "primary"}
          type="button"
          onClick={() => setOpen(true)}
        >
          {isRaise ? (
            <ArrowUp aria-hidden={true} className="h-4 w-4 shrink-0" />
          ) : (
            <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
          )}
          {isRaise ? "Raise to high tier" : "Add a high-tier detail"}
        </Button>
      </div>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-fg">
        {isRaise ? "Raise to high tier" : "Add a high-tier detail"}
      </h3>

      {isRaise ? null : (
        <>
          <Field
            label="What is it?"
            id={labelId}
            placeholder="e.g. Passport"
            value={state.label}
            onChange={(event) => flow.setLabel(event.target.value)}
          />
          <Field
            label="The detail"
            id={valueId}
            autoComplete="off"
            placeholder="Type the detail to protect"
            value={state.value}
            onChange={(event) => flow.setValue(event.target.value)}
          />
        </>
      )}

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.status === "saved" ? (
        <p role="status" className="text-sm text-success">
          Your detail is saved.
        </p>
      ) : null}

      <SensitiveNotice
        explanation={PROTECTION_EXPLAINER}
        onConfirm={() => {
          void flow.submit();
        }}
      />
    </Card>
  );
}

export default HighTierFlow;
