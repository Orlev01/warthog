// E17-S10 — Dev fake agent console VIEW (src/components/dev/agent-console-view.tsx).
//
// RED-first: src/components/dev/agent-console-view.tsx does NOT exist yet, so importing
// `./agent-console-view` throws and EVERY test here fails until the builder adds the
// module. That absence is the entire point of test-first — do not implement anything to
// make these pass.
//
// Why this view exists (task E17-S10): the MCP loop is only demonstrably drivable
// end-to-end when something calls `/mcp` as an agent over HTTP. This "fake agent console"
// is that dev affordance: the `/dev/agent-console` loader provisions a dev access key
// through the real per-agent access-key mechanism (its sibling `actions.ts`, pinned in
// actions.test.ts) and hands this view that key plus the `/mcp` endpoint; the view lets a
// developer POST a tool call to `/mcp` with the key as a Bearer and shows the response.
//
// How these tests stay honest (and runnable without a DOM):
//   * There is no jsdom / testing-library on this job and React component / E2E testing is
//     a per-job ADR, so the interactive BEHAVIOUR is not driven through a rendered DOM.
//     As the sibling sign-in / sign-up flows do, that behaviour lives in a framework-free,
//     injectable CONTROLLER that `agent-console-view.tsx` exports ALONGSIDE its
//     `"use client"` component. These tests drive the controller directly with a FAKE
//     fetch and assert what it DOES — which URL it posts to, with which Authorization and
//     body, what it shows — never the source text of the module. A later
//     behaviour-preserving refactor stays green.
//   * The component render test renders with `react-dom/server` (no DOM) and reads the
//     emitted markup, mirroring the other view render tests. Absence checks (no dead
//     controls, no raw hex) are scoped to the rendered controls / markup, never a
//     whole-output text scan — the console legitimately renders the key, the endpoint and
//     the response as text.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it),
// exported from `./agent-console-view`:
//
//   createAgentConsole(deps: {
//     fetch:     typeof fetch;   // the fake fetch seam
//     accessKey: string;         // the dev access key the loader provisioned
//     endpoint:  string;         // the /mcp URL to POST tool calls to
//     onChange?: () => void;     // optional: the component wires this to re-render
//   }): AgentConsoleController
//
//   AgentConsoleController = {
//     getState(): AgentConsoleState;      // a snapshot the component renders from
//     setTool(value: string): void;       // the tool name to call
//     setArguments(value: string): void;  // the tool arguments, as JSON text
//     callTool(): Promise<void>;          // POST endpoint with the Bearer + JSON-RPC body
//   }
//
//   AgentConsoleState = {
//     tool: string;        // what was typed (survives a call)
//     args: string;        // the arguments JSON text (survives a call)
//     response?: string;   // the tool response to show, after a SUCCESSFUL call
//     error?: string;      // failure copy, after a FAILED call (never fail silently)
//     // (any further fields, e.g. a pending flag, are the builder's to add)
//   }
//
//   AgentConsoleView(props: { accessKey: string; endpoint: string; fetch?: typeof fetch })
//     — the thin `"use client"` binding over the controller (the render-test target).
//
// callTool() posts to `endpoint` a JSON-RPC 2.0 `tools/call` request carrying the Bearer
// access key; a successful response is shown in `response`, a 4xx failure in `error`. The
// handler that enforces the 4xx and parameter-binds the arguments is `/mcp` itself
// (E07-S12 + the tool pipeline, with their own tests); these tests pin that the CONSOLE
// presents a dev access key to `/mcp`, sends the input as structured DATA (never built
// into a URL / SQL), and surfaces whatever `/mcp` returns without failing silently.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createAgentConsole, AgentConsoleView } from "./agent-console-view";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────
const ACCESS_KEY = "wh_ak_0123456789ABCDEFghijklmnopqrstuv"; // a wh_ak_ + 32 base62 shape
const ENDPOINT = "https://warthog.example/mcp";
const TOOL = "get_context";

// ── A programmable, recording fake fetch ───────────────────────────────────────────────

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

