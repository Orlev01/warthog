// E04-S34 — Client new-device flow (src/components/auth/device-flow.tsx).
//
// RED-first: src/components/auth/device-flow.tsx does NOT exist yet, so importing
// `./device-flow` throws and EVERY test in this file fails until the builder adds the
// flow. That absence is the entire point of test-first — do not implement anything to
// make these pass.
//
// Why this task exists (E04-S34): without a client flow the /device page is static
// copy — a NEW phone or computer can't actually add itself to an existing account by
// approving the sign-in from a device the person already uses. This flow drives the
// "approval from a signed-in device" handshake (the E04-S31 handler, surfaced over HTTP
// by E04-S32 at POST /api/auth/device/[step], over the new-device module E04-S30):
//
//   request  → POST /api/auth/device/request  { email, code, deviceLabel }
//              → verifies the emailed one-time code, records a pending request, sends ONE
//                approval push to the person's other device, and returns { requestId } —
//                the new device's own collection handle. No session is minted.
//   (approve → an EXISTING signed-in device approves, out of band — NOT part of this
//              NEW-device flow; it happens on the other device inside the signed-in app.)
//   collect  → POST /api/auth/device/collect   { requestId }
//              → while the owner has not approved yet: 400 { error: "not_approved" } — the
//                flow keeps WAITING (this is the poll). Once approved: a followed 303 →
//                /home carrying the new device's session cookie (a 2xx — `response.ok`),
//                and the flow navigates to /home. A gone handle (expired / refused /
//                already collected) answers 400 { error: "unknown_request" } — a terminal
//                failure the person can only recover from by starting again.
//
// The single binary server state (pending vs approved; the handle vanishes when it can no
// longer be completed) is why the flow MUST read the collect error code: `not_approved`
// means "keep waiting", anything else means "this request is done — start again". A flow
// that treated the first `not_approved` as a hard error could never poll.
//
// ── How these tests stay honest (and runnable without a DOM) ──────────────────────────
// There is no jsdom / testing-library on this job and React component / E2E testing is a
// per-job ADR, so the interactive BEHAVIOUR of the flow is not driven through a rendered
// DOM. Instead the flow's logic lives in a framework-free, injectable controller that
// `device-flow.tsx` exports alongside its `"use client"` component — the "pure logic,
// testable without I/O" convention (as the sibling signin/signup/recover flows do). The
// React component is a thin binding over this controller (inputs read `state`, buttons
// and a waiting-step timer call its methods); these tests drive the controller directly
// with a FAKE fetch and a captured navigate and assert what it DOES — which URLs it
// posts, in what order, with which bodies; what it shows; where it navigates — never the
// source text of the module. A later behaviour-preserving refactor stays green.
//
// The contract the builder implements (exactly this), exported from `./device-flow`:
//
//   createDeviceFlow(deps: {
//     fetch: typeof fetch;                 // the fake fetch seam
//     navigate: (path: string) => void;    // sends the browser to /home on success
//     // (any further deps the component wires — e.g. an onChange re-render notifier, or
//     //  the waiting-step poll timer — must be OPTIONAL so the page mounts with none)
//   }): DeviceFlowController
//
//   DeviceFlowController = {
//     getState(): DeviceFlowState;          // a snapshot the component renders from
//     setEmail(value: string): void;
//     setCode(value: string): void;         // the emailed one-time code the person types
//     requestApproval(): Promise<void>;     // → request; on success advances to WAITING
//     poll(): Promise<void>;                // → collect; the component calls this while waiting
//     startAgain(): void;                   // → back to the first step, ready to request again
//   }
//
//   DeviceFlowState = {
//     phase: ...;            // which step is shown (first entry | waiting | a start-again step)
//     email: string;        // what the person typed (survives a step error)
//     code: string;         // the emailed one-time code typed (survives a step error)
//     error?: string;       // plain-English copy when a step fails — never a raw machine code
//   }
//
// These tests never pin the literal `phase` strings — they compare phases for
// equality/inequality — so the builder may name the steps however reads best, as long as
// the waiting step is distinct from the first and a failed request leaves waiting.
//
// AC3 (GET /device renders the flow's first step) is proven by rendering the device
// page's default export (its only framework field) with `react-dom/server` and reading
// the markup — the same no-DOM render the view/page tests use.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createDeviceFlow } from "./device-flow";
import { DeviceView } from "./auth-views";
import DevicePage from "../../app/(auth)/device/page";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────
// Distinct, JSON-safe sample values so an assertion proves the flow carried THROUGH the
// value it was given, not a constant. The requestId is a full-entropy-looking bearer
// handle the server returns at `request` and the flow must send back at `collect`.
const EMAIL = "robin@example.com";
const EMAIL_CODE = "472913"; // the one-time code we emailed, the person types it
const REQUEST_ID = "9f3c1a7e5b2d4680ab12cd34ef56a7b89f3c1a7e5b2d4680ab12cd34ef56a7b8";

