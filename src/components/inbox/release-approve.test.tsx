// E11-S17 — Approve and release: the on-device card / high-tier release control
// (src/components/inbox/release-approve.tsx).
//
// RED-first: src/components/inbox/release-approve.tsx does NOT exist yet, so importing
// `./release-approve` throws and EVERY test in this file fails until the builder adds the
// component. That absence is the entire point of test-first — do NOT implement anything
// to make these pass.
//
// WHY this component exists (brief "High-tier release" / "Card requests"; design §4.2
// "Release"; constitution 17 "no readable card numbers or security codes on Warthog's
// side" + 18 "approvals only inside the signed-in app"): the inbox renders a card /
// high-tier release's "Approve and release" DISABLED with a reason today, because its
// on-device flow was never wired — a signed-in server page cannot hand a React client a
// callback. This task adds the self-wired CLIENT control that, on this device, unlocks
// the vault key (passkey PRF, or a passphrase), decrypts the chosen saved card number or
// the requested high-tier value LOCALLY (the existing `src/client/vault` modules), and
// posts it to the existing approval release endpoint so the agent collects it once
// (collect_release). The plaintext never reaches the server except in that one-time
// release (design §4.2: only ciphertext at rest server-side).
//
// This file pins the TWO seams `release-approve.tsx` exports, exactly mirroring the
// repo's established split for a screen that is both render-testable AND interactive
// (SignupView + createSignupFlow; SigninView + createSigninFlow; InboxView +
// createReleaseFlow):
//
//   1. ReleaseApprove — the client control InboxView mounts for a card / high-tier
//      release. It renders (for a card) the sensitive-moment explainer, the saved-card
//      picker and the security-code field; (for high-tier) the explainer alone; and a
//      LIVE control that runs the device hand-over. It is a Client Component in the app,
//      render-tested here with `react-dom/server` (no DOM/jsdom — React component / E2E
//      testing is a per-job ADR), exactly like every other component render test.
//
//   2. createReleaseApproveFlow(deps) — the framework-free, injectable controller behind
//      the LIVE control (like createSignupFlow / createSigninFlow). The interactive
//      behaviour — choose the card, enter the code, gather the unlock material by the
//      chosen method, then run the unlock → decrypt → post hand-over — is tested by
//      DRIVING THE CONTROLLER with fake seams and asserting what it DOES, never the
//      source text of the module.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the control RENDERS for its props, and what the
//     controller DOES for its inputs — never the source text of release-approve.tsx. A
//     later behaviour-preserving refactor (reworded-but-still-plain copy, different
//     wrappers, extra classes, a different icon, composing a UI primitive) stays green.
//   * The device-decrypt-and-post core (createReleaseFlow) is already pinned by
//     inbox-view.test.tsx; this controller REUSES it through an injected `releaseFlow`
//     seam, so these tests never re-prove the unlock → decrypt → post internals — they
//     prove this control chooses the RIGHT card, carries the entered code, uses the
//     RIGHT unlock method, and handles a cancel / a wrong passphrase in plain words.
//   * Absence checks ("a high-tier release has no card picker / no security-code field",
//     "nothing is released on a cancel") are scoped to the EXACT unit under test — one
//     release rendered / driven alone — never a whole-output text scan.
//
// ─── the contract this task introduces (documented here as the cross-task contract) ───
//
//   createReleaseApproveFlow(deps: {
//     request: PendingRequestView;              // the card / high_tier release being decided
//     approvalId?: string;                      // the approval to release for (defaults to request.id)
//     savedCards?: readonly SavedCardView[];    // a card release's picker cards
//     highTierCiphertext?: string;              // a high_tier release's stored value ciphertext
//     releaseFlow: ReleaseFlow;                 // createReleaseFlow core: unlock → decrypt → post
//     // Gather the opaque unlock material by the chosen method. The component wires these
//     // to the real client/vault derivations (passphrase → PBKDF2; passkey → a WebAuthn
//     // PRF assertion). Each returns the UnlockRequest releaseFlow consumes; a cancelled
//     // passkey prompt (or an unusable passphrase) REJECTS → nothing released, plain copy.
//     unlockByPassphrase: (passphrase: string) => UnlockRequest | Promise<UnlockRequest>;
//     unlockByPasskey: () => Promise<UnlockRequest>;
//     onChange?: () => void;                    // re-render notifier (the component wires it)
//     onReleased?: () => void;                  // called once on a completed release
//   }): ReleaseApproveController
//
//   ReleaseApproveController = {
//     getState(): ReleaseApproveState;          // a snapshot the component renders from
//     setMethod(method: "passkey" | "passphrase"): void;
//     setPassphrase(value: string): void;
//     setCardId(cardId: string): void;
//     setSecurityCode(value: string): void;
//     submit(): Promise<void>;                  // gather unlock → releaseFlow.release → success / error
//   }
//
//   ReleaseApproveState = {
//     method: "passkey" | "passphrase"; passphrase: string; cardId?: string;
//     securityCode: string; error?: string; /* plus the control's own status */
//   }

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ReleaseApprove, createReleaseApproveFlow } from "./release-approve";
import type {
  PendingRequestView,
  SavedCardView,
  ReleaseFlow,
  ReleaseInput,
  ReleaseResult,
} from "./inbox-view";
import type { UnlockRequest } from "@/client/vault/unlock";

