"use client";

import * as React from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import { RecoverView, type RecoverStep } from "./auth-views";

// E04-S33 — Client account recovery flow.
//
// The interactive BEHAVIOUR lives in a framework-free, injectable controller
// (`createRecoverFlow`) so it is testable without a DOM (the "pure logic, testable
// without I/O" convention — React component / E2E testing is a per-job ADR). The
// `RecoverFlow` component is a thin binding over the controller: inputs read its
// `state`, buttons call its methods, and a change notifier re-renders.
//
// The controller walks a person who has lost every device through the four recovery
// requests (the E04-S29 handler, surfaced over HTTP by E04-S30 at
// POST /api/auth/recover/[step]) and the passkey ceremony between:
//
//   identify       → POST identify        { email }            → keep { recoveryId }
//   recovery code  → POST verify-code      { recoveryId, recoveryCode }
//                    → keep { registrationOptions }
//   new passkey    → startRegistration({ optionsJSON: registrationOptions })
//                    → POST register-passkey { recoveryId, registrationResponse }
//                    → show the returned (NEW) recoveryCode ONCE
//   new recovery   → the person ticks "I've saved it"
//                    → POST finish          { recoveryId }      → navigate to /home
//
// Two recovery codes exist in this flow and they are kept distinct: the EXISTING code
// the person TYPES at the recovery-code step (legitimately posted to verify-code), and
// the NEW shown-once code the server returns at register-passkey. The new code is held
// only in memory and shown once — it is never sent back to the server (finish carries
// only the recoveryId) and never written to browser storage.

// The recovery steps double as the controller's phases (one RecoverView step each), so
// the component renders `step={state.phase}` with no mapping. The tests compare phases
// for equality only — the names are free to read however they read best.
export type RecoverPhase = RecoverStep;

export interface RecoverFlowDeps {
  readonly fetch: typeof fetch;
  readonly startRegistration: (opts: {
    optionsJSON: PublicKeyCredentialCreationOptionsJSON;
    useAutoRegister?: boolean;
  }) => Promise<RegistrationResponseJSON>;
  readonly navigate: (path: string) => void;
  // Optional: the component wires this to re-render after each state change. The
  // controller works standalone (the unit tests) when it is omitted.
  readonly onChange?: () => void;
}

export interface RecoverFlowState {
  readonly phase: RecoverPhase;
  readonly email: string;
  // The EXISTING saved recovery code the person types at the recovery-code step.
  readonly recoveryCode: string;
  readonly savedConfirmed: boolean;
  // The shown-once NEW recovery code returned by register-passkey.
  readonly newRecoveryCode?: string;
  readonly error?: string;
}

export interface RecoverFlowController {
  getState(): RecoverFlowState;
  setEmail(value: string): void;
  setRecoveryCode(value: string): void;
  setSavedConfirmed(value: boolean): void;
  submitIdentify(): Promise<void>;
  submitRecoveryCode(): Promise<void>;
  createPasskey(): Promise<void>;
  confirm(): Promise<void>;
}

const API_BASE = "/api/auth/recover";

type StepPath = "identify" | "verify-code" | "register-passkey" | "finish";

// Plain-English copy for a failed step — a real sentence a person can act on, never a
// raw machine code (the server speaks `invalid_code`, `unknown_recovery`,
// `bad_attestation`, `no_second_factor`, `forbidden`, …) and never protocol/security
// jargon (brief design_ux.copy; constitution INV-22). identify reveals nothing about
// whether the email has an account (the server answers the same either way), so its
// copy makes no account-existence claim.
function stepErrorCopy(step: StepPath): string {
  switch (step) {
    case "identify":
      return "We couldn't start recovering your account. Check your email address and try again.";
    case "verify-code":
      return "That recovery code didn't match. Check the code you saved and try again.";
    case "register-passkey":
      return "We couldn't set up your new passkey. Please try again.";
    case "finish":
      return "We couldn't finish recovering your account. Please try again.";
  }
}

const PASSKEY_CANCELLED_COPY =
  "Setting up your new passkey was cancelled. You can try again when you're ready.";

