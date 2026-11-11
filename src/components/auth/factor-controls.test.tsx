// E04-S37 — Security screen factor controls (src/components/auth/factor-controls.tsx).
//
// RED-first: src/components/auth/factor-controls.tsx does NOT exist yet, so importing
// `./factor-controls` throws and EVERY test in this file fails until the builder adds it.
// That absence is the entire point of test-first — do NOT implement anything to make
// these pass.
//
// Why this task exists (E04-S37): the security screen (E04-S15) LISTS a person's
// passkeys and recovery, but its "Add a passkey" and "Generate a new recovery code"
// controls render DISABLED ("coming soon") because nothing on the client drives the
// ceremonies. This component replaces those two dead controls with live ones:
//
//   Add a passkey:
//     beginAddPasskey()                                   (the screen's server action)
//       → { ok:false, reason:"step_up_required" }  →  offer "Confirm it's you" (see below)
//       → { ok:true, options }
//       → startRegistration({ optionsJSON: options })     (@simplewebauthn/browser)
//       → finishAddPasskey(registrationResponse)          (the screen's server action)
//       → report success in plain words
//
//   Generate a new recovery code:
//     regenerateRecovery()                                (the screen's server action)
//       → { ok:false, reason:"step_up_required" }  →  offer "Confirm it's you"
//       → { ok:true, code }  →  show the new code ONCE (never stored, never re-sent)
//
//   Confirm it's you (step-up), offered when a sensitive change is refused for a fresh
//   confirmation — in place of the old "sign out and back in" advice:
//     POST /api/auth/step-up/begin                        → keep { options }
//       → startAuthentication({ optionsJSON: options })   (@simplewebauthn/browser)
//       → POST /api/auth/step-up/finish { authenticationResponse }
//       → on success, resume the change that was refused (add passkey / new recovery code)
//
// ── How these tests stay honest (and runnable without a DOM) ──────────────────────────
// There is no jsdom / testing-library on this job and React component / E2E testing is a
// per-job ADR, so the interactive BEHAVIOUR is not driven through a rendered DOM. As the
// sibling sign-in/sign-up flows (E04-S24/E04-S25) do, the logic lives in a framework-free,
// injectable CONTROLLER (`createFactorControls`) that `factor-controls.tsx` exports
// alongside its `"use client"` component. These tests drive the controller directly with
// FAKE seams and assert what it DOES — which actions it calls and in what order, which
// step-up URLs it posts, what it forwards into the WebAuthn prompts, what it reports, and
// the one-time recovery code's handling — never the source text of the module. A later
// behaviour-preserving refactor stays green.
//
// Why the SERVER ACTIONS are injected (not fetched): "add a passkey" and "new recovery
// code" go through the SCREEN's own server actions (the E04-S15 `createSecurityActions`
// beginAddPasskey / finishAddPasskey / regenerateRecovery, wrapped by page.tsx and handed
// to this client component as props — server actions are the only callables a server page
// can pass across the client boundary). Only the step-up "Confirm it's you" round trip is
// a `fetch` to the E04-S36 HTTP endpoints. So the WebAuthn + fetch seams are the
// component's own client-side defaults (optional overrides for tests); the actions are
// required props.
//
// The contract the builder implements (exactly this), exported from `./factor-controls`:
//
//   createFactorControls(deps: {
//     // the screen's server actions (page.tsx passes these as props):
//     beginAddPasskey: () => Promise<{ ok:true; options } | { ok:false; reason:string }>;
//     finishAddPasskey: (response) => Promise<{ ok:true } | { ok:false; reason:string }>;
//     regenerateRecovery: () => Promise<{ ok:true; code:string } | { ok:false; reason:string }>;
//     // browser seams:
//     fetch: typeof fetch;                 // POSTs the step-up begin/finish endpoints
//     startRegistration: (opts: { optionsJSON }) => Promise<RegistrationResponseJSON>;
//     startAuthentication: (opts: { optionsJSON }) => Promise<AuthenticationResponseJSON>;
//     // (any FURTHER deps the component wires — a refresh, an onChange — must be OPTIONAL)
//   }): FactorControlsController
//
//   FactorControlsController = {
//     getState(): FactorControlsState;
//     addPasskey(): Promise<void>;            // beginAddPasskey → (confirm if needed) → ceremony → finishAddPasskey
//     generateRecoveryCode(): Promise<void>;  // regenerateRecovery → (confirm if needed) → show code once
//     confirm(): Promise<void>;               // the "Confirm it's you" action: step-up, then resume the refused change
//   }
//
//   FactorControlsState = {
//     notice?: { tone: "done" | "problem"; text: string };  // the plain-words outcome of the last action
//     confirmRequired: boolean;   // true when a change was refused for a fresh confirmation; the component then
//                                 // renders a "Confirm it's you" control (which calls confirm()) INSTEAD of
//                                 // advising a sign-out-and-back-in
//     recoveryCode?: string;      // the one shown-once new recovery code (never stored, never re-sent)
//   }
//
// AC3 (the /settings/security page renders the controls ENABLED) is proven by rendering
// the default-exported `FactorControls` component — the unit that replaces the disabled
// placeholders — with `react-dom/server` and reading the markup (the DB-backed security
// page loader is not unit-renderable, and a Next page may export only its framework
// fields). The jargon / "coming soon" absence checks are scoped to THIS component's own
// rendered output, never the whole app.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import FactorControls, { createFactorControls } from "./factor-controls";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────
// Distinct, JSON-safe sample values so an assertion proves the flow carried THROUGH the
// value it was given, not a constant.

