"use client";

import * as React from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";

import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";

// E04-S37 — Security screen factor controls.
//
// The security screen (E04-S15) LISTS a person's passkeys and recovery but its
// "Add a passkey" and "Generate a new recovery code" controls render DISABLED
// ("coming soon") because nothing on the client drives the ceremonies. This
// component replaces those two dead controls with live ones.
//
// As the sibling sign-in / sign-up flows (E04-S24/E04-S25) do, the interactive
// BEHAVIOUR lives in a framework-free, injectable CONTROLLER (`createFactorControls`)
// so it is testable without a DOM (the "pure logic, testable without I/O" convention
// — React component / E2E testing is a per-job ADR). The `FactorControls` component is
// a thin binding over the controller.
//
//   Add a passkey:
//     beginAddPasskey()                                   (the screen's server action)
//       → refused for a fresh confirmation  →  offer "Confirm it's you"
//       → otherwise startRegistration({ optionsJSON })    (@simplewebauthn/browser)
//       → finishAddPasskey(registrationResponse)          (the screen's server action)
//       → report success in plain words
//
//   Generate a new recovery code:
//     regenerateRecovery()                                (the screen's server action)
//       → refused for a fresh confirmation  →  offer "Confirm it's you"
//       → otherwise show the new code ONCE (never stored, never re-sent)
//
//   Confirm it's you (step-up), offered when a sensitive change is refused for a fresh
//   confirmation — in place of the old "sign out and back in" advice:
//     POST /api/auth/step-up/begin                        → keep { options }
//       → startAuthentication({ optionsJSON })            (@simplewebauthn/browser)
//       → POST /api/auth/step-up/finish { authenticationResponse }
//       → on success, resume the change that was refused
//
// The server actions are REQUIRED deps (server actions are the only callables a server
// page can pass across the client boundary). The WebAuthn + step-up `fetch` seams are
// the component's own browser-side defaults (optional overrides for tests).

// The screen's server actions, as page.tsx passes them across the client boundary.
export type BeginAddPasskeyResult =
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON }
  | { ok: false; reason: string };
export type FinishAddPasskeyResult = { ok: true } | { ok: false; reason: string };
export type RegenerateRecoveryResult = { ok: true; code: string } | { ok: false; reason: string };

export interface FactorControlsDeps {
  // the screen's server actions (page.tsx passes these as props):
  readonly beginAddPasskey: () => Promise<BeginAddPasskeyResult>;
  readonly finishAddPasskey: (response: RegistrationResponseJSON) => Promise<FinishAddPasskeyResult>;
  readonly regenerateRecovery: () => Promise<RegenerateRecoveryResult>;
  // browser seams:
  readonly fetch: typeof fetch; // POSTs the step-up begin/finish endpoints
  readonly startRegistration: (opts: {
    optionsJSON: PublicKeyCredentialCreationOptionsJSON;
  }) => Promise<RegistrationResponseJSON>;
  readonly startAuthentication: (opts: {
    optionsJSON: PublicKeyCredentialRequestOptionsJSON;
  }) => Promise<AuthenticationResponseJSON>;
  // Optional: the component wires this to re-render after each state change. The
  // controller works standalone (the unit tests) when it is omitted.
  readonly onChange?: () => void;
}

export interface FactorControlsNotice {
  readonly tone: "done" | "problem";
  readonly text: string;
}

export interface FactorControlsState {
  // the plain-words outcome of the last action
  readonly notice?: FactorControlsNotice;
  // true when a change was refused for a fresh confirmation; the component then renders
  // a "Confirm it's you" control (which calls confirm()) INSTEAD of advising a
  // sign-out-and-back-in
  readonly confirmRequired: boolean;
  // the one shown-once new recovery code (never stored, never re-sent)
  readonly recoveryCode?: string;
}

export interface FactorControlsController {
  getState(): FactorControlsState;
  addPasskey(): Promise<void>;
  generateRecoveryCode(): Promise<void>;
  confirm(): Promise<void>;
}

// The step-up (Confirm it's you) HTTP endpoints — the only `fetch` this component makes.
const STEP_UP_BASE = "/api/auth/step-up";

