"use client";

import * as React from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import type { HandoffResult } from "@/server/admin/handoff";

// AdminPortalEntry — the member app's door into the admin portal (docs/design/admin-portal.md §2),
// shown on Settings only to a live admin. "Open admin portal" asks the server action to mint
// a single-use handoff; the browser then NAVIGATES by script to the admin origin's exchange
// URL (script navigation is not governed by CSP form-action, so the strict policy stays).
// A stale step-up mounts the shared ConfirmItsYou control inline and retries once confirmed;
// every refusal is a plain sentence; a second tap while working is ignored.
//
// The repo's render-testable-AND-interactive split: `createAdminPortalEntry` is the
// framework-free controller driven with fake actions in tests; the component is a thin
// client wrapper with real browser defaults.

export type StartHandoff = () => Promise<HandoffResult>;

export type AdminPortalEntryState =
  | { readonly phase: "idle" }
  | { readonly phase: "working" }
  | { readonly phase: "step_up" }
  | { readonly phase: "error"; readonly error: string };

export interface AdminPortalEntryDeps {
  readonly startHandoff: StartHandoff;
  readonly navigate: (url: string) => void;
  readonly onChange?: () => void;
}

export interface AdminPortalEntryController {
  getState(): AdminPortalEntryState;
  open(): Promise<void>;
}

const SIGNED_OUT_COPY = "Your session has ended. Sign in again, then open the admin portal.";
const NOT_ADMIN_COPY = "This account can't open the admin portal.";
const FAILED_COPY = "We couldn't open the admin portal. Please try again.";
export const STEP_UP_EXPLANATION = "We need to check it's really you before opening the admin portal.";

export function createAdminPortalEntry(deps: AdminPortalEntryDeps): AdminPortalEntryController {
  let state: AdminPortalEntryState = { phase: "idle" };
  const set = (next: AdminPortalEntryState) => { state = next; deps.onChange?.(); };
  return {
    getState: () => state,
    async open() {
      if (state.phase === "working") return;
      set({ phase: "working" });
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
    },
  };
}

export function AdminPortalEntry({
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
  const flowRef = React.useRef<AdminPortalEntryController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createAdminPortalEntry({
      startHandoff,
      navigate: navigate ?? ((url) => { window.location.assign(url); }),
      onChange: () => forceUpdate(),
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const working = state.phase === "working";
  return (
    <WorkspacePanel
      title="Admin portal"
      icon={ShieldCheck}
      description="Sign-ups, usage, traffic and the product's health, at a glance. Opening it checks it's you first."
    >
      <div className="flex flex-col gap-4">
        {state.phase === "error" ? (
          <p role="alert" className="text-sm text-danger">{state.error}</p>
        ) : null}
        {state.phase === "step_up" ? (
          <ConfirmItsYou
            passkey={passkey}
            authenticator={authenticator}
            explanation={STEP_UP_EXPLANATION}
            confirmedText="Thanks — that's confirmed. Opening the admin portal…"
            onConfirmed={() => { void flow.open(); }}
          />
        ) : null}
        <div className="flex">
          <Button
            type="button"
            variant="primary"
            aria-disabled={working || undefined}
            aria-busy={working || undefined}
            onClick={() => { void flow.open(); }}
          >
            <ExternalLink aria-hidden={true} className="h-4 w-4 shrink-0" />
            {working ? "Opening…" : "Open admin portal"}
          </Button>
        </div>
      </div>
    </WorkspacePanel>
  );
}