// ── A programmable, recording fake fetch keyed by the device step path ──────────────────

type StepKey = "send-code" | "request" | "collect";

interface RecordedCall {
  step: StepKey;
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function stepOf(url: string): StepKey {
  if (url.includes("/api/auth/device/send-code")) return "send-code";
  if (url.includes("/api/auth/device/request")) return "request";
  if (url.includes("/api/auth/device/collect")) return "collect";
  // The NEW-device flow never posts `approve` (that is the OTHER device's job); any other
  // URL means the flow went somewhere it shouldn't.
  throw new Error(`the device flow posted to an unexpected URL: ${url}`);
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch() {
  const calls: RecordedCall[] = [];
  // Default: request succeeds and the very first collect already finds the request
  // approved (the followed-303 result a browser's default fetch sees — a 2xx landing on
  // /home). A test swaps `collect` to drive the pending poll / terminal-failure paths.
  const responders: Record<StepKey, () => Response> = {
    "send-code": () => jsonResponse(200, { ok: true }),
    request: () => jsonResponse(200, { requestId: REQUEST_ID }),
    collect: () => jsonResponse(200, { ok: true }),
  };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const step = stepOf(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ step, url, method, body });
    return responders[step]();
  };
  return { fetchImpl, calls, responders };
}

// ── Test harness ────────────────────────────────────────────────────────────────────────

function setup() {
  const { fetchImpl, calls, responders } = makeFetch();
  const navCalls: string[] = [];
  const flow = createDeviceFlow({
    fetch: fetchImpl as typeof fetch,
    navigate: (path: string) => {
      navCalls.push(path);
    },
  });
  return { flow, calls, responders, navCalls };
}

// A step's user-facing error must read as plain Australian English — a real sentence,
// never a raw machine code (the server speaks `invalid_code`, `not_approved`,
// `unknown_request`, `forbidden`, …) and never protocol/security jargon.
const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "attestation", re: /\battestation\b/i },
  { label: "assertion", re: /\bassertion\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "4xx", re: /\b4\d\d\b/ },
];

function assertPlainEnglish(message: unknown, ctx: string): asserts message is string {
  assert.equal(typeof message, "string", `${ctx}: expected plain-English error copy, got ${typeof message}`);
  const text = (message as string).trim();
  assert.ok(text.length >= 8, `${ctx}: error copy must be a real message a person can read, got: "${text}"`);
  assert.ok(/\s/.test(text), `${ctx}: error copy must read as words, not a single machine token, got: "${text}"`);
  assert.ok(!/_/.test(text), `${ctx}: error copy must not be a raw machine code (snake_case), got: "${text}"`);
  for (const { label, re } of JARGON) {
    assert.ok(!re.test(text), `${ctx}: error copy must avoid jargon "${label}", got: "${text}"`);
  }
}

// ── AC1 — post request, show the waiting step, then collect succeeds → navigate /home ───

