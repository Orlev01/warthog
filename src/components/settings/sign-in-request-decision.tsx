"use client";

import * as React from "react";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { SIGN_IN_REQUESTS_PATH } from "@/server/auth/sign-in-requests-path";
import { APPROVE_WARNING } from "./sign-in-request-copy";

// The Approve / Deny controls for one waiting sign-in request (follow-up S3). Neither answers
// on one tap: each opens an in-page dialog that asks first and says plainly what it means.
//
//   approve → the screen's server action → step_up_required: "Confirm it's you" inside the
//             dialog, then the approval goes ahead (the member already chose it)
//           → ok / gone: reload the screen with the outcome
//   deny    → the screen's server action (no step-up: denying only takes access away)
//           → reload the screen with the outcome
//
// Both share one in-flight guard, so a double tap sends one request. The server re-checks
// everything (session owner, fresh confirmation, expiry); this only sequences the calls.

export type SignInRequestAnswer = { ok: true } | { ok: false; reason: string };

export interface SignInRequestDecisionDeps {
  readonly approve: () => Promise<SignInRequestAnswer>;
  readonly deny: () => Promise<SignInRequestAnswer>;
  // The screen reloads with this outcome code (approved, denied, not_found, …).
  readonly onDone: (code: string) => void;
  readonly onChange?: () => void;
}

export interface SignInRequestDecisionState {
  readonly busy: boolean;
  readonly confirmRequired: boolean;
  readonly error?: string;
}

export interface SignInRequestDecisionController {
  getState(): SignInRequestDecisionState;
  approve(): Promise<void>;
  deny(): Promise<void>;
  confirmed(): Promise<void>;
  reset(): void;
}

const FAILED = "We couldn't send your answer. Please try again.";

export function createSignInRequestDecision(deps: SignInRequestDecisionDeps): SignInRequestDecisionController {
  let state: SignInRequestDecisionState = { busy: false, confirmRequired: false };

  function set(patch: Partial<SignInRequestDecisionState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (state.busy) return;
    set({ busy: true, error: undefined });
    try {
      await action();
    } catch {
      set({ error: FAILED });
    } finally {
      set({ busy: false });
    }
  }

  async function approve(): Promise<void> {
    const result = await deps.approve();
    if (result.ok) return deps.onDone("approved");
    if (result.reason === "step_up_required") {
      set({ confirmRequired: true });
      return;
    }
    deps.onDone(result.reason);
  }

  async function deny(): Promise<void> {
    const result = await deps.deny();
    deps.onDone(result.ok ? "denied" : result.reason);
  }

  return {
    getState: () => state,
    approve: async () => { if (!state.confirmRequired) await run(approve); },
    deny: () => run(deny),
    confirmed: async () => {
      set({ confirmRequired: false });
      await run(approve);
    },
    reset: () => { if (!state.busy) set({ confirmRequired: false, error: undefined }); },
  };
}

// --- the client component ------------------------------------------------------------

function reloadWith(code: string): void {
  window.location.assign(`${SIGN_IN_REQUESTS_PATH}?notice=${encodeURIComponent(code)}`);
}

const DIALOG =
  "top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)] bottom-[env(safe-area-inset-bottom)] left-[env(safe-area-inset-left)] m-auto max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-md overflow-y-auto rounded-panel border border-line bg-surface p-4 text-fg shadow-lg sm:p-6";


