"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { IssuedKey } from "./issued-key";
import { ConnectionPermissions, ConnectionAccessSummary } from "./connection-permissions";
import { connectionChoices, connectionChoiceInput, type ConnectionChoices, type ConnectionService } from "@/domain/permissions/connection-choices";

// E10-S13 — Access-key flow (brief "Connect an agent" — "For a platform that cannot use
// the standard connector sign-in, 'Create an access key' lets the person name the agent
// and set its permissions on the same screen as the consent screen, shows the key once
// with a copy button, and lets them revoke or replace the key later"; design §6.1;
// the key is replaced or revoked later from the "Access key" panel in that agent's
// Settings section (`access-key-panel.tsx`), and the issued panel points there
// (interaction-07); constitution 16 — each agent has its own revocable credential, a per-agent access key
// where a platform cannot use the connector flow).
//
// The `/agents/access-key` page mounts this flow over the already-built, already-tested
// `createAccessKeyActions` seam (its sibling `access-key/actions.ts`). The person names
// the agent and picks its starting permission set on ONE screen, creates it, and the raw
// key is shown ONCE with a Copy control and plain instructions. The server-side contract
// (the agent is named under the SESSION user, the key is stored only hashed and verifies
// at /mcp, revoke stops it, a SQLi probe is bound as data, malformed/oversized input is a
// 4xx) lives in `access-key/actions.ts` — this flow only CALLS `create` with the person's
// choices and shows the ONE returned key.
//
// It exports the TWO seams the repo's render-testable-AND-interactive pattern uses
// (SignupView + createSignupFlow; AddCardFlow + createAddCardFlow; HighTierFlow +
// createHighTierFlow):
//   1. AccessKeyFlow — the Client Component the page mounts: its create surface names the
//      agent and offers the three starting sets with a live Create; once a key is issued it
//      shows that key ONCE with a live Copy control, plain instructions and a warning that
//      it won't be shown again.
//   2. createAccessKeyFlow(deps) — the framework-free, injectable controller behind the
//      live Create: collect the name / platform / starting set, call the page's `create`
//      action, hold the issued key for its one showing, and report a refusal in plain words.
//
// Colour comes from the design tokens (globals.css) — never a raw hex. Everything is said
// in plain Australian English — no protocol or security jargon (brief design_ux.copy;
// constitution INV-22).

// ─── the controller contract this task introduces ─────────────────────────────────────

export type AccessKeyTemplate = "minimal" | "standard" | "custom";

// The create input, as the access-key screen submits it — the SAME shape the access-key
// actions' `create` validates. The acting person's identity is the SESSION's (the server's
// job): this flow never invents a user id in the untrusted input.
export interface AccessKeyCreateInput {
  name: string;
  platform: string;
  template: AccessKeyTemplate;
  tickedServices?: readonly string[];
  identity?: boolean;
  memoryRead?: boolean;
  memoryWrite?: boolean;
  tasks?: boolean;
  records?: boolean;
  highTier?: boolean;
  card?: boolean;
  cardBudget?: { amount: number; currency: string; period: string } | null;
  learningSharing?: boolean;
}

// The outcome of a create: the created agent's id and the RAW key shown ONCE, or a refusal
// naming its machine reason (never surfaced raw — plain copy instead).
export type AccessKeyCreateResult =
  | { ok: true; agentId: string; key: string }
  | { ok: false; reason: string };

export type AccessKeyCreate = (input: AccessKeyCreateInput) => Promise<AccessKeyCreateResult>;

// The control's own status: idle until the person confirms, `working` while the create
// runs, then `created` (the key is exposed once) or `error` (a plain refusal, no key).
export type AccessKeyFlowStatus = "idle" | "working" | "created" | "error";

export interface AccessKeyFlowState {
  name: string;
  platform: string;
  template: AccessKeyTemplate;
  status: AccessKeyFlowStatus;
  choices: ConnectionChoices;
  key?: string; // the RAW key, present only in "created" — shown once
  agentId?: string; // the created agent's id, present only in "created"
  error?: string; // a plain-English refusal, present only in "error"
}

export interface AccessKeyFlowDeps {
  services?: readonly ConnectionService[];
  create: AccessKeyCreate;
  defaultTemplate?: "minimal" | "standard";
  defaultName?: string; // the proposed agent name (page-supplied)
  defaultPlatform?: string; // the platform the key is for (page-supplied)
  onChange?: () => void; // re-render notifier (the component wires it)
  onCreated?: () => void; // called once a key is issued (list refresh)
}