// ─── fixtures ────────────────────────────────────────────────────────────────────────
//
// Hex-free content (so the raw-hex scan can only catch a hard-coded colour) with distinct
// marker phrases per field. No fixture copy contains an explainer phrase, a decision-
// control word, or a sensitive marker, so a presence / absence assertion can only be
// satisfied by the thing it targets.

// A card release — takes the device unlock-decrypt-release Approve path.
const PENDING_CARD: PendingRequestView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agent: "Claude",
  sentence: "wants to use a card to pay the ferry fare",
  details: [
    { label: "To", value: "Harbour Ferries" },
    { label: "Amount", value: "forty-two dollars" },
    { label: "Using", value: "a saved card" },
  ],
  reason: "the weekend ferry pass is due now",
  rule: "Ask me when an agent wants a card",
  timeLeft: "four minutes left",
  release: "card",
};

// A high-tier identity release — device Approve path, but NO card picker and NO security
// code ("where relevant" means cards only).
const PENDING_HIGH: PendingRequestView = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  agent: "Claude",
  sentence: "wants to share your passport number",
  details: [
    { label: "Field", value: "passport number" },
    { label: "To", value: "the travel agent" },
  ],
  reason: "booking your overseas trip",
  rule: "Ask me when an agent wants a high-tier detail",
  timeLeft: "two minutes left",
  release: "high_tier",
};

const CARD_VISA: SavedCardView = { id: "card-visa", label: "Visa ending 4242", ciphertext: "v1:visaCipherFerry" };
const CARD_AMEX: SavedCardView = { id: "card-amex", label: "Amex ending 1005", ciphertext: "v1:amexCipherFerry" };
const SAVED_CARDS: readonly SavedCardView[] = [CARD_VISA, CARD_AMEX];

// The high-tier value's stored ciphertext (server holds only this; the device decrypts it).
const HIGH_CIPHERTEXT = "v1:passportCiphertextMarker";

// Distinct, hex-free secret markers so a leak assertion can only match the real secret.
const PASSPHRASE = "correct horse battery staple ferry";
const SECURITY_CODE = "ferry-security-marker";

// Valid-shaped unlock requests the gather seams hand back (opaque to the controller — it
// passes them straight to releaseFlow). The passphrase one echoes the entered secret so a
// test can prove the typed passphrase travelled through unchanged.
function passphraseUnlock(secret: string): UnlockRequest {
  return { method: "passphrase", material: { wrapped: "v1:wrapped-vault-key", salt: new Uint8Array(16) }, secret };
}
const PASSKEY_UNLOCK: UnlockRequest = {
  method: "prf",
  material: { wrapped: "v1:wrapped-vault-key" },
  secret: new Uint8Array([9, 8, 7, 6, 5]) as Uint8Array<ArrayBuffer>,
};

// ─── a recording, programmable set of fakes for the controller ───────────────────────

type FlowOptions = {
  request: PendingRequestView;
  savedCards?: readonly SavedCardView[];
  highTierCiphertext?: string;
  // What the injected releaseFlow.release resolves with (defaults to success).
  releaseResult?: ReleaseResult;
  // The passkey PRF prompt is dismissed / times out (AC2 "cancelling the unlock").
  passkeyCancelled?: boolean;
  // What the injected "Confirm it's you" (step-up) ceremony resolves with.
  confirmResult?: boolean;
};

