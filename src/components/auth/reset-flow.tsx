"use client";

import * as React from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import { ResetView, type ResetStep } from "./auth-views";

// Review fix W3.3 — the client account-reset flow, for a person who has lost every passkey
// AND the recovery code. The behaviour lives in a framework-free, injectable controller
// (`createResetFlow`, the recover-flow pattern) so it is testable without a DOM; the
// `ResetFlow` component is a thin binding over it.
//
//   identify    → POST send-code { email }        (the same answer for any address)
//   email code  → POST request   { email, code }  → keep { completesAt }
//   requested   → the reset has started; it finishes on completesAt
//
// The emailed code is posted once, to the request step, and kept nowhere else.
//
// Review fix W5 — in "setup" mode (the /reset/setup page: "Reset finished? Set up a new
// passkey") the same controller walks a person whose reset has finished back in:
//
//   setup-identify   → POST setup-send-code { email }   (the same answer for any address)
//   setup-email-code → POST setup-verify    { email, code } → keep { setupId, options }
//   setup-passkey    → startRegistration({ optionsJSON })
//                      → POST setup-finish  { setupId, registrationResponse }
//                      → the NEW recovery code, shown once (the session cookie is set)
//   setup-recovery   → the person ticks "I've saved it" → /home
//
// The set-up handle and the options stay in closures, never in the rendered state; the
// new recovery code is held only in memory, never sent back or stored, and dropped once
// the person has saved it.

export interface ResetFlowDeps {
  readonly fetch: typeof fetch;
  // "reset" (the default) starts a reset; "setup" sets up a new passkey after one.
  readonly mode?: "reset" | "setup";
  // The browser passkey ceremony and navigation, used only by the set-up.
  readonly startRegistration?: (opts: {
    optionsJSON: PublicKeyCredentialCreationOptionsJSON;
  }) => Promise<RegistrationResponseJSON>;
  readonly navigate?: (path: string) => void;
  // Optional: the component wires this to re-render after each change.
  readonly onChange?: () => void;
}

export interface ResetFlowState {
  readonly busy: boolean;
  readonly phase: ResetStep;
  readonly email: string;
  readonly emailCode: string;
  readonly completesAt?: string;
  readonly savedConfirmed: boolean;
  // The shown-once NEW recovery code returned by setup-finish.
  readonly newRecoveryCode?: string;
  readonly error?: string;
}

export interface ResetFlowController {
  getState(): ResetFlowState;
  setEmail(value: string): void;
  setEmailCode(value: string): void;
  setSavedConfirmed(value: boolean): void;
  submitIdentify(): Promise<void>;
  submitEmailCode(): Promise<void>;
  createPasskey(): Promise<void>;
  confirm(): Promise<void>;
  // Back to the email step to change the address. Client-side only: it sends nothing.
  changeEmail(): void;
}

const API_BASE = "/api/auth/reset";
const HOME_PATH = "/home";

type StepPath = "send-code" | "request" | "setup-send-code" | "setup-verify" | "setup-finish";

// Plain sentences for a failed step (never the server's machine codes).
const SEND_FAILED_COPY = "We couldn't send a code just now. Check your email address and try again.";
const CODE_MISMATCH_COPY = "That code didn't match. Check the code from your email and try again.";
const REQUEST_FAILED_COPY = "We couldn't start the reset just now. Please try again in a few minutes.";
const THROTTLED_COPY = "Too many tries with that code. Please wait a few minutes, then try again.";
const NO_FINISHED_RESET_COPY =
  "There's no finished reset for that account. A reset finishes 7 days after you ask for it.";
const VERIFY_FAILED_COPY = "We couldn't check that code just now. Please try again in a few minutes.";
const PASSKEY_CANCELLED_COPY =
  "Creating your passkey was cancelled. You can try again when you're ready.";
const SETUP_FAILED_COPY =
  "We couldn't set up your new passkey. Please start again, and we'll email you a new code.";

