"use client";

import * as React from "react";
import { KeyRound, AlertTriangle, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { CopyButton } from "@/components/ui/copy-button";

// E10-S13 — Access-key flow (brief "Connect an agent" — "For a platform that cannot use
// the standard connector sign-in, 'Create an access key' lets the person name the agent
// and set its permissions on the same screen as the consent screen, shows the key once
// with a copy button, and lets them revoke or replace the key later"; design §6.1;
// constitution 16 — each agent has its own revocable credential, a per-agent access key
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
  key?: string; // the RAW key, present only in "created" — shown once
  agentId?: string; // the created agent's id, present only in "created"
  error?: string; // a plain-English refusal, present only in "error"
}

export interface AccessKeyFlowDeps {
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
    if (state.status === "working") return; // guard against a double confirm
    set({ status: "working", error: undefined });

    let result: AccessKeyCreateResult;
    try {
      result = await deps.create({
        name: state.name,
        platform: state.platform,
        template: state.template,
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
    setTemplate: (value) => set({ template: value }),
    submit,
  };
}

// ─── copy (plain Australian English; no protocol jargon) ───────────────────────────────

// The three starting sets the create surface offers, in plain words (the consent screen's
// twin set).
const STARTING_SETS: ReadonlyArray<{
  value: AccessKeyTemplate;
  label: string;
  description: string;
}> = [
  { value: "minimal", label: "Minimal", description: "Just the low-tier basics." },
  { value: "standard", label: "Standard", description: "The recommended balance." },
  { value: "custom", label: "Custom", description: "Start from Standard, then change anything later." },
];

// ─── the key-shown surface (the key once, a Copy control, instructions, a warning) ─────

function IssuedPanel({ keyValue }: { keyValue: string }) {
  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">Your access key is ready</h1>
        <p className="text-sm text-fg-muted">
          Paste this key into your agent where it asks for an access key.
        </p>
      </header>

      <Card className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="block min-w-0 flex-1 select-all overflow-x-auto rounded-card border border-line bg-surface-muted px-3 py-2 font-mono text-sm text-fg">
            {keyValue}
          </code>
          <CopyButton value={keyValue} successMessage="Access key copied. Paste it into your agent, then clear your clipboard." />
        </div>
        <p className="inline-flex items-center gap-2 text-sm font-medium text-warning">
          <TriangleAlert aria-hidden={true} className="h-4 w-4 shrink-0" />
          Copy it now — for your security this key won&rsquo;t be shown again.
        </p>
      </Card>

      <p className="text-sm text-fg-muted">
        Add it in your agent&rsquo;s connector or access-key settings. You can revoke or
        replace it any time from your agents list.
      </p>
    </section>
  );
}

// ─── the client component (a thin binding over the controller) ─────────────────────────

export interface AccessKeyFlowProps {
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
      defaultTemplate: props.defaultTemplate,
      defaultName: props.defaultName,
      defaultPlatform: props.defaultPlatform,
      onChange: () => forceUpdate(),
      onCreated: props.onCreated,
    });
  }
  const flow = flowRef.current;
  const state = flow.getState();

  // Call every hook unconditionally (rules of hooks), even on the issued path.
  const nameId = React.useId();
  const setGroupName = React.useId();

  // The issued key: from a completed create, or the preview/test seed.
  const issuedKey = state.status === "created" ? state.key : props.initialKey;

  if (issuedKey) {
    return <IssuedPanel keyValue={issuedKey} />;
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">Create an access key</h1>
        <p className="text-sm text-fg-muted">
          Name this agent and choose what it can do, then create its key.
        </p>
      </header>

      <Field
        label="Name"
        id={nameId}
        value={state.name}
        placeholder={props.defaultName}
        onChange={(event) => flow.setName(event.target.value)}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-medium text-fg">Starting set</legend>
        <div className="flex flex-col gap-2">
          {STARTING_SETS.map((set) => (
            <div key={set.value} className="rounded-card border border-line bg-surface p-3">
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name={setGroupName}
                  value={set.value}
                  checked={state.template === set.value}
                  onChange={() => flow.setTemplate(set.value)}
                  className="h-4 w-4 accent-accent"
                />
                <span className="font-medium text-fg">{set.label}</span>
              </label>
              <p className="mt-1 text-sm text-fg-muted">{set.description}</p>
            </div>
          ))}
        </div>
      </fieldset>

      {state.error ? (
        <p role="alert" className="inline-flex items-center gap-2 text-sm text-danger">
          <AlertTriangle aria-hidden={true} className="h-4 w-4 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <div className="flex">
        <Button
          type="button"
          variant="primary"
          disabled={state.status === "working"}
          onClick={() => {
            void flow.submit();
          }}
        >
          <KeyRound aria-hidden={true} className="h-4 w-4 shrink-0" />
          {state.status === "working" ? "Creating…" : "Create access key"}
        </Button>
      </div>
    </section>
  );
}

export default AccessKeyFlow;