test("posts request, advances to the waiting step, then collect succeeds and navigates to /home", async () => {
  const ctx = setup();
  const firstStep = ctx.flow.getState().phase;

  ctx.flow.setEmail(EMAIL);
  ctx.flow.setCode(EMAIL_CODE);
  await ctx.flow.requestApproval();

  // The request step posted the new device's email, the emailed code, and a non-empty
  // device label (the server's schema requires all three; the label is what the approval
  // push names, so it must not be blank).
  assert.equal(ctx.calls.length, 1, "requestApproval must post exactly one request");
  const req = ctx.calls[0]!;
  assert.equal(req.step, "request", "the first post must be the request step");
  assert.equal(req.method, "POST", "the request step must be a POST");
  assert.equal(req.body.email, EMAIL, "request must send the entered email");
  assert.equal(req.body.code, EMAIL_CODE, "request must send the emailed one-time code the person typed");
  assert.equal(typeof req.body.deviceLabel, "string", "request must send a device label");
  assert.ok(
    req.body.deviceLabel.trim().length >= 1,
    `request must send a non-empty device label (it names the approval push), got: ${JSON.stringify(req.body.deviceLabel)}`,
  );

  // The waiting step is shown: a distinct phase, no error, and NOTHING navigated yet —
  // the person is waiting for their other device to approve.
  const waiting = ctx.flow.getState();
  assert.notEqual(waiting.phase, firstStep, "a successful request must advance off the first step to the waiting step");
  assert.ok(!waiting.error, "the waiting step shows no error");
  assert.deepEqual(ctx.navCalls, [], "requesting approval must not navigate — it only starts the wait");

  // The new device polls: collect finds the request approved and the person lands on /home.
  await ctx.flow.poll();

  assert.equal(ctx.calls.length, 2, "poll must post exactly one collect");
  const col = ctx.calls[1]!;
  assert.equal(col.step, "collect", "the second post must be the collect step");
  assert.equal(col.method, "POST", "the collect step must be a POST");
  assert.equal(
    col.body.requestId,
    REQUEST_ID,
    "collect must carry the collection handle the request step returned",
  );
  assert.deepEqual(ctx.navCalls, ["/home"], "a successful collect must navigate to /home");
});

test("keeps waiting while the approval is still pending, then completes once approved", async () => {
  const ctx = setup();

  ctx.flow.setEmail(EMAIL);
  ctx.flow.setCode(EMAIL_CODE);
  await ctx.flow.requestApproval();
  const waiting = ctx.flow.getState().phase;

  // The owner has not approved yet: collect answers `not_approved`. The flow keeps
  // WAITING — no error shown (this is expected, not a failure) and no navigation.
  ctx.responders["collect"] = () => jsonResponse(400, { error: "not_approved" });
  await ctx.flow.poll();
  let s = ctx.flow.getState();
  assert.equal(s.phase, waiting, "a not-yet-approved poll must keep the person on the waiting step");
  assert.ok(!s.error, "a not-yet-approved poll must not show an error — it is still waiting, not failing");
  assert.deepEqual(ctx.navCalls, [], "a not-yet-approved poll must not navigate");

  // Polling again while still pending keeps waiting just the same (the flow can poll
  // repeatedly).
  await ctx.flow.poll();
  s = ctx.flow.getState();
  assert.equal(s.phase, waiting, "repeated pending polls keep the person waiting");
  assert.ok(!s.error, "repeated pending polls still show no error");
  assert.deepEqual(ctx.navCalls, [], "repeated pending polls still do not navigate");

  // Now the owner approves on their other device: the next collect succeeds → /home.
  ctx.responders["collect"] = () => jsonResponse(200, { ok: true });
  await ctx.flow.poll();
  assert.deepEqual(ctx.navCalls, ["/home"], "once approved, the next poll navigates to /home");
  assert.ok(
    ctx.calls.filter((c) => c.step === "collect").length === 3,
    "every poll posts a collect (two pending + one that succeeds)",
  );
});

// ── AC2 — a refused or expired request shows plain-English copy and offers to start again ─

