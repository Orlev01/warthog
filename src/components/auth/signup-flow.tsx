"use client";

import * as React from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import { SignupView, type SignupStep } from "./auth-views";
import { safeReturnPath } from "../../server/auth/return-path";

// E04-S24 — Client sign-up flow.
//
// The interactive BEHAVIOUR lives in a framework-free, injectable controller
// (`createSignupFlow`) so it is testable without a DOM (the "pure logic, testable
// without I/O" convention — React component / E2E testing is a per-job ADR). The
// `SignupFlow` component is a thin binding over the controller: inputs read its
// `state`, buttons call its methods, and a change notifier re-renders.
//
// The controller walks the three sign-up requests (the E04-S10 handler, surfaced over
// HTTP by E04-S23 at POST /api/auth/signup/[step]) and the passkey ceremony between:
//
//   details  → POST send-code      { email }
//   code     → POST verify-email   { email, code }  → keep { signupId, registrationOptions }
//   passkey  → startRegistration({ optionsJSON: registrationOptions })  (@simplewebauthn/browser)
//            → POST register-passkey { signupId, registrationResponse } → show recoveryCode ONCE
//   recovery → POST confirm         { signupId, savedConfirmed: true }  → navigate to /home
//
// The one-time recovery code is held only in memory and shown once: it is never sent
// back to the server (confirm carries only the signupId and the saved confirmation)
// and never written to browser storage.

// The sign-up steps double as the controller's phases (one SignupView step each), so
// the component renders `step={state.phase}` with no mapping. The tests compare phases
// for equality only — the names are free to read however they read best.
export type SignupPhase = SignupStep;