function setupFlow(opts: FlowOptions) {
  const events: string[] = [];
  const releaseCalls: ReleaseInput[] = [];
  const passphraseCalls: string[] = [];
  const changeEvents: true[] = [];
  const releasedEvents: true[] = [];
  let passkeyCalls = 0;

  const releaseFlow: ReleaseFlow = {
    async release(input: ReleaseInput): Promise<ReleaseResult> {
      events.push("release");
      releaseCalls.push(input);
      return opts.releaseResult ?? { ok: true };
    },
  };

  const unlockByPassphrase = async (passphrase: string): Promise<UnlockRequest> => {
    events.push("passphrase");
    passphraseCalls.push(passphrase);
    return passphraseUnlock(passphrase);
  };
  const unlockByPasskey = async (): Promise<UnlockRequest> => {
    events.push("passkey");
    passkeyCalls += 1;
    if (opts.passkeyCancelled) throw new Error("The passkey prompt was dismissed.");
    return PASSKEY_UNLOCK;
  };

  let confirmCalls = 0;
  const flow = createReleaseApproveFlow({
    request: opts.request,
    savedCards: opts.savedCards,
    highTierCiphertext: opts.highTierCiphertext,
    releaseFlow,
    unlockByPassphrase,
    unlockByPasskey,
    confirmItsYou: async () => {
      events.push("confirm");
      confirmCalls += 1;
      return opts.confirmResult ?? true;
    },
    onChange: () => changeEvents.push(true),
    onReleased: () => releasedEvents.push(true),
  });

  return {
    flow,
    events,
    releaseCalls,
    passphraseCalls,
    get passkeyCalls() {
      return passkeyCalls;
    },
    get releasedCount() {
      return releasedEvents.length;
    },
    get changeCount() {
      return changeEvents.length;
    },
    get confirmCalls() {
      return confirmCalls;
    },
  };
}

// A failure message must read as plain Australian English — a real sentence, never a raw
// machine code or crypto/protocol jargon — and must never contain the released value, the
// security code or the passphrase (brief design_ux.copy; constitution INV-22).
const CRYPTO_JARGON: { label: string; re: RegExp }[] = [
  { label: "ciphertext", re: /ciphertext/i },
  { label: "decrypt", re: /decrypt/i },
  { label: "AES", re: /\baes\b/i },
  { label: "GCM", re: /\bgcm\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "nonce", re: /nonce/i },
  { label: "envelope", re: /envelope/i },
];

function assertPlainFailure(message: unknown, ctx: string): asserts message is string {
  assert.equal(typeof message, "string", `${ctx}: expected plain-English failure copy, got ${typeof message}`);
  const text = (message as string).trim();
  assert.ok(text.length >= 8, `${ctx}: failure copy must be a real message, got: "${text}"`);
  assert.ok(/\s/.test(text), `${ctx}: failure copy must read as words, not a single token, got: "${text}"`);
  assert.ok(!/_/.test(text), `${ctx}: failure copy must not be a raw machine code (snake_case), got: "${text}"`);
  for (const { label, re } of CRYPTO_JARGON) {
    assert.ok(!re.test(text), `${ctx}: failure copy must avoid jargon "${label}", got: "${text}"`);
  }
  for (const secret of [SECURITY_CODE, PASSPHRASE]) {
    assert.ok(!text.includes(secret), `${ctx}: failure copy must never leak a secret value, got: "${text}"`);
  }
}

// ═══ AC1 — the on-device hand-over: unlock → decrypt the chosen card → post, once ═════

test("constructing the flow performs no unlock, decrypt or release", () => {
  const ctx = setupFlow({ request: PENDING_CARD, savedCards: SAVED_CARDS });
  assert.deepEqual(ctx.events, [], "creating the control touches nothing until the person decides");
  assert.equal(ctx.releaseCalls.length, 0, "no release is posted on construction");
  assert.equal(ctx.releasedCount, 0, "no completion is signalled on construction");
});

test("a card release via passphrase decrypts the CHOSEN card and posts the entered code, then reports success", async () => {
  const ctx = setupFlow({ request: PENDING_CARD, savedCards: SAVED_CARDS });

  ctx.flow.setMethod("passphrase");
  ctx.flow.setCardId(CARD_AMEX.id); // deliberately NOT the first card
  ctx.flow.setSecurityCode(SECURITY_CODE);
  ctx.flow.setPassphrase(PASSPHRASE);
  await ctx.flow.submit();

  assert.deepEqual(ctx.events, ["passphrase", "release"], "it gathers the passphrase unlock, then runs the release");
  assert.deepEqual(ctx.passphraseCalls, [PASSPHRASE], "the entered passphrase is handed to the passphrase unlock, unchanged");
  assert.equal(ctx.passkeyCalls, 0, "the passkey prompt is not used on the passphrase path");

  assert.equal(ctx.releaseCalls.length, 1, "the release is run exactly once");
  const input = ctx.releaseCalls[0]!;
  assert.equal(input.approvalId, PENDING_CARD.id, "the release is posted for this approval's id");
  assert.equal(input.ciphertext, CARD_AMEX.ciphertext, "the CHOSEN saved card's ciphertext is the one decrypted (not the first)");
  assert.equal(input.securityCode, SECURITY_CODE, "the freshly-entered security code is carried into the release");
  assert.equal(input.unlockRequest.method, "passphrase", "the release uses the passphrase unlock material");

  assert.equal(ctx.releasedCount, 1, "a completed release signals success exactly once");
  assert.equal(ctx.flow.getState().error, undefined, "a completed release carries no error");
});

