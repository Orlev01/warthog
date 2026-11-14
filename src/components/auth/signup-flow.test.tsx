// E04-S24 — Client sign-up flow (src/components/auth/signup-flow.tsx).
//
// RED-first: src/components/auth/signup-flow.tsx does NOT exist yet, so importing
// `./signup-flow` throws and EVERY test in this file fails until the builder adds the
// flow. That absence is the entire point of test-first — do not implement anything to
// make these pass.
//
// Why this task exists (E04-S24): without a client flow the sign-up page is static
// copy — nobody can create an account in a browser. This flow walks a person through
// the three sign-up requests (E04-S10 handler, surfaced over HTTP by E04-S23 at
// POST /api/auth/signup/[step]) and the passkey ceremony in between:
//
//   email  → POST /api/auth/signup/send-code      { email }
//   code   → POST /api/auth/signup/verify-email   { email, code }
//            → keeps the returned { signupId, registrationOptions }
//   passkey→ startRegistration({ optionsJSON: registrationOptions })   (@simplewebauthn/browser)
//            → POST /api/auth/signup/register-passkey { signupId, registrationResponse }
//            → shows the returned recoveryCode ONCE
//   confirm→ POST /api/auth/signup/confirm         { signupId, savedConfirmed: true }
//            → navigate to /home
//
// ── How these tests stay honest (and runnable without a DOM) ──────────────────────
// There is no jsdom / testing-library on this job and React component / E2E testing is
// a per-job ADR, so the interactive BEHAVIOUR of the flow is not driven through a
// rendered DOM. Instead the flow's logic lives in a framework-free, injectable
// controller that `signup-flow.tsx` exports alongside its `"use client"` component —
// the "pure logic, testable without I/O" convention. The React component is a thin
// binding over this controller (inputs read `state`, buttons call its methods); these
// tests drive the controller directly with a FAKE fetch and a FAKE WebAuthn seam and
// assert what it DOES — which URLs it posts, in what order, with which bodies; what it
// shows; where it navigates — never the source text of the module. A later
// behaviour-preserving refactor stays green.
//
// The contract the builder implements (exactly this), exported from `./signup-flow`:
//
//   createSignupFlow(deps: {
//     fetch: typeof fetch;                                  // the fake fetch seam
//     startRegistration: (opts: {                           // the WebAuthn seam,
//       optionsJSON: PublicKeyCredentialCreationOptionsJSON;//   @simplewebauthn/browser's
//       useAutoRegister?: boolean;                          //   startRegistration,
//     }) => Promise<RegistrationResponseJSON>;              //   injectable for tests
//     navigate: (path: string) => void;                     // sends the browser to /home
//     // (any further deps the component wires must be OPTIONAL)
//   }): SignupFlowController
//
//   SignupFlowController = {
//     getState(): SignupFlowState;             // a snapshot the component renders from
//     setEmail(value: string): void;
//     setCode(value: string): void;
//     setSavedConfirmed(value: boolean): void;
//     submitEmail(): Promise<void>;            // → send-code
//     submitCode(): Promise<void>;             // → verify-email
//     createPasskey(): Promise<void>;          // → startRegistration → register-passkey
//     confirm(): Promise<void>;                // → confirm → navigate("/home")
//   }
//
//   SignupFlowState = {
//     phase: ...;              // which step is shown (maps to a SignupView step)
//     email: string;          // what the person typed (survives a step error)
//     code: string;           // what the person typed (survives a step error)
//     savedConfirmed: boolean;// the "I have saved it" tick — confirm is gated on it
//     recoveryCode?: string;  // the one shown-once code from register-passkey
//     error?: string;         // plain-English copy for the CURRENT step, when a step fails
//   }
//
// These tests never pin the literal `phase` strings — they compare phases for
// equality/inequality — so the builder may name the steps however reads best, as long
// as each step is distinct and a failed step stays put.
//
// AC4 (GET /signup renders the flow's first step) is proven by rendering the sign-up
// page's default export (its only framework field) with `react-dom/server` and reading
// the markup — the same no-DOM render the view/page tests use.

// First: Next's environment baseline must load before the page pulls in its request stores.
import { withPageRequest } from "../../test/page-request";
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createSignupFlow } from "./signup-flow";
import SignupPage from "../../app/(auth)/signup/page";