export function SignInRequestDecision({
  id,
  deviceLabel,
  approve,
  deny,
  passkey,
  authenticator,
}: {
  id: string;
  deviceLabel: string;
  // The screen's server actions, taking the request's approval id.
  approve: (id: string) => Promise<SignInRequestAnswer>;
  deny: (id: string) => Promise<SignInRequestAnswer>;
  // Which factors the member has, so "Confirm it's you" offers the right ones.
  passkey: boolean;
  authenticator: boolean;
}) {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<SignInRequestDecisionController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createSignInRequestDecision({
      approve: () => approve(id),
      deny: () => deny(id),
      onDone: reloadWith,
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const approveDialog = React.useRef<HTMLDialogElement>(null);
  const denyDialog = React.useRef<HTMLDialogElement>(null);
  const ids = { approveTitle: React.useId(), approveBody: React.useId(), denyTitle: React.useId(), denyBody: React.useId() };
  const open = (dialog: React.RefObject<HTMLDialogElement | null>) => {
    const modal = dialog.current;
    if (modal && !modal.open) modal.showModal();
  };
  const close = (dialog: React.RefObject<HTMLDialogElement | null>) => {
    if (state.busy) return;
    flow.reset();
    dialog.current?.close();
  };

  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      <Button
        type="button"
        variant="primary"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`Approve sign-in on ${deviceLabel}`}
        onClick={() => open(approveDialog)}
      >
        <Check aria-hidden={true} className="h-4 w-4 shrink-0" />
        Approve
      </Button>
      <Button
        type="button"
        variant="danger"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`Deny sign-in on ${deviceLabel}`}
        onClick={() => open(denyDialog)}
      >
        <X aria-hidden={true} className="h-4 w-4 shrink-0" />
        Deny
      </Button>

      <dialog ref={approveDialog} aria-labelledby={ids.approveTitle} aria-describedby={ids.approveBody} className={DIALOG}
        onCancel={(event) => { if (state.busy) event.preventDefault(); else flow.reset(); }}>
        <h2 id={ids.approveTitle} className="wh-section-title">{`Approve sign-in on ${deviceLabel}?`}</h2>
        <div id={ids.approveBody} className="mt-3 flex flex-col gap-3 text-sm text-fg-muted">
          <p className="font-medium text-fg">{APPROVE_WARNING}</p>
          <p>
            Approving signs that device in to your account. If you didn&apos;t just try to sign in,
            deny it: someone may be able to read your email.
          </p>
        </div>
        {state.error ? <Notice tone="error" className="mt-4">{state.error}</Notice> : null}
        {state.confirmRequired ? (
          <div className="mt-4">
            <ConfirmItsYou
              passkey={passkey}
              authenticator={authenticator}
              explanation="To approve, confirm it's you first."
              onConfirmed={() => { void flow.confirmed(); }}
            />
          </div>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" autoFocus aria-disabled={state.busy || undefined} onClick={() => close(approveDialog)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            aria-disabled={state.busy || state.confirmRequired || undefined}
            aria-busy={state.busy || undefined}
            className="aria-disabled:opacity-50"
            onClick={() => { void flow.approve(); }}
          >
            {state.busy ? "Approving…" : "Approve sign-in"}
          </Button>
        </div>
      </dialog>

      <dialog ref={denyDialog} aria-labelledby={ids.denyTitle} aria-describedby={ids.denyBody} className={DIALOG}
        onCancel={(event) => { if (state.busy) event.preventDefault(); else flow.reset(); }}>
        <h2 id={ids.denyTitle} className="wh-section-title">Deny this sign-in request?</h2>
        <div id={ids.denyBody} className="mt-3 flex flex-col gap-3 text-sm text-fg-muted">
          <p>{`${deviceLabel} won't be able to sign in with this request.`}</p>
          <p>If you didn&apos;t try to sign in, someone may be able to read your email. Change your email password.</p>
        </div>
        {state.error ? <Notice tone="error" className="mt-4">{state.error}</Notice> : null}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" autoFocus aria-disabled={state.busy || undefined} onClick={() => close(denyDialog)}>
            Keep request
          </Button>
          <Button
            type="button"
            variant="danger-solid"
            aria-disabled={state.busy || undefined}
            aria-busy={state.busy || undefined}
            className="aria-disabled:opacity-50"
            onClick={() => { void flow.deny(); }}
          >
            {state.busy ? "Denying…" : "Deny request"}
          </Button>
        </div>
      </dialog>
    </div>
  );
}