test("a card release defaults to the FIRST offered card when the person doesn't change the picker", async () => {
  const ctx = setupFlow({ request: PENDING_CARD, savedCards: SAVED_CARDS });

  ctx.flow.setMethod("passphrase");
  ctx.flow.setSecurityCode(SECURITY_CODE);
  ctx.flow.setPassphrase(PASSPHRASE);
  await ctx.flow.submit(); // no setCardId — the picker's default card

  assert.equal(ctx.releaseCalls.length, 1, "the release runs once");
  assert.equal(
    ctx.releaseCalls[0]!.ciphertext,
    CARD_VISA.ciphertext,
    "the first offered card is released when the picker is left on its default",
  );
});

test("a card release via passkey uses the passkey unlock, not the passphrase", async () => {
  const ctx = setupFlow({ request: PENDING_CARD, savedCards: SAVED_CARDS });

  ctx.flow.setMethod("passkey");
  ctx.flow.setCardId(CARD_VISA.id);
  ctx.flow.setSecurityCode(SECURITY_CODE);
  await ctx.flow.submit();

  assert.deepEqual(ctx.events, ["passkey", "release"], "it gathers the passkey unlock, then runs the release");
  assert.equal(ctx.passkeyCalls, 1, "the passkey prompt runs once");
  assert.deepEqual(ctx.passphraseCalls, [], "the passphrase path is not used on the passkey path");

  assert.equal(ctx.releaseCalls.length, 1, "the release runs once");
  const input = ctx.releaseCalls[0]!;
  assert.equal(input.ciphertext, CARD_VISA.ciphertext, "the chosen card's ciphertext is decrypted");
  assert.equal(input.securityCode, SECURITY_CODE, "the entered security code is carried");
  assert.equal(input.unlockRequest.method, "prf", "the release uses the passkey (PRF) unlock material");
  assert.equal(ctx.releasedCount, 1, "the release reports success");
});

test("a high-tier release posts the decrypted high-tier value with NO security code", async () => {
  const ctx = setupFlow({ request: PENDING_HIGH, highTierCiphertext: HIGH_CIPHERTEXT });

  ctx.flow.setMethod("passphrase");
  ctx.flow.setPassphrase(PASSPHRASE);
  await ctx.flow.submit();

  assert.deepEqual(ctx.events, ["passphrase", "release"], "the high-tier hand-over gathers the unlock, then releases");
  assert.equal(ctx.releaseCalls.length, 1, "the release runs once");
  const input = ctx.releaseCalls[0]!;
  assert.equal(input.approvalId, PENDING_HIGH.id, "the release is posted for the high-tier approval");
  assert.equal(input.ciphertext, HIGH_CIPHERTEXT, "the requested high-tier value's ciphertext is the one decrypted");
  assert.equal(input.securityCode, undefined, "a high-tier release carries no security code (there is none)");
  assert.equal(ctx.releasedCount, 1, "the high-tier release reports success");
});

// ═══ AC2 — cancelling the unlock, or a wrong passphrase, releases nothing + plain copy ═

test("cancelling the passkey prompt releases nothing and shows plain-English copy on the same request", async () => {
  const ctx = setupFlow({ request: PENDING_CARD, savedCards: SAVED_CARDS, passkeyCancelled: true });

  ctx.flow.setMethod("passkey");
  ctx.flow.setCardId(CARD_VISA.id);
  ctx.flow.setSecurityCode(SECURITY_CODE);
  await ctx.flow.submit();

  assert.deepEqual(ctx.events, ["passkey"], "a cancelled passkey prompt never reaches the release");
  assert.equal(ctx.releaseCalls.length, 0, "nothing is released when the unlock is cancelled");
  assert.equal(ctx.releasedCount, 0, "a cancelled unlock signals no success — the request stays on the screen");
  assertPlainFailure(ctx.flow.getState().error, "cancelled unlock");
});

