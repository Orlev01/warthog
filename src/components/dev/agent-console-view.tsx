"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";

// E17-S10 — Dev fake agent console (view).
//
// The MCP loop is only demonstrably drivable end-to-end when something calls `/mcp` as an
// agent over HTTP. This "fake agent console" is that dev affordance: the `/dev/agent-console`
// loader provisions a dev access key through the real per-agent access-key mechanism (its
// sibling `actions.ts`) and hands this view that key plus the `/mcp` endpoint; the view lets
// a developer POST a `tools/call` to `/mcp` with the key as a Bearer and shows the response.
//
// The interactive BEHAVIOUR lives in a framework-free, injectable controller
// (`createAgentConsole`) so it is testable without a DOM (the "pure logic, testable without
// I/O" convention — React component / E2E testing is a per-job ADR). `AgentConsoleView` is a
// thin binding over it: fields read its state, the Send control calls `callTool`, and a
// change notifier re-renders.
//
// The developer's input travels to `/mcp` as structured DATA — the tool name and the parsed
// arguments inside a JSON-RPC body (INV-102: never woven into the URL/SQL; the parameter
// binding happens in the `/mcp` tool pipeline). The handler at `/mcp` enforces the 4xx on
// malformed/oversized input; this console surfaces whatever `/mcp` returns and never fails
// silently — a 4xx, a thrown fetch, or malformed arguments all become a visible error.

export interface AgentConsoleDeps {
  readonly fetch: typeof fetch;
  // The dev access key the loader provisioned, presented to `/mcp` as a Bearer.
  readonly accessKey: string;
  // The `/mcp` URL to POST tool calls to.
  readonly endpoint: string;
  // Optional: the component wires this to re-render after each state change. The controller
  // works standalone (the unit tests) when it is omitted.
  readonly onChange?: () => void;
}

export interface AgentConsoleState {
  readonly tool: string; // the tool name to call (survives a call)
  readonly args: string; // the arguments, as JSON text (survives a call)
  readonly response?: string; // the tool response to show, after a SUCCESSFUL call
  readonly error?: string; // failure copy, after a FAILED call (never fail silently)
}

export interface AgentConsoleController {
  getState(): AgentConsoleState;
  setTool(value: string): void;
  setArguments(value: string): void;
  callTool(): Promise<void>;
}

// Plain-English failure copy a developer can act on — never a silent failure.
const ARGUMENTS_INVALID_COPY =
  "The arguments aren't valid JSON. Fix them and try again.";
const NETWORK_FAILED_COPY =
  "Couldn't reach /mcp. Check the app is running and try again.";

// Pretty-print a JSON response for display; fall back to the raw text when it is not JSON.
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function createAgentConsole(deps: AgentConsoleDeps): AgentConsoleController {
  let state: AgentConsoleState = { tool: "", args: "" };
  let nextId = 1;

  function set(patch: Partial<AgentConsoleState>): void {
    state = { ...state, ...patch };
    deps.onChange?.();
  }

  async function callTool(): Promise<void> {
    // Parse the arguments as structured DATA: empty text is a no-argument call ({}),
    // malformed JSON is reported and NOTHING is posted (never fail silently).
    let args: unknown;
    if (state.args.trim() === "") {
      args = {};
    } else {
      try {
        args = JSON.parse(state.args);
      } catch {
        set({ error: ARGUMENTS_INVALID_COPY, response: undefined });
        return;
      }
    }

    // A JSON-RPC 2.0 tools/call carrying the tool name and arguments as data — the input is
    // never concatenated into the request URL.
    const body = {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: state.tool, arguments: args },
    };

    try {
      const response = await deps.fetch(deps.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The Streamable-HTTP headers a real MCP client sends — an Accept naming BOTH
          // application/json and text/event-stream (or /mcp answers 406 Not Acceptable)
          // and the protocol-version header (E07-S19).
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          authorization: `Bearer ${deps.accessKey}`,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        set({ error: `/mcp rejected the call (${response.status}). ${text}`.trim(), response: undefined });
        return;
      }
      set({ response: pretty(text), error: undefined });
    } catch {
      // A thrown fetch (offline) is reported, not crashed through.
      set({ error: NETWORK_FAILED_COPY, response: undefined });
    }
  }

  return {
    getState: () => state,
    setTool: (value) => set({ tool: value }),
    setArguments: (value) => set({ args: value }),
    callTool,
  };
}

// --- the client component (a thin binding over the controller) --------------

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export interface AgentConsoleViewProps {
  readonly accessKey: string;
  readonly endpoint: string;
  // Optional override so the view can be driven with a fake fetch; the page mounts it with
  // just the key and endpoint.
  readonly fetch?: typeof fetch;
}

export function AgentConsoleView(props: AgentConsoleViewProps): React.ReactElement {
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
  const consoleRef = React.useRef<AgentConsoleController | null>(null);
  if (consoleRef.current === null) {
    consoleRef.current = createAgentConsole({
      fetch: props.fetch ?? defaultFetch,
      accessKey: props.accessKey,
      endpoint: props.endpoint,
      onChange: () => forceUpdate(),
    });
  }
  const agentConsole = consoleRef.current;
  const state = agentConsole.getState();
  const argsId = React.useId();

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium text-fg">Endpoint</dt>
          <dd className="break-all text-fg-muted">{props.endpoint}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium text-fg">Dev access key</dt>
          <dd className="break-all font-mono text-fg-muted">{props.accessKey}</dd>
        </div>
      </dl>

      <Field
        label="Tool name"
        value={state.tool}
        placeholder="get_context"
        onChange={(event) => agentConsole.setTool(event.target.value)}
      />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={argsId}>Arguments (JSON)</Label>
        <textarea
          id={argsId}
          value={state.args}
          rows={5}
          placeholder="{}"
          onChange={(event) => agentConsole.setArguments(event.target.value)}
          className="min-h-11 w-full rounded-card border border-line bg-surface px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        />
      </div>

      <div>
        <Button
          variant="primary"
          onClick={() => {
            void agentConsole.callTool();
          }}
        >
          Send to /mcp
        </Button>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      {state.response ? (
        <pre className="overflow-x-auto rounded-card border border-line bg-surface-muted p-4 text-sm text-fg">
          {state.response}
        </pre>
      ) : null}
    </div>
  );
}

export default AgentConsoleView;
