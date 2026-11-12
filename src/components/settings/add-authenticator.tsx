"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";

// Settings › Security — set up an authenticator app after sign-up (follow-up S1; see
// docs/adr/security-followups-2026-11.md). Replaces the old "you can only add one when you
// create an account" dead end.
//
// The screen's two server actions do the work (settings/security/actions.ts → the
// totp-enrolment seam): `begin` returns the pending secret and its QR once the person has
// confirmed it's them, `verify` checks the six-digit code and stores the secret. This
// controller only sequences them:
//
//   start  → begin()  → step_up_required: offer "Confirm it's you", then begin() again
//                     → ok: show the QR and setup key, ask for the code
//   submit → verify() → ok: hand back to the page (it reloads with "Authenticator app set up")
//                     → step_up_required: confirm, then ask for the code the app shows NOW
//                       (a code is never re-sent on its own: it may have rolled over)
//                     → anything else: a plain sentence
//
// The secret is held only in this component's memory while the set-up is on screen, and is
// dropped once it finishes or is cancelled. Cancel is client-only: the server's pending
// set-up keeps its attempt count and expiry, so cancelling never buys extra attempts.

export type AddAuthenticatorBeginResult =
  | { ok: true; secret: string; qr: string }
  | { ok: false; reason: string };
export type AddAuthenticatorVerifyResult = { ok: true } | { ok: false; reason: string };

export interface AddAuthenticatorDeps {
  readonly begin: () => Promise<AddAuthenticatorBeginResult>;
  readonly verify: (code: string) => Promise<AddAuthenticatorVerifyResult>;
  // Called once the authenticator is on the account (or already was).
  readonly onDone: () => void;
  readonly onChange?: () => void;
}

export interface AddAuthenticatorState {
  readonly phase: "idle" | "scan";
  readonly busy: boolean;
  readonly confirmRequired: boolean;
  readonly secret?: string;
  readonly qr?: string;
  readonly code: string;
  readonly error?: string;
  // A plain, non-error line (e.g. after confirming, "enter the code your app shows now").
  readonly notice?: string;
}

export interface AddAuthenticatorController {
  getState(): AddAuthenticatorState;
  start(): Promise<void>;
  setCode(value: string): void;
  submit(): Promise<void>;
  confirmed(): Promise<void>;
  cancel(): void;
}

const STEP_UP_REQUIRED = "step_up_required";

const COPY = {
  confirmToStart: "Before you set up an authenticator app, we need to check it's really you.",
  confirmToFinish: "It's been a few minutes, so we need to check it's really you again before saving your authenticator app.",
  afterConfirm: "Thanks, that's confirmed. Enter the code your app shows now.",
  startFailed: "We couldn't start setting up your authenticator app. Please try again.",
  inProgress: "We're already checking a code. Please wait a moment.",
  malformed: "Enter the six-digit code your authenticator app shows.",
  invalid: "That code didn't match. Check your phone's time is set automatically, then enter the code your app shows now.",
  tooMany: "Too many incorrect codes. Wait 10 minutes, then start again.",
  expired: "This set-up has expired. Start again to get a new QR code.",
  verifyFailed: "We couldn't save your authenticator app. Please try again.",
} as const;