test("a wrong passphrase releases nothing to collect and shows plain-English copy on the same request", async () => {
  // A wrong secret / tampered envelope makes the device unlock fail INSIDE releaseFlow,
  // which decrypts and posts nothing and reports a plain failure (pinned by
  // inbox-view.test.tsx). This control must surface that failure plainly and NOT report a
  // release — the request stays waiting.
  const ctx = setupFlow({
    request: PENDING_CARD,
    savedCards: SAVED_CARDS,
    releaseResult: {
      ok: false,
      error: "We couldn't unlock your vault on this device. Check how you unlocked it, then try again.",
    },
  });

  ctx.flow.setMethod("passphrase");
  ctx.flow.setCardId(CARD_VISA.id);
  ctx.flow.setSecurityCode(SECURITY_CODE);
  ctx.flow.setPassphrase(PASSPHRASE);
  await ctx.flow.submit();

  assert.deepEqual(ctx.events, ["passphrase", "release"], "it attempts the release, which fails on the bad unlock");
  assert.equal(ctx.releaseCalls.length, 1, "the release was attempted once");
  assert.equal(ctx.releasedCount, 0, "a failed release signals no success — nothing was handed over");
  assertPlainFailure(ctx.flow.getState().error, "wrong passphrase");
});

// ═══ AC3 — the released value and security code never leak client-side ════════════════

// Operator review (E11-S17): once a release attempt finishes — handed over or not — the
// passphrase and the security code must not linger in the control's state.
test("after a release attempt the passphrase and security code are cleared from the control's state", async () => {
  for (const releaseResult of [undefined, { ok: false as const, error: "We couldn't unlock your vault on this device." }]) {
    const ctx = setupFlow({ request: PENDING_CARD, savedCards: SAVED_CARDS, ...(releaseResult ? { releaseResult } : {}) });
    ctx.flow.setMethod("passphrase");
    ctx.flow.setSecurityCode(SECURITY_CODE);
    ctx.flow.setPassphrase(PASSPHRASE);
    await ctx.flow.submit();
    const state = ctx.flow.getState();
    const outcome = releaseResult ? "failed" : "succeeded";
    assert.equal(state.passphrase, "", `passphrase cleared after a ${outcome} release`);
    assert.equal(state.securityCode, "", `security code cleared after a ${outcome} release`);
  }
});

test("the security code and the passphrase never touch browser storage or the console", async () => {
  // Install recording stand-ins for browser storage and the console so a leak is caught.
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

  const consoleOut: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original: Partial<Record<(typeof methods)[number], typeof console.log>> = {};
  for (const m of methods) {
    original[m] = console[m];
    console[m] = (...args: unknown[]) => {
      consoleOut.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }

  try {
    const ctx = setupFlow({ request: PENDING_CARD, savedCards: SAVED_CARDS });
    ctx.flow.setMethod("passphrase");
    ctx.flow.setCardId(CARD_AMEX.id);
    ctx.flow.setSecurityCode(SECURITY_CODE);
    ctx.flow.setPassphrase(PASSPHRASE);
    await ctx.flow.submit();

    // Sanity: the code DID reach the release endpoint (the markers are real) ...
    assert.equal(ctx.releasedCount, 1, "the release completed");
    assert.equal(ctx.releaseCalls[0]!.securityCode, SECURITY_CODE, "the code reached the release endpoint");

    // ... but neither the code nor the passphrase leaked to browser storage ...
    for (const w of [...local.writes, ...session.writes]) {
      for (const secret of [SECURITY_CODE, PASSPHRASE]) {
        assert.ok(
          !String(w.value).includes(secret) && !String(w.key).includes(secret),
          `a secret must never be written to browser storage, write: ${w.key}=${w.value}`,
        );
      }
    }
    // ... and never leaked to the console.
    for (const line of consoleOut) {
      for (const secret of [SECURITY_CODE, PASSPHRASE]) {
        assert.ok(!line.includes(secret), `a secret must never be logged to the console, line: "${line}"`);
      }
    }
  } finally {
    for (const m of methods) console[m] = original[m]!;
    if (hadLocal) g.localStorage = origLocal;
    else delete g.localStorage;
    if (hadSession) g.sessionStorage = origSession;
    else delete g.sessionStorage;
  }
});

// ═══ the ReleaseApprove control renders the right surface for each release kind ════════
//
// Rendered with react-dom/server (no DOM), reading the emitted markup — the same approach
// as every other component render test in the repo. The control is mounted with just its
// data props (the device seams / unlock material it uses at submit time are defaulted, so
// the initial render needs none).

type El = { attrs: string; inner: string };

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

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}

function controlFace(el: El): string {
  const parts = [visibleText(el.inner)];
  const al = attr(el.attrs, "aria-label");
  if (al) parts.push(decode(al));
  const ti = attr(el.attrs, "title");
  if (ti) parts.push(decode(ti));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function isDisabled(el: El): boolean {
  return /\bdisabled\b/i.test(el.attrs);
}

// Every CONTROL (a <button> or a disclosure <summary>) whose accessible name matches `re`.
function controlsMatching(markup: string, re: RegExp): El[] {
  return [...findAll(markup, "button"), ...findAll(markup, "summary")].filter((c) => re.test(controlFace(c)));
}

function inputAttrs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) out.push(m[1]!);
  return out;
}

