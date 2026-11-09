"use client";

import * as React from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";

import { SigninView, type SigninStep } from "./auth-views";
import { safeReturnPath } from "../../server/auth/return-path";

// E04-S25 — Client sign-in flow.
//
// The interactive BEHAVIOUR lives in a framework-free, injectable controller
// (`createSigninFlow`) so it is testable without a DOM (the "pure logic, testable
// without I/O" convention — React component / E2E testing is a per-job ADR). The
// `SigninFlow` component is a thin binding over the controller: inputs read its
// `state`, buttons call its methods, and a change notifier re-renders.
//
// The controller walks a RETURNING person through the sign-in requests (the E04-S11
// handler, surfaced over HTTP by E04-S23 at POST /api/auth/signin/[step]) and the
// passkey ceremony between:
//
//   passkey path:
//     email → POST begin-passkey  { email }                     → keep { options }
//           → startAuthentication({ optionsJSON: options })     (@simplewebauthn/browser)
//           → POST finish-passkey { email, authenticationResponse } → navigate /home
//
//   authenticator-app path ("Use my authenticator app instead"):
//     email → POST send-email-code → email code → POST verify-email
//           → { signinId } + authenticator code → POST totp → navigate /home
//
// A successful step answers with a followed 303 → /home (a 2xx — `response.ok`); a
// failed one answers with a 4xx. The flow reports a failure as one plain-English
// message that never says whether the email has an account (no enumeration), and a
// cancelled passkey prompt stays put with a retry — never fail silently.

// The sign-in steps double as the controller's phases (one SigninView step each), so
// the component renders `step={state.phase}` with no mapping. The tests compare phases
// for equality only — the names are free to read however they read best.
export type SigninPhase = SigninStep;

export interface SigninFlowDeps {
  readonly fetch: typeof fetch;
  readonly startAuthentication: (opts: {
    optionsJSON: PublicKeyCredentialRequestOptionsJSON;
    useBrowserAutofill?: boolean;
  }) => Promise<AuthenticationResponseJSON>;
  readonly navigate: (path: string) => void;
  // Where to go after success: the page's validated `?next=` (review fix B6). It is
  // checked again here, and anything unsafe — or nothing — means /home.
  readonly returnTo?: string;
  // Optional: the component wires this to re-render after each state change. The
  // controller works standalone (the unit tests) when it is omitted.
  readonly onChange?: () => void;
}

export interface SigninFlowState {
  readonly phase: SigninPhase;
  readonly email: string;
  readonly code: string;
  readonly error?: string;
  readonly busy?: boolean;
}

export interface SigninFlowController {
  getState(): SigninFlowState;
  setEmail(value: string): void;
  setCode(value: string): void;
  signInWithPasskey(): Promise<void>;
  useAuthenticatorApp(): void;
  signInWithCode(): Promise<void>;
}

const API_BASE = "/api/auth/signin";

type StepPath = "begin-passkey" | "finish-passkey" | "send-email-code" | "verify-email" | "totp";

// Plain-English copy for a failed sign-in — a real sentence a person can act on,
// never a raw machine code (the server speaks `invalid_assertion`, `invalid_code`,
// `forbidden`, …) and never protocol/security jargon (brief design_ux.copy;
// constitution INV-22). It must NOT reveal whether the email has an account: the
// server answers the same 4xx either way, so the copy just doesn't invent an
// account-existence claim (no enumeration; E04-S19).
const PASSKEY_FAILED_COPY =
  "We couldn't sign you in with your passkey. Check your email and try again.";
const CODE_FAILED_COPY =
  "We couldn't sign you in with that code. Check the code from your authenticator app and try again.";
const PASSKEY_CANCELLED_COPY =
  "Signing in with your passkey was cancelled. You can try again when you're ready.";

