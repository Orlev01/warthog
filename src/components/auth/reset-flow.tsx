"use client";

import * as React from "react";

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

export interface ResetFlowDeps {
  readonly fetch: typeof fetch;
  // Optional: the component wires this to re-render after each change.
  readonly onChange?: () => void;
}

export interface ResetFlowState {
  readonly phase: ResetStep;
  readonly email: string;
  readonly emailCode: string;
  readonly completesAt?: string;
  readonly error?: string;
}

export interface ResetFlowController {
  getState(): ResetFlowState;
  setEmail(value: string): void;
  setEmailCode(value: string): void;
  submitIdentify(): Promise<void>;
  submitEmailCode(): Promise<void>;
}

const API_BASE = "/api/auth/reset";

// Plain sentences for a failed step (never the server's machine codes).
const SEND_FAILED_COPY = "We couldn't send a code just now. Check your email address and try again.";
const CODE_MISMATCH_COPY = "That code didn't match. Check the code from your email and try again.";
const REQUEST_FAILED_COPY = "We couldn't start the reset just now. Please try again in a few minutes.";

export function createResetFlow(deps: ResetFlowDeps): ResetFlowController {
  let state: ResetFlowState = { phase: "identify", email: "", emailCode: "" };

  function set(patch: Partial<ResetFlowState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // POST a JSON body to a reset step; a thrown fetch (offline) is a failed step, not a crash.
  async function post(step: "send-code" | "request", body: unknown): Promise<Response | null> {
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

  async function submitIdentify(): Promise<void> {
    const response = await post("send-code", { email: state.email });
    if (!response || !response.ok) {
      set({ error: SEND_FAILED_COPY });
      return;
    }
    set({ phase: "email-code", error: undefined });
  }

  async function submitEmailCode(): Promise<void> {
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
    setEmail: (value) => set({ email: value }),
    setEmailCode: (value) => set({ emailCode: value }),
    submitIdentify,
    submitEmailCode,
  };
}

// --- the client component (a thin binding over the controller) --------------

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export interface ResetFlowProps {
  readonly fetch?: typeof fetch;
  readonly returnTo?: string;
}

export function ResetFlow(props: ResetFlowProps = {}): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<ResetFlowController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createResetFlow({ fetch: props.fetch ?? defaultFetch, onChange: () => forceUpdate() });
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
      error={state.error}
      onEmailChange={(value) => flow.setEmail(value)}
      onEmailCodeChange={(value) => flow.setEmailCode(value)}
      onSubmitIdentify={() => {
        void flow.submitIdentify();
      }}
      onSubmitEmailCode={() => {
        void flow.submitEmailCode();
      }}
    />
  );
}

export default ResetFlow;