// ── Fixtures ──────────────────────────────────────────────────────────────────────
// Distinct, JSON-safe sample values so an assertion proves the flow carried THROUGH the
// value it was given, not a constant. The recovery code carries no "_" and no space, so
// the plain-English error scan (which forbids both) is unaffected by it.
const EMAIL = "robin@example.com";
const CODE = "483921";
const SIGNUP_ID = "9f3c1a7e5b2d4680ab12cd34ef56a7b89f3c1a7e5b2d4680ab12cd34ef56a7b8";
const RECOVERY_CODE = "K7MQ-2P4R-9XTD-6WHF";

// The registration options the server hands back at verify-email and that the flow must
// forward VERBATIM into the WebAuthn seam (startRegistration's optionsJSON).
const REG_OPTIONS = {
  challenge: "Y2hhbGxlbmdlLWJ5dGVz",
  rp: { name: "Warthog", id: "warthog.com.au" },
  user: { id: "dXNlci1oYW5kbGU", name: EMAIL, displayName: EMAIL },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
  extensions: { prf: {} },
};

// The attestation the authenticator returns from startRegistration and that the flow
// must post VERBATIM as `registrationResponse` to register-passkey.
const ATTESTATION = {
  id: "Y3JlZGVudGlhbC1pZA",
  rawId: "Y3JlZGVudGlhbC1pZA",
  type: "public-key",
  response: {
    clientDataJSON: "Y2xpZW50LWRhdGEtanNvbg",
    attestationObject: "YXR0ZXN0YXRpb24tb2JqZWN0",
  },
  clientExtensionResults: {},
};

// ── A programmable, recording fake fetch keyed by the sign-up step path ──────────────

type StepKey = "send-code" | "verify-email" | "register-passkey" | "confirm";