// The passkey-registration options beginAddPasskey hands back and that the flow must
// forward VERBATIM into startRegistration (the add-passkey ceremony).
const ADD_OPTIONS = {
  challenge: "YWRkLXBhc3NrZXktY2hhbGxlbmdl",
  rp: { name: "Warthog", id: "warthog.com.au" },
  user: { id: "dXNlci1oYW5kbGU", name: "robin@example.com", displayName: "robin@example.com" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
  extensions: { prf: {} },
};

// The attestation startRegistration returns and that the flow must post VERBATIM as the
// argument to finishAddPasskey.
const ATTESTATION = {
  id: "bmV3LWNyZWRlbnRpYWwtaWQ",
  rawId: "bmV3LWNyZWRlbnRpYWwtaWQ",
  type: "public-key",
  response: {
    clientDataJSON: "Y2xpZW50LWRhdGEtYWRk",
    attestationObject: "YXR0ZXN0YXRpb24tb2JqZWN0LWFkZA",
  },
  clientExtensionResults: {},
};

// The step-up authentication options POST begin hands back and that the flow must forward
// VERBATIM into startAuthentication (the "Confirm it's you" prompt).
const STEPUP_OPTIONS = {
  challenge: "c3RlcC11cC1jaGFsbGVuZ2U",
  rpId: "warthog.com.au",
  timeout: 60000,
  userVerification: "required",
  allowCredentials: [{ id: "ZXhpc3RpbmctY3JlZGVudGlhbA", type: "public-key" }],
};

// The assertion startAuthentication returns and that the flow must post VERBATIM as
// `authenticationResponse` to POST /api/auth/step-up/finish.
const ASSERTION = {
  id: "ZXhpc3RpbmctY3JlZGVudGlhbA",
  rawId: "ZXhpc3RpbmctY3JlZGVudGlhbA",
  type: "public-key",
  response: {
    clientDataJSON: "Y2xpZW50LWRhdGEtc3RlcHVw",
    authenticatorData: "YXV0aGVudGljYXRvci1kYXRhLXN0ZXB1cA",
    signature: "c2lnbmF0dXJlLXN0ZXB1cA",
    userHandle: "dXNlci1oYW5kbGU",
  },
  clientExtensionResults: {},
};

// The fresh recovery code regenerateRecovery hands back. No "_" and no space, so the
// plain-English error scan (which forbids both) is unaffected by it, and it is distinctive
// enough to find in a request body or a storage write if it ever leaked.
const NEW_RECOVERY_CODE = "QX7K-2P4R-9ZTD-6WHF";

// ── A JSON Response helper ───────────────────────────────────────────────────────────
function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── A programmable, recording fake WebAuthn seam (startRegistration / startAuthentication)
// Each records every call (so we can assert the options forwarded) and pushes an ordered
// event so a cross-seam sequence can be asserted. `cancel()` models a dismissed OS prompt.
function makeWebAuthn(label: string, result: unknown, events: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: any[] = [];
  let behaviour: () => Promise<unknown> = async () => result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = async (opts: { optionsJSON: any; [k: string]: unknown }) => {
    calls.push(opts);
    events.push(label); // the prompt opened — recorded even if the person then dismisses it
    return behaviour();
  };
  return {
    fn,
    calls,
    succeed() {
      behaviour = async () => result;
    },
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

// ── The test harness ──────────────────────────────────────────────────────────────────
// A single ORDERED `events` log records every action call, every step-up POST and every
// WebAuthn prompt, so a test can assert the end-to-end choreography across seams.
//
// `env.stepUp` models the server's step-up freshness: the screen's sensitive actions
// (beginAddPasskey / regenerateRecovery) refuse with `step_up_required` while it is false,
// and the step-up finish endpoint RECORDS a step-up (flips it true) on success — exactly
// as the real session does — so a confirm genuinely unblocks the refused change.

type FetchCall = { step: "begin" | "finish"; url: string; method: string; body: unknown };

function setup(opts: { stepUp?: boolean } = {}) {
  const env = { stepUp: opts.stepUp ?? false };
  const events: string[] = [];

  // The screen's server actions (what page.tsx passes as props), programmable + recording.
  const finishAddPasskeyArgs: unknown[] = [];
  let beginResult: null | (() => unknown) = null; // test override; default reads env.stepUp
  let finishResult: () => unknown = () => ({ ok: true });
  let regenerateResult: null | (() => unknown) = null; // default reads env.stepUp

  const actions = {
    beginAddPasskey: async () => {
      events.push("beginAddPasskey");
      return (beginResult ?? (() => (env.stepUp ? { ok: true, options: ADD_OPTIONS } : { ok: false, reason: "step_up_required" })))();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    finishAddPasskey: async (response: any) => {
      events.push("finishAddPasskey");
      finishAddPasskeyArgs.push(response);
      return finishResult();
    },
    regenerateRecovery: async () => {
      events.push("regenerateRecovery");
      return (regenerateResult ?? (() => (env.stepUp ? { ok: true, code: NEW_RECOVERY_CODE } : { ok: false, reason: "step_up_required" })))();
    },
  };

  // The step-up HTTP endpoints (the only `fetch` the component makes).
  const fetchCalls: FetchCall[] = [];
  let finishStatus = 200; // test override to force a refused confirmation
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.includes("/api/auth/step-up/begin")) {
      events.push("stepup:begin");
      fetchCalls.push({ step: "begin", url, method, body });
      return jsonResponse(200, { options: STEPUP_OPTIONS });
    }
    if (url.includes("/api/auth/step-up/finish")) {
      events.push("stepup:finish");
      fetchCalls.push({ step: "finish", url, method, body });
      if (finishStatus === 200) {
        env.stepUp = true; // the server recorded a step-up; the refused change now succeeds
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(finishStatus, { error: "invalid_assertion" });
    }
    throw new Error(`the factor controls posted to an unexpected URL: ${url}`);
  };

  const reg = makeWebAuthn("startRegistration", ATTESTATION, events);
  const auth = makeWebAuthn("startAuthentication", ASSERTION, events);

  const flow = createFactorControls({
    beginAddPasskey: actions.beginAddPasskey,
    finishAddPasskey: actions.finishAddPasskey,
    regenerateRecovery: actions.regenerateRecovery,
    fetch: fetchImpl as typeof fetch,
    startRegistration: reg.fn,
    startAuthentication: auth.fn,
  });

  return {
    flow,
    env,
    events,
    fetchCalls,
    reg,
    auth,
    finishAddPasskeyArgs,
    setBeginResult(fn: () => unknown) {
      beginResult = fn;
    },
    setFinishResult(fn: () => unknown) {
      finishResult = fn;
    },
    setRegenerateResult(fn: () => unknown) {
      regenerateResult = fn;
    },
    setStepUpFinishStatus(status: number) {
      finishStatus = status;
    },
  };
}

// ── Plain-English outcome copy ─────────────────────────────────────────────────────────
// Every outcome a person sees must read as plain Australian English — a real sentence,
// never a raw machine code (the server speaks `step_up_required`, `not_found`,
// `bad_attestation`, …) and never protocol / security jargon. "passkey", "recovery code"
// and "confirm" are the brief's OWN plain vocabulary and are expected, not jargon.
const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "FIDO", re: /\bfido\b/i },
  { label: "TOTP", re: /\btotp\b/i },
  { label: "attestation", re: /\battestation\b/i },
  { label: "assertion", re: /\bassertion\b/i },
  { label: "step-up", re: /\bstep[-\s]?up\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "JWT", re: /\bjwt\b/i },
  { label: "4xx", re: /\b4\d\d\b/ },
];

function assertPlainEnglish(message: unknown, ctx: string): asserts message is string {
  assert.equal(typeof message, "string", `${ctx}: expected plain-English copy, got ${typeof message}`);
  const text = (message as string).trim();
  assert.ok(text.length >= 8, `${ctx}: copy must be a real message a person can read, got: "${text}"`);
  assert.ok(/\s/.test(text), `${ctx}: copy must read as words, not a single machine token, got: "${text}"`);
  assert.ok(!/_/.test(text), `${ctx}: copy must not be a raw machine code (snake_case), got: "${text}"`);
  for (const { label, re } of JARGON) {
    assert.ok(!re.test(text), `${ctx}: copy must avoid jargon "${label}", got: "${text}"`);
  }
}

// The step-up notice must OFFER "Confirm it's you" — not the old E04-S15 advice to sign
// out and back in. So its copy must not carry that sign-out-and-back-in instruction.
const SIGN_OUT_ADVICE: { label: string; re: RegExp }[] = [
  { label: "sign out", re: /\bsign(?:ing)? out\b/i },
  { label: "signed out", re: /\bsigned out\b/i },
  { label: "sign back in", re: /\bsign back in\b/i },
  { label: "sign in again", re: /\bsign in again\b/i },
  { label: "five minutes", re: /\bfive minutes\b/i },
];

function assertNoSignOutAdvice(text: string, ctx: string): void {
  for (const { label, re } of SIGN_OUT_ADVICE) {
    assert.ok(
      !re.test(text),
      `${ctx}: the confirm notice must offer "Confirm it's you", not the old sign-out advice — found "${label}" in: "${text}"`,
    );
  }
}

function noticeOf(ctx: ReturnType<typeof setup>) {
  return ctx.flow.getState().notice;
}

// ════════════════════════════════════════════════════════════════════════════════════
// AC1 — Add a passkey: confirm (when required) then begin and finish, success in plain
// words; a cancelled prompt offers a retry.
// ════════════════════════════════════════════════════════════════════════════════════

test("a fresh controls starts idle: nothing reported, no confirm offered, no requests, no prompts", () => {
  const ctx = setup({ stepUp: true });
  const s = ctx.flow.getState();
  assert.ok(!s.notice, "no outcome is reported before anything is done");
  assert.equal(s.confirmRequired, false, "no confirm is offered before a change is refused");
  assert.equal(s.recoveryCode, undefined, "no recovery code is shown before one is generated");
  assert.deepEqual(ctx.events, [], "constructing the controls runs no actions, posts nothing, opens no prompt");
});

test("adding a passkey with a fresh confirmation runs begin → ceremony → finish and reports success (no step-up)", async () => {
  const ctx = setup({ stepUp: true }); // a fresh confirmation already on the session

  await ctx.flow.addPasskey();

  assert.deepEqual(
    ctx.events,
    ["beginAddPasskey", "startRegistration", "finishAddPasskey"],
    "with a fresh confirmation, add-passkey goes begin → registration ceremony → finish, in order",
  );
  // The step-up endpoints are NOT touched when no confirmation is required.
  assert.deepEqual(ctx.fetchCalls, [], "no step-up confirmation is needed, so nothing is posted to the step-up endpoints");

  // The options from begin are forwarded VERBATIM into the OS registration prompt...
  assert.deepEqual(
    ctx.reg.calls.map((c) => c.optionsJSON),
    [ADD_OPTIONS],
    "startRegistration must be driven once with the options beginAddPasskey returned",
  );
  // ...and the attestation it produced is posted VERBATIM to finishAddPasskey.
  assert.deepEqual(
    ctx.finishAddPasskeyArgs,
    [ATTESTATION],
    "finishAddPasskey must receive exactly what startRegistration returned",
  );

  const s = ctx.flow.getState();
  assert.equal(s.confirmRequired, false, "a completed add-passkey offers no confirm");
  assert.ok(s.notice, "the outcome is reported, never silent");
  assert.equal(s.notice!.tone, "done", "a successful add-passkey reports success");
  assertPlainEnglish(s.notice!.text, "add-passkey success");
});

test("adding a passkey when a confirmation is required offers 'Confirm it's you', then confirm resumes begin → ceremony → finish", async () => {
  const ctx = setup({ stepUp: false }); // no fresh confirmation yet

  // First attempt: the screen refuses for a fresh confirmation. The controls must STOP —
  // offer confirm — not drive the registration prompt or the step-up endpoints itself.
  await ctx.flow.addPasskey();

  let s = ctx.flow.getState();
  assert.deepEqual(ctx.events, ["beginAddPasskey"], "a refused begin must not run the ceremony or auto-confirm");
  assert.equal(ctx.reg.calls.length, 0, "a refused begin must not open the registration prompt");
  assert.deepEqual(ctx.fetchCalls, [], "the step-up endpoints are driven by the person's Confirm it's you, not by addPasskey itself");
  assert.equal(s.confirmRequired, true, "a step_up_required refusal must offer the Confirm it's you control");
  assert.ok(s.notice, "the refusal is reported in words, never silent");
  assert.notEqual(s.notice!.text, "step_up_required", "the raw server reason must not be shown to the person");
  assertPlainEnglish(s.notice!.text, "confirm-required notice");
  assertNoSignOutAdvice(s.notice!.text, "confirm-required notice");

  // The person clicks "Confirm it's you": the step-up round trip, then the change resumes.
  await ctx.flow.confirm();

  assert.deepEqual(
    ctx.events,
    [
      "beginAddPasskey", // the refused first attempt
      "stepup:begin",
      "startAuthentication",
      "stepup:finish",
      "beginAddPasskey", // resumed, now permitted
      "startRegistration",
      "finishAddPasskey",
    ],
    "confirm runs the step-up (begin → prompt → finish) then resumes the refused add-passkey (begin → ceremony → finish)",
  );

  // The confirm prompt forwarded the step-up options verbatim and posted the assertion.
  assert.deepEqual(
    ctx.auth.calls.map((c) => c.optionsJSON),
    [STEPUP_OPTIONS],
    "startAuthentication must be driven with the options the step-up begin returned",
  );
  const finishPost = ctx.fetchCalls.find((c) => c.step === "finish");
  assert.ok(finishPost, "the step-up finish must be posted");
  assert.equal(finishPost!.method, "POST", "the step-up finish must be a POST");
  assert.deepEqual(
    (finishPost!.body as { authenticationResponse: unknown }).authenticationResponse,
    ASSERTION,
    "the step-up finish must carry the assertion startAuthentication produced, as authenticationResponse",
  );

  // The resumed ceremony still forwards begin's options and the attestation verbatim.
  assert.deepEqual(ctx.reg.calls.map((c) => c.optionsJSON), [ADD_OPTIONS], "the resumed ceremony uses beginAddPasskey's options");
  assert.deepEqual(ctx.finishAddPasskeyArgs, [ATTESTATION], "the resumed finish receives the attestation");

  s = ctx.flow.getState();
  assert.equal(s.confirmRequired, false, "a completed confirm-then-add clears the confirm offer");
  assert.equal(s.notice!.tone, "done", "the resumed add-passkey reports success");
  assertPlainEnglish(s.notice!.text, "confirm-then-add success");
});

test("a cancelled passkey prompt stays put, posts no finish, reports plainly, and can be retried", async () => {
  const ctx = setup({ stepUp: true });

  // The person dismisses the OS registration prompt — startRegistration rejects.
  ctx.reg.cancel();
  await ctx.flow.addPasskey();

  let s = ctx.flow.getState();
  assert.deepEqual(ctx.events, ["beginAddPasskey", "startRegistration"], "a cancelled prompt stops before finish");
  assert.equal(ctx.finishAddPasskeyArgs.length, 0, "a cancelled prompt must not post the passkey to finishAddPasskey");
  assert.ok(s.notice, "a cancelled prompt is reported, never silent");
  assert.equal(s.notice!.tone, "problem", "a cancelled prompt reports a problem, not success");
  assertPlainEnglish(s.notice!.text, "cancelled add-passkey"); // the retry affordance is the message + a live control

  // The retry works: a fresh attempt completes and the problem clears.
  ctx.reg.succeed();
  await ctx.flow.addPasskey();
  s = ctx.flow.getState();
  assert.ok(ctx.finishAddPasskeyArgs.length === 1, "retrying the prompt posts the passkey to finishAddPasskey");
  assert.equal(s.notice!.tone, "done", "a successful retry reports success");
  assert.deepEqual(ctx.finishAddPasskeyArgs, [ATTESTATION], "the retry forwards the attestation verbatim");
});

test("a refused finishAddPasskey reports the problem in plain words and never claims success", async () => {
  // Never fail silently: if the server rejects the attestation, the person is told plainly
  // and the control does not report a success it did not achieve.
  const ctx = setup({ stepUp: true });
  ctx.setFinishResult(() => ({ ok: false, reason: "bad_attestation" }));

  await ctx.flow.addPasskey();

  const s = ctx.flow.getState();
  assert.deepEqual(ctx.events, ["beginAddPasskey", "startRegistration", "finishAddPasskey"], "the ceremony runs, then finish refuses");
  assert.ok(s.notice, "a refused finish is reported, never silent");
  assert.equal(s.notice!.tone, "problem", "a refused finish must not be reported as a success");
  assert.notEqual(s.notice!.text, "bad_attestation", "the raw server reason must not be shown to the person");
  assertPlainEnglish(s.notice!.text, "refused finish");
});

// ════════════════════════════════════════════════════════════════════════════════════
// AC2 — Generate a new recovery code: show it once, never store it in the browser, report
// success in plain words.
// ════════════════════════════════════════════════════════════════════════════════════

test("generating a new recovery code with a fresh confirmation shows the new code and reports success (no step-up)", async () => {
  const ctx = setup({ stepUp: true });

  await ctx.flow.generateRecoveryCode();

  assert.deepEqual(ctx.events, ["regenerateRecovery"], "with a fresh confirmation, generate goes straight to the server action");
  assert.deepEqual(ctx.fetchCalls, [], "no confirmation is needed, so the step-up endpoints are untouched");

  const s = ctx.flow.getState();
  assert.equal(s.recoveryCode, NEW_RECOVERY_CODE, "the new recovery code is shown once");
  assert.equal(s.confirmRequired, false, "a completed generate offers no confirm");
  assert.ok(s.notice, "the outcome is reported, never silent");
  assert.equal(s.notice!.tone, "done", "a successful generate reports success");
  assertPlainEnglish(s.notice!.text, "generate-recovery success");
});

test("the new recovery code is shown once and never leaves the browser (not stored, not re-sent)", async () => {
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
    const ctx = setup({ stepUp: true });
    await ctx.flow.generateRecoveryCode();

    assert.equal(ctx.flow.getState().recoveryCode, NEW_RECOVERY_CODE, "the code is shown once in state");

    // Never written to browser storage.
    for (const w of [...local.writes, ...session.writes]) {
      assert.ok(
        !String(w.value).includes(NEW_RECOVERY_CODE) && !String(w.key).includes(NEW_RECOVERY_CODE),
        `the recovery code must never be written to browser storage, write: ${w.key}=${w.value}`,
      );
    }
    // Never sent back out: it appears in no request body.
    for (const c of ctx.fetchCalls) {
      const serialized = JSON.stringify(c.body ?? {});
      assert.ok(
        !serialized.includes(NEW_RECOVERY_CODE),
        `step "${c.step}" must not send the recovery code anywhere, body: ${serialized}`,
      );
    }
  } finally {
    if (hadLocal) g.localStorage = origLocal;
    else delete g.localStorage;
    if (hadSession) g.sessionStorage = origSession;
    else delete g.sessionStorage;
  }
});