// The one reason string the step-up gate refuses sensitive changes with; a refusal with
// this reason offers "Confirm it's you" rather than reporting an unrecoverable problem.
const STEP_UP_REQUIRED = "step_up_required";

// Plain-English outcome copy — a real sentence a person can act on, never a raw machine
// code (the server speaks `step_up_required`, `bad_attestation`, …) and never protocol /
// security jargon (brief design_ux.copy; constitution INV-22). "passkey", "recovery
// code" and "confirm" are the brief's own plain vocabulary. The confirm-required copy
// OFFERS "Confirm it's you" — not the old E04-S15 advice to sign out and back in.
const COPY = {
  addSuccess: "Your new passkey is ready. You can use it to sign in next time.",
  addFailed: "We couldn't add your passkey. Please try again.",
  addCancelled: "Adding your passkey was cancelled. You can try again when you're ready.",
  addConfirmRequired:
    "Before you can add a passkey, we need to check it's really you. Choose “Confirm it's you” to continue.",
  generateSuccess: "Here's your new recovery code. Write it down and keep it safe — we'll only show it once.",
  generateFailed: "We couldn't create a new recovery code. Please try again.",
  generateConfirmRequired:
    "Before you can create a new recovery code, we need to check it's really you. Choose “Confirm it's you” to continue.",
  confirmFailed: "We couldn't check it's you. Please try again.",
  confirmCancelled: "Confirming it's you was cancelled. You can try again when you're ready.",
} as const;

