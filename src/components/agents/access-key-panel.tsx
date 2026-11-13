"use client";

import * as React from "react";
import { KeyRound, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Notice, type NoticeTone } from "@/components/ui/notice";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { IssuedKey } from "./issued-key";

// The "Access key" panel in an access-key agent's Settings section (brief "Connect an
// agent": the access-key route "lets them revoke or replace the key later from that agent's
// page"; interaction-07 follow-up). Only an agent that connected with a Warthog access key
// (`wh_ak_…`) gets it: an agent connected over OAuth has no access key. The page decides,
// from `accessKeyState` (src/server/agents/access-key-state.ts).
//
//   • Replace key — asks first, then shows the new key ONCE (the same `IssuedKey` piece as
//     the creation flow: the key, the Copy control and its clipboard instruction, the
//     shown-once warning). The old key stops working straight away.
//   • Revoke key — a danger confirmation: the agent loses access until you create a new key.
//   • Create a new key — once revoked, the same server replace issues the agent's new key,
//     so its permissions and history are kept.
//
// The page's server actions do the work (`createAccessKeyActions`): they resolve the agent
// from the SESSION's person, re-check it is connected under the connection's credential
// lock, and write the same activity entries as before ("Access key replaced" / "Access key
// revoked"). A new key is lasting access, so making one needs a fresh "confirm it's you"
// (security audit 2026-11-13): a `step_up_required` refusal shows the confirmation here and,
// once confirmed, makes the key without another tap. Revoking only cuts access, so like
// Disconnect it stays a single confirmation.
//
// As the sibling flows do, the logic is a framework-free controller
// (`createAccessKeyPanel`) with a thin client component over it. The raw key lives only in
// the controller's state for its one showing; "Done" drops it, and it is never logged.

export type AccessKeyPanelKey = "active" | "revoked";
export type ReplaceKeyResult = { ok: true; key: string } | { ok: false; reason: string };
export type RevokeKeyResult = { ok: true } | { ok: false; reason: string };

export interface AccessKeyPanelDeps {
  agentName: string;
  initial: AccessKeyPanelKey;
  // The page's "use server" wrappers over createAccessKeyActions, bound to this agent.
  replace: () => Promise<ReplaceKeyResult>;
  revoke: () => Promise<RevokeKeyResult>;
  onChange?: () => void;
}

export interface AccessKeyPanelState {
  key: AccessKeyPanelKey;
  working: "replace" | "revoke" | null;
  // The new RAW key, present only for its one showing.
  issuedKey?: string;
  // Whether the new key replaced a working one (so "the old key has stopped working").
  replacedOldKey?: boolean;
  notice?: { tone: NoticeTone; text: string };
  // A new key waits for a fresh "confirm it's you"; `confirmed()` then makes it.
  confirmRequired?: boolean;
}

export interface AccessKeyPanelController {
  getState(): AccessKeyPanelState;
  replace(): Promise<void>;
  revoke(): Promise<void>;
  confirmed(): Promise<void>;
  dismissKey(): void;
}

// Plain words for every outcome: never the raw reason, no protocol jargon.
const DISCONNECTED = "This agent is disconnected, so its key can’t be changed. Reload the page to see its current state.";
const REPLACE_FAILED = "We couldn’t make a new key just now. Please try again.";
const REVOKE_FAILED = "We couldn’t revoke the key just now. Please try again.";
const ALREADY_REVOKED = "This key was already revoked, so nothing changed.";
const CONFIRM_TO_REPLACE = "Before we make a new key, we need to check it's really you. Anyone with the key can act as this agent.";