test("generating a new recovery code when a confirmation is required offers confirm, then confirm resumes to show the code once", async () => {
  const ctx = setup({ stepUp: false });

  await ctx.flow.generateRecoveryCode();

  let s = ctx.flow.getState();
  assert.deepEqual(ctx.events, ["regenerateRecovery"], "a refused generate must not auto-confirm");
  assert.equal(s.recoveryCode, undefined, "a refused generate shows no code");
  assert.equal(s.confirmRequired, true, "a step_up_required refusal offers the Confirm it's you control");
  assertPlainEnglish(s.notice!.text, "generate confirm-required notice");
  assertNoSignOutAdvice(s.notice!.text, "generate confirm-required notice");

  await ctx.flow.confirm();

  assert.deepEqual(
    ctx.events,
    ["regenerateRecovery", "stepup:begin", "startAuthentication", "stepup:finish", "regenerateRecovery"],
    "confirm runs the step-up then resumes the refused generate",
  );
  s = ctx.flow.getState();
  assert.equal(s.recoveryCode, NEW_RECOVERY_CODE, "the resumed generate shows the new code once");
  assert.equal(s.confirmRequired, false, "a completed confirm-then-generate clears the confirm offer");
  assert.equal(s.notice!.tone, "done", "the resumed generate reports success");
  assertPlainEnglish(s.notice!.text, "confirm-then-generate success");
});

