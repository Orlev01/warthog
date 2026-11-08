"use client";

import * as React from "react";

import { DeviceView } from "./auth-views";
import { safeReturnPath } from "../../server/auth/return-path";

// E04-S34 — Client new-device flow.
//
// The interactive BEHAVIOUR lives in a framework-free, injectable controller
// (`createDeviceFlow`) so it is testable without a DOM (the "pure logic, testable
// without I/O" convention — React component / E2E testing is a per-job ADR). The
// `DeviceFlow` component is a thin binding over the controller: inputs read its
// `state`, the Continue button calls its methods, and the waiting step polls on a
// timer.
//
// The controller drives the "approval from a signed-in device" handshake for a NEW
// device joining an existing account (the E04-S31 handler, surfaced over HTTP by
// E04-S32 at POST /api/auth/device/[step]):
//
//   request  → POST /api/auth/device/request { email, code, deviceLabel }
//              → verifies the emailed one-time code, records a pending request, sends ONE
//                approval push to a device the person already uses, and returns
//                { requestId } — this device's own collection handle. No session minted.
//   (approve → an EXISTING signed-in device approves out of band, inside the signed-in
//              app — NOT part of this new-device flow.)
//   collect  → POST /api/auth/device/collect { requestId }
//              → while not approved yet: 400 { error: "not_approved" } — keep WAITING
//                (this is the poll). Once approved: a followed 303 → /home carrying this
//                device's session cookie (a 2xx — response.ok), and the flow navigates to
//                /home. A gone handle (expired / refused / already collected) answers
//                400 { error: "unknown_request" } — a terminal failure the person can only
//                recover from by starting again.
//
// The single binary server state is why the flow reads the collect error code:
// `not_approved` means "keep waiting", anything else means "this request is done —
// start again". A flow that treated the first `not_approved` as a hard error could never
// poll.

// The flow's phases map straight onto the DeviceView steps they render (`code` collects
// the email + one-time code, `waiting` is shown during the poll, `stopped` after a
// refused/expired request), so the component renders `step={state.phase}` with no
// mapping. The tests compare phases for equality only — the names are free to read
// however they read best.
export type DevicePhase = "code" | "waiting" | "stopped";

export interface DeviceFlowDeps {
  readonly fetch: typeof fetch;
  readonly navigate: (path: string) => void;
  // Where to go after success: the page's validated `?next=` (review fix B6). It is
  // checked again here, and anything unsafe — or nothing — means /home.
  readonly returnTo?: string;
  // The label naming the approval push on the person's other device. Optional so the
  // page mounts the flow with none; a sensible default is used when omitted.
  readonly deviceLabel?: string;
  // Optional: the component wires this to re-render after each state change. The
  // controller works standalone (the unit tests) when it is omitted.
  readonly onChange?: () => void;
}

export interface DeviceFlowState {
  readonly phase: DevicePhase;
  readonly email: string;
  // The emailed one-time code the person types (the request's first factor).
  readonly code: string;
  readonly error?: string;
}

export interface DeviceFlowController {
  getState(): DeviceFlowState;
  setEmail(value: string): void;
  setCode(value: string): void;
  requestApproval(): Promise<void>;
  poll(): Promise<void>;
  startAgain(): void;
}

const API_BASE = "/api/auth/device";

// The approval request's schema requires a non-empty device label (it names the push),
// so the flow always sends one. A fuller label is not collected on this screen.
const DEFAULT_DEVICE_LABEL = "New device";

// Plain-English copy for a failed step — a real sentence a person can act on, never a
// raw machine code (the server speaks `invalid_code`, `not_approved`, `unknown_request`,
// `forbidden`, …) and never protocol/security jargon (brief design_ux.copy;
// constitution INV-22). The request copy reveals nothing about whether the email has an
// account (the server answers the same either way), so it makes no account claim.
const REQUEST_FAILED_COPY =
  "We couldn't add this device. Check your email address and the code we emailed you, then try again.";
