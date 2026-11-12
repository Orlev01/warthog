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
//              The response also names the label the request is listed under on the
//              approving device and when it expires (follow-up S3), so the waiting step can
//              say what to look for.
//   (approve → an EXISTING signed-in device approves out of band, inside the signed-in
//              app at Settings › Security › Sign-in requests — NOT part of this flow.)
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
  readonly busy: boolean;
  readonly phase: DevicePhase;
  readonly email: string;
  // The emailed one-time code the person types (the request's first factor).
  readonly code: string;
  readonly error?: string;
  // A plain, non-error status line (e.g. "we've emailed you a code").
  readonly notice?: string;
  // While waiting: the label the approving device lists this request under, and when the
  // request expires (this device's local time).
  readonly deviceLabel?: string;
  readonly expires?: string;
}

export interface DeviceFlowController {
  getState(): DeviceFlowState;
  setEmail(value: string): void;
  setCode(value: string): void;
  sendCode(): Promise<void>;
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
const SEND_CODE_FAILED_COPY =
  "We couldn't send a code just now. Check your email address and try again.";
// The server answers the same whether or not the address has an account, so the notice
// makes no account claim either.
// The server can't say whether a send was throttled without revealing the account, so the
// notice never claims a send it can't vouch for (public-04).
const CODE_SENT_NOTICE =
  "If there's an account for that address, we'll email it a code. We send at most one a minute, so if you asked moments ago, use the code you already have.";
const REQUEST_GONE_COPY =
  "That approval request has expired or was turned down. You can start again when you're ready.";

type StepPath = "send-code" | "request" | "collect";

// "10:52 am" in this device's own time zone (a signed-out device has no account zone).
function localTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" }).format(instant);
}

export function createDeviceFlow(deps: DeviceFlowDeps): DeviceFlowController {
  // The collection handle lives in this closure, never in the rendered snapshot — it is
  // machinery the person never sees.
  let requestId: string | undefined;
  let generation = 0;
  let pollingGeneration: number | undefined;

  let state: DeviceFlowState = {
    busy: false,
    phase: "code",
    email: "",
    code: "",
  };

  function set(patch: Partial<DeviceFlowState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  async function run(action: () => Promise<void>, failure: string): Promise<void> {
    if (state.busy || state.phase !== "code") return;
    set({ busy: true, error: undefined, notice: undefined });
    try {
      await action();
    } catch {
      set({ error: failure });
    } finally {
      set({ busy: false });
    }
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
      const body: unknown = await response.json();
      return body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  // Ask for the emailed one-time code the request needs (the first factor).
  async function sendCode(): Promise<void> {
    const response = await post("send-code", { email: state.email });
    if (!response || !response.ok) {
      set({ error: SEND_CODE_FAILED_COPY, notice: undefined });
      return;
    }
    set({ error: undefined, notice: CODE_SENT_NOTICE });
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
    if (!requestId) { set({ error: REQUEST_FAILED_COPY }); return; }
    // The request is recorded and the push is on its way — start waiting for approval.
    set({
      phase: "waiting",
      error: undefined,
      deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 80) : undefined,
      expires: localTime(body.expiresAt),
    });
  }

  async function poll(): Promise<void> {
    // Only the waiting step polls, and only once a handle exists.
    if (requestId === undefined || state.phase !== "waiting" || pollingGeneration === generation) return;
    const currentGeneration = generation;
    const currentRequest = requestId;
    pollingGeneration = currentGeneration;
    try {

      const response = await post("collect", { requestId: currentRequest });
      if (generation !== currentGeneration || requestId !== currentRequest) return;
      // A transient network blip is not a verdict — stay waiting and let the next tick retry.
      if (!response) return;

      if (response.ok) {
        // Approved: the session cookie rode the followed 303; go to /home.
        requestId = undefined;
        set({ error: undefined });
        deps.navigate(safeReturnPath(deps.returnTo));
        return;
      }

      const body = await readJson(response);
      if (generation !== currentGeneration || requestId !== currentRequest) return;
      // `not_approved` is the expected "still pending" answer — keep waiting, no error.
      if (body.error === "not_approved") return;

      // Anything else (unknown_request, …) is terminal: the handle can no longer be
      // completed, so stop polling and offer to start again.
      requestId = undefined;
      set({ phase: "stopped", error: REQUEST_GONE_COPY });
    } finally {
      if (pollingGeneration === currentGeneration) pollingGeneration = undefined;
    }
  }

  function startAgain(): void {
    if (state.busy) return;
    generation++;
    requestId = undefined;
    set({ phase: "code", code: "", notice: undefined, error: undefined, deviceLabel: undefined, expires: undefined });
  }

  return {
    getState: () => state,
    setEmail: (value) => { if (!state.busy) set({ email: value }); },
    setCode: (value) => { if (!state.busy) set({ code: value }); },
    sendCode: () => run(sendCode, SEND_CODE_FAILED_COPY),
    requestApproval: () => run(requestApproval, REQUEST_FAILED_COPY),
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
      notice={state.notice}
      deviceLabel={state.deviceLabel}
      expires={state.expires}
      busy={state.busy}
      onEmailChange={(value) => flow.setEmail(value)}
      onCodeChange={(value) => flow.setCode(value)}
      onSendCode={() => {
        void flow.sendCode();
      }}
      onSubmit={() => {
        void flow.requestApproval();
      }}
      onStartAgain={() => flow.startAgain()}
    />
  );
}

export default DeviceFlow;