// ════════════════════════════════════════════════════════════════════════════════════
// Confirm it's you (step-up) — the "Confirm it's you" action uses the step-up endpoints,
// and its own failures are reported plainly without resuming or claiming success.
// ════════════════════════════════════════════════════════════════════════════════════

test("Confirm it's you posts begin then finish to the step-up endpoints with the assertion between the prompts", async () => {
  const ctx = setup({ stepUp: false });
  await ctx.flow.addPasskey(); // refused → confirm offered

  await ctx.flow.confirm();

  const posts = ctx.fetchCalls;
  assert.deepEqual(
    posts.map((c) => c.step),
    ["begin", "finish"],
    "Confirm it's you posts the step-up begin then finish, in order",
  );
  for (const c of posts) assert.equal(c.method, "POST", `the step-up ${c.step} must be a POST`);
  assert.equal(ctx.auth.calls.length, 1, "the confirm passkey prompt runs exactly once per attempt");
  assert.deepEqual(ctx.auth.calls[0]!.optionsJSON, STEPUP_OPTIONS, "startAuthentication gets the begin options");
});

test("a confirm whose step-up is refused reports plainly, does not resume the change, and keeps offering confirm", async () => {
  const ctx = setup({ stepUp: false });
  await ctx.flow.addPasskey(); // refused → confirm offered
  ctx.setStepUpFinishStatus(401); // the server rejects the step-up assertion

  await ctx.flow.confirm();

  assert.deepEqual(
    ctx.events,
    ["beginAddPasskey", "stepup:begin", "startAuthentication", "stepup:finish"],
    "a refused step-up must not resume the add-passkey (no second begin, no ceremony)",
  );
  assert.equal(ctx.reg.calls.length, 0, "a refused step-up must not run the registration ceremony");
  const s = ctx.flow.getState();
  assert.equal(s.confirmRequired, true, "a refused confirm keeps offering Confirm it's you for another try");
  assert.equal(s.notice!.tone, "problem", "a refused confirm reports a problem, not success");
  assertPlainEnglish(s.notice!.text, "refused confirm");
});

