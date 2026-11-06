// E04-S39 — the client sign-up flow carries the person's name (the controller half:
// `src/components/auth/signup-flow.tsx`).
//
// RED-first: the flow controller today holds only `email` / `code` and posts
// `{ email }` to send-code — the name entered at the details step is never captured
// or sent. This task adds a controlled `name` to the flow's state (settable, like
// email) and sends it with send-code. Until the builder adds `setName` and the
// `name` state, these tests fail — that absence IS the point of test-first. Do NOT
// implement anything to make them pass.
//
// There is no jsdom on this job (React component / E2E testing is a per-job ADR), so
// the flow's interactive BEHAVIOUR lives in the framework-free, injectable
// controller `createSignupFlow` that `signup-flow.tsx` exports alongside its
// component. These tests drive the controller directly with a FAKE fetch and assert
// what it DOES — the body it posts, what survives an error — never the source text.
//
// ─── Acceptance criterion → tests ───────────────────────────────────────────────
//   AC (details step is controlled from the first render + the name is sent with
//       send-code): the controller starts with an empty-string `name` (a controlled
//       value from the very first render, never `undefined`), captures what the
//       person types, posts it in the send-code body alongside the email, and keeps
//       it on a send-code error so the person does not lose what they typed.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";

import { createSignupFlow } from "./signup-flow";

// Distinct, JSON-safe sample values so an assertion proves the flow carried THROUGH
// the value it was given, not a constant.
const EMAIL = "robin@example.com";
const NAME = "Sam Rivera";

// ── A programmable, recording fake fetch keyed by the sign-up step path ──────────────

type StepKey = "send-code" | "verify-email" | "register-passkey" | "confirm";

interface RecordedCall {
  step: StepKey;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function stepOf(url: string): StepKey {
  if (url.includes("/api/auth/signup/send-code")) return "send-code";
  if (url.includes("/api/auth/signup/verify-email")) return "verify-email";
  if (url.includes("/api/auth/signup/register-passkey")) return "register-passkey";
  if (url.includes("/api/auth/signup/confirm")) return "confirm";
  throw new Error(`the sign-up flow posted to an unexpected URL: ${url}`);
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup() {
  const calls: RecordedCall[] = [];
  const responders: Record<StepKey, () => Response> = {
    "send-code": () => jsonResponse(200, { ok: true }),
    "verify-email": () => jsonResponse(200, { signupId: "sid", registrationOptions: {} }),
    "register-passkey": () => jsonResponse(200, { recoveryCode: "K7MQ-2P4R" }),
    confirm: () => jsonResponse(200, { ok: true }),
  };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const step = stepOf(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ step, method, body });
    return responders[step]();
  };
  const navCalls: string[] = [];
  const flow = createSignupFlow({
    fetch: fetchImpl as typeof fetch,
    // Never exercised by these name tests (they stop at send-code); a stub satisfies the dep.
    startRegistration: async () => ({}) as unknown as RegistrationResponseJSON,
    navigate: (path: string) => {
      navCalls.push(path);
    },
  });
  return { flow, calls, responders, navCalls };
}

// ===========================================================================

test("a fresh flow starts with an empty-string name (a controlled value from the first render)", () => {
  const ctx = setup();
  const s = ctx.flow.getState() as { name?: unknown };
  assert.equal(s.name, "", "the name starts as an empty string, never undefined, so the input is controlled");
});

test("setName captures what the person types into the name field", () => {
  const ctx = setup();
  ctx.flow.setName(NAME);
  const s = ctx.flow.getState() as { name?: unknown };
  assert.equal(s.name, NAME, "setName records the entered name in the flow state");
});

test("submitEmail posts the entered name alongside the email in the send-code body", async () => {
  const ctx = setup();

  ctx.flow.setName(NAME);
  ctx.flow.setEmail(EMAIL);
  await ctx.flow.submitEmail();

  const sendCode = ctx.calls.find((c) => c.step === "send-code");
  assert.ok(sendCode, "submitEmail must post to send-code");
  assert.equal(sendCode!.method, "POST", "send-code must be a POST");
  assert.equal(sendCode!.body.email, EMAIL, "send-code carries the entered email");
  assert.equal(sendCode!.body.name, NAME, "send-code carries the entered name");
});

test("the entered name survives a send-code error so the person does not retype it", async () => {
  const ctx = setup();

  ctx.flow.setName(NAME);
  ctx.flow.setEmail(EMAIL);
  const before = ctx.flow.getState().phase;

  ctx.responders["send-code"] = () => jsonResponse(400, { error: "bad_request" });
  await ctx.flow.submitEmail();

  const s = ctx.flow.getState() as { name?: unknown; email: string; phase: unknown };
  assert.equal(s.phase, before, "a send-code 4xx keeps the person on the details step");
  assert.equal(s.name, NAME, "the name the person typed survives the error");
  assert.equal(s.email, EMAIL, "the email the person typed survives the error");
});