export function createFactorControls(deps: FactorControlsDeps): FactorControlsController {
  let state: FactorControlsState = { confirmRequired: false };

  // The change that was refused for a fresh confirmation, resumed once the person has
  // confirmed it's them. Cleared only when a confirm genuinely unblocks it.
  let pendingResume: null | (() => Promise<void>) = null;

  function set(patch: Partial<FactorControlsState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  // POST a JSON body (or none) to a step-up endpoint. A thrown fetch (offline) is
  // reported as a failure rather than crashing the flow — never fail silently.
  async function postStepUp(step: "begin" | "finish", body?: unknown): Promise<Response | null> {
    try {
      return await deps.fetch(`${STEP_UP_BASE}/${step}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return null;
    }
  }

  async function addPasskey(): Promise<void> {
    const begin = await deps.beginAddPasskey();
    if (!begin.ok) {
      if (begin.reason === STEP_UP_REQUIRED) {
        pendingResume = addPasskey;
        set({ confirmRequired: true, notice: { tone: "problem", text: COPY.addConfirmRequired } });
      } else {
        set({ notice: { tone: "problem", text: COPY.addFailed } });
      }
      return;
    }

    // The OS registration prompt. A dismissed / timed-out prompt rejects here: stay put
    // with a plain message and a retry, and run NOTHING further.
    let registrationResponse: RegistrationResponseJSON;
    try {
      registrationResponse = await deps.startRegistration({ optionsJSON: begin.options });
    } catch {
      set({ notice: { tone: "problem", text: COPY.addCancelled } });
      return;
    }

    const finish = await deps.finishAddPasskey(registrationResponse);
    if (!finish.ok) {
      set({ notice: { tone: "problem", text: COPY.addFailed } });
      return;
    }
    set({ confirmRequired: false, notice: { tone: "done", text: COPY.addSuccess } });
  }

  async function generateRecoveryCode(): Promise<void> {
    const result = await deps.regenerateRecovery();
    if (!result.ok) {
      if (result.reason === STEP_UP_REQUIRED) {
        pendingResume = generateRecoveryCode;
        set({ confirmRequired: true, notice: { tone: "problem", text: COPY.generateConfirmRequired } });
      } else {
        set({ notice: { tone: "problem", text: COPY.generateFailed } });
      }
      return;
    }
    // Show the new code once. It is held only in state — never written to browser
    // storage, never sent back out.
    set({ confirmRequired: false, recoveryCode: result.code, notice: { tone: "done", text: COPY.generateSuccess } });
  }

  async function confirm(): Promise<void> {
    // Step 1 — ask the step-up endpoint for a fresh confirmation challenge.
    const beginResponse = await postStepUp("begin");
    if (!beginResponse || !beginResponse.ok) {
      set({ notice: { tone: "problem", text: COPY.confirmFailed } });
      return;
    }
    const options = (await readJson(beginResponse)).options as
      | PublicKeyCredentialRequestOptionsJSON
      | undefined;
    if (options === undefined) {
      set({ notice: { tone: "problem", text: COPY.confirmFailed } });
      return;
    }

    // The OS confirm prompt. A dismissed / timed-out prompt rejects here: keep offering
    // confirm for a retry and post NOTHING to the finish endpoint.
    let authenticationResponse: AuthenticationResponseJSON;
    try {
      authenticationResponse = await deps.startAuthentication({ optionsJSON: options });
    } catch {
      set({ notice: { tone: "problem", text: COPY.confirmCancelled } });
      return;
    }

    // Step 2 — hand the assertion back; on success the session has a fresh confirmation.
    const finishResponse = await postStepUp("finish", { authenticationResponse });
    if (!finishResponse || !finishResponse.ok) {
      // A refused confirm changes nothing and keeps offering confirm for another try.
      set({ notice: { tone: "problem", text: COPY.confirmFailed } });
      return;
    }

    // Confirmed — resume the change that was refused (now permitted).
    const resume = pendingResume;
    pendingResume = null;
    if (resume) {
      await resume();
    } else {
      set({ confirmRequired: false });
    }
  }

  return {
    getState: () => state,
    addPasskey,
    generateRecoveryCode,
    confirm,
  };
}

// --- the client component (a thin binding over the controller) --------------

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

// The screen's server actions, handed down from page.tsx; the browser seams are the
// component's own defaults (the page cannot pass them across the client boundary).
export interface FactorControlsProps {
  readonly beginAddPasskey: FactorControlsDeps["beginAddPasskey"];
  readonly finishAddPasskey: FactorControlsDeps["finishAddPasskey"];
  readonly regenerateRecovery: FactorControlsDeps["regenerateRecovery"];
  readonly fetch?: typeof fetch;
  readonly startRegistration?: FactorControlsDeps["startRegistration"];
  readonly startAuthentication?: FactorControlsDeps["startAuthentication"];
}

// The outcome of the last action, in words plus an icon (never colour alone): a problem
// is announced immediately (alert), a success politely (status).
function NoticeBanner({ notice }: { notice: FactorControlsNotice }) {
  const Icon = notice.tone === "done" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role={notice.tone === "done" ? "status" : "alert"}
      className="flex items-start gap-3 rounded-card border border-line bg-surface p-4 text-sm text-fg"
    >
      <Icon aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0" />
      <p>{notice.text}</p>
    </div>
  );
}

export function FactorControls(props: FactorControlsProps): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<FactorControlsController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createFactorControls({
      beginAddPasskey: props.beginAddPasskey,
      finishAddPasskey: props.finishAddPasskey,
      regenerateRecovery: props.regenerateRecovery,
      fetch: props.fetch ?? defaultFetch,
      startRegistration: props.startRegistration ?? startRegistration,
      startAuthentication: props.startAuthentication ?? startAuthentication,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  return (
    <div className="flex flex-col gap-4">
      {state.notice ? <NoticeBanner notice={state.notice} /> : null}

      {state.confirmRequired ? (
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            void flow.confirm();
          }}
        >
          Confirm it&apos;s you
        </Button>
      ) : null}

      <div className="flex flex-col gap-1">
        <Button
          type="button"
          // The accent is reserved for the one primary action: while a confirmation is
          // owed, "Confirm it's you" is that action, so add drops to a neutral button.
          variant={state.confirmRequired ? "secondary" : "primary"}
          onClick={() => {
            void flow.addPasskey();
          }}
        >
          Add a passkey
        </Button>
        <p className="text-sm text-fg-muted">
          Register another passkey so you can sign in from another device.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {state.recoveryCode ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-fg">Your new recovery code</span>
            <p className="rounded-card border border-line bg-surface-muted px-3 py-3 text-center font-mono text-lg tracking-widest text-fg">
              {state.recoveryCode}
            </p>
          </div>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void flow.generateRecoveryCode();
          }}
        >
          Generate a new recovery code
        </Button>
        <p className="text-sm text-fg-muted">
          A one-time way back in if you ever lose every passkey. Generating a new one replaces the old.
        </p>
      </div>
    </div>
  );
}

export default FactorControls;
