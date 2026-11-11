// E04-S25 — Client sign-in flow (src/components/auth/signin-flow.tsx).
//
// RED-first: src/components/auth/signin-flow.tsx does NOT exist yet, so importing
// `./signin-flow` throws and EVERY test in this file fails until the builder adds the
// flow. That absence is the entire point of test-first — do not implement anything to
// make these pass.
//
// Why this task exists (E04-S25): without a client flow the sign-in page is static
// copy — nobody can sign in in a browser. This flow walks a RETURNING person through
// the sign-in requests (the E04-S11 handler, surfaced over HTTP by E04-S23 at
// POST /api/auth/signin/[step]) and the passkey ceremony between:
//
//   passkey path:
//     email  → POST /api/auth/signin/begin-passkey   { email }
//            → keeps the returned { options }
//            → startAuthentication({ optionsJSON: options })   (@simplewebauthn/browser)
//            → POST /api/auth/signin/finish-passkey   { email, authenticationResponse }
//            → navigate to /home on success
//
//   authenticator-app path ("Use my authenticator app instead"):
//     email + code → POST /api/auth/signin/totp       { email, totp: code }
//            → navigate to /home on success
//
// ── How success is signalled ────────────────────────────────────────────────────────
// A successful sign-in step answers with a 303 redirect to /home carrying the session
// cookie; a failed one answers with a 4xx JSON error (E04-S11 handler.ts). The flow
// posts with `fetch` (default redirect-follow, as the sibling sign-up flow does), so a
// successful finish-passkey / totp surfaces to the client as the followed /home (a 2xx)
// — i.e. `response.ok`. A 4xx surfaces as `!response.ok`. So these tests feed a 2xx for
// a successful step and a 4xx for a failed one, and assert the OUTCOME (navigate / stay
// put), never how the flow inspects the response.
//
// ── How these tests stay honest (and runnable without a DOM) ──────────────────────────
// There is no jsdom / testing-library on this job and React component / E2E testing is a
// per-job ADR, so the interactive BEHAVIOUR of the flow is not driven through a rendered
// DOM. Instead the flow's logic lives in a framework-free, injectable controller that
// `signin-flow.tsx` exports alongside its `"use client"` component — the "pure logic,
// testable without I/O" convention, exactly as the sign-up flow (E04-S24) does. The
// React component is a thin binding over this controller (inputs read `state`, buttons
// call its methods); these tests drive the controller directly with a FAKE fetch and a
// FAKE WebAuthn seam and assert what it DOES — which URLs it posts, in what order, with
// which bodies; what it shows; where it navigates — never the source text of the module.
// A later behaviour-preserving refactor stays green.
//
// The contract the builder implements (exactly this), exported from `./signin-flow`:
//
//   createSigninFlow(deps: {
//     fetch: typeof fetch;                                 // the fake fetch seam
//     startAuthentication: (opts: {                        // the WebAuthn seam,
//       optionsJSON: PublicKeyCredentialRequestOptionsJSON;//   @simplewebauthn/browser's
//       useBrowserAutofill?: boolean;                      //   startAuthentication,
//     }) => Promise<AuthenticationResponseJSON>;           //   injectable for tests
//     navigate: (path: string) => void;                    // sends the browser to /home
//     // (any further deps the component wires must be OPTIONAL)
//   }): SigninFlowController
//
//   SigninFlowController = {
//     getState(): SigninFlowState;              // a snapshot the component renders from
//     setEmail(value: string): void;
//     setCode(value: string): void;             // the authenticator-app code
//     signInWithPasskey(): Promise<void>;       // begin-passkey → startAuthentication → finish-passkey → /home
//     useAuthenticatorApp(): void;              // switch to the "enter a code" step
//     signInWithCode(): Promise<void>;          // totp → /home
//   }
//
//   SigninFlowState = {
//     phase: ...;        // which step is shown (maps to a SigninView step)
//     email: string;     // what the person typed (survives a step error, carries across steps)
//     code: string;      // the authenticator-app code (survives a step error)
//     error?: string;    // plain-English copy for the CURRENT step, when a step fails
//   }
//
// These tests never pin the literal `phase` strings — they compare phases for
// equality/inequality — so the builder may name the steps however reads best, as long as
// the passkey step and the code step are distinct and a failed step stays put.
//
// AC4 (GET /signin renders the flow's first step) is proven by rendering the sign-in
// page's default export (its only framework field) with `react-dom/server` and reading
// the markup — the same no-DOM render the view/page tests use.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createSigninFlow } from "./signin-flow";
import { SigninView } from "./auth-views";
import SigninPage from "../../app/(auth)/signin/page";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────
// Distinct, JSON-safe sample values so an assertion proves the flow carried THROUGH the
// value it was given, not a constant.
const EMAIL = "robin@example.com";
const CODE = "483921"; // the six-digit authenticator-app code