export function createAddAuthenticator(deps: AddAuthenticatorDeps): AddAuthenticatorController {
  let state: AddAuthenticatorState = { phase: "idle", busy: false, confirmRequired: false, code: "" };
  // What a confirmation unblocks: starting again, or asking for a fresh code.
  let resume: "start" | "code" | null = null;

  function set(patch: Partial<AddAuthenticatorState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  async function run(action: () => Promise<void>, failure: string): Promise<void> {
    // Set before the first await, so a second tap is ignored even before React re-renders.
    if (state.busy) return;
    set({ busy: true, error: undefined, notice: undefined });
    try {
      await action();
    } catch {
      set({ error: failure });
    } finally {
      set({ busy: false });
    }
  }

  async function begin(): Promise<void> {
    const result = await deps.begin();
    if (result.ok) {
      set({ phase: "scan", secret: result.secret, qr: result.qr, code: "", confirmRequired: false });
      return;
    }
    if (result.reason === STEP_UP_REQUIRED) {
      resume = "start";
      set({ confirmRequired: true, notice: COPY.confirmToStart });
      return;
    }
    if (result.reason === "already_enrolled") {
      deps.onDone();
      return;
    }
    set({ error: result.reason === "in_progress" ? COPY.inProgress : COPY.startFailed });
  }

  async function verify(): Promise<void> {
    const code = state.code.trim();
    if (!/^[0-9]{6}$/.test(code)) {
      set({ error: COPY.malformed });
      return;
    }
    const result = await deps.verify(code);
    if (result.ok || result.reason === "already_enrolled") {
      set({ phase: "idle", secret: undefined, qr: undefined, code: "" });
      deps.onDone();
      return;
    }
    switch (result.reason) {
      case STEP_UP_REQUIRED:
        resume = "code";
        set({ confirmRequired: true, code: "", notice: COPY.confirmToFinish });
        return;
      case "invalid_code":
        set({ code: "", error: COPY.invalid });
        return;
      case "too_many_attempts":
        set({ code: "", error: COPY.tooMany });
        return;
      case "no_enrolment":
        set({ phase: "idle", secret: undefined, qr: undefined, code: "", error: COPY.expired });
        return;
      case "in_progress":
        set({ error: COPY.inProgress });
        return;
      default:
        set({ error: COPY.verifyFailed });
    }
  }

  async function confirmed(): Promise<void> {
    const next = resume;
    resume = null;
    set({ confirmRequired: false, notice: undefined });
    if (next === "start") await run(begin, COPY.startFailed);
    else if (next === "code") set({ code: "", notice: COPY.afterConfirm });
  }

  return {
    getState: () => state,
    start: async () => { if (!state.confirmRequired) await run(begin, COPY.startFailed); },
    setCode: (value) => { if (!state.busy) set({ code: value }); },
    submit: async () => { if (!state.confirmRequired) await run(verify, COPY.verifyFailed); },
    confirmed,
    cancel: () => {
      if (state.busy) return;
      resume = null;
      set({ phase: "idle", secret: undefined, qr: undefined, code: "", error: undefined, notice: undefined, confirmRequired: false });
    },
  };
}

// --- the client component (a thin binding over the controller) --------------

function defaultDone(): void {
  window.location.assign("/settings/security?notice=authenticator_added");
}

export interface AddAuthenticatorProps {
  readonly begin: AddAuthenticatorDeps["begin"];
  readonly verify: AddAuthenticatorDeps["verify"];
  // Whether the member has a passkey, so "Confirm it's you" offers the right factor.
  readonly passkey: boolean;
  readonly onDone?: () => void;
}

export function AddAuthenticator(props: AddAuthenticatorProps): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<AddAuthenticatorController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createAddAuthenticator({
      begin: props.begin,
      verify: props.verify,
      onDone: props.onDone ?? defaultDone,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const codeId = React.useId();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {state.phase === "idle" ? (
        <p className="text-sm text-fg-muted">
          Add an authenticator app as a second way in. You&apos;ll sign in with your email and a
          six-digit code from the app, and you can use a code to confirm it&apos;s you.
        </p>
      ) : null}

      {state.error ? <Notice tone="error">{state.error}</Notice> : null}
      {state.notice && !state.confirmRequired ? <Notice tone="info">{state.notice}</Notice> : null}

      {state.confirmRequired ? (
        <ConfirmItsYou
          passkey={props.passkey}
          authenticator={false}
          explanation={state.notice}
          onConfirmed={() => { void flow.confirmed(); }}
        />
      ) : null}

      {state.phase === "idle" ? (
        <Button
          type="button"
          variant={state.confirmRequired ? "secondary" : "primary"}
          aria-disabled={state.busy || state.confirmRequired || undefined}
          aria-busy={state.busy || undefined}
          className="aria-disabled:opacity-50 sm:self-start"
          onClick={() => { void flow.start(); }}
        >
          <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
          {state.busy ? "Please wait…" : "Set up an authenticator app"}
        </Button>
      ) : null}

      {state.phase === "scan" && state.secret && state.qr ? (
        <div className="flex min-w-0 flex-col gap-4">
          <p className="text-sm text-fg">
            Scan this QR code with your authenticator app, or enter the setup key by hand. Then
            enter the six-digit code the app shows.
          </p>
          {/* Intrinsic size, square, its own quiet zone and light background; never inverted. */}
          <img
            src={state.qr}
            alt="QR code for setting up your authenticator app"
            width={256}
            height={256}
            className="h-auto w-full max-w-64 self-start rounded-card bg-surface-muted p-2"
          />
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium text-fg">Setup key</span>
              <p className="break-all rounded-card bg-surface-muted p-3 font-mono text-sm text-fg">{state.secret}</p>
            </div>
            <CopyButton value={state.secret} label="setup key" successMessage="Setup key copied." />
          </div>
          <form
            className="flex min-w-0 flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void flow.submit();
            }}
          >
            <Field
              id={codeId}
              label="Authenticator app code"
              name="totp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="[0-9]{6}"
              maxLength={6}
              width="short"
              value={state.code}
              readOnly={state.busy || state.confirmRequired}
              aria-disabled={state.busy || state.confirmRequired || undefined}
              onChange={(event) => flow.setCode(event.target.value)}
            />
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                type="submit"
                variant="primary"
                aria-disabled={state.busy || state.confirmRequired || undefined}
                aria-busy={state.busy || undefined}
                className="aria-disabled:opacity-50"
              >
                {state.busy ? "Checking…" : "Confirm authenticator app"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                aria-disabled={state.busy || undefined}
                onClick={() => flow.cancel()}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export default AddAuthenticator;
