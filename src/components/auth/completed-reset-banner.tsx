"use client";

import * as React from "react";

import { Button } from "../ui/button";
import { Notice } from "../ui/notice";
import { ConfirmItsYou } from "../ui/confirm-its-you";
import { formatAccountTime } from "@/domain/display-time";
import { SUPPORT_EMAIL } from "../public/operator";

// Sign-in audit (founder decision 13 November 2026) — the banner every signed-in screen
// shows while an account reset has completed but has not been used to set up a new passkey.
// For 7 days after completion, whoever reads the account's email can use the reset to get
// in, so the person still signed in here is told and can close it: "This wasn't me — close
// re-enrolment" posts to /api/auth/reset/close (the session cookie says whose reset; nothing
// else is sent). Closing needs a fresh "confirm it's you"; a step_up_required refusal shows
// the shared confirmation, and once confirmed the close is sent again without another tap.
// Every outcome is plain words inside a page-level notice.

export type CloseReenrolmentResult =
  | { ok: true }
  | { ok: false; reason: "step_up_required" | "nothing_to_close" | "failed" };

// The close request, injectable for tests.
export function createCloseReenrolment(fetchImpl: typeof fetch): () => Promise<CloseReenrolmentResult> {
  return async () => {
    try {
      const response = await fetchImpl("/api/auth/reset/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (response.ok) return { ok: true };
      if (response.status === 404) return { ok: false, reason: "nothing_to_close" };
      if (response.status === 403) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        if (body.error === "step_up_required") return { ok: false, reason: "step_up_required" };
      }
    } catch {
      /* offline: reported below */
    }
    return { ok: false, reason: "failed" };
  };
}

export type CompletedResetPhase = "open" | "confirm" | "closed" | "nothing";

export interface CompletedResetState {
  readonly phase: CompletedResetPhase;
  readonly busy: boolean;
  readonly error?: string;
}

export interface CompletedResetController {
  getState(): CompletedResetState;
  close(): Promise<void>;
  // The person confirmed it's them: send the close they already asked for.
  confirmed(): Promise<void>;
}

const CLOSE_FAILED_COPY = "We couldn't close re-enrolment just now. Please try again.";

export function createCompletedResetBanner(deps: {
  close: () => Promise<CloseReenrolmentResult>;
  onChange?: () => void;
}): CompletedResetController {
  let state: CompletedResetState = { phase: "open", busy: false };
  function set(next: Partial<CompletedResetState>): void {
    state = { ...state, ...next };
    deps.onChange?.();
  }

  async function close(): Promise<void> {
    if (state.busy || state.phase !== "open") return;
    set({ busy: true, error: undefined });
    const result = await deps.close();
    if (result.ok) set({ busy: false, phase: "closed" });
    else if (result.reason === "step_up_required") set({ busy: false, phase: "confirm" });
    else if (result.reason === "nothing_to_close") set({ busy: false, phase: "nothing" });
    else set({ busy: false, error: CLOSE_FAILED_COPY });
  }

  async function confirmed(): Promise<void> {
    if (state.phase !== "confirm") return;
    set({ phase: "open" });
    await close();
  }

  return { getState: () => state, close, confirmed };
}

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export interface CompletedResetBannerProps {
  readonly completedAt: string;
  readonly reenrolUntil: string;
  readonly timeZone?: string;
  // Which ways the person can confirm it's them (the layout reads both).
  readonly passkey?: boolean;
  readonly authenticator?: boolean;
  readonly fetch?: typeof fetch;
}

const CONFIRM_TO_CLOSE =
  "Before we close re-enrolment, we need to check it's really you.";

export function CompletedResetBanner(props: CompletedResetBannerProps) {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const [banner] = React.useState(() =>
    createCompletedResetBanner({ close: createCloseReenrolment(props.fetch ?? defaultFetch), onChange: redraw }),
  );
  const state = banner.getState();

  // Every state sits on the page grid as a page-level notice, like the pending-reset banner.
  if (state.phase === "closed") {
    return (
      <div className="wh-page" style={{ paddingBottom: 0 }}>
        <Notice tone="success" className="wh-page-notice">
          Re-enrolment is closed. Nobody can use this reset to set up a new passkey. If you didn&apos;t ask for
          the reset, email {SUPPORT_EMAIL} and check Settings › Security for passkeys and devices you don&apos;t
          recognise.
        </Notice>
      </div>
    );
  }
  if (state.phase === "nothing") {
    return (
      <div className="wh-page" style={{ paddingBottom: 0 }}>
        <Notice tone="info" className="wh-page-notice">
          There&apos;s nothing left to close: this reset was already closed or used, or its 7 days have passed. If
          you didn&apos;t ask for it, email {SUPPORT_EMAIL}.
        </Notice>
      </div>
    );
  }

  return (
    <div className="wh-page" style={{ paddingBottom: 0 }}>
      <Notice tone="error" className="wh-page-notice">
        <div className="flex flex-col gap-3">
          <p className="font-medium">
            Your account reset finished on {formatAccountTime(props.completedAt, props.timeZone)}.
          </p>
          <p>
            Your saved cards and protected details were erased and your agents were disconnected. Until{" "}
            {formatAccountTime(props.reenrolUntil, props.timeZone)}, anyone who can read your email can use this
            reset to set up a new passkey and get into your account. If you didn&apos;t ask for this reset, close
            re-enrolment now.
          </p>
          {state.error ? <p className="text-danger">{state.error}</p> : null}
          {state.phase === "confirm" ? (
            <ConfirmItsYou
              explanation={CONFIRM_TO_CLOSE}
              passkey={props.passkey}
              authenticator={props.authenticator}
              onConfirmed={() => {
                void banner.confirmed();
              }}
            />
          ) : (
            <div>
              <Button
                type="button"
                variant="primary"
                aria-busy={state.busy ? true : undefined}
                aria-disabled={state.busy ? true : undefined}
                onClick={() => {
                  void banner.close();
                }}
              >
                {state.busy ? "Closing…" : "This wasn't me — close re-enrolment"}
              </Button>
            </div>
          )}
        </div>
      </Notice>
    </div>
  );
}

export default CompletedResetBanner;