// The authentication options the server hands back at begin-passkey and that the flow
// must forward VERBATIM into the WebAuthn seam (startAuthentication's optionsJSON).
const AUTH_OPTIONS = {
  challenge: "Y2hhbGxlbmdlLWJ5dGVz",
  rpId: "warthog.com.au",
  timeout: 60000,
  userVerification: "required",
  allowCredentials: [{ id: "Y3JlZGVudGlhbC1pZA", type: "public-key" }],
};

// The assertion the authenticator returns from startAuthentication and that the flow
// must post VERBATIM as `authenticationResponse` to finish-passkey.
const ASSERTION = {
  id: "Y3JlZGVudGlhbC1pZA",
  rawId: "Y3JlZGVudGlhbC1pZA",
  type: "public-key",
  response: {
    clientDataJSON: "Y2xpZW50LWRhdGEtanNvbg",
    authenticatorData: "YXV0aGVudGljYXRvci1kYXRh",
    signature: "c2lnbmF0dXJl",
    userHandle: "dXNlci1oYW5kbGU",
  },
  clientExtensionResults: {},
};

// ── A programmable, recording fake fetch keyed by the sign-in step path ─────────────────

type StepKey = "begin-passkey" | "finish-passkey" | "send-email-code" | "verify-email" | "totp";

