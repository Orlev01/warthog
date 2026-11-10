"use client";

import * as React from "react";

import { AgentListView, type AgentListItem } from "@/components/agents/agent-list-view";
import { Button } from "@/components/ui/button";

// E10-S11 — the single confirm that gates a Disconnect, mounted by the Agents list page
// around <AgentListView/>.
//
// Disconnecting an agent is destructive (its very next request is refused, its pending
// approvals denied, its uncollected release cancelled — E10-S09), so the Agents list asks
// the person to confirm ONCE before the disconnect runs. The merged E10-S10 AgentListView
// renders each Disconnect as a `<form action={disconnectAction}>`; this module wraps the
// page's bound disconnect action on the client so the confirm gates it.
//
// As the sibling client flows do (auth factor-controls / sign-in / sign-up export an
// injectable, framework-free controller alongside their `"use client"` component), the
// gating logic lives in `createDisconnectConfirm` — a pure controller driven by injected
// seams — and the `"use client"` component presents an accessible in-page dialog.
// The controller holds no React or browser state, so it is unit-tested
// framework-free.

export type DisconnectAction = (formData: FormData) => void | Promise<void>;

export interface DisconnectConfirmDeps {
  // The bound disconnect action the page passes (an inline `use server` wrapper that
  // re-derives the session and calls disconnectAgent with the submitted agent id).
  readonly disconnect: DisconnectAction;
  // The confirm seam: resolves true to proceed, false to cancel.
  readonly confirm: (message?: string) => boolean | Promise<boolean>;
}

// Plain Australian English, one sentence — what disconnecting does, before it happens.
const CONFIRM_MESSAGE =
  "Disconnect this agent? It loses access straight away, and can't act for you until you reconnect it.";

// Gate the bound disconnect behind a single confirm: ask the confirm seam EXACTLY ONCE
// and run `disconnect` (forwarding the submitted FormData, which carries the agent id)
// only when it returns true; a cancelled confirm runs the disconnect not at all.
export function createDisconnectConfirm(deps: DisconnectConfirmDeps): DisconnectAction {
  const { disconnect, confirm } = deps;
  return async (formData: FormData) => {
    if (!(await confirm(CONFIRM_MESSAGE))) return;
    await disconnect(formData);
  };
}

export interface AgentsScreenProps {
  readonly agents: readonly AgentListItem[];
  // The page's bound disconnect server action, gated here behind the single confirm.
  readonly disconnect: DisconnectAction;
}

// The client wrapper the page mounts: gate the page's disconnect action behind a single
// in-page dialog, then render the already-render-tested AgentListView over it.
export function AgentsScreen({ agents, disconnect }: AgentsScreenProps) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const decision = React.useRef<((approved: boolean) => void) | null>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  React.useEffect(() => () => { decision.current?.(false); }, []);
  function finish(approved: boolean) {
    const resolve = decision.current;
    decision.current = null;
    dialog.current?.close();
    resolve?.(approved);
  }
  const gated = createDisconnectConfirm({
    disconnect,
    confirm: () => new Promise<boolean>((resolve) => {
      decision.current?.(false);
      const modal = dialog.current;
      if (!modal) { resolve(false); return; }
      decision.current = resolve;
      // React form actions run in a transition: state updates can wait for this
      // promise, so opening through state would deadlock the confirmation.
      if (!modal.open) modal.showModal();
    }),
  });
  return <>
    <AgentListView agents={agents} disconnectAction={gated} />
    <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
      className="top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)] bottom-[env(safe-area-inset-bottom)] left-[env(safe-area-inset-left)] m-auto max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-md overflow-y-auto rounded-card border border-line bg-surface p-4 text-fg shadow-lg sm:p-6"
      onCancel={(event) => { event.preventDefault(); finish(false); }}>
      <h2 id={titleId} className="text-lg font-semibold">Disconnect this agent?</h2>
      <p id={descriptionId} className="mt-3 text-sm text-fg-muted">{CONFIRM_MESSAGE}</p>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button autoFocus variant="secondary" onClick={() => finish(false)}>Keep connected</Button>
        <Button onClick={() => finish(true)}>Disconnect agent</Button>
      </div>
    </dialog>
  </>;
}

export default AgentsScreen;