export function createRecoverFlow(deps: RecoverFlowDeps): RecoverFlowController {
  // The pending-recovery handle and the registration options are kept in these
  // closures, never in the rendered snapshot — they are machinery the person never sees.
  let recoveryId: string | undefined;
  let registrationOptions: PublicKeyCredentialCreationOptionsJSON | undefined;

  let state: RecoverFlowState = {
    phase: "identify",
    email: "",
    recoveryCode: "",
    savedConfirmed: false,
  };

  function set(patch: Partial<RecoverFlowState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // POST a JSON body to a recovery step. A thrown fetch (offline) is reported as a step
  // failure rather than crashing the flow — never fail silently.
  async function post(step: StepPath, body: unknown): Promise<Response | null> {
    try {
      return await deps.fetch(`${API_BASE}/${step}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return null;
    }
  }

  async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async function submitIdentify(): Promise<void> {
    const response = await post("identify", { email: state.email });
    if (!response || !response.ok) {
      set({ error: stepErrorCopy("identify") });
      return;
    }
    const body = await readJson(response);
    recoveryId = typeof body.recoveryId === "string" ? body.recoveryId : undefined;
    set({ phase: "recovery-code", error: undefined });
  }

  async function submitRecoveryCode(): Promise<void> {
    if (recoveryId === undefined) {
      set({ error: stepErrorCopy("verify-code") });
      return;
    }
    const response = await post("verify-code", {
      recoveryId,
      recoveryCode: state.recoveryCode,
    });
    if (!response || !response.ok) {
      set({ error: stepErrorCopy("verify-code") });
      return;
    }
    const body = await readJson(response);
    registrationOptions = body.registrationOptions as
      | PublicKeyCredentialCreationOptionsJSON
      | undefined;
    set({ phase: "passkey", error: undefined });
  }

  async function createPasskey(): Promise<void> {
    if (recoveryId === undefined || registrationOptions === undefined) {
      set({ error: stepErrorCopy("register-passkey") });
      return;
    }

    // The OS passkey prompt. A dismissed / timed-out prompt rejects here: stay on the
    // step with a plain message and a retry, and post NOTHING to the server.
    let registrationResponse: RegistrationResponseJSON;
    try {
      registrationResponse = await deps.startRegistration({ optionsJSON: registrationOptions });
    } catch {
      set({ error: PASSKEY_CANCELLED_COPY });
      return;
    }

    const response = await post("register-passkey", { recoveryId, registrationResponse });
    if (!response || !response.ok) {
      set({ error: stepErrorCopy("register-passkey") });
      return;
    }
    const body = await readJson(response);
    const newRecoveryCode = typeof body.recoveryCode === "string" ? body.recoveryCode : undefined;
    set({ phase: "new-recovery", newRecoveryCode, error: undefined });
  }

  async function confirm(): Promise<void> {
    // Gated on the "I've saved it" tick (the view disables Continue until then); a call
    // while unticked changes nothing — stays put, keeps the new code shown.
    if (!state.savedConfirmed) return;
    if (recoveryId === undefined) {
      set({ error: stepErrorCopy("finish") });
      return;
    }

    // finish carries only the recoveryId — the NEW recovery code is never sent back.
    const response = await post("finish", { recoveryId });
    if (!response || !response.ok) {
      set({ error: stepErrorCopy("finish") });
      return;
    }
    set({ error: undefined });
    deps.navigate("/home");
  }

  return {
    getState: () => state,
    setEmail: (value) => set({ email: value }),
    setRecoveryCode: (value) => set({ recoveryCode: value }),
    setSavedConfirmed: (value) => set({ savedConfirmed: value }),
    submitIdentify,
    submitRecoveryCode,
    createPasskey,
    confirm,
  };
}

// --- the client component (a thin binding over the controller) --------------

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

export interface RecoverFlowProps {
  // The real browser seams, with optional overrides so the flow can be driven with
  // fakes. The page mounts it with no props.
  readonly fetch?: typeof fetch;
  readonly startRegistration?: RecoverFlowDeps["startRegistration"];
  readonly navigate?: (path: string) => void;
}

export function RecoverFlow(props: RecoverFlowProps = {}): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<RecoverFlowController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createRecoverFlow({
      fetch: props.fetch ?? defaultFetch,
      startRegistration: props.startRegistration ?? startRegistration,
      navigate: props.navigate ?? defaultNavigate,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  return (
    <RecoverView
      step={state.phase}
      email={state.email}
      recoveryCodeValue={state.recoveryCode}
      recoveryCode={state.newRecoveryCode}
      savedConfirmed={state.savedConfirmed}
      error={state.error}
      onEmailChange={(value) => flow.setEmail(value)}
      onRecoveryCodeChange={(value) => flow.setRecoveryCode(value)}
      onSavedConfirmedChange={(value) => flow.setSavedConfirmed(value)}
      onSubmitIdentify={() => {
        void flow.submitIdentify();
      }}
      onSubmitRecoveryCode={() => {
        void flow.submitRecoveryCode();
      }}
      onCreatePasskey={() => {
        void flow.createPasskey();
      }}
      onConfirm={() => {
        void flow.confirm();
      }}
    />
  );
}

export default RecoverFlow;