interface RecordedCall {
  step: StepKey;
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function stepOf(url: string): StepKey {
  if (url.includes("/api/auth/signin/begin-passkey")) return "begin-passkey";
  if (url.includes("/api/auth/signin/finish-passkey")) return "finish-passkey";
  if (url.includes("/api/auth/signin/send-email-code")) return "send-email-code";
  if (url.includes("/api/auth/signin/verify-email")) return "verify-email";
  if (url.includes("/api/auth/signin/totp")) return "totp";
  throw new Error(`the sign-in flow posted to an unexpected URL: ${url}`);
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch() {
  const calls: RecordedCall[] = [];
  // Default: every step succeeds. begin-passkey hands back the challenge options; a
  // successful finish-passkey / totp surfaces to the client as the followed /home (a
  // 2xx — see the success-signal note at the top). A test swaps a single responder to
  // drive a failure.
  const responders: Record<StepKey, () => Response> = {
    "begin-passkey": () => jsonResponse(200, { options: AUTH_OPTIONS }),
    "finish-passkey": () => jsonResponse(200, { ok: true }),
    "send-email-code": () => jsonResponse(200, { ok: true }),
    "verify-email": () => jsonResponse(200, { signinId: "a".repeat(64) }),
    totp: () => jsonResponse(200, { ok: true }),
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

// ── A programmable, recording fake WebAuthn seam (startAuthentication) ───────────────────

function makeStart() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: any[] = [];
  let behaviour: () => Promise<typeof ASSERTION> = async () => ASSERTION;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = async (opts: { optionsJSON: any; useBrowserAutofill?: boolean }) => {
    calls.push(opts);
    return behaviour();
  };
  return {
    fn,
    calls,
    succeed() {
      behaviour = async () => ASSERTION;
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

// ── Test harness ─────────────────────────────────────────────────────────────────────

function setup() {
  const { fetchImpl, calls, responders } = makeFetch();
  const start = makeStart();
  const navCalls: string[] = [];
  const flow = createSigninFlow({
    fetch: fetchImpl as typeof fetch,
    startAuthentication: start.fn,
    navigate: (path: string) => {
      navCalls.push(path);
    },
  });
  return { flow, calls, responders, start, navCalls };
}

type Ctx = ReturnType<typeof setup>;

// A step's user-facing error must read as plain Australian English — a real sentence,
// never a raw machine code (the server speaks `invalid_assertion`, `invalid_code`,
// `forbidden`, `not_found`, …) and never protocol/security jargon. "passkey", "code" and
// "authenticator" are the brief's OWN plain vocabulary and are expected, not jargon.
const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "FIDO", re: /\bfido\b/i },
  { label: "TOTP", re: /\btotp\b/i },
  { label: "attestation", re: /\battestation\b/i },
  { label: "assertion", re: /\bassertion\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "JWT", re: /\bjwt\b/i },
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

// A failed sign-in must NOT reveal whether the email has an account (no account
// enumeration; E04-S19, brief sign_in_model). The server already answers the same 4xx
// whether the account exists or not, so the client just has to NOT invent copy that
// affirms or denies an account's existence.
const ENUMERATION: { label: string; re: RegExp }[] = [
  { label: "no account / no user", re: /\bno (such )?(account|user|email)\b/i },
  { label: "not found", re: /\bnot found\b/i },
  { label: "doesn't exist", re: /\bdoes(?:n'?t| not) exist\b/i },
  { label: "couldn't find", re: /\bcould(?:n'?t| not) find\b/i },
  { label: "unknown email/account/user", re: /\bunknown (email|account|user)\b/i },
  { label: "not registered", re: /\b(isn'?t|is not|not) registered\b/i },
  { label: "there's no", re: /\bthere(?:'s| is) no\b/i },
  { label: "we have no", re: /\bwe (have|had) no\b/i },
  { label: "already registered / exists", re: /\balready (registered|exists|have an account)\b/i },
];

function assertNoEnumeration(message: string, ctx: string): void {
  for (const { label, re } of ENUMERATION) {
    assert.ok(
      !re.test(message),
      `${ctx}: the failure message must not reveal whether the email has an account — found "${label}" in: "${message}"`,
    );
  }
}

// ── AC1 — the passkey path: begin-passkey → startAuthentication → finish-passkey → /home ─

test("the passkey path posts begin-passkey then finish-passkey with the assertion, then navigates to /home", async () => {
  const ctx = setup();

  ctx.flow.setEmail(EMAIL);
  await ctx.flow.signInWithPasskey();

  // The two passkey steps, in exactly this order, each a POST.
  assert.deepEqual(
    ctx.calls.map((c) => c.step),
    ["begin-passkey", "finish-passkey"],
    "the passkey path must post begin-passkey then finish-passkey, in order",
  );
  for (const c of ctx.calls) {
    assert.equal(c.method, "POST", `step "${c.step}" must be a POST`);
  }

  // begin-passkey names the account to challenge.
  assert.equal(ctx.calls[0]!.body.email, EMAIL, "begin-passkey must send the entered email");

  // The WebAuthn seam is driven once with the options begin-passkey returned.
  assert.deepEqual(
    ctx.start.calls.map((c) => c.optionsJSON),
    [AUTH_OPTIONS],
    "startAuthentication must be called once with the options begin-passkey returned",
  );

  // finish-passkey carries the email and the assertion the authenticator produced.
  assert.equal(ctx.calls[1]!.body.email, EMAIL, "finish-passkey must send the entered email");
  assert.deepEqual(
    ctx.calls[1]!.body.authenticationResponse,
    ASSERTION,
    "finish-passkey must post the assertion from the WebAuthn seam as authenticationResponse",
  );

  // ...and the person lands on /home.
  assert.deepEqual(ctx.navCalls, ["/home"], "a successful passkey sign-in must navigate to /home");
  assert.ok(!ctx.flow.getState().error, "no error on a successful sign-in");
});

test("the passkey path runs the WebAuthn prompt between begin-passkey and finish-passkey", async () => {
  // startAuthentication must be driven with begin-passkey's options and its result fed
  // into finish-passkey: proving begin → startAuthentication → finish, not finish first.
  const ctx = setup();
  ctx.flow.setEmail(EMAIL);
  await ctx.flow.signInWithPasskey();

  assert.equal(ctx.start.calls.length, 1, "the passkey prompt runs exactly once per attempt");
  const finish = ctx.calls.find((c) => c.step === "finish-passkey");
  assert.ok(finish, "finish-passkey must be posted");
  assert.deepEqual(
    finish!.body.authenticationResponse,
    ASSERTION,
    "finish-passkey must carry exactly what startAuthentication returned",
  );
});

// ── AC2 — the authenticator-app path: email + code → totp → /home ───────────────────────

async function advanceToAuthenticator(ctx: ReturnType<typeof setup>) {
  ctx.flow.useAuthenticatorApp();
  ctx.flow.setEmail(EMAIL);
  await ctx.flow.signInWithCode();
  assert.equal(ctx.flow.getState().phase, "email-code");
  ctx.flow.setCode("123456");
  await ctx.flow.signInWithCode();
  assert.equal(ctx.flow.getState().phase, "code");
}

test("failed email delivery or verification never advances to authenticator sign-in", async () => {
  const ctx = setup();
  ctx.flow.useAuthenticatorApp(); ctx.flow.setEmail(EMAIL);
  ctx.responders["send-email-code"] = () => jsonResponse(429);
  await ctx.flow.signInWithCode();
  assert.equal(ctx.flow.getState().phase, "email");
  assert.ok(ctx.flow.getState().error);
  ctx.responders["send-email-code"] = () => jsonResponse(200);
  await ctx.flow.signInWithCode();
  ctx.flow.setCode("123456");
  ctx.responders["verify-email"] = () => jsonResponse(401);
  await ctx.flow.signInWithCode();
  assert.equal(ctx.flow.getState().phase, "email-code");
  assert.ok(ctx.flow.getState().error);
  assert.deepEqual(ctx.navCalls, []);
  assert.equal(ctx.calls.some((c) => c.step === "totp"), false);
});

test("changing the email discards a verified first-factor handle", async () => {
  const ctx = setup(); await advanceToAuthenticator(ctx);
  ctx.flow.setEmail("different@example.test");
  assert.equal(ctx.flow.getState().phase, "email");
  assert.equal(ctx.flow.getState().code, "");
  await ctx.flow.signInWithCode();
  assert.equal(ctx.calls.at(-1)?.step, "send-email-code");
  assert.deepEqual(ctx.navCalls, []);
});

test("the authenticator-app path verifies email before exchanging the proof and authenticator code", async () => {
  const ctx = setup();

  // "Use my authenticator app instead".
  await advanceToAuthenticator(ctx);
  ctx.flow.setCode(CODE);
  await ctx.flow.signInWithCode();

  assert.deepEqual(
    ctx.calls.map((c) => c.step),
    ["send-email-code", "verify-email", "totp"],
    "email must be verified before the authenticator step",
  );
  assert.equal(ctx.calls[0]!.method, "POST", "the totp step must be a POST");
  assert.equal(ctx.calls[0]!.body.email, EMAIL);
  assert.equal(ctx.calls[2]!.body.signinId, "a".repeat(64));
  assert.equal(ctx.calls[2]!.body.email, undefined, "the verified identity cannot be replaced by a caller email");
  assert.equal(ctx.calls[2]!.body.totp, CODE);

  // The code method never touches the WebAuthn prompt.
  assert.equal(ctx.start.calls.length, 0, "the authenticator-app path must not run the passkey prompt");

  assert.deepEqual(ctx.navCalls, ["/home"], "a successful code sign-in must navigate to /home");
  assert.ok(!ctx.flow.getState().error, "no error on a successful sign-in");
});

test("switching to the authenticator-app step keeps the typed email, changes the step, and clears a prior error", async () => {
  const ctx = setup();

  // Type the email and hit a cancelled passkey so an error is showing on the passkey step.
  ctx.flow.setEmail(EMAIL);
  ctx.start.cancel();
  await ctx.flow.signInWithPasskey();
  const passkeyPhase = ctx.flow.getState().phase;
  assert.ok(ctx.flow.getState().error, "a cancelled passkey leaves an error on the passkey step");

  // Switch to the authenticator-app method.
  ctx.flow.useAuthenticatorApp();
  const s = ctx.flow.getState();
  assert.notEqual(s.phase, passkeyPhase, "switching must move off the passkey step to a distinct code step");
  assert.equal(s.email, EMAIL, "the email the person typed must carry across to the code step");
  assert.ok(!s.error, "switching methods must clear the previous step's error (no stale message)");
});

// ── AC3 — a failed sign-in: one plain message, no account enumeration, stay put ──────────

test("a failed passkey sign-in keeps the person on the passkey step with one plain, non-enumerating message", async () => {
  const ctx = setup();
  ctx.flow.setEmail(EMAIL);
  const before = ctx.flow.getState().phase;

  // The server rejects the assertion (same 401 whether or not the account exists).
  ctx.responders["finish-passkey"] = () => jsonResponse(401, { error: "invalid_assertion" });
  await ctx.flow.signInWithPasskey();

  const s = ctx.flow.getState();
  assert.equal(s.phase, before, "a rejected passkey must keep the person on the passkey step");
  assert.equal(s.email, EMAIL, "the email the person typed must survive the error");
  assert.notEqual(s.error, "invalid_assertion", "the raw server code must not be shown to the person");
  assertPlainEnglish(s.error, "failed passkey sign-in");
  assertNoEnumeration(s.error, "failed passkey sign-in");
  assert.deepEqual(ctx.navCalls, [], "a failed sign-in must not navigate");
});

test("a failed authenticator-app sign-in keeps the person on the code step with one plain, non-enumerating message", async () => {
  const ctx = setup();
  await advanceToAuthenticator(ctx);
  ctx.flow.setCode(CODE);
  const atCode = ctx.flow.getState().phase;

  // The server rejects the code (same 401 whether or not the account exists).
  ctx.responders["totp"] = () => jsonResponse(401, { error: "invalid_code" });
  await ctx.flow.signInWithCode();

  const s = ctx.flow.getState();
  assert.equal(s.phase, atCode, "a rejected code must keep the person on the code step");
  assert.equal(s.email, EMAIL, "the email must survive the error");
  assert.equal(s.code, CODE, "the code the person typed must survive the error");
  assert.notEqual(s.error, "invalid_code", "the raw server code must not be shown to the person");
  assertPlainEnglish(s.error, "failed code sign-in");
  assertNoEnumeration(s.error, "failed code sign-in");
  assert.deepEqual(ctx.navCalls, [], "a failed sign-in must not navigate");
});

test("a failed begin-passkey never runs the WebAuthn prompt, posts no finish, and shows plain copy", async () => {
  // Never fail silently (and never crash): if begin-passkey is refused, the flow stops
  // before the OS prompt, posts no finish-passkey, and tells the person in plain words.
  const ctx = setup();
  ctx.flow.setEmail(EMAIL);
  const before = ctx.flow.getState().phase;

  ctx.responders["begin-passkey"] = () => jsonResponse(400, { error: "bad_request" });
  await ctx.flow.signInWithPasskey();

  const s = ctx.flow.getState();
  assert.equal(s.phase, before, "a refused begin-passkey must keep the person on the passkey step");
  assert.equal(ctx.start.calls.length, 0, "a refused begin-passkey must not open the OS passkey prompt");
  assert.ok(
    !ctx.calls.some((c) => c.step === "finish-passkey"),
    "a refused begin-passkey must not post a finish-passkey",
  );
  assertPlainEnglish(s.error, "refused begin-passkey");
  assert.deepEqual(ctx.navCalls, [], "a refused begin-passkey must not navigate");
});

// ── AC3 — a cancelled passkey prompt stays put, posts nothing, and offers a retry ────────

test("a cancelled passkey prompt stays on the passkey step, posts no finish, and can be retried", async () => {
  const ctx = setup();
  ctx.flow.setEmail(EMAIL);
  const atPasskey = ctx.flow.getState().phase;

  // The person dismisses the OS passkey prompt — the WebAuthn seam rejects.
  ctx.start.cancel();
  await ctx.flow.signInWithPasskey();

  let s = ctx.flow.getState();
  assert.equal(s.phase, atPasskey, "a cancelled passkey keeps the person on the passkey step");
  assert.ok(
    !ctx.calls.some((c) => c.step === "finish-passkey"),
    "a cancelled passkey must not post a finish-passkey to the server",
  );
  assertPlainEnglish(s.error, "cancelled passkey"); // never fail silently — tell them, offer a retry
  assert.deepEqual(ctx.navCalls, [], "a cancelled passkey must not navigate");

  // The retry affordance works: a fresh attempt completes and the message clears.
  ctx.start.succeed();
  await ctx.flow.signInWithPasskey();
  s = ctx.flow.getState();
  assert.ok(
    ctx.calls.some((c) => c.step === "finish-passkey"),
    "retrying the passkey prompt posts the finish-passkey",
  );
  assert.deepEqual(ctx.navCalls, ["/home"], "a successful retry navigates to /home");
  assert.ok(!s.error, "the cancellation message clears once the retry succeeds");
});

// ── The flow starts clean on the first step ──────────────────────────────────────────────

test("a fresh flow starts with nothing typed, no error, and makes no requests or navigation", () => {
  const ctx = setup();
  const s = ctx.flow.getState();
  assert.equal(s.email, "", "the email starts empty");
  assert.equal(s.code, "", "the code starts empty");
  assert.ok(!s.error, "no error on a fresh flow");
  assert.deepEqual(ctx.calls, [], "constructing the flow makes no requests");
  assert.deepEqual(ctx.navCalls, [], "constructing the flow navigates nowhere");
  assert.equal(ctx.start.calls.length, 0, "constructing the flow opens no passkey prompt");
});

// ── AC4 — GET /signin renders the flow's first step (the passkey / email entry) ──────────

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

// All human-facing text: the visible copy PLUS the words a screen reader announces from
// the attributes that carry them. The jargon scan runs over this.
function faceText(markup: string): string {
  const parts = [visibleText(markup)];
  for (const re of [
    /aria-label="([^"]*)"/gi,
    /placeholder="([^"]*)"/gi,
    /\btitle="([^"]*)"/gi,
    /\balt="([^"]*)"/gi,
  ]) {
    for (const m of markup.matchAll(re)) parts.push(decode(m[1]!));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
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

// An actionable native <button> is one not carrying the native `disabled` attribute
// (React renders a truthy boolean `disabled` prop as `disabled=""`). Matching the
// ATTRIBUTE (never a Tailwind `disabled:` class) proves a genuinely live control.
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
  assert.equal(typeof Page, "function", "the sign-in entry must have a default-exported page component");
  const element = await Promise.resolve(
    (Page as (props: unknown) => unknown)({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({}),
    }),
  );
  return renderToStaticMarkup(element as React.ReactElement);
}

const PAGE_JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "MCP", re: /\bmcp\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "FIDO", re: /\bfido\b/i },
  { label: "TOTP", re: /\btotp\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "JWT", re: /\bjwt\b/i },
  { label: "attestation", re: /\battestation\b/i },
  { label: "assertion", re: /\bassertion\b/i },
  { label: "RP ID", re: /\brp id\b/i },
];

test("GET /signin renders the flow's first step: an accessibly-labelled email entry with a live control", async () => {
  const markup = await renderPage(SigninPage);

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
  assert.match(labelBlob, /email/i, `the first step must collect the email (begin-passkey needs it), got labels: "${labelBlob}"`);

  const live = actionableButtons(markup).filter((b) => b.name.trim().length > 0);
  assert.ok(
    live.length >= 1,
    `the first step must offer a live, named control to sign in (not a dead screen), got: ${markup}`,
  );
});

test("GET /signin offers the authenticator-app path on the first step", async () => {
  // "Use my authenticator app instead" — the person must be able to reach the code
  // method from the first screen (task E04-S25).
  const text = faceText(await renderPage(SigninPage));
  assert.match(
    text,
    /authenticator/i,
    `the first step must offer the authenticator-app path ("Use my authenticator app instead"), got: "${text}"`,
  );
});

test("GET /signin renders for a signed-out visitor and shows no protocol or security jargon", async () => {
  // The sign-in page must stay reachable by a signed-out visitor (outside any protected
  // route group) — rendering here, with no request scope or session, must not throw.
  let markup: string;
  try {
    markup = await renderPage(SigninPage);
  } catch (err) {
    assert.fail(
      "the sign-in page must render for a signed-out visitor — keep it outside any protected route group: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  const text = faceText(markup);
  assert.ok(text.length >= 8, `the sign-in entry must render a real screen for a signed-out visitor, got: "${text}"`);
  for (const { label, re } of PAGE_JARGON) {
    assert.ok(!re.test(text), `the sign-in screen must say what happens in plain words — found jargon "${label}" in: "${text}"`);
  }
});

// ── Review fix B6 — sign-in returns to where the person started (a safe `next`) ────────

function setupReturning(returnTo: string) {
  const { fetchImpl, calls, responders } = makeFetch();
  const start = makeStart();
  const navCalls: string[] = [];
  const flow = createSigninFlow({
    fetch: fetchImpl as typeof fetch,
    startAuthentication: start.fn,
    navigate: (path: string) => {
      navCalls.push(path);
    },
    returnTo,
  });
  return { flow, calls, responders, start, navCalls };
}

test("after a passkey or code sign-in the flow goes back to a safe return path", async () => {
  const next = "/oauth/authorize?client_id=c&state=s";

  const passkey = setupReturning(next);
  passkey.flow.setEmail(EMAIL);
  await passkey.flow.signInWithPasskey();
  assert.deepEqual(passkey.navCalls, [next], "the passkey sign-in returns to the authorize request");

  const code = setupReturning(next);
  await advanceToAuthenticator(code);
  code.flow.setCode(CODE);
  await code.flow.signInWithCode();
  assert.deepEqual(code.navCalls, [next], "the code sign-in returns to the authorize request");
});

test("an unsafe return path is ignored: the flow goes to /home", async () => {
  const ctx = setupReturning("//evil.example/steal");
  ctx.flow.setEmail(EMAIL);
  await ctx.flow.signInWithPasskey();
  assert.deepEqual(ctx.navCalls, ["/home"]);
});

test("the sign-in page passes a safe ?next= to the flow and drops an unsafe one", async () => {
  const render = async (next: unknown) =>
    renderToStaticMarkup(
      (await Promise.resolve(
        (SigninPage as (props: unknown) => unknown)({
          searchParams: Promise.resolve({ next }),
          params: Promise.resolve({}),
        }),
      )) as React.ReactElement,
    );
  const kept = await render("/a/AbC123");
  assert.ok(kept.includes("next=%2Fa%2FAbC123"), "the return path rides on the screen's links");
  const dropped = await render("https://evil.example");
  assert.ok(!dropped.includes("evil.example"), "an unsafe return path never reaches the page");
});

test("a pending passkey sign-in blocks repeated submissions, method changes and identity edits before a render", async () => {
  const begin = Promise.withResolvers<Response>();
  const finish = Promise.withResolvers<Response>();
  const calls: RecordedCall[] = [];
  const navCalls: string[] = [];
  const flow = createSigninFlow({
    fetch: (async (input, init) => {
      const url = String(input);
      const step = stepOf(url);
      calls.push({ step, url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return step === "begin-passkey" ? begin.promise : finish.promise;
    }) as typeof fetch,
    startAuthentication: makeStart().fn,
    navigate: (path) => { navCalls.push(path); },
  });
  flow.setEmail(EMAIL);
  const signingIn = flow.signInWithPasskey();
  void flow.signInWithPasskey();
  void flow.signInWithCode();
  flow.useAuthenticatorApp();
  flow.setEmail("different@example.com");
  flow.setCode("999999");
  assert.equal(flow.getState().busy, true);
  assert.equal(flow.getState().email, EMAIL);
  assert.equal(flow.getState().code, "");
  assert.equal(flow.getState().phase, "passkey");
  assert.deepEqual(calls.map((call) => call.step), ["begin-passkey"]);
  begin.resolve(jsonResponse(200, { options: AUTH_OPTIONS }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(flow.getState().busy, true, "the finish request is still pending");
  assert.deepEqual(calls[1]?.body, { email: EMAIL, authenticationResponse: ASSERTION });
  finish.resolve(jsonResponse(200, { ok: true }));
  await signingIn;
  assert.equal(flow.getState().busy, false);
  assert.deepEqual(navCalls, ["/home"]);
});

test("failed and cancelled passkey sign-ins release the pending guard for a retry", async () => {
  const ctx = setup();
  ctx.flow.setEmail(EMAIL);
  ctx.responders["begin-passkey"] = () => { throw new Error("private transport detail"); };
  await ctx.flow.signInWithPasskey();
  assert.equal(ctx.flow.getState().busy, false);
  assert.ok(ctx.flow.getState().error);
  assert.ok(!ctx.flow.getState().error?.includes("private transport detail"));
  ctx.responders["begin-passkey"] = () => jsonResponse(200, { options: AUTH_OPTIONS });
  ctx.start.cancel();
  await ctx.flow.signInWithPasskey();
  assert.equal(ctx.flow.getState().busy, false);
  ctx.start.succeed();
  await ctx.flow.signInWithPasskey();
  assert.deepEqual(ctx.navCalls, ["/home"]);
});

test("the pending passkey view prevents identity and method edits and keeps its initiating button focusable", () => {
  const html = renderToStaticMarkup(<SigninView step="passkey" email={EMAIL} busy />);
  assert.match(html, /<input[^>]*disabled=""/);
  const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)];
  const primary = buttons.find((button) => button[1]?.includes('type="submit"'));
  assert.match(primary?.[1] ?? "", /aria-disabled="true"/);
  assert.doesNotMatch(primary?.[1] ?? "", /\sdisabled=""/);
  assert.match(primary?.[2] ?? "", /Signing in/);
  assert.match(buttons.find((button) => /authenticator/.test(button[2] ?? ""))?.[1] ?? "", /disabled=""/);
});