test("a refused-or-expired request leaves the waiting step with plain copy and the chance to start again", async () => {
  const ctx = setup();
  const firstStep = ctx.flow.getState().phase;

  ctx.flow.setEmail(EMAIL);
  ctx.flow.setCode(EMAIL_CODE);
  await ctx.flow.requestApproval();
  const waiting = ctx.flow.getState().phase;

  // The pending request is gone — expired, turned down, or already used: collect answers
  // `unknown_request`. This is terminal: the person can no longer be approved on this
  // handle, so the flow must STOP waiting and explain in plain words.
  ctx.responders["collect"] = () => jsonResponse(400, { error: "unknown_request" });
  await ctx.flow.poll();

  const s = ctx.flow.getState();
  assert.notEqual(s.phase, waiting, "a refused/expired request must leave the waiting step (stop polling)");
  assert.notEqual(s.error, "unknown_request", "the raw server code must never be shown to the person");
  assertPlainEnglish(s.error, "refused/expired request");
  assert.deepEqual(ctx.navCalls, [], "a refused/expired request must not navigate");

  // ...and it offers to start again: startAgain returns to the first step, clears the
  // error, and the person can request approval afresh.
  ctx.flow.startAgain();
  const restarted = ctx.flow.getState();
  assert.equal(restarted.phase, firstStep, "start again returns the person to the first step");
  assert.ok(!restarted.error, "start again clears the plain-English failure message");

  // The restarted flow genuinely works: a fresh request posts again.
  ctx.responders["collect"] = () => jsonResponse(200, { ok: true });
  ctx.flow.setEmail(EMAIL);
  ctx.flow.setCode(EMAIL_CODE);
  await ctx.flow.requestApproval();
  assert.ok(
    ctx.calls.filter((c) => c.step === "request").length === 2,
    "starting again lets the person send a brand-new approval request",
  );
});

test("a rejected request (wrong or expired emailed code) keeps the person on the first step with plain copy and their input", async () => {
  const ctx = setup();
  const firstStep = ctx.flow.getState().phase;

  ctx.flow.setEmail(EMAIL);
  ctx.flow.setCode(EMAIL_CODE);

  // The emailed code is wrong or expired (or no account): the request step is rejected
  // before any pending request exists, so there is nothing to wait for.
  ctx.responders["request"] = () => jsonResponse(400, { error: "invalid_code" });
  await ctx.flow.requestApproval();

  const s = ctx.flow.getState();
  assert.equal(s.phase, firstStep, "a rejected request must keep the person on the first step (no waiting)");
  assert.equal(s.email, EMAIL, "the email the person typed must survive the error");
  assert.equal(s.code, EMAIL_CODE, "the emailed code the person typed must survive the error");
  assert.notEqual(s.error, "invalid_code", "the raw server code must never be shown to the person");
  assertPlainEnglish(s.error, "rejected request");
  assert.ok(
    !ctx.calls.some((c) => c.step === "collect"),
    "a rejected request must not start polling for a collect",
  );
  assert.deepEqual(ctx.navCalls, [], "a rejected request must not navigate");
});

// ── The flow starts clean on the first step ─────────────────────────────────────────────

test("a fresh flow starts on the first step with nothing typed, no error, and no network", () => {
  const ctx = setup();
  const s = ctx.flow.getState();
  assert.equal(s.email, "", "the email starts empty");
  assert.equal(s.code, "", "the code starts empty");
  assert.ok(!s.error, "no error on a fresh flow");
  // No network and no navigation happen just by constructing the flow.
  assert.deepEqual(ctx.calls, [], "constructing the flow makes no requests");
  assert.deepEqual(ctx.navCalls, [], "constructing the flow navigates nowhere");
});

// ── AC3 — GET /device renders the flow's first step (an accessibly-labelled code entry) ──

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

function inputs(markup: string): { attrs: string; type: string; id: string | null }[] {
  const out: { attrs: string; type: string; id: string | null }[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1]!;
    out.push({ attrs, type: (attr(attrs, "type") ?? "text").toLowerCase(), id: attr(attrs, "id") });
  }
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

const LABELLABLE = new Set(["text", "email", "tel", "number", "password", "search", "url"]);

function inputIsLabelled(
  input: { attrs: string; id: string | null },
  labels: Record<string, string>,
): boolean {
  if (input.id && labels[input.id] && labels[input.id]!.length > 0) return true;
  const al = attr(input.attrs, "aria-label");
  if (al && al.trim().length > 0) return true;
  const alb = attr(input.attrs, "aria-labelledby");
  if (alb && alb.trim().length > 0) return true;
  return false;
}