// Read a header case-insensitively from whatever shape `init.headers` took (a plain
// object, a Headers instance, or an entries array).
function headerOf(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers;
  if (!h) return null;
  const lower = name.toLowerCase();
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const entries = Array.isArray(h) ? (h as [string, string][]) : Object.entries(h as Record<string, string>);
  for (const [k, v] of entries) if (k.toLowerCase() === lower) return v;
  return null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch() {
  const calls: RecordedCall[] = [];
  let responder: () => Response = () =>
    jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let parsed: unknown;
    try {
      parsed = rawBody !== undefined ? JSON.parse(rawBody) : undefined;
    } catch {
      parsed = undefined;
    }
    calls.push({
      url: urlOf(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: {
        authorization: headerOf(init, "authorization") ?? "",
        "content-type": headerOf(init, "content-type") ?? "",
      },
      rawBody,
      body: parsed,
    });
    return responder();
  };
  return {
    fetchImpl,
    calls,
    respondWith(fn: () => Response) {
      responder = fn;
    },
  };
}

function setup(overrides: { accessKey?: string; endpoint?: string } = {}) {
  const f = makeFetch();
  const console_ = createAgentConsole({
    fetch: f.fetchImpl as typeof fetch,
    accessKey: overrides.accessKey ?? ACCESS_KEY,
    endpoint: overrides.endpoint ?? ENDPOINT,
  });
  return { console: console_, ...f };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// AC1 — the console calls /mcp WITH THE DEV ACCESS KEY: callTool POSTs to the endpoint,
// carrying `Authorization: Bearer <accessKey>` and a JSON-RPC tools/call body naming the
// tool and its arguments.
// ═══════════════════════════════════════════════════════════════════════════════════════

test("callTool POSTs the tool call to the /mcp endpoint with the dev access key as a Bearer", async () => {
  const ctx = setup();
  ctx.console.setTool(TOOL);
  ctx.console.setArguments(JSON.stringify({ query: "hello" }));

  await ctx.console.callTool();

  assert.equal(ctx.calls.length, 1, "callTool must make exactly one request to /mcp");
  const call = ctx.calls[0]!;
  assert.equal(call.url, ENDPOINT, "the request must go to the configured /mcp endpoint");
  assert.equal(call.method, "POST", "a tool call is a POST");
  assert.equal(
    call.headers.authorization,
    `Bearer ${ACCESS_KEY}`,
    "the request must present the provisioned dev access key as a Bearer (reuse the real credential)",
  );
  assert.match(call.headers["content-type"], /application\/json/i, "the body is JSON");

  // The body is a JSON-RPC 2.0 tools/call naming the tool and carrying the arguments.
  assert.equal(call.body.jsonrpc, "2.0", "an MCP request is JSON-RPC 2.0");
  assert.ok("id" in call.body, "a JSON-RPC request carries an id");
  assert.equal(call.body.method, "tools/call", "the console posts a tools/call");
  assert.equal(call.body.params?.name, TOOL, "the call names the tool the developer entered");
  assert.deepEqual(
    call.body.params?.arguments,
    { query: "hello" },
    "the call carries the arguments the developer entered, as structured data",
  );
});

test("callTool defaults to empty arguments when none were entered", async () => {
  const ctx = setup();
  ctx.console.setTool(TOOL); // no setArguments call

  await ctx.console.callTool();

  assert.equal(ctx.calls.length, 1, "a tool call with no arguments is still a valid call");
  assert.deepEqual(
    ctx.calls[0]!.body.params?.arguments,
    {},
    "absent arguments default to an empty object (a no-argument tool call is valid)",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// AC1 — the console SHOWS THE TOOL RESPONSE: a successful /mcp response is surfaced in the
// state the view renders.
// ═══════════════════════════════════════════════════════════════════════════════════════

test("callTool surfaces the /mcp tool response so the console shows it", async () => {
  const ctx = setup();
  const marker = `tool-result-${randomUUID()}`;
  ctx.respondWith(() =>
    jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: marker }] } }),
  );

  ctx.console.setTool(TOOL);
  await ctx.console.callTool();

  const s = ctx.console.getState();
  assert.equal(typeof s.response, "string", "a successful call must produce a response to show");
  assert.ok(
    (s.response ?? "").includes(marker),
    `the shown response must contain what /mcp returned, got: ${JSON.stringify(s.response)}`,
  );
  assert.ok(!s.error, "a successful call shows no error");
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// AC4 — a handler (/mcp) rejects malformed / oversized input with a 4xx; the console
// surfaces that 4xx and never fails silently or fakes a success.
// ═══════════════════════════════════════════════════════════════════════════════════════

test("a 4xx from /mcp is surfaced as an error, not a silent failure or a fake success", async () => {
  const ctx = setup();
  ctx.respondWith(() => jsonResponse(400, { error: "bad_request" }));

  ctx.console.setTool(TOOL);
  await ctx.console.callTool(); // must not throw

  const s = ctx.console.getState();
  assert.equal(typeof s.error, "string", "a 4xx must be reported to the developer (never fail silently)");
  assert.ok((s.error ?? "").trim().length > 0, "the error must say something");
  assert.ok(
    !s.response || !/"result"/.test(s.response),
    "a rejected call must not present a successful tool result",
  );
});

test("a thrown fetch (offline) is reported, not crashed through", async () => {
  const calls: unknown[] = [];
  const console_ = createAgentConsole({
    fetch: (async () => {
      calls.push(1);
      throw new TypeError("network down");
    }) as unknown as typeof fetch,
    accessKey: ACCESS_KEY,
    endpoint: ENDPOINT,
  });
  console_.setTool(TOOL);

  await console_.callTool(); // must not throw out of the controller

  assert.equal(typeof console_.getState().error, "string", "a network failure is reported, not thrown");
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// AC4 — [validate-and-parameterize-input] a SQL-injection probe typed into an input field
// travels to /mcp as structured DATA (a JSON string value in the arguments), never built
// into the URL — so it reaches the parameter-binding tool pipeline as data, not SQL.
// ═══════════════════════════════════════════════════════════════════════════════════════

test("a SQL-injection probe in the arguments is sent as JSON data, never woven into the URL", async () => {
  const ctx = setup();
  const probe = "'; DROP TABLE agents; --";

  ctx.console.setTool(TOOL);
  ctx.console.setArguments(JSON.stringify({ q: probe }));
  await ctx.console.callTool();

  const call = ctx.calls[0]!;
  // The probe is carried as a JSON string value (data), bound into the body — not
  // concatenated into the request URL.
  assert.deepEqual(
    call.body.params?.arguments,
    { q: probe },
    "the probe must travel as a JSON string value (structured data), exactly as entered",
  );
  assert.ok(
    !call.url.includes("DROP TABLE"),
    `the probe must never be concatenated into the request URL, got: ${call.url}`,
  );
  // The call still addressed /mcp as a normal tool call (the probe did not redirect it).
  assert.equal(call.url, ENDPOINT, "the request still targets /mcp");
});

test("malformed arguments JSON is reported as an error (never fail silently)", async () => {
  const ctx = setup();
  ctx.console.setTool(TOOL);
  ctx.console.setArguments("{ not valid json");

  await ctx.console.callTool(); // must not throw

  const s = ctx.console.getState();
  assert.equal(typeof s.error, "string", "malformed arguments must be reported to the developer");
  assert.ok(!s.response || !/"result"/.test(s.response), "malformed input produces no tool result");
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// The controller starts clean and makes no request on construction.
// ═══════════════════════════════════════════════════════════════════════════════════════

test("a fresh console makes no request and shows no response or error", () => {
  const ctx = setup();
  const s = ctx.console.getState();
  assert.ok(!s.response, "no response on a fresh console");
  assert.ok(!s.error, "no error on a fresh console");
  assert.equal(ctx.calls.length, 0, "constructing the console makes no request");
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// The component render (the thin binding) — a real screen with a field to enter a tool
// call and a live control to send it, built on design tokens, with no dead controls.
// ═══════════════════════════════════════════════════════════════════════════════════════

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}
function findAll(markup: string, tag: string): { attrs: string; inner: string }[] {
  const out: { attrs: string; inner: string }[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}
// Fields the developer can type a tool call into: <input>s and <textarea>s.
function fields(markup: string): { attrs: string; id: string | null }[] {
  const out: { attrs: string; id: string | null }[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) out.push({ attrs: m[1]!, id: attr(m[1]!, "id") });
  for (const t of findAll(markup, "textarea")) out.push({ attrs: t.attrs, id: attr(t.attrs, "id") });
  return out;
}
function labelTextById(markup: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const l of findAll(markup, "label")) {
    const f = attr(l.attrs, "for");
    if (f) map[f] = visibleText(l.inner);
  }
  return map;
}
// A field has an accessible name when a <label for> points at it, or it carries an
// aria-label / aria-labelledby / placeholder.
function fieldHasAccessibleName(
  field: { attrs: string; id: string | null },
  labels: Record<string, string>,
): boolean {
  if (field.id && (labels[field.id] ?? "").length > 0) return true;
  for (const a of ["aria-label", "aria-labelledby", "placeholder"]) {
    const v = attr(field.attrs, a);
    if (v && v.trim().length > 0) return true;
  }
  return false;
}
// A live native <button> is one not carrying the native `disabled` attribute.
function liveButtons(markup: string): { name: string }[] {
  return findAll(markup, "button")
    .filter((b) => !/\bdisabled=""/i.test(b.attrs))
    .map((b) => ({ name: visibleText(b.inner) || attr(b.attrs, "aria-label") || "" }));
}

// A no-op fetch so mounting never touches the network (it should not on the initial
// render anyway).
const noopFetch = (async () => jsonResponse(200, {})) as unknown as typeof fetch;

function renderView(): string {
  return renderToStaticMarkup(
    <AgentConsoleView accessKey={ACCESS_KEY} endpoint={ENDPOINT} fetch={noopFetch} />,
  );
}

test("AgentConsoleView renders a real screen with an accessibly-named field to enter a tool call", () => {
  const markup = renderView();
  assert.ok(visibleText(markup).length >= 3, `the console must render a real screen, got: "${visibleText(markup)}"`);

  const labels = labelTextById(markup);
  const entry = fields(markup);
  assert.ok(entry.length >= 1, `the console must render a field to enter a tool call, got: ${markup}`);
  for (const field of entry) {
    assert.ok(
      fieldHasAccessibleName(field, labels),
      `every tool-call field must carry an accessible name, got: ${field.attrs}`,
    );
  }
});

test("AgentConsoleView offers a live, named control to send the tool call (no dead screen)", () => {
  const live = liveButtons(renderView()).filter((b) => b.name.trim().length > 0);
  assert.ok(
    live.length >= 1,
    "the console must offer a live, named control to send the tool call to /mcp",
  );
});

test("AgentConsoleView uses design tokens, never a raw hex colour", () => {
  // The props carry no "#", so any #rrggbb in the output could only be a hard-coded colour.
  const markup = renderView();
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the AgentConsoleView markup, got: ${markup}`,
  );
});