export function createResetFlow(deps: ResetFlowDeps): ResetFlowController {
  const setup = deps.mode === "setup";
  // The set-up handle and the registration options: machinery the person never sees.
  let setupId: string | undefined;
  let registrationOptions: PublicKeyCredentialCreationOptionsJSON | undefined;

  let state: ResetFlowState = {
    busy: false,
    phase: setup ? "setup-identify" : "identify",
    email: "",
    emailCode: "",
    savedConfirmed: false,
  };

  function set(patch: Partial<ResetFlowState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  async function run(action: () => Promise<void>, failure: string): Promise<void> {
    if (state.busy) return;
    set({ busy: true, error: undefined });
    try {
      await action();
    } catch {
      set({ error: failure });
    } finally {
      set({ busy: false });
    }
  }

  // POST a JSON body to a reset step; a thrown fetch (offline) is a failed step, not a crash.
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
      const body: unknown = await response.json();
      return body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  async function submitIdentify(): Promise<void> {
    const response = await post(setup ? "setup-send-code" : "send-code", { email: state.email });
    if (!response || !response.ok) {
      set({ error: SEND_FAILED_COPY });
      return;
    }
    set({ phase: setup ? "setup-email-code" : "email-code", error: undefined });
  }

  async function submitSetupEmailCode(): Promise<void> {
    const response = await post("setup-verify", { email: state.email, code: state.emailCode });
    if (!response || !response.ok) {
      const copy =
        response?.status === 400
          ? CODE_MISMATCH_COPY
          : response?.status === 429
            ? THROTTLED_COPY
            : response?.status === 409
              ? NO_FINISHED_RESET_COPY
              : VERIFY_FAILED_COPY;
      set({ error: copy });
      return;
    }
    const body = await readJson(response);
    setupId = typeof body.setupId === "string" ? body.setupId : undefined;
    registrationOptions = body.registrationOptions as PublicKeyCredentialCreationOptionsJSON | undefined;
    if (!setupId || !registrationOptions) { set({ error: VERIFY_FAILED_COPY }); return; }
    set({ phase: "setup-passkey", emailCode: "", error: undefined });
  }

  // Start again from the email step: the server's set-up handle is single use.
  function startAgain(error: string): void {
    setupId = undefined;
    registrationOptions = undefined;
    set({ phase: "setup-identify", emailCode: "", newRecoveryCode: undefined, savedConfirmed: false, error });
  }

  async function createPasskey(): Promise<void> {
    if (setupId === undefined || registrationOptions === undefined || !deps.startRegistration) {
      startAgain(SETUP_FAILED_COPY);
      return;
    }
    // The OS passkey prompt. A dismissed or timed-out prompt rejects: stay on the step with
    // a plain message, and post NOTHING (the server's challenge is still unspent).
    let registrationResponse: RegistrationResponseJSON;
    try {
      registrationResponse = await deps.startRegistration({ optionsJSON: registrationOptions });
    } catch {
      set({ error: PASSKEY_CANCELLED_COPY });
      return;
    }
    const response = await post("setup-finish", { setupId, registrationResponse });
    if (!response || !response.ok) {
      startAgain(SETUP_FAILED_COPY);
      return;
    }
    const body = await readJson(response);
    const newRecoveryCode = typeof body.recoveryCode === "string" ? body.recoveryCode : undefined;
    setupId = undefined;
    registrationOptions = undefined;
    set({ phase: "setup-recovery", newRecoveryCode, savedConfirmed: false, error: undefined });
  }

  // Gated on the "I've saved it" tick (the view disables Continue until then). The session
  // cookie was set by setup-finish, so continuing is just going home.
  async function confirm(): Promise<void> {
    if (state.phase !== "setup-recovery" || !state.savedConfirmed) return;
    set({ newRecoveryCode: undefined, error: undefined });
    deps.navigate?.(HOME_PATH);
  }

  async function submitEmailCode(): Promise<void> {
    if (setup) {
      await submitSetupEmailCode();
      return;
    }
    const response = await post("request", { email: state.email, code: state.emailCode });
    if (!response || !response.ok) {
      set({ error: response?.status === 400 ? CODE_MISMATCH_COPY : REQUEST_FAILED_COPY });
      return;
    }
    let completesAt: string | undefined;
    try {
      const body = (await response.json()) as { completesAt?: unknown };
      completesAt = typeof body.completesAt === "string" ? body.completesAt : undefined;
    } catch {
      completesAt = undefined;
    }
    set({ phase: "requested", completesAt, emailCode: "", error: undefined });
  }

  return {
    getState: () => state,
    setEmail: (value) => { if (!state.busy) set({ email: value }); },
    setEmailCode: (value) => { if (!state.busy) set({ emailCode: value }); },
    setSavedConfirmed: (value) => { if (!state.busy) set({ savedConfirmed: value }); },
    changeEmail: () => {
      if (state.busy || (state.phase !== "email-code" && state.phase !== "setup-email-code")) return;
      setupId = undefined;
      registrationOptions = undefined;
      set({ phase: setup ? "setup-identify" : "identify", emailCode: "", error: undefined });
    },
    submitIdentify: () => run(submitIdentify, SEND_FAILED_COPY),
    submitEmailCode: () => run(submitEmailCode, setup ? VERIFY_FAILED_COPY : REQUEST_FAILED_COPY),
    createPasskey: () => run(createPasskey, SETUP_FAILED_COPY),
    confirm: () => run(confirm, SETUP_FAILED_COPY),
  };
}

// --- the client component (a thin binding over the controller) --------------

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

export interface ResetFlowProps {
  readonly mode?: "reset" | "setup";
  readonly fetch?: typeof fetch;
  readonly startRegistration?: ResetFlowDeps["startRegistration"];
  readonly navigate?: (path: string) => void;
  readonly returnTo?: string;
}

export function ResetFlow(props: ResetFlowProps = {}): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<ResetFlowController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createResetFlow({
      fetch: props.fetch ?? defaultFetch,
      mode: props.mode,
      startRegistration: props.startRegistration ?? startRegistration,
      navigate: props.navigate ?? defaultNavigate,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  return (
    <ResetView
      returnTo={props.returnTo}
      step={state.phase}
      email={state.email}
      emailCode={state.emailCode}
      completesAt={state.completesAt}
      recoveryCode={state.newRecoveryCode}
      savedConfirmed={state.savedConfirmed}
      error={state.error}
      busy={state.busy}
      onEmailChange={(value) => flow.setEmail(value)}
      onEmailCodeChange={(value) => flow.setEmailCode(value)}
      onSavedConfirmedChange={(value) => flow.setSavedConfirmed(value)}
      onSubmitIdentify={() => {
        void flow.submitIdentify();
      }}
      onSubmitEmailCode={() => {
        void flow.submitEmailCode();
      }}
      onCreatePasskey={() => {
        void flow.createPasskey();
      }}
      onConfirm={() => {
        void flow.confirm();
      }}
      onChangeEmail={() => flow.changeEmail()}
    />
  );
}

export default ResetFlow;