const REQUEST_GONE_COPY =
  "That approval request has expired or was turned down. You can start again when you're ready.";

type StepPath = "request" | "collect";

export function createDeviceFlow(deps: DeviceFlowDeps): DeviceFlowController {
  // The collection handle lives in this closure, never in the rendered snapshot — it is
  // machinery the person never sees.
  let requestId: string | undefined;

  let state: DeviceFlowState = {
    phase: "code",
    email: "",
    code: "",
  };

  function set(patch: Partial<DeviceFlowState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // POST a JSON body to a device step. A thrown fetch (offline) returns null so the
  // caller can decide — never fail silently, never crash the flow.
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

  async function requestApproval(): Promise<void> {
    const response = await post("request", {
      email: state.email,
      code: state.code,
      deviceLabel: deps.deviceLabel ?? DEFAULT_DEVICE_LABEL,
    });
    // A rejected request (wrong/expired code, unknown email, offline) starts nothing:
    // stay on the first step, keep what the person typed, explain in plain words.
    if (!response || !response.ok) {
      set({ error: REQUEST_FAILED_COPY });
      return;
    }
    const body = await readJson(response);
    requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    // The request is recorded and the push is on its way — start waiting for approval.
    set({ phase: "waiting", error: undefined });
  }

  async function poll(): Promise<void> {
    // Only the waiting step polls, and only once a handle exists.
    if (requestId === undefined) return;

    const response = await post("collect", { requestId });
    // A transient network blip is not a verdict — stay waiting and let the next tick retry.
    if (!response) return;

    if (response.ok) {
      // Approved: the session cookie rode the followed 303; go to /home.
      set({ error: undefined });
      deps.navigate(safeReturnPath(deps.returnTo));
      return;
    }

    const body = await readJson(response);
    // `not_approved` is the expected "still pending" answer — keep waiting, no error.
    if (body.error === "not_approved") return;

    // Anything else (unknown_request, …) is terminal: the handle can no longer be
    // completed, so stop polling and offer to start again.
    requestId = undefined;
    set({ phase: "stopped", error: REQUEST_GONE_COPY });
  }

  function startAgain(): void {
    requestId = undefined;
    set({ phase: "code", error: undefined });
  }

  return {
    getState: () => state,
    setEmail: (value) => set({ email: value }),
    setCode: (value) => set({ code: value }),
    requestApproval,
    poll,
    startAgain,
  };
}

// --- the client component (a thin binding over the controller) --------------

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

function defaultNavigate(path: string): void {
  window.location.assign(path);
}

// How often the waiting step asks the server whether the request has been approved yet.
const POLL_INTERVAL_MS = 3000;

export interface DeviceFlowProps {
  // The real browser seams, with optional overrides so the flow can be driven with
  // fakes. The page mounts it with no props.
  readonly fetch?: typeof fetch;
  readonly navigate?: (path: string) => void;
  // The validated return path the page read from `?next=`.
  readonly returnTo?: string;
  readonly deviceLabel?: string;
}

export function DeviceFlow(props: DeviceFlowProps = {}): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<DeviceFlowController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createDeviceFlow({
      fetch: props.fetch ?? defaultFetch,
      navigate: props.navigate ?? defaultNavigate,
      returnTo: props.returnTo,
      deviceLabel: props.deviceLabel,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  // While waiting, poll the server for the owner's approval. The interval is torn down
  // as soon as the flow leaves the waiting step (approved → /home, or stopped).
  React.useEffect(() => {
    if (state.phase !== "waiting") return;
    const id = setInterval(() => {
      void flow.poll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state.phase, flow]);

  return (
    <DeviceView
      returnTo={props.returnTo}
      step={state.phase}
      email={state.email}
      code={state.code}
      error={state.error}
      onEmailChange={(value) => flow.setEmail(value)}
      onCodeChange={(value) => flow.setCode(value)}
      onSubmit={() => {
        void flow.requestApproval();
      }}
      onStartAgain={() => flow.startAgain()}
    />
  );
}

export default DeviceFlow;