export interface SignupFlowDeps {
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

export interface SignupFlowState {
  readonly phase: SignupPhase;
  readonly name: string;
  readonly email: string;
  readonly code: string;
  readonly savedConfirmed: boolean;
  readonly recoveryCode?: string;
  readonly error?: string;
  readonly working: boolean;
  readonly authenticatorSecret?: string;
  readonly authenticatorQr?: string;
}

export interface SignupFlowController {
  getState(): SignupFlowState;
  setName(value: string): void;
  setEmail(value: string): void;
  setCode(value: string): void;
  setSavedConfirmed(value: boolean): void;
  submitEmail(): Promise<void>;
  submitCode(): Promise<void>;
  createPasskey(): Promise<void>;
  useAuthenticatorApp(): Promise<void>;
  submitAuthenticatorCode(): Promise<void>;
  confirm(): Promise<void>;
}

const API_BASE = "/api/auth/signup";

type StepPath = "send-code" | "verify-email" | "register-passkey" | "begin-totp" | "verify-totp" | "confirm";

// Plain-English copy for a failed step — a real sentence a person can act on, never a
// raw machine code (the server speaks `invalid_code`, `bad_attestation`, …) and never
// protocol/security jargon (brief design_ux.copy; constitution INV-22).
function stepErrorCopy(step: StepPath): string {
  switch (step) {
    case "send-code":
      return "We couldn't send a code to that email address. Check it and try again.";
    case "verify-email":
      return "That code didn't match. Check the code from your email and try again.";
    case "register-passkey":
      return "We couldn't set up your passkey. Please try again.";
    case "confirm":
      return "We couldn't finish creating your account. Please try again.";
    case "begin-totp":
      return "We couldn't start authenticator setup. Please try again.";
    case "verify-totp":
      return "That authenticator code didn't match. Check your app and try a fresh code.";
  }
}

// A send-code refused because this address was sent a code moments ago (429).
const CODE_THROTTLED_COPY =
  "We sent a code to this address a moment ago. Check your email, or wait a minute and try again.";

// Confirm found the address already has an account (409).
const ACCOUNT_EXISTS_COPY =
  "There's already an account for this email address. Sign in instead, or recover your account if you've lost your passkey.";

const PASSKEY_CANCELLED_COPY =
  "Setting up your passkey was cancelled. You can try again when you're ready.";

export function createSignupFlow(deps: SignupFlowDeps): SignupFlowController {
  // The one-time code and the registration options are kept in these closures, never
  // in the rendered snapshot — the recovery code reaches the view (shown once) but the
  // signup handle / options never do.
  let signupId: string | undefined;
  let registrationOptions: PublicKeyCredentialCreationOptionsJSON | undefined;

  let state: SignupFlowState = {
    phase: "details",
    name: "",
    email: "",
    code: "",
    savedConfirmed: false,
    working: false,
  };

  function set(patch: Partial<SignupFlowState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // POST a JSON body to a sign-up step. A thrown fetch (offline) is reported as a step
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

  async function submitEmail(): Promise<void> {
    const response = await post("send-code", { email: state.email, name: state.name });
    if (!response || !response.ok) {
      set({ error: response?.status === 429 ? CODE_THROTTLED_COPY : stepErrorCopy("send-code") });
      return;
    }
    set({ phase: "code", error: undefined });
  }

  async function submitCode(): Promise<void> {
    const response = await post("verify-email", { email: state.email, code: state.code });
    if (!response || !response.ok) {
      set({ error: stepErrorCopy("verify-email") });
      return;
    }
    const body = await readJson(response);
    signupId = typeof body.signupId === "string" ? body.signupId : undefined;
    registrationOptions = body.registrationOptions as PublicKeyCredentialCreationOptionsJSON | undefined;
    set({ phase: "passkey", error: undefined });
  }

  async function createPasskey(): Promise<void> {
    if (signupId === undefined || registrationOptions === undefined) {
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

    const response = await post("register-passkey", { signupId, registrationResponse });
    if (!response || !response.ok) {
      set({ error: stepErrorCopy("register-passkey") });
      return;
    }
    const body = await readJson(response);
    const recoveryCode = typeof body.recoveryCode === "string" ? body.recoveryCode : undefined;
    set({ phase: "recovery", recoveryCode, error: undefined });
  }

  async function confirm(): Promise<void> {
    // Gated on the "I have saved it" tick (the view disables Continue until then); a
    // call while unticked changes nothing — stays put, keeps the code shown.
    if (!state.savedConfirmed) return;
    if (signupId === undefined) {
      set({ error: stepErrorCopy("confirm") });
      return;
    }

    const response = await post("confirm", { signupId, savedConfirmed: true });
    if (!response || !response.ok) {
      set({ error: response?.status === 409 ? ACCOUNT_EXISTS_COPY : stepErrorCopy("confirm") });
      return;
    }
    set({ error: undefined });
    deps.navigate(safeReturnPath(deps.returnTo));
  }

  async function useAuthenticatorApp(): Promise<void> {
    if (!signupId) { set({ error: stepErrorCopy("begin-totp") }); return; }
    const response = await post("begin-totp", { signupId });
    if (!response?.ok) { set({ error: stepErrorCopy("begin-totp") }); return; }
    const result = await readJson(response);
    if (typeof result.secret !== "string" || !result.secret || typeof result.qr !== "string" || !result.qr.startsWith("data:image/png;base64,")) {
      set({ error: stepErrorCopy("begin-totp") }); return;
    }
    set({ phase: "authenticator", authenticatorSecret: result.secret, authenticatorQr: result.qr, code: "", error: undefined });
  }

  async function submitAuthenticatorCode(): Promise<void> {
    if (!signupId) { set({ error: stepErrorCopy("verify-totp") }); return; }
    const response = await post("verify-totp", { signupId, totp: state.code });
    if (!response?.ok) {
      set({ error: response?.status === 429
        ? "Too many incorrect codes. Start signup again to set up your authenticator safely."
        : stepErrorCopy("verify-totp") }); return;
    }
    const result = await readJson(response);
    if (typeof result.recoveryCode !== "string" || !result.recoveryCode) { set({ error: stepErrorCopy("verify-totp") }); return; }
    set({ phase: "recovery", recoveryCode: result.recoveryCode, authenticatorSecret: undefined, authenticatorQr: undefined, code: "", savedConfirmed: false, error: undefined });
  }

  async function transition(action: () => Promise<void>): Promise<void> {
    if (state.working) return;
    set({ working: true });
    try { await action(); } finally { set({ working: false }); }
  }
  const edit = (patch: Partial<SignupFlowState>) => { if (!state.working) set(patch); };

  return {
    getState: () => state,
    setName: (value) => edit({ name: value }),
    setEmail: (value) => edit({ email: value }),
    setCode: (value) => edit({ code: value }),
    setSavedConfirmed: (value) => edit({ savedConfirmed: value }),
    submitEmail: () => transition(submitEmail),
    submitCode: () => transition(submitCode),
    createPasskey: () => transition(createPasskey),
    useAuthenticatorApp: () => transition(useAuthenticatorApp),
    submitAuthenticatorCode: () => transition(submitAuthenticatorCode),
    confirm: () => transition(confirm),
  };
}

// --- the client component (a thin binding over the controller) --------------

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

export interface SignupFlowProps {
  // The real browser seams, with optional overrides so the flow can be driven with
  // fakes. The page mounts it with no props.
  readonly fetch?: typeof fetch;
  readonly startRegistration?: SignupFlowDeps["startRegistration"];
  readonly navigate?: (path: string) => void;
  // The validated return path the page read from `?next=`.
  readonly returnTo?: string;
}

export function SignupFlow(props: SignupFlowProps = {}): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<SignupFlowController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createSignupFlow({
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
    <SignupView
      returnTo={props.returnTo}
      step={state.phase}
      name={state.name}
      email={state.email}
      code={state.code}
      recoveryCode={state.recoveryCode}
      savedConfirmed={state.savedConfirmed}
      error={state.error}
      working={state.working}
      authenticatorSecret={state.authenticatorSecret}
      authenticatorQr={state.authenticatorQr}
      onUseAuthenticatorApp={() => { void flow.useAuthenticatorApp(); }}
      onNameChange={(value) => flow.setName(value)}
      onEmailChange={(value) => flow.setEmail(value)}
      onCodeChange={(value) => flow.setCode(value)}
      onSavedConfirmedChange={(value) => flow.setSavedConfirmed(value)}
      onSubmit={() => {
        void (state.phase === "details" ? flow.submitEmail()
          : state.phase === "authenticator" ? flow.submitAuthenticatorCode() : flow.submitCode());
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

export default SignupFlow;