test("a cancelled Confirm it's you prompt posts no finish, reports plainly, and can be retried", async () => {
  const ctx = setup({ stepUp: false });
  await ctx.flow.addPasskey(); // refused → confirm offered

  // The person dismisses the OS confirm prompt — startAuthentication rejects.
  ctx.auth.cancel();
  await ctx.flow.confirm();

  let s = ctx.flow.getState();
  assert.ok(
    !ctx.fetchCalls.some((c) => c.step === "finish"),
    "a cancelled confirm prompt must not post the step-up finish",
  );
  assert.equal(ctx.reg.calls.length, 0, "a cancelled confirm must not run the add-passkey ceremony");
  assert.equal(s.confirmRequired, true, "a cancelled confirm keeps the Confirm it's you offer for a retry");
  assert.equal(s.notice!.tone, "problem", "a cancelled confirm reports a problem, never silent");
  assertPlainEnglish(s.notice!.text, "cancelled confirm");

  // Retry succeeds end to end: the step-up completes and the add-passkey resumes.
  ctx.auth.succeed();
  await ctx.flow.confirm();
  s = ctx.flow.getState();
  assert.ok(ctx.fetchCalls.some((c) => c.step === "finish"), "the retried confirm posts the step-up finish");
  assert.deepEqual(ctx.finishAddPasskeyArgs, [ATTESTATION], "the retried confirm resumes the add-passkey through to finish");
  assert.equal(s.confirmRequired, false, "a successful retry clears the confirm offer");
  assert.equal(s.notice!.tone, "done", "a successful retry reports success");
});