// The "label-ish" text of a region: every <label>/<legend> visible text, plus the
// aria-label / name / placeholder that name a control, plus <select> names. Used to find a
// named field (e.g. a security-code input) without betting on the element kind.
function controlLabelText(markup: string): string {
  const parts: string[] = [];
  for (const l of findAll(markup, "label")) parts.push(visibleText(l.inner));
  for (const l of findAll(markup, "legend")) parts.push(visibleText(l.inner));
  for (const m of markup.matchAll(/aria-label="([^"]*)"/gi)) parts.push(decode(m[1]!));
  for (const a of inputAttrs(markup)) {
    for (const n of ["name", "placeholder"]) {
      const v = attr(a, n);
      if (v) parts.push(decode(v));
    }
  }
  for (const s of findAll(markup, "select")) {
    const n = attr(s.attrs, "name");
    if (n) parts.push(n);
  }
  return parts.join(" | ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whether the markup lets the person CHOOSE among the given saved cards: a <select> whose
// options cover every label, OR a radio per card, OR a button per card label.
function hasCardChooser(markup: string, cards: readonly SavedCardView[]): boolean {
  for (const s of findAll(markup, "select")) {
    const opts = findAll(s.inner, "option").map((o) => visibleText(o.inner));
    if (cards.every((c) => opts.some((o) => o.includes(c.label)))) return true;
  }
  const radios = inputAttrs(markup).filter((a) => (attr(a, "type") ?? "").toLowerCase() === "radio");
  if (radios.length >= cards.length) return true;
  return cards.every((c) => controlsMatching(markup, new RegExp(escapeRegExp(c.label), "i")).length >= 1);
}

// The sensitive-moment explainer copy (several phrasings so a reworded explainer stays
// matched, but all strong "slow down for this one moment" signals), and the security-code
// field matcher (Warthog's vocabulary) — mirrored from inbox-view.test.tsx.
const EXPLAINER_RE =
  /sensitive|take a moment|moment before|before it goes ahead|check the details|double.?check|one[- ]?time|slow down/i;
const SECURITY_CODE_RE =
  /security code|security number|\bcvc\b|\bcvv\b|card code|code on (?:the )?(?:back|front)|[34].?digit code/i;
// The proceed/confirm control that runs the device hand-over.
const RELEASE_RE = /release|hand over|hand it|share|confirm|continue/i;

test("a card release renders the explainer, the saved-card picker, a security-code field and a live release control", () => {
  const markup = renderToStaticMarkup(<ReleaseApprove request={PENDING_CARD} savedCards={SAVED_CARDS} />);
  const text = visibleText(markup);

  assert.match(text, EXPLAINER_RE, `a card release must show the sensitive-moment explainer, got: "${text}"`);

  for (const card of SAVED_CARDS) {
    assert.ok(text.includes(card.label), `the card picker must offer "${card.label}", got: "${text}"`);
  }
  assert.ok(
    hasCardChooser(markup, SAVED_CARDS),
    "the saved cards must be offered through a real chooser (a select, radios or per-card buttons)",
  );

  assert.match(
    controlLabelText(markup),
    SECURITY_CODE_RE,
    `a card release must offer a security-code field, got control labels: "${controlLabelText(markup)}"`,
  );

  const proceed = controlsMatching(markup, RELEASE_RE).filter((c) => !isDisabled(c));
  assert.ok(proceed.length >= 1, "a card release must offer a LIVE control to run the on-device release");
});

test("a high-tier release renders the explainer and a live release control, with NO card picker and NO security code", () => {
  // Passed savedCards deliberately, to prove a high-tier release ignores them.
  const markup = renderToStaticMarkup(<ReleaseApprove request={PENDING_HIGH} savedCards={SAVED_CARDS} />);
  const text = visibleText(markup);

  assert.match(text, EXPLAINER_RE, `a high-tier release must show the sensitive-moment explainer, got: "${text}"`);
  const proceed = controlsMatching(markup, RELEASE_RE).filter((c) => !isDisabled(c));
  assert.ok(proceed.length >= 1, "a high-tier release must offer a LIVE control to run the release");

  for (const card of SAVED_CARDS) {
    assert.ok(!text.includes(card.label), `a high-tier release must not show the card picker ("${card.label}"), got: "${text}"`);
  }
  assert.ok(
    !SECURITY_CODE_RE.test(controlLabelText(markup)),
    `a high-tier release must not offer a security-code field, got control labels: "${controlLabelText(markup)}"`,
  );
});

test("uses design tokens, never a raw hex colour (card and high-tier)", () => {
  for (const element of [
    <ReleaseApprove request={PENDING_CARD} savedCards={SAVED_CARDS} />,
    <ReleaseApprove request={PENDING_HIGH} savedCards={SAVED_CARDS} />,
  ]) {
    const markup = renderToStaticMarkup(element);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the ReleaseApprove markup, got: ${markup}`,
    );
  }
});

// ═══ Review fix C7 — no dead ends on the release ═══════════════════════════════════════
//
// A lapsed step-up used to show "Please try again" forever (only signing out and in again
// helped). The control now offers "Confirm it's you" inline: it runs the step-up ceremony
// and then asks the person to approve and release again. A card release with no saved
// card, or a high-tier release with no saved detail, is disabled with a reason instead of
// failing at decrypt. And a high-tier release decrypts the CHOSEN saved detail.

test("a release refused for a lapsed step-up offers 'Confirm it's you' instead of a dead 'try again'", async () => {
  const ctx = setupFlow({
    request: PENDING_CARD,
    savedCards: SAVED_CARDS,
    releaseResult: { ok: false, error: "Please confirm it's you first, then approve and release again.", reason: "step_up_required" },
  });
  ctx.flow.setSecurityCode(SECURITY_CODE);
  await ctx.flow.submit();

  const refused = ctx.flow.getState();
  assert.equal(refused.confirmRequired, true, "the control now offers to confirm it's you");
  assert.equal(refused.status, "error");
  assert.equal(refused.securityCode, "", "the security code is still cleared after the attempt");

  await ctx.flow.confirm();
  const confirmed = ctx.flow.getState();
  assert.equal(ctx.confirmCalls, 1, "the step-up ceremony ran once");
  assert.equal(confirmed.confirmRequired, false, "once confirmed, it no longer asks");
  assert.equal(confirmed.status, "idle", "ready to approve and release again");
  assert.match(confirmed.notice ?? "", /approve and release again/i, "and says what to do next");
  assert.equal(ctx.releaseCalls.length, 1, "confirming never releases on its own");
});

test("a 'Confirm it's you' that fails or is cancelled keeps offering it, with plain copy", async () => {
  const ctx = setupFlow({
    request: PENDING_HIGH,
    highTierCiphertext: HIGH_CIPHERTEXT,
    releaseResult: { ok: false, error: "Please confirm it's you first, then approve and release again.", reason: "step_up_required" },
    confirmResult: false,
  });
  await ctx.flow.submit();
  await ctx.flow.confirm();
  const state = ctx.flow.getState();
  assert.equal(state.confirmRequired, true, "it still offers to confirm");
  assertPlainFailure(state.error, "failed confirm");
});

test("a high-tier release decrypts the saved detail the person chose", async () => {
  const fields = [
    { id: "f-passport", label: "Passport", ciphertext: "v1:passportCipherOne" },
    { id: "f-licence", label: "Driver licence", ciphertext: "v1:licenceCipherTwo" },
  ];
  const ctx = setupFlow({ request: { ...PENDING_HIGH, highTierFields: fields } });
  assert.equal(ctx.flow.getState().highTierFieldId, "f-passport", "the first (best-matching) detail is preselected");
  ctx.flow.setHighTierFieldId("f-licence");
  await ctx.flow.submit();
  assert.equal(ctx.releaseCalls[0]!.ciphertext, "v1:licenceCipherTwo", "the chosen detail is what is decrypted");
});

test("a card release with no saved card, or a high-tier release with no saved detail, is disabled with a reason", () => {
  for (const [label, element] of [
    ["card", <ReleaseApprove request={PENDING_CARD} savedCards={[]} />],
    ["high-tier", <ReleaseApprove request={{ ...PENDING_HIGH, highTierFields: [] }} />],
  ] as const) {
    const markup = renderToStaticMarkup(element);
    const live = controlsMatching(markup, /approve and release/i).filter((c) => !isDisabled(c));
    assert.equal(live.length, 0, `${label}: no live release control when there is nothing to release`);
    assert.match(visibleText(markup), /vault/i, `${label}: a one-line reason points the person to their vault`);
  }
});

test("a high-tier release with several saved details offers a chooser", () => {
  const fields = [
    { id: "f-passport", label: "Passport", ciphertext: "v1:passportCipherOne" },
    { id: "f-licence", label: "Driver licence", ciphertext: "v1:licenceCipherTwo" },
  ];
  const markup = renderToStaticMarkup(<ReleaseApprove request={{ ...PENDING_HIGH, highTierFields: fields }} />);
  const options = findAll(markup, "option").map((o) => visibleText(o.inner));
  assert.ok(options.includes("Passport") && options.includes("Driver licence"), "each saved detail can be chosen");
});

// ═══ Review fix W1 — the vault recovery phrase in the release flow ══════════════════════

const RECOVERY_UNLOCK = (secret: string): UnlockRequest => ({
  method: "recovery",
  material: { wrapped: "v1:wrapped-under-phrase" },
  secret,
});

function setupRecoveryFlow(opts: {
  request: PendingRequestView;
  savedCards?: readonly SavedCardView[];
  afterRelease?: (request: UnlockRequest) => Promise<{ notice?: string; phrase?: { value: string; save: () => Promise<void> } }>;
}) {
  const releaseCalls: ReleaseInput[] = [];
  const phraseCalls: string[] = [];
  const afterCalls: UnlockRequest[] = [];
  const flow = createReleaseApproveFlow({
    request: opts.request,
    savedCards: opts.savedCards,
    releaseFlow: {
      async release(input: ReleaseInput): Promise<ReleaseResult> {
        releaseCalls.push(input);
        return { ok: true };
      },
    },
    unlockByPassphrase: async (p) => passphraseUnlock(p),
    unlockByPasskey: async () => PASSKEY_UNLOCK,
    unlockByRecoveryPhrase: async (phrase: string) => {
      phraseCalls.push(phrase);
      return RECOVERY_UNLOCK(phrase);
    },
    afterRelease: async (request) => {
      afterCalls.push(request);
      return opts.afterRelease ? opts.afterRelease(request) : {};
    },
  });
  return { flow, releaseCalls, phraseCalls, afterCalls };
}

test("W1 — a release can unlock the vault with the recovery phrase, which is cleared once used", async () => {
  const ctx = setupRecoveryFlow({ request: PENDING_HIGH });
  ctx.flow.setMethod("recovery");
  ctx.flow.setRecoveryPhrase("abcd-efgh");
  await ctx.flow.submit();
  assert.deepEqual(ctx.phraseCalls, ["abcd-efgh"]);
  assert.equal(ctx.releaseCalls[0]!.unlockRequest.method, "recovery");
  assert.equal(ctx.flow.getState().status, "released");
  assert.equal(ctx.flow.getState().recoveryPhrase, "", "the typed phrase is not kept");
  assert.equal(ctx.afterCalls.length, 1, "the follow-up (re-seal under this passkey) runs after the release");
});

test("W1 — after a phrase release, the follow-up's note is shown", async () => {
  const ctx = setupRecoveryFlow({
    request: PENDING_HIGH,
    afterRelease: async () => ({ notice: "This device's passkey can now unlock your vault." }),
  });
  ctx.flow.setMethod("recovery");
  ctx.flow.setRecoveryPhrase("abcd");
  await ctx.flow.submit();
  assert.match(String(ctx.flow.getState().notice), /passkey/);
});

test("W1 — a vault with no recovery phrase is offered one after the release, saved only once ticked", async () => {
  const saves: string[] = [];
  const ctx = setupRecoveryFlow({
    request: PENDING_HIGH,
    afterRelease: async () => ({
      phrase: { value: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567", save: async () => void saves.push("saved") },
    }),
  });
  await ctx.flow.submit();
  assert.equal(ctx.flow.getState().status, "released", "the release itself is never held up");
  assert.equal(ctx.flow.getState().newPhrase, "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567");

  await ctx.flow.confirmRecoveryPhrase();
  assert.deepEqual(saves, [], "an unticked Continue saves nothing");
  assert.ok(ctx.flow.getState().phraseError);

  ctx.flow.setPhraseSaved(true);
  await ctx.flow.confirmRecoveryPhrase();
  assert.deepEqual(saves, ["saved"]);
  assert.equal(ctx.flow.getState().newPhrase, null, "the phrase is forgotten once saved");
});

test("W1 — a failing follow-up never turns a completed release into an error", async () => {
  const ctx = setupRecoveryFlow({
    request: PENDING_HIGH,
    afterRelease: async () => {
      throw new Error("offline");
    },
  });
  await ctx.flow.submit();
  assert.equal(ctx.flow.getState().status, "released");
  assert.equal(ctx.flow.getState().error, undefined);
});

test("W1 — the release control offers the recovery phrase as a third way to unlock", () => {
  const html = renderToStaticMarkup(<ReleaseApprove request={PENDING_CARD} savedCards={SAVED_CARDS} />);
  assert.match(html, /recovery phrase/i);
});
