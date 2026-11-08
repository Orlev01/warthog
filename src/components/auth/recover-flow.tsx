"use client";

import * as React from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import { RecoverView, type RecoverStep } from "./auth-views";
import { safeReturnPath } from "../../server/auth/return-path";

// E04-S33 — Client account recovery flow.
//
// The interactive BEHAVIOUR lives in a framework-free, injectable controller
// (`createRecoverFlow`) so it is testable without a DOM (the "pure logic, testable
// without I/O" convention — React component / E2E testing is a per-job ADR). The
// `RecoverFlow` component is a thin binding over the controller: inputs read its
// `state`, buttons call its methods, and a change notifier re-renders.
//
// The controller walks a person who has lost every device through the five recovery
// requests (the E04-S29 handler, surfaced over HTTP by E04-S30 at
// POST /api/auth/recover/[step]) and the passkey ceremony between. Recovery is "email
// code plus recovery code" (brief; review fix B2), so the emailed code comes first:
//
//   identify       → POST identify        { email }            → keep { recoveryId }
//   email code     → POST verify-email     { recoveryId, code }
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
  // Where to go after success: the page's validated `?next=` (review fix B6). It is
  // checked again here, and anything unsafe — or nothing — means /home.
  readonly returnTo?: string;
  // Optional: the component wires this to re-render after each state change. The
  // controller works standalone (the unit tests) when it is omitted.
  readonly onChange?: () => void;
}

export interface RecoverFlowState {
  readonly phase: RecoverPhase;
  readonly email: string;
  // The one-time code from the email identify sent.
  readonly emailCode: string;
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
  setEmailCode(value: string): void;
  setRecoveryCode(value: string): void;
  setSavedConfirmed(value: boolean): void;
  submitIdentify(): Promise<void>;
  submitEmailCode(): Promise<void>;
  submitRecoveryCode(): Promise<void>;
  createPasskey(): Promise<void>;
  confirm(): Promise<void>;
}

const API_BASE = "/api/auth/recover";

type StepPath = "identify" | "verify-email" | "verify-code" | "register-passkey" | "finish";

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
    case "verify-email":
      return "That code didn't match. Check the code from your email and try again.";
    case "verify-code":
      return "That recovery code didn't match. Check the code you saved and try again.";
    case "register-passkey":
      return "We couldn't set up your new passkey. Please try again.";
    case "finish":
      return "We couldn't finish recovering your account. Please try again.";
  }
}

// Too many wrong email codes for this address in a short time (429).
const EMAIL_CODE_THROTTLED_COPY =
  "Too many tries with that code. Please wait a few minutes, then try again.";

// The recovery was closed after too many wrong recovery codes (429): start again.
const RECOVERY_CLOSED_COPY =
  "That recovery code didn't match too many times. Start again, and we'll email you a new code.";

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
    emailCode: "",
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
    set({ phase: "email-code", error: undefined });
  }

  async function submitEmailCode(): Promise<void> {
    if (recoveryId === undefined) {
      set({ error: stepErrorCopy("verify-email") });
      return;
    }
    const response = await post("verify-email", { recoveryId, code: state.emailCode });
    if (!response || !response.ok) {
      set({
        error: response?.status === 429 ? EMAIL_CODE_THROTTLED_COPY : stepErrorCopy("verify-email"),
      });
      return;
    }
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
    if (response?.status === 429) {
      // The server closed this recovery: begin again from the email step.
      recoveryId = undefined;
      set({ phase: "identify", emailCode: "", recoveryCode: "", error: RECOVERY_CLOSED_COPY });
      return;
    }
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
    deps.navigate(safeReturnPath(deps.returnTo));
  }

  return {
    getState: () => state,
    setEmail: (value) => set({ email: value }),
    setEmailCode: (value) => set({ emailCode: value }),
    setRecoveryCode: (value) => set({ recoveryCode: value }),
    setSavedConfirmed: (value) => set({ savedConfirmed: value }),
    submitIdentify,
    submitEmailCode,
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
  // The validated return path the page read from `?next=`.
  readonly returnTo?: string;
}

export function RecoverFlow(props: RecoverFlowProps = {}): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<RecoverFlowController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createRecoverFlow({
      fetch: props.fetch ?? defaultFetch,
      startRegistration: props.startRegistration ?? startRegistration,
      navigate: props.navigate ?? defaultNavigate,
      returnTo: props.returnTo,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  return (
    <RecoverView
      returnTo={props.returnTo}
      step={state.phase}
      email={state.email}
      emailCode={state.emailCode}
      recoveryCodeValue={state.recoveryCode}
      recoveryCode={state.newRecoveryCode}
      savedConfirmed={state.savedConfirmed}
      error={state.error}
      onEmailChange={(value) => flow.setEmail(value)}
      onEmailCodeChange={(value) => flow.setEmailCode(value)}
      onRecoveryCodeChange={(value) => flow.setRecoveryCode(value)}
      onSavedConfirmedChange={(value) => flow.setSavedConfirmed(value)}
      onSubmitIdentify={() => {
        void flow.submitIdentify();
      }}
      onSubmitEmailCode={() => {
        void flow.submitEmailCode();
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
