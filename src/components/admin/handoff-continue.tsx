"use client";

import * as React from "react";
import { Home, RotateCcw, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { StatusScreen } from "@/components/shell/status-screens";
import type { HandoffResult } from "@/server/admin/handoff";

// HandoffContinue — the app-side half of the way into the admin portal
// (docs/design/admin-portal.md §2, as amended on 13 November 2026). The member app links
// to it nowhere: the admin host's "Sign in" goes through the app's ordinary sign-in, which
// returns here, and the route renders this screen only for a signed-in live admin (anyone
// else gets the app's ordinary 404). On mount it asks the server action to mint a
// single-use handoff; the browser then NAVIGATES by script to the admin origin's exchange
// URL (script navigation is not governed by CSP form-action, so the strict policy stays).
// A stale step-up mounts the shared ConfirmItsYou control and retries once confirmed (a
// fresh sign-in already counts as one, so straight after signing in nothing is asked);
// every refusal is a plain sentence; a second start while one is in flight is ignored.
//
// The repo's render-testable-AND-interactive split: `createHandoffContinue` is the
// framework-free controller driven with fake actions in tests; the component is a thin
// client wrapper with real browser defaults.

export type StartHandoff = () => Promise<HandoffResult>;

export type HandoffContinueState =
  | { readonly phase: "working" }
  | { readonly phase: "step_up" }
  | { readonly phase: "error"; readonly error: string };

export interface HandoffContinueDeps {
  readonly startHandoff: StartHandoff;
  readonly navigate: (url: string) => void;
  readonly onChange?: () => void;
}

export interface HandoffContinueController {
  getState(): HandoffContinueState;
  start(): Promise<void>;
}

const SIGNED_OUT_COPY = "Your session has ended. Sign in again.";
const NOT_ADMIN_COPY = "This account can't continue.";
const FAILED_COPY = "We couldn't open the admin portal. Please try again.";

export function createHandoffContinue(deps: HandoffContinueDeps): HandoffContinueController {
  // Working from the first paint: the screen starts the handoff as soon as it mounts.
  let state: HandoffContinueState = { phase: "working" };
  let inFlight = false;
  const set = (next: HandoffContinueState) => { state = next; deps.onChange?.(); };
  return {
    getState: () => state,
    async start() {
      if (inFlight) return;
      inFlight = true;
      set({ phase: "working" });
      try {
        let result: HandoffResult;
        try {
          result = await deps.startHandoff();
        } catch {
          set({ phase: "error", error: FAILED_COPY });
          return;
        }
        if (result.ok) {
          deps.navigate(result.url);
          return;
        }
        if (result.reason === "step_up_required") set({ phase: "step_up" });
        else if (result.reason === "signed_out") set({ phase: "error", error: SIGNED_OUT_COPY });
        else set({ phase: "error", error: NOT_ADMIN_COPY });
      } finally {
        inFlight = false;
      }
    },
  };
}

export function HandoffContinue({
  startHandoff,
  passkey,
  authenticator,
  navigate,
}: {
  startHandoff: StartHandoff;
  passkey: boolean;
  authenticator: boolean;
  // Browser seam, overridable for tests; defaults to a real navigation.
  navigate?: (url: string) => void;
}) {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<HandoffContinueController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createHandoffContinue({
      startHandoff,
      navigate: navigate ?? ((url) => { window.location.assign(url); }),
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  React.useEffect(() => { void flow.start(); }, [flow]);
  const state = flow.getState();

  if (state.phase === "step_up") {
    return (
      <StatusScreen icon={<ShieldCheck aria-hidden size={22} strokeWidth={1.7} />} title="Confirm it's you" actions={null}>
        <ConfirmItsYou
          passkey={passkey}
          authenticator={authenticator}
          explanation="Confirm it's you to open the admin portal."
          confirmedText="Thanks — that's confirmed. Opening the admin portal…"
          onConfirmed={() => { void flow.start(); }}
        />
      </StatusScreen>
    );
  }
  if (state.phase === "error") {
    return (
      <StatusScreen
        icon={<ShieldCheck aria-hidden size={22} strokeWidth={1.7} />}
        title="We couldn't open the admin portal"
        actions={
          <>
            <Button type="button" variant="primary" onClick={() => { void flow.start(); }}>
              <RotateCcw aria-hidden={true} className="h-4 w-4 shrink-0" />
              Try again
            </Button>
            <ButtonLink href="/home">
              <Home aria-hidden={true} className="h-4 w-4 shrink-0" />
              Go to Warthog
            </ButtonLink>
          </>
        }
      >
        <p role="alert">{state.error}</p>
      </StatusScreen>
    );
  }
  return (
    <StatusScreen icon={<ShieldCheck aria-hidden size={22} strokeWidth={1.7} />} title="Opening the admin portal" actions={null}>
      <p role="status" aria-busy="true">One moment…</p>
    </StatusScreen>
  );
}