// ════════════════════════════════════════════════════════════════════════════════════
// AC3 — the /settings/security page renders the controls ENABLED (not the disabled
// "coming soon" placeholders), in plain words, on the design-system components.
// Proven by rendering the component the page mounts — see the header note on why the
// DB-backed page loader itself is not unit-renderable.
// ════════════════════════════════════════════════════════════════════════════════════

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

// An actionable native <button> is one NOT carrying the native `disabled` attribute (React
// renders a truthy boolean `disabled` prop as `disabled=""`). Matching the ATTRIBUTE
// (never a Tailwind `disabled:` class) proves a genuinely live control.
function actionableButtons(markup: string): { name: string; attrs: string }[] {
  return findAll(markup, "button")
    .filter((b) => !/\bdisabled=""/i.test(b.attrs))
    .map((b) => ({ name: visibleText(b.inner) || attr(b.attrs, "aria-label") || "", attrs: b.attrs }));
}

function disabledButtonNames(markup: string): string[] {
  return findAll(markup, "button")
    .filter((b) => /\bdisabled=""/i.test(b.attrs))
    .map((b) => visibleText(b.inner) || attr(b.attrs, "aria-label") || "");
}

// Render the component the security page mounts, with the screen's server actions supplied
// as the fake props page.tsx would pass (the browser seams are the component's own
// defaults — the page cannot pass them across the client boundary).
function renderControls(): string {
  const props = {
    beginAddPasskey: async () => ({ ok: true as const, options: ADD_OPTIONS }),
    finishAddPasskey: async () => ({ ok: true as const }),
    regenerateRecovery: async () => ({ ok: true as const, code: NEW_RECOVERY_CODE }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return renderToStaticMarkup(React.createElement(FactorControls as any, props as any));
}

test("the security controls render ENABLED — a live Add-a-passkey and a live Generate-a-new-recovery-code (not 'coming soon')", () => {
  const markup = renderControls();
  const live = actionableButtons(markup).map((b) => b.name);

  assert.ok(
    live.some((n) => /passkey/i.test(n)),
    `an enabled "Add a passkey" control must render, got live controls: ${JSON.stringify(live)}`,
  );
  assert.ok(
    live.some((n) => /recovery/i.test(n)),
    `an enabled "Generate a new recovery code" control must render, got live controls: ${JSON.stringify(live)}`,
  );

  // The old placeholders are gone: neither control may be a disabled "coming soon" button.
  const disabledNames = disabledButtonNames(markup);
  assert.ok(
    !disabledNames.some((n) => /passkey|recovery/i.test(n)),
    `the passkey / recovery controls must be enabled, not disabled placeholders, got disabled: ${JSON.stringify(disabledNames)}`,
  );
  assert.doesNotMatch(
    visibleText(markup),
    /coming soon/i,
    "the controls are live now — no 'coming soon' dead copy on this component",
  );
});

test("the security controls render in plain words with no protocol or security jargon", () => {
  const markup = renderControls();
  const text = visibleText(markup);
  assert.ok(text.length >= 8, `the controls must render real, readable copy, got: "${text}"`);
  for (const { label, re } of JARGON) {
    assert.ok(!re.test(text), `the controls must speak plainly — found jargon "${label}" in: "${text}"`);
  }
});

test("a shared authenticator confirmation resumes only the pending security change once", async () => {
  const { flow, env, events } = setup();
  await flow.generateRecoveryCode();
  assert.equal(flow.getState().confirmRequired, true);
  env.stepUp = true; // shared confirmation endpoint has authenticated this session
  await flow.resumeAfterConfirmation();
  await flow.resumeAfterConfirmation();
  assert.equal(flow.getState().confirmRequired, false);
  assert.equal(flow.getState().recoveryCode, NEW_RECOVERY_CODE);
  assert.equal(events.filter((event) => event === "regenerateRecovery").length, 2);
  assert.ok(!events.includes("startAuthentication"));
});

test("recovery generation serializes repeated and competing actions before a render", async () => {
  const ctx = setup({ stepUp: true });
  const pending = Promise.withResolvers<unknown>();
  ctx.setRegenerateResult(() => pending.promise);
  const generating = ctx.flow.generateRecoveryCode();
  void ctx.flow.generateRecoveryCode();
  void ctx.flow.addPasskey();
  void ctx.flow.confirm();
  assert.equal(ctx.flow.getState().busy, true);
  assert.deepEqual(ctx.events, ["regenerateRecovery"]);
  pending.resolve({ ok: true, code: NEW_RECOVERY_CODE });
  await generating;
  assert.equal(ctx.flow.getState().busy, false);
  assert.equal(ctx.flow.getState().recoveryCode, NEW_RECOVERY_CODE);
});

test("replacing a recovery code clears the old output even when the action loses its response", async () => {
  const ctx = setup({ stepUp: true });
  await ctx.flow.generateRecoveryCode();
  assert.equal(ctx.flow.getState().recoveryCode, NEW_RECOVERY_CODE);
  const pending = Promise.withResolvers<unknown>();
  ctx.setRegenerateResult(() => pending.promise);
  const generating = ctx.flow.generateRecoveryCode();
  assert.equal(ctx.flow.getState().recoveryCode, undefined);
  pending.reject(new Error("private database detail"));
  await assert.doesNotReject(generating);
  assert.equal(ctx.flow.getState().recoveryCode, undefined);
  assert.equal(ctx.flow.getState().busy, false);
  assert.equal(ctx.flow.getState().notice?.tone, "problem");
  assert.ok(!ctx.flow.getState().notice?.text.includes("private database detail"));
  ctx.setRegenerateResult(() => ({ ok: true, code: "REPLACEMENT-CODE" }));
  await ctx.flow.generateRecoveryCode();
  assert.equal(ctx.flow.getState().recoveryCode, "REPLACEMENT-CODE");
});

test("passkey registration stays exclusive through begin and finish and can retry a lost server response", async () => {
  const ctx = setup({ stepUp: true });
  const begin = Promise.withResolvers<unknown>();
  const finish = Promise.withResolvers<unknown>();
  ctx.setBeginResult(() => begin.promise);
  ctx.setFinishResult(() => finish.promise);
  const adding = ctx.flow.addPasskey();
  void ctx.flow.addPasskey();
  assert.equal(ctx.flow.getState().busy, true);
  assert.deepEqual(ctx.events, ["beginAddPasskey"]);
  begin.resolve({ ok: true, options: ADD_OPTIONS });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await ctx.flow.generateRecoveryCode();
  assert.equal(ctx.flow.getState().busy, true);
  assert.deepEqual(ctx.events, ["beginAddPasskey", "startRegistration", "finishAddPasskey"]);
  finish.reject(new Error("private transport detail"));
  await assert.doesNotReject(adding);
  assert.equal(ctx.flow.getState().busy, false);
  assert.equal(ctx.flow.getState().notice?.tone, "problem");
  assert.ok(!ctx.flow.getState().notice?.text.includes("private transport detail"));
  ctx.setFinishResult(() => ({ ok: true }));
  await ctx.flow.addPasskey();
  assert.equal(ctx.flow.getState().notice?.tone, "done");
});

test("a rejected passkey begin reports a safe error and releases the busy guard", async () => {
  const ctx = setup({ stepUp: true });
  ctx.setBeginResult(() => { throw new Error("private server detail"); });
  await assert.doesNotReject(ctx.flow.addPasskey());
  assert.equal(ctx.flow.getState().busy, false);
  assert.equal(ctx.flow.getState().notice?.tone, "problem");
  assert.ok(!ctx.flow.getState().notice?.text.includes("private server detail"));
});

test("confirmation resumes the requested change once while keeping the whole operation exclusive", async () => {
  const ctx = setup();
  await ctx.flow.generateRecoveryCode();
  const pending = Promise.withResolvers<unknown>();
  ctx.setRegenerateResult(() => pending.promise);
  const confirming = ctx.flow.confirm();
  void ctx.flow.confirm();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await ctx.flow.resumeAfterConfirmation();
  await ctx.flow.generateRecoveryCode();
  assert.equal(ctx.flow.getState().busy, true);
  assert.equal(ctx.events.filter((event) => event === "stepup:begin").length, 1);
  assert.equal(ctx.events.filter((event) => event === "regenerateRecovery").length, 2);
  pending.resolve({ ok: true, code: NEW_RECOVERY_CODE });
  await confirming;
  assert.equal(ctx.flow.getState().busy, false);
  assert.equal(ctx.flow.getState().confirmRequired, false);
  assert.equal(ctx.flow.getState().recoveryCode, NEW_RECOVERY_CODE);
});