interface RecordedCall {
  step: StepKey;
  url: string;
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

function makeFetch() {
  const calls: RecordedCall[] = [];
  // Default: every step succeeds. A test swaps a single responder to drive a 4xx.
  const responders: Record<StepKey, () => Response> = {
    "send-code": () => jsonResponse(200, { ok: true }),
    "verify-email": () => jsonResponse(200, { signupId: SIGNUP_ID, registrationOptions: REG_OPTIONS }),
    "register-passkey": () => jsonResponse(200, { recoveryCode: RECOVERY_CODE }),
    confirm: () => jsonResponse(200, { ok: true }),
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

// ── A programmable, recording fake WebAuthn seam (startRegistration) ─────────────────

function makeStart() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: any[] = [];
  let behaviour: () => Promise<typeof ATTESTATION> = async () => ATTESTATION;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = async (opts: { optionsJSON: any; useAutoRegister?: boolean }) => {
    calls.push(opts);
    return behaviour();
  };
  return {
    fn,
    calls,
    succeed() {
      behaviour = async () => ATTESTATION;
    },
    // What the browser does when the person dismisses the OS passkey prompt.
    cancel() {
      behaviour = async () => {
        throw Object.assign(
          new Error("The operation either timed out or was not allowed by the user agent."),
          { name: "NotAllowedError" },
        );
      };
    },
  };
}

// ── Test harness ────────────────────────────────────────────────────────────────────

function setup() {
  const { fetchImpl, calls, responders } = makeFetch();
  const start = makeStart();
  const navCalls: string[] = [];
  const flow = createSignupFlow({
    fetch: fetchImpl as typeof fetch,
    startRegistration: start.fn,
    navigate: (path: string) => {
      navCalls.push(path);
    },
  });
  return { flow, calls, responders, start, navCalls };
}

type Ctx = ReturnType<typeof setup>;

// Walk the happy path up to (but not including) confirm, leaving the recovery code
// shown and awaiting the "I have saved it" confirmation.
async function driveToRecovery(ctx: Ctx): Promise<void> {
  ctx.flow.setEmail(EMAIL);
  await ctx.flow.submitEmail();
  ctx.flow.setCode(CODE);
  await ctx.flow.submitCode();
  await ctx.flow.createPasskey();
}

// A step's user-facing error must read as plain Australian English — a real sentence,
// never a raw machine code (the server speaks `invalid_code`, `bad_attestation`,
// `no_second_factor`, `forbidden`, …) and never protocol/security jargon.
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

// ── AC1 — the ordered, correctly-valued request sequence, then navigate to /home ─────

test("posts send-code, verify-email, register-passkey and confirm in order, then navigates to /home", async () => {
  const ctx = setup();

  ctx.flow.setEmail(EMAIL);
  await ctx.flow.submitEmail();
  ctx.flow.setCode(CODE);
  await ctx.flow.submitCode();
  await ctx.flow.createPasskey();

  // The recovery code is now shown; the person ticks "I have saved it", then continues.
  assert.equal(ctx.flow.getState().recoveryCode, RECOVERY_CODE, "register-passkey's code must be shown");
  ctx.flow.setSavedConfirmed(true);
  await ctx.flow.confirm();

  // The four steps, in exactly this order, each a POST.
  assert.deepEqual(
    ctx.calls.map((c) => c.step),
    ["send-code", "verify-email", "register-passkey", "confirm"],
    "the flow must post the four sign-up steps in order",
  );
  for (const c of ctx.calls) {
    assert.equal(c.method, "POST", `step "${c.step}" must be a POST`);
  }

  // Each body carries the values the person entered and the server-returned signupId.
  assert.equal(ctx.calls[0]!.body.email, EMAIL, "send-code must send the entered email");
  assert.equal(ctx.calls[1]!.body.email, EMAIL, "verify-email must send the entered email");
  assert.equal(ctx.calls[1]!.body.code, CODE, "verify-email must send the entered code");

  // The WebAuthn seam is driven with the registration options verify-email returned.
  assert.deepEqual(
    ctx.start.calls.map((c) => c.optionsJSON),
    [REG_OPTIONS],
    "startRegistration must be called once with the returned registrationOptions",
  );

  assert.equal(ctx.calls[2]!.body.signupId, SIGNUP_ID, "register-passkey must carry the returned signupId");
  assert.deepEqual(
    ctx.calls[2]!.body.registrationResponse,
    ATTESTATION,
    "register-passkey must post the attestation from the WebAuthn seam",
  );

  assert.equal(ctx.calls[3]!.body.signupId, SIGNUP_ID, "confirm must carry the returned signupId");
  assert.equal(ctx.calls[3]!.body.savedConfirmed, true, "confirm must carry the saved confirmation");

  // ...and the person lands on /home.
  assert.deepEqual(ctx.navCalls, ["/home"], "a successful confirm must navigate to /home");
});

test("each step advances to a distinct next step", async () => {
  const ctx = setup();
  const p0 = ctx.flow.getState().phase;

  ctx.flow.setEmail(EMAIL);
  await ctx.flow.submitEmail();
  const p1 = ctx.flow.getState().phase;

  ctx.flow.setCode(CODE);
  await ctx.flow.submitCode();
  const p2 = ctx.flow.getState().phase;

  await ctx.flow.createPasskey();
  const p3 = ctx.flow.getState().phase;

  assert.notEqual(p1, p0, "sending the code must advance off the first step");
  assert.notEqual(p2, p1, "verifying the email must advance off the code step");
  assert.notEqual(p3, p2, "registering the passkey must advance to the recovery step");
});

// ── AC2 — the recovery code is shown once, never re-sent, never stored ───────────────

test("the recovery code is shown once and never leaves the browser (not re-sent, not stored)", async () => {
  // Install recording stand-ins for browser storage so a write of the code is caught.
  const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
  const hadLocal = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const hadSession = Object.prototype.hasOwnProperty.call(g, "sessionStorage");
  const origLocal = g.localStorage;
  const origSession = g.sessionStorage;

  function fakeStorage() {
    const map = new Map<string, string>();
    const writes: { key: string; value: string }[] = [];
    const store: Storage = {
      getItem: (k) => (map.has(k) ? map.get(k)! : null),
      setItem: (k, v) => {
        map.set(k, String(v));
        writes.push({ key: k, value: String(v) });
      },
      removeItem: (k) => void map.delete(k),
      clear: () => map.clear(),
      key: (i) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
    return { store, writes };
  }

  const local = fakeStorage();
  const session = fakeStorage();
  g.localStorage = local.store;
  g.sessionStorage = session.store;

  try {
    const ctx = setup();
    await driveToRecovery(ctx);

    assert.equal(ctx.flow.getState().recoveryCode, RECOVERY_CODE, "the recovery code must be shown once");

    ctx.flow.setSavedConfirmed(true);
    await ctx.flow.confirm();

    // Never sent back to the server: the code appears in no request body.
    for (const c of ctx.calls) {
      const serialized = JSON.stringify(c.body ?? {});
      assert.ok(
        !serialized.includes(RECOVERY_CODE),
        `step "${c.step}" must not send the recovery code back to the server, body: ${serialized}`,
      );
    }

    // Never written to browser storage.
    for (const w of [...local.writes, ...session.writes]) {
      assert.ok(
        !String(w.value).includes(RECOVERY_CODE) && !String(w.key).includes(RECOVERY_CODE),
        `the recovery code must never be written to browser storage, write: ${w.key}=${w.value}`,
      );
    }
  } finally {
    if (hadLocal) g.localStorage = origLocal;
    else delete g.localStorage;
    if (hadSession) g.sessionStorage = origSession;
    else delete g.sessionStorage;
  }
});

test("continue is disabled until the person confirms they saved the recovery code", async () => {
  const ctx = setup();
  await driveToRecovery(ctx);

  // Before the tick: the gate is closed.
  assert.equal(ctx.flow.getState().savedConfirmed, false, "the saved confirmation starts unticked");

  const atRecovery = ctx.flow.getState().phase;
  await ctx.flow.confirm();
  assert.ok(
    !ctx.calls.some((c) => c.step === "confirm"),
    "confirm must NOT post while the person has not confirmed they saved the code",
  );
  assert.deepEqual(ctx.navCalls, [], "confirm must NOT navigate while unticked");
  assert.equal(ctx.flow.getState().phase, atRecovery, "the person stays on the recovery step while unticked");
  assert.equal(ctx.flow.getState().recoveryCode, RECOVERY_CODE, "the code is still shown while unticked");

  // After the tick: the gate opens.
  ctx.flow.setSavedConfirmed(true);
  assert.equal(ctx.flow.getState().savedConfirmed, true, "ticking records the saved confirmation");
  await ctx.flow.confirm();
  assert.ok(ctx.calls.some((c) => c.step === "confirm"), "confirm must post once the code is saved");
  assert.deepEqual(ctx.navCalls, ["/home"], "confirm navigates to /home once the code is saved");
});

// ── AC3 — a 4xx on any step keeps the person put, with their input and plain copy ────

test("a 4xx from send-code keeps the person on the email step, with the email they typed and plain copy", async () => {
  const ctx = setup();
  const before = ctx.flow.getState().phase;

  ctx.flow.setEmail(EMAIL);
  ctx.responders["send-code"] = () => jsonResponse(400, { error: "bad_request" });
  await ctx.flow.submitEmail();

  const s = ctx.flow.getState();
  assert.equal(s.phase, before, "a send-code 4xx must keep the person on the email step");
  assert.equal(s.email, EMAIL, "the email the person typed must survive the error");
  assertPlainEnglish(s.error, "send-code 4xx");
  assert.deepEqual(
    ctx.calls.map((c) => c.step),
    ["send-code"],
    "a send-code 4xx must not advance to verify-email",
  );
  assert.deepEqual(ctx.navCalls, [], "a send-code 4xx must not navigate");
});

test("a 4xx from verify-email keeps the person on the code step, with their email and code and plain copy", async () => {
  const ctx = setup();

  ctx.flow.setEmail(EMAIL);
  await ctx.flow.submitEmail();
  const atCode = ctx.flow.getState().phase;

  ctx.flow.setCode(CODE);
  ctx.responders["verify-email"] = () => jsonResponse(400, { error: "invalid_code" });
  await ctx.flow.submitCode();

  const s = ctx.flow.getState();
  assert.equal(s.phase, atCode, "a verify-email 4xx must keep the person on the code step");
  assert.equal(s.email, EMAIL, "the email must survive the error");
  assert.equal(s.code, CODE, "the code the person typed must survive the error");
  assert.notEqual(s.error, "invalid_code", "the raw server code must not be shown to the person");
  assertPlainEnglish(s.error, "verify-email 4xx");
  assert.ok(
    !ctx.calls.some((c) => c.step === "register-passkey"),
    "a verify-email 4xx must not start the passkey step",
  );
  assert.deepEqual(ctx.navCalls, [], "a verify-email 4xx must not navigate");
});

test("a 4xx from register-passkey keeps the person on the passkey step with plain copy, and the step can be retried", async () => {
  const ctx = setup();

  ctx.flow.setEmail(EMAIL);
  await ctx.flow.submitEmail();
  ctx.flow.setCode(CODE);
  await ctx.flow.submitCode();
  const atPasskey = ctx.flow.getState().phase;

  ctx.responders["register-passkey"] = () => jsonResponse(400, { error: "bad_attestation" });
  await ctx.flow.createPasskey();

  let s = ctx.flow.getState();
  assert.equal(s.phase, atPasskey, "a register-passkey 4xx must keep the person on the passkey step");
  assert.equal(s.email, EMAIL, "the email must survive the error");
  assert.equal(s.code, CODE, "the code must survive the error");
  assert.ok(!s.recoveryCode, "no recovery code is shown when registration was rejected");
  assertPlainEnglish(s.error, "register-passkey 4xx");
  assert.deepEqual(ctx.navCalls, [], "a register-passkey 4xx must not navigate");

  // Retry: a fresh attempt can complete, and the error clears.
  ctx.responders["register-passkey"] = () => jsonResponse(200, { recoveryCode: RECOVERY_CODE });
  await ctx.flow.createPasskey();
  s = ctx.flow.getState();
  assert.equal(s.recoveryCode, RECOVERY_CODE, "a retry of the passkey step can complete registration");
  assert.ok(!s.error, "the error clears once the retry succeeds");
});

test("a 4xx from confirm keeps the recovery code shown, with plain copy and no navigation", async () => {
  const ctx = setup();
  await driveToRecovery(ctx);
  ctx.flow.setSavedConfirmed(true);
  const atRecovery = ctx.flow.getState().phase;

  ctx.responders["confirm"] = () => jsonResponse(400, { error: "no_second_factor" });
  await ctx.flow.confirm();

  const s = ctx.flow.getState();
  assert.equal(s.phase, atRecovery, "a confirm 4xx must keep the person on the recovery step");
  assert.equal(s.recoveryCode, RECOVERY_CODE, "the recovery code is still shown so the person can save it");
  assertPlainEnglish(s.error, "confirm 4xx");
  assert.deepEqual(ctx.navCalls, [], "a confirm 4xx must not navigate");
});

test("a cancelled passkey prompt stays on the passkey step, posts nothing, and can be retried", async () => {
  const ctx = setup();

  ctx.flow.setEmail(EMAIL);
  await ctx.flow.submitEmail();
  ctx.flow.setCode(CODE);
  await ctx.flow.submitCode();
  const atPasskey = ctx.flow.getState().phase;

  // The person dismisses the OS passkey prompt — the WebAuthn seam rejects.
  ctx.start.cancel();
  await ctx.flow.createPasskey();

  let s = ctx.flow.getState();
  assert.equal(s.phase, atPasskey, "a cancelled passkey keeps the person on the passkey step");
  assert.ok(
    !ctx.calls.some((c) => c.step === "register-passkey"),
    "a cancelled passkey must not post a registration to the server",
  );
  assertPlainEnglish(s.error, "cancelled passkey"); // never fail silently — tell them, offer a retry
  assert.deepEqual(ctx.navCalls, [], "a cancelled passkey must not navigate");

  // Retry: the person tries again and the ceremony completes.
  ctx.start.succeed();
  await ctx.flow.createPasskey();
  s = ctx.flow.getState();
  assert.equal(s.recoveryCode, RECOVERY_CODE, "retrying the passkey lets the person continue");
  assert.ok(!s.error, "the cancellation message clears once the retry succeeds");
  assert.ok(ctx.calls.some((c) => c.step === "register-passkey"), "the retry posts the registration");
});

// ── The flow starts clean on the email step ─────────────────────────────────────────

test("a fresh flow starts on the email step with nothing typed and no error", () => {
  const ctx = setup();
  const s = ctx.flow.getState();
  assert.equal(s.email, "", "the email starts empty");
  assert.equal(s.code, "", "the code starts empty");
  assert.equal(s.savedConfirmed, false, "the saved confirmation starts unticked");
  assert.ok(!s.recoveryCode, "no recovery code before registration");
  assert.ok(!s.error, "no error on a fresh flow");
  // No network and no navigation happen just by constructing the flow.
  assert.deepEqual(ctx.calls, [], "constructing the flow makes no requests");
  assert.deepEqual(ctx.navCalls, [], "constructing the flow navigates nowhere");
});

// ── AC4 — GET /signup renders the flow's first step (email entry) ────────────────────

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
  assert.equal(typeof Page, "function", "the sign-up entry must have a default-exported page component");
  // An anonymous request: the entry forwards a signed-in visitor before rendering the flow.
  const element = await withPageRequest("/signup", undefined, () =>
    Promise.resolve(
      (Page as (props: unknown) => unknown)({
        searchParams: Promise.resolve({}),
        params: Promise.resolve({}),
      }),
    ),
  );
  return renderToStaticMarkup(element as React.ReactElement);
}

test("GET /signup renders the flow's first step: an accessibly-labelled email entry with a live control", async () => {
  const markup = await renderPage(SignupPage);

  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type));
  assert.ok(entry.length >= 1, `the first step must render an email-entry field, got: ${markup}`);
  for (const input of entry) {
    assert.ok(
      inputIsLabelled(input, labels),
      `every field on the first step must carry an accessible label, got: ${input.attrs}`,
    );
  }

  const labelBlob = Object.values(labels).join(" ").toLowerCase();
  assert.match(labelBlob, /email/i, `the first step must be the email entry, got labels: "${labelBlob}"`);

  const live = actionableButtons(markup).filter((b) => b.name.trim().length > 0);
  assert.ok(
    live.length >= 1,
    `the first step must offer a live, named control to continue (not a dead screen), got: ${markup}`,
  );
});