export interface AccessKeyController {
  getState(): AccessKeyFlowState;
  setName(value: string): void;
  setPlatform(value: string): void;
  setTemplate(value: AccessKeyTemplate): void;
  setChoices(value: ConnectionChoices): void;
  submit(): Promise<void>;
}

// Plain-English failure copy — a real sentence a person can act on, with no protocol
// jargon and never the raw machine reason (brief design_ux.copy; constitution INV-22). A
// refusal and a thrown transport fault both surface this.
const CREATE_FAILED_COPY =
  "We couldn't create your access key just now. Please try again.";

export function createAccessKeyFlow(deps: AccessKeyFlowDeps): AccessKeyController {
  let state: AccessKeyFlowState = {
    name: deps.defaultName ?? "",
    platform: deps.defaultPlatform ?? "",
    template: deps.defaultTemplate ?? "standard",
    status: "idle",
    choices: connectionChoices(deps.defaultTemplate ?? "standard"),
  };

  function set(patch: Partial<AccessKeyFlowState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  // Create: call the page's action with the person's choices. The acting user id is the
  // session's (the server's job) — never smuggled into this input. A refusal comes back
  // with its own machine reason, which is never surfaced raw; a thrown boundary fault (a
  // 4xx / transport error) is caught here, never let escape. On success the ONE returned
  // key is held for its single showing.
  async function submit(): Promise<void> {
    if (state.status === "working" || state.status === "created") return; // guard against a double confirm
    set({ status: "working", error: undefined });

    let result: AccessKeyCreateResult;
    try {
      result = await deps.create({
        name: state.name,
        platform: state.platform,
        template: state.template,
        ...connectionChoiceInput(state.choices),
      });
    } catch {
      set({ status: "error", error: CREATE_FAILED_COPY });
      return;
    }

    if (result.ok) {
      set({ status: "created", key: result.key, agentId: result.agentId, error: undefined });
      deps.onCreated?.();
    } else {
      set({ status: "error", error: CREATE_FAILED_COPY });
    }
  }

  return {
    getState: () => state,
    setName: (value) => set({ name: value }),
    setPlatform: (value) => set({ platform: value }),
    setTemplate: (value) => set({ template: value, choices: value === "custom" ? state.choices : connectionChoices(value) }),
    setChoices: (choices) => set({ template: "custom", choices }),
    submit,
  };
}

// ─── copy (plain Australian English; no protocol jargon) ───────────────────────────────

// ─── the key-shown surface (the key once, a Copy control, instructions, a warning) ─────

function IssuedPanel({ keyValue, agentId }: { keyValue: string; agentId?: string }) {
  // The create surface is replaced by this one, so focus moves to its heading — a keyboard
  // or screen-reader user lands on the key, not on an empty page.
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => { heading.current?.focus(); }, []);
  return (
    <div className="wh-connection-flow">
      <header className="wh-connection-intro">
        <span className="wh-connection-mark"><KeyRound size={24} aria-hidden="true" /></span>
        <p className="wh-connection-eyebrow">Agent connection</p>
        <h1 ref={heading} tabIndex={-1}>Your access key is ready</h1>
        <p>Paste this key into your agent where it asks for an access key.</p>
      </header>

      <section className="wh-connection-section" aria-labelledby="access-key-issued-heading">
        <h2 id="access-key-issued-heading" className="sr-only">Your access key</h2>
        <IssuedKey keyValue={keyValue} />
        <p className="wh-connection-help">
          Add it in your agent&rsquo;s connector or access-key settings. If the key is lost or
          shared by mistake, replace it in{" "}
          {agentId ? (
            <a href={`/agents/${encodeURIComponent(agentId)}?section=settings`} className="font-medium text-fg underline underline-offset-4">
              this agent&rsquo;s Settings
            </a>
          ) : (
            "this agent’s Settings in Agents"
          )}
          : the old key stops working straight away. You can revoke it there too.
        </p>
      </section>

      <div className="wh-connection-actionbar">
        <div className="wh-connection-actions">
          <ButtonLink href={agentId ? `/agents/${encodeURIComponent(agentId)}` : "/agents"} variant="primary">
            Review this agent&rsquo;s permissions
          </ButtonLink>
          <ButtonLink href="/agents">Go to your agents</ButtonLink>
        </div>
      </div>
    </div>
  );
}