export function createAccessKeyPanel(deps: AccessKeyPanelDeps): AccessKeyPanelController {
  let state: AccessKeyPanelState = { key: deps.initial, working: null };
  function set(patch: Partial<AccessKeyPanelState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  async function replace(): Promise<void> {
    if (state.working || state.confirmRequired) return; // one confirm, one new key
    const replacedOldKey = state.key === "active";
    set({ working: "replace", notice: undefined, issuedKey: undefined });
    let result: ReplaceKeyResult;
    try {
      result = await deps.replace();
    } catch {
      set({ working: null, notice: { tone: "error", text: REPLACE_FAILED } });
      return;
    }
    if (result.ok) {
      set({ working: null, key: "active", issuedKey: result.key, replacedOldKey });
    } else if (result.reason === "step_up_required") {
      set({ working: null, confirmRequired: true });
    } else {
      set({ working: null, notice: { tone: "error", text: result.reason === "not_connected" ? DISCONNECTED : REPLACE_FAILED } });
    }
  }

  // The person confirmed it's them: make the new key they already asked for.
  async function confirmed(): Promise<void> {
    if (!state.confirmRequired) return;
    set({ confirmRequired: false });
    await replace();
  }

  async function revoke(): Promise<void> {
    if (state.working) return;
    set({ working: "revoke", notice: undefined, issuedKey: undefined });
    let result: RevokeKeyResult;
    try {
      result = await deps.revoke();
    } catch {
      set({ working: null, notice: { tone: "error", text: REVOKE_FAILED } });
      return;
    }
    if (result.ok) {
      set({
        working: null,
        key: "revoked",
        notice: { tone: "success", text: `Key revoked. ${deps.agentName} can’t use Warthog until you create a new key.` },
      });
    } else if (result.reason === "no_key") {
      set({ working: null, key: "revoked", notice: { tone: "info", text: ALREADY_REVOKED } });
    } else {
      set({ working: null, notice: { tone: "error", text: result.reason === "not_connected" ? DISCONNECTED : REVOKE_FAILED } });
    }
  }

  return {
    getState: () => state,
    replace,
    revoke,
    confirmed,
    dismissKey: () => set({ issuedKey: undefined, replacedOldKey: undefined }),
  };
}

// ─── the confirmation (the same in-page dialog as Disconnect) ─────────────────────────

const DIALOG_CLASS =
  "top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)] bottom-[env(safe-area-inset-bottom)] left-[env(safe-area-inset-left)] m-auto max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-md overflow-y-auto rounded-panel border border-line bg-surface p-4 text-fg shadow-lg sm:p-6";

function ConfirmDialog({
  dialogRef,
  title,
  children,
  keepLabel,
  confirmLabel,
  danger,
  onConfirm,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  title: string;
  children: React.ReactNode;
  keepLabel: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const close = () => dialogRef.current?.close();
  return (
    <dialog ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId} className={DIALOG_CLASS}>
      {/* Title, plain consequences, the safe choice first and focused, then the final step
          (danger-solid for a revoke, as for Disconnect and removing a passkey). */}
      <h2 id={titleId} className="wh-section-title [overflow-wrap:anywhere]">{title}</h2>
      <div id={descriptionId} className="mt-3 flex flex-col gap-2 text-sm text-fg-muted">{children}</div>
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button autoFocus variant="secondary" onClick={close}>{keepLabel}</Button>
        <Button variant={danger ? "danger-solid" : "primary"} onClick={() => { close(); onConfirm(); }}>{confirmLabel}</Button>
      </div>
    </dialog>
  );
}

// ─── the client component ─────────────────────────────────────────────────────────────

export interface AccessKeyPanelProps {
  agentName: string;
  state: AccessKeyPanelKey;
  replace: () => Promise<ReplaceKeyResult>;
  revoke: () => Promise<RevokeKeyResult>;
  // Seed a new key for a render test (the production panel reaches it through Replace).
  initialKey?: string;
  // Seed the confirm-it's-you prompt for a render test (production reaches it through a
  // `step_up_required` refusal).
  initialConfirmRequired?: boolean;
  // Which ways this person can confirm it's you (the page reads them); omitted offers both.
  passkey?: boolean;
  authenticator?: boolean;
}

export function AccessKeyPanel(props: AccessKeyPanelProps): React.ReactElement {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const [panel] = React.useState(() =>
    createAccessKeyPanel({ agentName: props.agentName, initial: props.state, replace: props.replace, revoke: props.revoke, onChange: redraw }),
  );
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);
  const replaceDialog = React.useRef<HTMLDialogElement>(null);
  const revokeDialog = React.useRef<HTMLDialogElement>(null);
  const issuedHeading = React.useRef<HTMLHeadingElement>(null);
  const replaceButton = React.useRef<HTMLButtonElement>(null);
  const restoreFocus = React.useRef(false);

  const state = panel.getState();
  const issuedKey = state.issuedKey ?? props.initialKey;
  const replacedOldKey = state.issuedKey ? state.replacedOldKey : props.initialKey ? true : false;
  const name = props.agentName;

  // The new key replaces the panel's controls, so focus moves to its heading; "Done" puts
  // focus back on Replace key rather than dropping it on the page.
  React.useEffect(() => {
    if (state.issuedKey) issuedHeading.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      replaceButton.current?.focus();
    }
  }, [state.issuedKey]);

  const open = (dialog: React.RefObject<HTMLDialogElement | null>) => {
    if (!ready || state.working) return;
    if (!dialog.current?.open) dialog.current?.showModal();
  };
  const notice = state.notice ? (
    <Notice tone={state.notice.tone}>{state.notice.text}</Notice>
  ) : null;
  const confirm = state.confirmRequired || props.initialConfirmRequired ? (
    <ConfirmItsYou explanation={CONFIRM_TO_REPLACE} passkey={props.passkey} authenticator={props.authenticator} onConfirmed={() => { void panel.confirmed(); }} />
  ) : null;

  if (issuedKey) {
    return (
      <WorkspacePanel
        title="Access key"
        description={`A new access key for ${name}.`}
        footer={
          <Button variant="secondary" onClick={() => { restoreFocus.current = true; panel.dismissKey(); }}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <h3 ref={issuedHeading} tabIndex={-1} className="wh-group-title">Your new access key</h3>
          <p className="text-sm text-fg-muted">
            {replacedOldKey ? "The old key has stopped working. " : null}
            Paste this key into {name} where it asks for an access key.
          </p>
          <IssuedKey keyValue={issuedKey} />
        </div>
      </WorkspacePanel>
    );
  }

  const working = state.working;
  if (state.key === "revoked") {
    return (
      <WorkspacePanel
        title="Access key"
        description={`${name} has no working access key, so it can’t use Warthog.`}
        footer={
          <Button
            ref={replaceButton}
            variant="secondary"
            disabled={!ready}
            aria-disabled={working ? true : undefined}
            aria-busy={working === "replace" || undefined}
            onClick={() => { if (!working) void panel.replace(); }}
          >
            <KeyRound aria-hidden className="h-4 w-4 shrink-0" />
            {working === "replace" ? "Creating…" : "Create a new key"}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-fg-muted">
          {notice}
          <p>Create a new key and paste it into {name} to let it back in. Its settings and history are kept.</p>
          {confirm}
        </div>
      </WorkspacePanel>
    );
  }

  return (
    <>
      <WorkspacePanel
        title="Access key"
        description={`${name} connects to Warthog with an access key.`}
        footer={
          <>
            <Button
              ref={replaceButton}
              variant="secondary"
              disabled={!ready}
              aria-disabled={working ? true : undefined}
              aria-busy={working === "replace" || undefined}
              onClick={() => open(replaceDialog)}
            >
              <RefreshCw aria-hidden className="h-4 w-4 shrink-0" />
              {working === "replace" ? "Replacing…" : "Replace key"}
            </Button>
            <Button
              variant="danger"
              disabled={!ready}
              aria-disabled={working ? true : undefined}
              aria-busy={working === "revoke" || undefined}
              onClick={() => open(revokeDialog)}
            >
              {working === "revoke" ? "Revoking…" : "Revoke key"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-fg-muted">
          {notice}
          <p>
            Warthog can&rsquo;t show the key again. If it&rsquo;s lost or may have been shared, replace
            it: you get a new key and the old one stops working straight away. Revoke it to cut off
            access until you create a new key.
          </p>
          {confirm}
        </div>
      </WorkspacePanel>
      <ConfirmDialog
        dialogRef={replaceDialog}
        title={`Replace ${name}’s access key?`}
        keepLabel="Keep current key"
        confirmLabel="Replace key"
        onConfirm={() => void panel.replace()}
      >
        <p>Warthog makes a new key and shows it to you once.</p>
        <p>The old key stops working straight away, so {name} can&rsquo;t use Warthog until you paste the new key into it.</p>
      </ConfirmDialog>
      <ConfirmDialog
        dialogRef={revokeDialog}
        title={`Revoke ${name}’s access key?`}
        keepLabel="Keep key"
        confirmLabel="Revoke key"
        danger
        onConfirm={() => void panel.revoke()}
      >
        <p>The key stops working straight away. {name} loses access to Warthog until you create a new key here.</p>
        <p>Its settings and history stay.</p>
      </ConfirmDialog>
    </>
  );
}

export default AccessKeyPanel;
