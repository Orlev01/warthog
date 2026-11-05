"use client";

import * as React from "react";

import { AgentListView, type AgentListItem } from "@/components/agents/agent-list-view";

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
// seams — and the `"use client"` component defaults the confirm seam to the browser's
// `window.confirm`. The controller holds no React and no `window`, so it is unit-tested
// framework-free.

export type DisconnectAction = (formData: FormData) => void | Promise<void>;

export interface DisconnectConfirmDeps {
  // The bound disconnect action the page passes (an inline `use server` wrapper that
  // re-derives the session and calls disconnectAgent with the submitted agent id).
  readonly disconnect: DisconnectAction;
  // The confirm seam (⇐ window.confirm): returns true to proceed, false to cancel.
  readonly confirm: (message?: string) => boolean;
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
    if (!confirm(CONFIRM_MESSAGE)) return;
    await disconnect(formData);
  };
}

export interface AgentsScreenProps {
  readonly agents: readonly AgentListItem[];
  // The page's bound disconnect server action, gated here behind the single confirm.
  readonly disconnect: DisconnectAction;
}

// The client wrapper the page mounts: gate the page's disconnect action behind a single
// `window.confirm`, then render the already-render-tested AgentListView over it.
export function AgentsScreen({ agents, disconnect }: AgentsScreenProps) {
  const gated = createDisconnectConfirm({
    disconnect,
    confirm: (message) => window.confirm(message),
  });
  return <AgentListView agents={agents} disconnectAction={gated} />;
}

export default AgentsScreen;