// ─── the client component (a thin binding over the controller) ─────────────────────────

export interface AccessKeyFlowProps {
  services?: readonly ConnectionService[];
  // The page's "use server" wrapper over createAccessKeyActions.create.
  create: AccessKeyCreate;
  defaultTemplate?: "minimal" | "standard";
  defaultName?: string;
  defaultPlatform?: string;
  // Seed the issued panel for a preview / render test (the production flow reaches it via
  // submit — the sibling `initialOpen` idiom of AddCardFlow / HighTierFlow).
  initialKey?: string;
  initialAgentId?: string;
  // Called once a key is issued (the page refreshes the agents list).
  onCreated?: () => void;
}

export function AccessKeyFlow(props: AccessKeyFlowProps): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const flowRef = React.useRef<AccessKeyController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createAccessKeyFlow({
      create: props.create,
      services: props.services,
      defaultTemplate: props.defaultTemplate,
      defaultName: props.defaultName,
      defaultPlatform: props.defaultPlatform,
      onChange: () => forceUpdate(),
      onCreated: props.onCreated,
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  // Call every hook unconditionally (rules of hooks), even on the issued path.
  const nameId = React.useId();


  // The issued key: from a completed create, or the preview/test seed.
  const issuedKey = state.status === "created" ? state.key : props.initialKey;

  if (issuedKey) {
    return <IssuedPanel keyValue={issuedKey} agentId={state.agentId ?? props.initialAgentId} />;
  }

  return (
    <form method="post" className="wh-connection-flow" onSubmit={event => { event.preventDefault(); if (ready) void flow.submit(); }}>
      <header className="wh-connection-intro">
        <span className="wh-connection-mark"><KeyRound size={24} aria-hidden="true" /></span>
        <p className="wh-connection-eyebrow">Agent connection</p>
        <h1>Create an access key</h1>
        <p>Choose what this agent can access before creating its key. Anyone with the key can use these permissions, so only share it with the agent you intend to connect.</p>
      </header>
      <fieldset disabled={!ready || state.status === "working"} className="contents">
        <section className="wh-connection-section">
          <div className="wh-connection-section-heading"><span>01</span><div><h2>Name this agent</h2><p>Use a name you’ll recognise in approvals and activity.</p></div></div>
          {/* The same 480px name field as the consent screen (public-22). */}
          <div className="wh-connection-name"><Field label="Agent name" name="name" id={nameId} value={state.name} placeholder={props.defaultName} required maxLength={200} aria-describedby={`${nameId}-help`} onChange={event => flow.setName(event.target.value)} /></div>
          <p id={`${nameId}-help`} className="wh-connection-name-help">This name appears in your agent list, approval requests and activity.</p>
        </section>
        <ConnectionPermissions template={state.template} state={state.choices} services={props.services} onTemplate={flow.setTemplate} onChange={flow.setChoices} />
        <section className="wh-connection-section">
          <div className="wh-connection-section-heading"><span>03</span><div><h2>Review before creating the key</h2><p>The key will be limited to the choices shown here.</p></div></div>
          <ConnectionAccessSummary state={state.choices} services={props.services} />
          <p className="wh-connection-boundary">Your rules for all agents still apply. Warthog controls only what an agent does through Warthog, not its own tools or chats. You can change its access or disconnect it later; information it has already received can’t be recalled.</p>
        </section>
      </fieldset>
      {state.error ? <Notice tone="error">{state.error} Your choices have been kept.</Notice> : null}
      <div className="wh-connection-actionbar">
        <div className="wh-connection-actions">
          <Button type="submit" variant="primary" disabled={!ready} aria-disabled={state.status === "working" || undefined} aria-busy={state.status === "working"} onClick={event => { if (state.status === "working") event.preventDefault(); }}>
            <KeyRound aria-hidden="true" size={16} />{state.status === "working" ? "Creating…" : "Create access key"}
          </Button>
          <ButtonLink href="/agents">Cancel</ButtonLink>
        </div>
        <p className="wh-connection-footer">The key is shown once. Copy it somewhere safe before leaving the next screen.</p>
      </div>
    </form>
  );
}

export default AccessKeyFlow;