export function createSigninFlow(deps: SigninFlowDeps): SigninFlowController {
  let signinId: string | undefined;
  let state: SigninFlowState = {
    phase: "passkey",
    email: "",
    code: "",
  };

  function set(patch: Partial<SigninFlowState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // POST a JSON body to a sign-in step. A thrown fetch (offline) is reported as a step
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

  async function signInWithPasskey(): Promise<void> {
    // begin-passkey names the account to challenge and hands back the options.
    const begin = await post("begin-passkey", { email: state.email });
    if (!begin || !begin.ok) {
      set({ error: PASSKEY_FAILED_COPY });
      return;
    }
    const body = await readJson(begin);
    const options = body.options as PublicKeyCredentialRequestOptionsJSON | undefined;
    if (options === undefined) {
      set({ error: PASSKEY_FAILED_COPY });
      return;
    }

    // The OS passkey prompt. A dismissed / timed-out prompt rejects here: stay on the
    // step with a plain message and a retry, and post NOTHING to the server.
    let authenticationResponse: AuthenticationResponseJSON;
    try {
      authenticationResponse = await deps.startAuthentication({ optionsJSON: options });
    } catch {
      set({ error: PASSKEY_CANCELLED_COPY });
      return;
    }

    const finish = await post("finish-passkey", {
      email: state.email,
      authenticationResponse,
    });
    if (!finish || !finish.ok) {
      set({ error: PASSKEY_FAILED_COPY });
      return;
    }
    set({ error: undefined });
    deps.navigate(safeReturnPath(deps.returnTo));
  }

  function useAuthenticatorApp(): void {
    // Switch to the "enter a code" step, keeping the typed email and clearing any
    // error left on the passkey step (no stale message).
    if (state.busy) return;
    signinId = undefined;
    set({ phase: "email", code: "", error: undefined });
  }

  async function signInWithCode(): Promise<void> {
    if (state.busy) return;
    set({ busy: true, error: undefined });
    try {
      if (state.phase === "email") {
        const response = await post("send-email-code", { email: state.email });
        if (!response?.ok) { set({ error: "We couldn't send your email code. Check the address, wait a minute and try again." }); return; }
        set({ phase: "email-code", code: "" });
        return;
      }
      if (state.phase === "email-code") {
        const response = await post("verify-email", { email: state.email, code: state.code });
        const result = response?.ok ? await readJson(response) : {};
        if (typeof result.signinId !== "string" || !/^[a-f0-9]{64}$/.test(result.signinId)) {
          set({ error: "We couldn't verify that email code. Check your latest email or start again." }); return;
        }
        signinId = result.signinId;
        set({ phase: "code", code: "" });
        return;
      }
      if (state.phase !== "code" || !signinId) { set({ phase: "email", code: "" }); return; }
      const response = await post("totp", { signinId, totp: state.code });
      if (!response?.ok) { set({ error: `${CODE_FAILED_COPY} If your email check expired, start again.` }); return; }
      signinId = undefined;
      set({ error: undefined });
      deps.navigate(safeReturnPath(deps.returnTo));
    } finally {
      set({ busy: false });
    }
  }

  return {
    getState: () => state,
    setEmail: (value) => {
      if (state.busy) return;
      signinId = undefined;
      set({ email: value, ...(state.phase === "passkey" ? {} : { phase: "email" as const, code: "" }) });
    },
    setCode: (value) => set({ code: value }),
    signInWithPasskey,
    useAuthenticatorApp,
    signInWithCode,
  };
}

// --- the client component (a thin binding over the controller) --------------

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

export interface SigninFlowProps {
  // The real browser seams, with optional overrides so the flow can be driven with
  // fakes. The page mounts it with no props.
  readonly fetch?: typeof fetch;
  readonly startAuthentication?: SigninFlowDeps["startAuthentication"];
  readonly navigate?: (path: string) => void;
  // The validated return path the page read from `?next=`.
  readonly returnTo?: string;
}

export function SigninFlow(props: SigninFlowProps = {}): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<SigninFlowController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createSigninFlow({
      fetch: props.fetch ?? defaultFetch,
      startAuthentication: props.startAuthentication ?? startAuthentication,
      navigate: props.navigate ?? defaultNavigate,
      returnTo: props.returnTo,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  return (
    <SigninView
      returnTo={props.returnTo}
      step={state.phase}
      email={state.email}
      code={state.code}
      error={state.error}
      busy={state.busy}
      onEmailChange={(value) => flow.setEmail(value)}
      onCodeChange={(value) => flow.setCode(value)}
      onPasskey={() => {
        void flow.signInWithPasskey();
      }}
      onUseAuthenticatorApp={() => flow.useAuthenticatorApp()}
      onSubmitCode={() => {
        void flow.signInWithCode();
      }}
    />
  );
}

export default SigninFlow;