function actionableButtons(markup: string): { name: string; attrs: string }[] {
  return findAll(markup, "button")
    .filter((b) => !/\bdisabled=""/i.test(b.attrs))
    .map((b) => ({ name: visibleText(b.inner) || attr(b.attrs, "aria-label") || "", attrs: b.attrs }));
}

// Render the page entry's default export (its only framework field). It mounts the flow
// at its first step from props alone, so it renders without a live request scope; the
// Next 15 resolved-promise props are supplied in case the entry reads them. A sync entry
// or an async server component are both awaited.
async function renderPage(Page: unknown): Promise<string> {
  assert.equal(typeof Page, "function", "the device entry must have a default-exported page component");
  const element = await Promise.resolve(
    (Page as (props: unknown) => unknown)({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({}),
    }),
  );
  return renderToStaticMarkup(element as React.ReactElement);
}

test("GET /device renders the flow's first step: an accessibly-labelled code entry with a live control", async () => {
  const markup = await renderPage(DevicePage);

  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type));
  assert.ok(entry.length >= 1, `the first step must render an entry field, got: ${markup}`);
  for (const input of entry) {
    assert.ok(
      inputIsLabelled(input, labels),
      `every field on the first step must carry an accessible label, got: ${input.attrs}`,
    );
  }

  const labelBlob = Object.values(labels).join(" ").toLowerCase();
  assert.match(labelBlob, /code/i, `the first step must collect the emailed one-time code, got labels: "${labelBlob}"`);

  // It is the add-a-device screen, not a look-alike, and it is LIVE (a named control to proceed).
  assert.match(
    visibleText(markup),
    /device/i,
    `the mounted screen must be the new-device flow (its copy names adding the device), got: "${visibleText(markup)}"`,
  );
  const live = actionableButtons(markup).filter((b) => b.name.trim().length > 0);
  assert.ok(
    live.length >= 1,
    `the first step must offer a live, named control to continue (not a dead screen), got: ${markup}`,
  );
});

// ── Review fix B6 — a newly approved device goes back to a safe return path ───────────

test("once approved, the device flow goes to a safe return path, and to /home for an unsafe one", async () => {
  for (const [returnTo, expected] of [
    ["/a/AbC123", "/a/AbC123"],
    ["https://evil.example", "/home"],
  ] as const) {
    const { fetchImpl } = makeFetch();
    const navCalls: string[] = [];
    const flow = createDeviceFlow({
      fetch: fetchImpl as typeof fetch,
      navigate: (path: string) => void navCalls.push(path),
      returnTo,
    });
    flow.setEmail(EMAIL);
    flow.setCode(EMAIL_CODE);
    await flow.requestApproval();
    await flow.poll();
    assert.deepEqual(navCalls, [expected], `returnTo ${returnTo}`);
  }
});

// ── Signing in on a new device starts with the emailed code: the flow can ask for it ──

test("'Email me a code' posts the email to send-code and says a code is on its way", async () => {
  const ctx = setup();
  ctx.flow.setEmail(EMAIL);
  await ctx.flow.sendCode();

  assert.deepEqual(ctx.calls.map((c) => c.step), ["send-code"]);
  assert.deepEqual(ctx.calls[0]!.body, { email: EMAIL });
  const s = ctx.flow.getState();
  assert.equal(s.phase, "code", "the person stays on the code step to type it");
  assert.equal(s.error, undefined);
  assert.match(s.notice ?? "", /email/i, "a plain notice says the code was emailed");
});

test("a failed send-code shows plain copy and no notice", async () => {
  const ctx = setup();
  ctx.responders["send-code"] = () => jsonResponse(400, { error: "bad_request" });
  ctx.flow.setEmail(EMAIL);
  await ctx.flow.sendCode();
  const s = ctx.flow.getState();
  assertPlainEnglish(s.error, "send-code 4xx");
  assert.equal(s.notice, undefined);
});

test("the device code step offers a 'Send me a code' control", () => {
  const markup = renderToStaticMarkup(<DeviceView step="code" />);
  assert.match(markup, /<button[^>]*type="button"[^>]*>Send me a code<\/button>/);
});