// ── Review fix B1 — a throttled send-code says to wait, in plain English ──────────────

test("a throttled send-code (429) stays on the details step and asks the person to wait", async () => {
  const ctx = setup();
  ctx.responders["send-code"] = () => jsonResponse(429, { error: "throttled" });

  ctx.flow.setEmail(EMAIL);
  await ctx.flow.submitEmail();

  const state = ctx.flow.getState();
  assert.equal(state.phase, "details", "no code step without a sent code");
  assertPlainEnglish(state.error, "throttled send-code");
  assert.match(state.error, /minute/i, "the copy tells the person to wait a minute");
});

// ── Review fix B9 — an address that already has an account (409) says so plainly ──────

test("a 409 at confirm tells the person the address already has an account and does not navigate", async () => {
  const ctx = setup();
  await driveToRecovery(ctx);
  ctx.responders.confirm = () => jsonResponse(409, { error: "account_exists" });
  ctx.flow.setSavedConfirmed(true);
  await ctx.flow.confirm();

  const state = ctx.flow.getState();
  assertPlainEnglish(state.error, "confirm 409");
  assert.match(state.error, /already/i, "the copy says the address already has an account");
  assert.match(state.error, /sign in/i, "the copy points to signing in");
  assert.deepEqual(ctx.navCalls, [], "no navigation");
});

// ── Review fix B6 — a new person who arrived from an agent or invite goes back there ──

test("after confirming, sign-up goes to a safe return path, and to /home for an unsafe one", async () => {
  for (const [returnTo, expected] of [
    ["/household/join/abc123", "/household/join/abc123"],
    ["javascript:alert(1)", "/home"],
  ] as const) {
    const { fetchImpl } = makeFetch();
    const start = makeStart();
    const navCalls: string[] = [];
    const flow = createSignupFlow({
      fetch: fetchImpl as typeof fetch,
      startRegistration: start.fn,
      navigate: (path: string) => void navCalls.push(path),
      returnTo,
    });
    flow.setEmail(EMAIL);
    await flow.submitEmail();
    flow.setCode(CODE);
    await flow.submitCode();
    await flow.createPasskey();
    flow.setSavedConfirmed(true);
    await flow.confirm();
    assert.deepEqual(navCalls, [expected], `returnTo ${returnTo}`);
  }
});
