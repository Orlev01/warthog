// E11-S20 — Add a high-tier detail on this device
// (src/components/vault/high-tier-flow.tsx).
//
// RED-first: src/components/vault/high-tier-flow.tsx does NOT exist yet, so importing
// `./high-tier-flow` throws and EVERY test in this file fails until the builder adds the
// component. That absence is the entire point of test-first — do NOT implement anything
// to make these pass.
//
// WHY this module exists (brief "Identity vault" / "Device-held protection"; design §4.2
// device-held vault; constitution 17/19 — the server holds no vault key and no staff role
// can read vault contents; INV-103): the identity screen (<IdentityView/>, E11-S13)
// renders an "Add a high-tier detail" control and a per-field "Raise to high tier" control
// that NEVER reach the device encryption step, so a licence / passport / date of birth can
// never be saved for release. This task is the self-wired CLIENT flow behind BOTH controls.
// On this device it:
//   • on FIRST use creates the vault key in the browser (createVaultKey) and wraps it under
//     the person's passkey PRF, saving the wrapped key via POST /api/vault/unlock-method;
//   • on LATER use unlocks the EXISTING vault key through the unlock-material endpoint
//     (GET /api/vault/unlock-material/passkey_prf) — no new key is created;
//   • ADD mode: seals the entered value on the device (sealHighTierDetail) and submits ONLY
//     the ciphertext plus plaintext metadata (type, label) to the page's saveHighTierField
//     action;
//   • RAISE mode: re-seals the EXISTING low-tier field's value on the device and submits the
//     ciphertext + metadata together with that field's id to the page's raiseFieldToHighTier
//     action (whose server side removes the plaintext low-tier value — pinned in
//     vault/actions.test.tsx, not re-proved here).
// The plaintext value is NEVER collected into a request body, storage or the console.
//
// This file pins the TWO seams `high-tier-flow.tsx` exports, exactly mirroring the repo's
// established split for a screen that is both render-testable AND interactive (SignupView +
// createSignupFlow; ReleaseApprove + createReleaseApproveFlow; AddCardFlow +
// createAddCardFlow):
//
//   1. HighTierFlow — the Client Component <IdentityView/> mounts. In ADD mode: closed it
//      is a live "Add a high-tier detail" control; open it is the sensitive-moment explainer
//      (HOW the detail is protected + WHO can ever read it), a live value field and a LIVE
//      confirm that runs the device flow. In RAISE mode (bound to one low-tier field): closed
//      it is a live "Raise to high tier" control; open it is the explainer and a LIVE confirm
//      that re-seals that field's value. It is render-tested here with `react-dom/server` (no
//      DOM — React component / E2E testing is a per-job ADR), exactly like every other
//      component render test.
//
//   2. createHighTierFlow(deps) — the framework-free, injectable controller behind the LIVE
//      confirm. The interactive behaviour — set up or unlock the vault key on this device,
//      seal the value, submit only the ciphertext + metadata — is tested by DRIVING THE
//      CONTROLLER with fake I/O seams and asserting what it DOES, never the source text.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the control RENDERS for its props, and what the controller
//     DOES for its inputs (the HTTP it makes, the key it creates vs unlocks, which action it
//     submits to and with what) — never the source text of high-tier-flow.tsx. A
//     behaviour-preserving refactor (reworded-but-still-plain copy, different wrappers, extra
//     classes, a different icon) stays green.
//   * Only the I/O boundaries are faked (fetch, the WebAuthn PRF ceremony, the vault-key
//     entropy, the saveHighTierField / raiseFieldToHighTier submit). The REAL client/vault
//     crypto runs (derive → wrap / unwrap → seal), so "the ciphertext decrypts under the
//     created key" and "a second write uses the SAME key" are proven, not asserted by
//     inspecting source.
//   * The device-seal step itself (sealHighTierDetail — value → `v1:` ciphertext, metadata
//     preserved, plaintext never carried) is already pinned by identity-view.test.tsx; these
//     tests do not re-prove it — they prove the flow CALLS it with the unlocked key and
//     submits only its output. The server-side "lists by label only" / "removes the plaintext
//     low-tier value" obligations are already pinned by vault/actions.test.tsx.
//   * Absence checks ("the plaintext value never appears in any request body / storage / the
//     console") are scoped to the EXACT unit under test — the bodies this flow actually sends
//     and the one panel it renders.
//
// ─── the contract this task introduces (documented here as the cross-task contract) ───
//
//   createHighTierFlow(deps: {
//     mode: "add" | "raise";               // which control this flow is behind
//     field?: { id: string; value: string; label?: string };
//                                          // RAISE mode: the existing low-tier field being
//                                          // raised — its id and current DECRYPTED value
//     fetch: typeof fetch;                 // GET /api/vault/unlock-material/<method>,
//                                          // POST /api/vault/unlock-method
//     startAuthentication: (opts: { optionsJSON: unknown }) => Promise<{
//       clientExtensionResults?: { prf?: { results?: { first?: string } } };
//     }>;                                  // the WebAuthn PRF assertion (OS passkey prompt);
//                                          // a dismissed prompt REJECTS. PRF output is
//                                          // base64url in clientExtensionResults.prf.results.first
//     createVaultKey: () => Uint8Array;    // fresh vault-key entropy; called ONLY on first use
//     saveHighTierField?: (submission: {  // ADD mode submit (the page's server action)
//       type: string; label: string; ciphertext: string;
//     }) => Promise<{ ok: boolean; reason?: string }>;
//     raiseFieldToHighTier?: (submission: { // RAISE mode submit (the page's server action)
//       fieldId: string; type: string; label: string; ciphertext: string;
//     }) => Promise<{ ok: boolean; reason?: string }>;
//     onChange?: () => void;               // re-render notifier (the component wires it)
//     onSaved?: () => void;                // called once on a completed save (list refresh)
//   }): HighTierController
//
//   HighTierController = {
//     getState(): HighTierState;           // a snapshot the component renders from
//     setType(v: string): void; setLabel(v: string): void; setValue(v: string): void;
//     submit(): Promise<void>;             // set up / unlock the vault key → seal → submit
//   }
//
//   HighTierState = {
//     type: string; label: string; value: string;
//     status: "idle" | "working" | "saved" | "error"; error?: string;
//   }
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { renderToStaticMarkup } from "react-dom/server";

import { HighTierFlow, createHighTierFlow } from "./high-tier-flow";
import { deriveWrappingKeyFromPrf } from "@/client/vault/derive";
import { unwrapVaultKey } from "@/client/vault/key";
import { unlockWithRecoveryPhrase } from "@/client/vault/recovery-phrase";
import { decryptValue } from "@/client/vault/values";

// ─── fixtures ────────────────────────────────────────────────────────────────────────

// The five high-tier types the store enum allows (vault/actions.ts highTierTypeSchema):
// the flow must submit one of these as `type`, whatever its panel lets a person choose.
const VALID_HIGH_TIER_TYPES = new Set([
  "date_of_birth",
  "passport",
  "driver_licence",
  "car_registration",
  "custom",
]);

// A high-tier value that must NEVER appear in a request body, storage or the console —
// distinctive so its presence anywhere is unambiguous.
const SECRET_VALUE = "PP-A1234567-must-never-leak";
// The current (decrypted) value of a low-tier field being RAISED to high tier.
const RAISE_VALUE = "DL-99887766-raise-me";
// A plausible uuid for the low-tier field id a raise carries (uuid-shaped so it matches the
// server action's boundary, though the action is faked here).
const RAISE_FIELD_ID = "11111111-1111-4111-8111-111111111111";

// Deterministic, known 32-/16-byte material so the real crypto round-trips are verifiable.
// FIXED_VK is the vault key the fake createVaultKey hands back; FIXED_PRF is the PRF output
// the fake passkey ceremony returns for the (fixed) per-person salt.
function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_unused, i) => (i * seed + seed) & 0xff);
}
const FIXED_VK = bytes(32, 11);
const FIXED_PRF = bytes(32, 7);
const PRF_SALT = bytes(16, 13);

function toBase64Url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}
function u8(b: Uint8Array): Uint8Array {
  // A tightly-fitted ArrayBuffer-backed copy for the real WebCrypto derivations.
  return new Uint8Array(b);
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// The WebAuthn authentication options the unlock-material endpoint returns (carrying the
// PRF eval of the person's fixed salt), echoed verbatim to startAuthentication — exactly
// the shape E11-S18's getMaterial produces and E11-S19's card flow consumes.
const PASSKEY_OPTIONS = {
  rpId: "warthog.com.au",
  challenge: "Y2hhbGxlbmdl",
  allowCredentials: [] as unknown[],
  userVerification: "required",
  extensions: { prf: { eval: { first: toBase64Url(PRF_SALT) } } },
};

// ─── a recording fake "server" behind the fetch seam ─────────────────────────────────
//
// It persists what POST /api/vault/unlock-method saves and returns it on the next GET
// /api/vault/unlock-material — so first-use (wrapped == null → create + save) and later-use
// (wrapped present → unlock) can be exercised end-to-end against ONE account.

type PostBody = { method: string; wrapped: string; params?: { salt?: string } };

// Review fix W1: the fake also keeps the 'recovery' envelope (the vault recovery phrase)
// and, like the real endpoint, refuses to REPLACE an existing method without a step-up.
function makeServer() {
  const store: { passkey_prf: string | null; recovery: string | null } = { passkey_prf: null, recovery: null };
  const gets: string[] = [];
  const posts: PostBody[] = [];

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (init && String(init.method).toUpperCase() === "POST") {
      const body = JSON.parse(String(init.body)) as PostBody;
      posts.push(body);
      if (body.method === "passkey_prf") {
        if (store.passkey_prf !== null) return json({ error: "step_up_required" }, 403);
        store.passkey_prf = body.wrapped;
      } else if (body.method === "recovery") {
        if (store.recovery !== null) return json({ error: "step_up_required" }, 403);
        store.recovery = body.wrapped;
      }
      return json({ ok: true });
    }
    gets.push(url);
    const proof = { challenge: "A".repeat(43), mode: Object.values(store).some(Boolean) ? "prove" : "enroll" };
    if (url.includes("/vault/unlock-material/passkey_prf")) {
      return json({ wrapped: store.passkey_prf, params: null, options: PASSKEY_OPTIONS, proof });
    }
    if (url.includes("/vault/unlock-material/recovery")) {
      return json({ wrapped: store.recovery, params: {}, options: null, proof });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

  return { store, gets, posts, fetch };
}

// The WebAuthn PRF ceremony fake: returns the fixed PRF output (base64url) for the salt in
// the options it was handed, recording the options so we can prove the endpoint's options
// are used. A `cancelled` prompt REJECTS (the OS dialog dismissed).
function makePasskey(opts: { cancelled?: boolean } = {}) {
  const calls: unknown[] = [];
  const fn = async ({ optionsJSON }: { optionsJSON: unknown }) => {
    calls.push(optionsJSON);
    if (opts.cancelled) throw new Error("The passkey prompt was dismissed.");
    return { id: "YQ", clientExtensionResults: { prf: { results: { first: toBase64Url(FIXED_PRF) } } } };
  };
  return {
    fn,
    get calls() {
      return calls;
    },
  };
}

// The vault-key entropy fake: hands back FIXED_VK and records every call (so "a second
// write creates no new key" is countable).
function makeCreateKey() {
  const created: Uint8Array[] = [];
  const fn = () => {
    created.push(FIXED_VK);
    return FIXED_VK as unknown as Uint8Array;
  };
  return {
    fn,
    get count() {
      return created.length;
    },
  };
}

type AddSubmission = { type: string; label: string; ciphertext: string };
type RaiseSubmission = { fieldId: string; type: string; label: string; ciphertext: string };

function makeSave(result: { ok: boolean; reason?: string } = { ok: true }) {
  const subs: AddSubmission[] = [];
  const fn = async (submission: AddSubmission) => {
    subs.push(submission);
    return result;
  };
  return {
    fn,
    get subs() {
      return subs;
    },
    get count() {
      return subs.length;
    },
  };
}

function makeRaise(result: { ok: boolean; reason?: string } = { ok: true }) {
  const subs: RaiseSubmission[] = [];
  const fn = async (submission: RaiseSubmission) => {
    subs.push(submission);
    return result;
  };
  return {
    fn,
    get subs() {
      return subs;
    },
    get count() {
      return subs.length;
    },
  };
}

type Server = ReturnType<typeof makeServer>;
type Passkey = ReturnType<typeof makePasskey>;
type CreateKey = ReturnType<typeof makeCreateKey>;
type Save = ReturnType<typeof makeSave>;
type Raise = ReturnType<typeof makeRaise>;

// Confirm, and when the flow pauses on a new vault recovery phrase (a vault with none —
// review fix W1), tick "I've saved it" and carry on, as the person would.
async function submitThroughPhrase(flow: ReturnType<typeof makeFlow>["flow"]): Promise<void> {
  await flow.submit();
  if (flow.getState().status === "phrase") {
    flow.setPhraseSaved(true);
    await flow.confirmRecoveryPhrase();
  }
}

function makeFlow(opts: {
  mode: "add" | "raise";
  field?: { id: string; value: string; label?: string };
  server: Server;
  passkey: Passkey;
  createKey: CreateKey;
  save?: Save;
  raise?: Raise;
}) {
  const changes: true[] = [];
  const saved: true[] = [];
  const flow = createHighTierFlow({
    mode: opts.mode,
    field: opts.field,
    fetch: opts.server.fetch,
    startAuthentication: opts.passkey.fn,
    createVaultKey: opts.createKey.fn,
    saveHighTierField: opts.save?.fn,
    raiseFieldToHighTier: opts.raise?.fn,
    onChange: () => changes.push(true),
    onSaved: () => saved.push(true),
  });
  return {
    flow,
    get changeCount() {
      return changes.length;
    },
    get savedCount() {
      return saved.length;
    },
  };
}

// Fill the ADD panel's entries: the person names the detail ("What is it?") and types its
// value ("The detail"). The `type` is left for the flow to default/derive (a render test
// does not force a type picker); the submission must still carry a valid high-tier type.
function fillAdd(
  flow: ReturnType<typeof makeFlow>["flow"],
  opts: { value: string; label?: string },
): void {
  flow.setLabel(opts.label ?? "Passport");
  flow.setValue(opts.value);
}

// Recover the vault key the passkey envelope wraps, using the REAL derivation + unwrap with
// the fixed PRF output — so "the saved envelope genuinely wraps the created key" is proven.
async function vkFromPasskeyEnvelope(wrapped: string): Promise<Uint8Array> {
  const wrappingKey = await deriveWrappingKeyFromPrf(u8(FIXED_PRF) as Uint8Array<ArrayBuffer>);
  return unwrapVaultKey(wrappingKey, wrapped);
}

// A failure message must read as plain Australian English — a real sentence, never a raw
// machine code or crypto/protocol jargon — and never the plaintext value (brief
// design_ux.copy; constitution INV-22).
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
  for (const secret of [SECRET_VALUE, RAISE_VALUE]) {
    assert.ok(!text.includes(secret), `${ctx}: failure copy must never leak the value, got: "${text}"`);
  }
}

// ═══ construction does nothing ════════════════════════════════════════════════════════

test("constructing the flow touches no device seam and submits nothing", () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const save = makeSave();
  makeFlow({ mode: "add", server, passkey, createKey, save });

  assert.deepEqual(server.gets, [], "no unlock-material is read until the person confirms");
  assert.deepEqual(server.posts, [], "no unlock method is saved on construction");
  assert.equal(passkey.calls.length, 0, "no passkey prompt is shown on construction");
  assert.equal(createKey.count, 0, "no vault key is created on construction");
  assert.equal(save.count, 0, "nothing is submitted on construction");
});

// ═══ a new detail needs a name and a value (spaces alone don't count) ═════════════════

test("an add with no name or no value says which, and never unlocks the vault or sends anything", async () => {
  for (const [label, value, expected] of [
    ["", SECRET_VALUE, /what this detail is/i],
    ["   ", SECRET_VALUE, /what this detail is/i],
    ["Passport", "", /type the detail/i],
    ["Passport", "  ", /type the detail/i],
  ] as const) {
    const server = makeServer();
    const passkey = makePasskey();
    const createKey = makeCreateKey();
    const save = makeSave();
    const ctx = makeFlow({ mode: "add", server, passkey, createKey, save });
    fillAdd(ctx.flow, { value, label });
    await ctx.flow.submit();
    assert.equal(ctx.flow.getState().status, "error");
    assert.match(String(ctx.flow.getState().error), expected);
    assert.equal(passkey.calls.length, 0, "no passkey prompt for an incomplete detail");
    assert.equal(createKey.count, 0, "no vault key is created");
    assert.deepEqual(server.gets, [], "no unlock material is read");
    assert.equal(save.count, 0, "nothing is submitted");
  }
});

test("the open panel offers a way back out, and the confirm says what it saves", () => {
  const markup = renderToStaticMarkup(<HighTierFlow mode="add" saveHighTierField={noopSave} initialOpen={true} />);
  assert.ok(liveButtons(markup).includes("Cancel"), `a Cancel is offered; live=${JSON.stringify(liveButtons(markup))}`);
  assert.ok(liveButtons(markup).includes("Save protected detail"), `the confirm names what it saves; live=${JSON.stringify(liveButtons(markup))}`);
  // The explainer states the release as it happens (content-31): no absolute "never".
  const text = visibleText(markup);
  assert.doesNotMatch(text, /can never read|no one else|not even Warthog/i);
  assert.match(text, /passed through Warthog once/i);
});

// ═══ AC1 — a FIRST add sets up the vault key, saves it wrapped, submits ciphertext ═════

test("AC1 — a first add creates the vault key, saves its passkey-wrapped envelope, and submits only ciphertext + metadata (type/label)", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const save = makeSave();
  const raise = makeRaise();
  const ctx = makeFlow({ mode: "add", server, passkey, createKey, save, raise });

  fillAdd(ctx.flow, { value: SECRET_VALUE, label: "Passport" });
  await submitThroughPhrase(ctx.flow);

  // It read the unlock-material endpoint and ran the passkey PRF ceremony with ITS options.
  assert.ok(
    server.gets.some((u) => u.includes("/vault/unlock-material/passkey_prf")),
    `it must read the passkey unlock material from the endpoint; GETs=${JSON.stringify(server.gets)}`,
  );
  assert.equal(passkey.calls.length, 1, "the passkey PRF ceremony runs once");
  assert.deepEqual(
    passkey.calls[0],
    PASSKEY_OPTIONS,
    "the PRF ceremony uses the options returned by the unlock-material endpoint",
  );

  // Exactly one vault key is created and saved passkey-wrapped.
  assert.equal(createKey.count, 1, "a first add creates the vault key exactly once");
  assert.equal(
    server.posts.filter((p) => p.method === "passkey_prf").length,
    1,
    `the passkey-wrapped vault key is saved once via POST /api/vault/unlock-method; posts=${JSON.stringify(server.posts)}`,
  );

  // The saved passkey envelope genuinely wraps the created vault key.
  assert.ok(typeof server.store.passkey_prf === "string", "the passkey envelope was stored");
  assert.ok(
    bytesEqual(await vkFromPasskeyEnvelope(server.store.passkey_prf!), FIXED_VK),
    "the saved passkey envelope must unwrap to the created vault key",
  );

  // It submitted to the ADD action (never the raise action), carrying ONLY the sealed
  // ciphertext + plaintext metadata.
  assert.equal(save.count, 1, "the high-tier detail is submitted to saveHighTierField exactly once");
  assert.equal(raise.count, 0, "an add never calls raiseFieldToHighTier");
  const sub = save.subs[0]!;
  assert.ok(
    typeof sub.ciphertext === "string" && sub.ciphertext.startsWith("v1:"),
    `the submission carries the sealed value as a "v1:" ciphertext; submission=${JSON.stringify(sub)}`,
  );
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, sub.ciphertext),
    SECRET_VALUE,
    "the submitted ciphertext decrypts to the entered value under the created vault key",
  );
  assert.equal(sub.label, "Passport", "the entered label is submitted as plaintext metadata");
  assert.ok(
    VALID_HIGH_TIER_TYPES.has(sub.type),
    `the submission must carry a valid high-tier type; submission=${JSON.stringify(sub)}`,
  );

  // Only the sealed value leaves — never the plaintext value, under any key name.
  assert.ok(
    !JSON.stringify(sub).includes(SECRET_VALUE),
    `the plaintext value must never appear in the submission; submission=${JSON.stringify(sub)}`,
  );

  // It reports success so the list can refresh and show the new detail's label.
  assert.equal(ctx.flow.getState().status, "saved", "a completed add reports success");
  assert.equal(ctx.flow.getState().error, undefined, "a completed add carries no error");
  assert.equal(ctx.savedCount, 1, "a completed add signals success exactly once");
});

// ═══ AC1 — a SECOND add unlocks the existing key; no new key is created ════════════════

test("AC1 — a second add unlocks the existing vault key (no new key) and seals under that same key", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const save = makeSave();

  // First detail sets the vault up.
  const first = makeFlow({ mode: "add", server, passkey, createKey, save });
  fillAdd(first.flow, { value: SECRET_VALUE, label: "Passport" });
  await submitThroughPhrase(first.flow);
  assert.equal(createKey.count, 1, "the first add created the vault key");
  const postsAfterFirst = server.posts.length;

  // Second detail on the SAME account (same server state, same seams).
  const second = makeFlow({ mode: "add", server, passkey, createKey, save });
  fillAdd(second.flow, { value: "DOB-1990-07-14", label: "Date of birth" });
  await submitThroughPhrase(second.flow);

  // No new key, no new unlock method saved — it UNLOCKED the existing one.
  assert.equal(createKey.count, 1, "the second add does NOT create a new vault key");
  assert.equal(
    server.posts.length,
    postsAfterFirst,
    `the second add saves no new unlock method; posts=${JSON.stringify(server.posts)}`,
  );
  assert.equal(passkey.calls.length, 2, "the second add unlocks via the passkey PRF ceremony again");

  // Both details' ciphertext decrypts under the SAME vault key the first add created.
  assert.equal(save.count, 2, "two details were submitted");
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, save.subs[0]!.ciphertext),
    SECRET_VALUE,
    "the first detail decrypts under the vault key",
  );
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, save.subs[1]!.ciphertext),
    "DOB-1990-07-14",
    "the second detail decrypts under the SAME vault key",
  );
  assert.equal(second.flow.getState().status, "saved", "the second add reports success");
});

// ═══ AC2 — raising re-seals the field's value and submits it with the field id ═════════

test("AC2 — raising a field re-seals its value on the device and submits the ciphertext with the field id (never the plaintext)", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const save = makeSave();
  const raise = makeRaise();
  const ctx = makeFlow({
    mode: "raise",
    field: { id: RAISE_FIELD_ID, value: RAISE_VALUE, label: "Driver licence" },
    server,
    passkey,
    createKey,
    save,
    raise,
  });

  await submitThroughPhrase(ctx.flow);

  // The vault key is set up on this device (first use here), and the passkey ceremony ran.
  assert.ok(
    server.gets.some((u) => u.includes("/vault/unlock-material/passkey_prf")),
    `raising must read the passkey unlock material; GETs=${JSON.stringify(server.gets)}`,
  );
  assert.equal(passkey.calls.length, 1, "the passkey PRF ceremony runs once for the raise");

  // It submitted to the RAISE action (never the add action), carrying the field id + the
  // re-sealed ciphertext + metadata.
  assert.equal(raise.count, 1, "the raise is submitted to raiseFieldToHighTier exactly once");
  assert.equal(save.count, 0, "a raise never calls saveHighTierField");
  const sub = raise.subs[0]!;
  assert.equal(sub.fieldId, RAISE_FIELD_ID, "the raise carries the low-tier field's id");
  assert.ok(
    typeof sub.ciphertext === "string" && sub.ciphertext.startsWith("v1:"),
    `the raise carries a sealed "v1:" ciphertext; submission=${JSON.stringify(sub)}`,
  );
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, sub.ciphertext),
    RAISE_VALUE,
    "the re-sealed ciphertext decrypts to the field's current value under the vault key",
  );
  assert.ok(
    VALID_HIGH_TIER_TYPES.has(sub.type),
    `the raise must carry a valid high-tier type; submission=${JSON.stringify(sub)}`,
  );
  assert.ok(
    typeof sub.label === "string" && sub.label.length > 0,
    `the raise must carry a non-empty label as plaintext metadata; submission=${JSON.stringify(sub)}`,
  );

  // The plaintext value never appears in the raise submission.
  assert.ok(
    !JSON.stringify(sub).includes(RAISE_VALUE),
    `the plaintext value must never appear in the raise submission; submission=${JSON.stringify(sub)}`,
  );

  assert.equal(ctx.flow.getState().status, "saved", "a completed raise reports success");
  assert.equal(ctx.savedCount, 1, "a completed raise signals success exactly once");
});

test("AC2 — raising a field on an already-set-up vault unlocks the existing key (no new key)", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const save = makeSave();
  const raise = makeRaise();

  // The vault already exists (an earlier add set it up).
  const setup = makeFlow({ mode: "add", server, passkey, createKey, save });
  fillAdd(setup.flow, { value: SECRET_VALUE, label: "Passport" });
  await submitThroughPhrase(setup.flow);
  assert.equal(createKey.count, 1, "the earlier add created the vault key");

  // Now raise an existing low-tier field.
  const ctx = makeFlow({
    mode: "raise",
    field: { id: RAISE_FIELD_ID, value: RAISE_VALUE, label: "Driver licence" },
    server,
    passkey,
    createKey,
    save,
    raise,
  });
  await submitThroughPhrase(ctx.flow);

  assert.equal(createKey.count, 1, "raising does NOT create a new vault key when one exists");
  assert.equal(raise.count, 1, "the raise is submitted");
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, raise.subs[0]!.ciphertext),
    RAISE_VALUE,
    "the raise re-seals the field's value under the SAME vault key",
  );
});

// ═══ AC3 — a cancelled unlock saves nothing; the value never leaks ════════════════════

test("AC3 — cancelling the passkey prompt saves nothing and shows plain-English copy", async () => {
  const server = makeServer();
  const passkey = makePasskey({ cancelled: true });
  const createKey = makeCreateKey();
  const save = makeSave();
  const ctx = makeFlow({ mode: "add", server, passkey, createKey, save });

  fillAdd(ctx.flow, { value: SECRET_VALUE, label: "Passport" });
  await submitThroughPhrase(ctx.flow);

  assert.equal(passkey.calls.length, 1, "the passkey prompt was shown");
  assert.equal(server.posts.length, 0, "a cancelled prompt saves no unlock method");
  assert.equal(save.count, 0, "a cancelled prompt submits nothing");
  assert.equal(ctx.savedCount, 0, "a cancelled prompt signals no success — nothing was saved");

  const state = ctx.flow.getState();
  assert.equal(state.status, "error", "the control shows an error state the person can act on");
  assertPlainFailure(state.error, "cancelled passkey prompt");
});

test("AC3 — the plaintext value never appears in any request body, browser storage or the console", async () => {
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
    const server = makeServer();
    const passkey = makePasskey();
    const createKey = makeCreateKey();
    const save = makeSave();
    const ctx = makeFlow({ mode: "add", server, passkey, createKey, save });

    fillAdd(ctx.flow, { value: SECRET_VALUE, label: "Passport" });
    await submitThroughPhrase(ctx.flow);

    // Sanity: it DID submit a ciphertext that genuinely decrypts to the value ...
    assert.equal(
      await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, save.subs[0]!.ciphertext),
      SECRET_VALUE,
      "the value was sealed and submitted as ciphertext",
    );

    // ... but the plaintext value appears in NO request body (the unlock-method POSTs carry
    // only the wrapped vault key; the submission carries only the ciphertext + metadata) ...
    for (const post of server.posts) {
      assert.ok(
        !JSON.stringify(post).includes(SECRET_VALUE),
        `the plaintext value must never appear in an unlock-method request body; body=${JSON.stringify(post)}`,
      );
    }
    for (const sub of save.subs) {
      assert.ok(
        !JSON.stringify(sub).includes(SECRET_VALUE),
        `the plaintext value must never appear in the submission; submission=${JSON.stringify(sub)}`,
      );
    }

    // ... nor in browser storage ...
    for (const w of [...local.writes, ...session.writes]) {
      assert.ok(
        !String(w.value).includes(SECRET_VALUE) && !String(w.key).includes(SECRET_VALUE),
        `the value must never be written to browser storage, write: ${w.key}=${w.value}`,
      );
    }
    // ... and never to the console.
    for (const line of consoleOut) {
      assert.ok(!line.includes(SECRET_VALUE), `the value must never be logged to the console, line: "${line}"`);
    }
  } finally {
    for (const m of methods) console[m] = original[m]!;
    if (hadLocal) g.localStorage = origLocal;
    else delete g.localStorage;
    if (hadSession) g.sessionStorage = origSession;
    else delete g.sessionStorage;
  }
});

test("a refused save reports a plain-English error and does not claim success", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  // The server action refuses with a raw machine reason; the flow must not surface it raw.
  const save = makeSave({ ok: false, reason: "not_found" });
  const ctx = makeFlow({ mode: "add", server, passkey, createKey, save });

  fillAdd(ctx.flow, { value: SECRET_VALUE, label: "Passport" });
  await submitThroughPhrase(ctx.flow);

  assert.equal(save.count, 1, "the save was attempted");
  assert.equal(ctx.savedCount, 0, "a refused save signals no success");
  const state = ctx.flow.getState();
  assert.equal(state.status, "error", "a refused save shows an error state");
  assertPlainFailure(state.error, "refused save");
});

// ═══ the HighTierFlow component renders the right surface, open and closed ═════════════
//
// Rendered with react-dom/server (no DOM), reading the emitted markup — the same approach
// as every other component render test in the repo. Mounted with just its data props (the
// device seams are defaulted, so the initial render needs none and calls nothing).

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
function hasBoolAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}
function findAll(markup: string, tag: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}
function allButtons(markup: string): Array<{ name: string; disabled: boolean }> {
  return findAll(markup, "button").map((b) => ({
    name: (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim(),
    disabled: hasBoolAttr(b.attrs, "disabled"),
  }));
}
function liveButtons(markup: string): string[] {
  return allButtons(markup)
    .filter((b) => !b.disabled && b.name.length > 0)
    .map((b) => b.name);
}
function labelTextById(markup: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const l of findAll(markup, "label")) {
    const f = attr(l.attrs, "for");
    if (f) map[f] = visibleText(l.inner);
  }
  return map;
}
// Genuinely-editable value controls: a text-ish <input> / <textarea> that is neither
// disabled nor readonly (a checkbox/radio/hidden/submit is not a value control).
function editableFields(markup: string): Array<{ label: string; value: string }> {
  const NON_VALUE = new Set(["checkbox", "radio", "hidden", "submit", "button", "reset", "image", "file"]);
  const labels = labelTextById(markup);
  const out: Array<{ label: string; value: string }> = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1]!;
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (NON_VALUE.has(type)) continue;
    if (hasBoolAttr(attrs, "disabled") || hasBoolAttr(attrs, "readonly")) continue;
    const id = attr(attrs, "id");
    out.push({ label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(), value: attr(attrs, "value") ?? "" });
  }
  for (const t of findAll(markup, "textarea")) {
    if (hasBoolAttr(t.attrs, "disabled") || hasBoolAttr(t.attrs, "readonly")) continue;
    const id = attr(t.attrs, "id");
    out.push({ label: ((id && labels[id]) || attr(t.attrs, "aria-label") || "").trim(), value: visibleText(t.inner) });
  }
  return out;
}

const noopSave = async () => ({ ok: true as const });
const noopRaise = async () => ({ ok: true as const });
const RAISE_FIELD = { id: RAISE_FIELD_ID, value: "+61400778899", label: "Phone" };

test("the closed add panel offers a live Add-a-high-tier-detail control and no value fields", () => {
  const markup = renderToStaticMarkup(<HighTierFlow mode="add" saveHighTierField={noopSave} />);
  assert.ok(
    liveButtons(markup).some((n) => /add/i.test(n) && /high|tier|detail/i.test(n)),
    `the closed add panel must offer a live control to add a high-tier detail; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
  assert.deepEqual(
    editableFields(markup),
    [],
    `the closed add panel must show no value-entry field; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
});

test("the open add panel shows the protection explainer, a value field and a live confirm", () => {
  const markup = renderToStaticMarkup(
    <HighTierFlow mode="add" saveHighTierField={noopSave} initialOpen={true} />,
  );
  const text = visibleText(markup);

  // HOW it is protected — plain words about being sealed/locked to the device.
  assert.match(
    text,
    /lock|on your device|encrypt|seal|stays on your|never leaves your device/i,
    `the open add panel must explain HOW the detail is protected; text="${text}"`,
  );
  // WHO can ever read it — released only when the person approves; no one else.
  assert.match(
    text,
    /only you|no one else|nobody else|only when you (approve|allow|release)|released only|you approve/i,
    `the open add panel must explain WHO can ever read it; text="${text}"`,
  );
  // A live value-entry field to type the new detail into ...
  assert.ok(
    editableFields(markup).length >= 1,
    `the open add panel must offer a live value-entry field; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
  // ... and a live control to confirm/add it (the explicit sensitive-moment confirm).
  assert.ok(
    liveButtons(markup).some((n) => /add|save|confirm|continue/i.test(n)),
    `the open add panel must offer a live confirm/add control; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

test("the closed raise panel offers a live Make-protected control", () => {
  const markup = renderToStaticMarkup(
    <HighTierFlow mode="raise" field={RAISE_FIELD} raiseFieldToHighTier={noopRaise} />,
  );
  assert.ok(
    liveButtons(markup).some((n) => /make protected/i.test(n)),
    `the closed raise panel must offer a live "Make protected" control; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

test("the open raise panel shows the protection explainer and a live confirm", () => {
  const markup = renderToStaticMarkup(
    <HighTierFlow mode="raise" field={RAISE_FIELD} raiseFieldToHighTier={noopRaise} initialOpen={true} />,
  );
  const text = visibleText(markup);

  // Raising is a sensitive moment too: it pauses with a plain explainer — either the
  // generic sensitive-step copy or the device-protection explanation — before confirming.
  assert.match(
    text,
    /sensitive|take a moment|before (it|this)|lock|on your device|encrypt|seal|released only|approve|never (leaves|read)/i,
    `the open raise panel must show a sensitive-moment explainer; text="${text}"`,
  );
  assert.ok(
    liveButtons(markup).some((n) => /raise|save|confirm|continue/i.test(n)),
    `the open raise panel must offer a live confirm control; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
});

test("uses design tokens, never a raw hex colour (add + raise, open and closed)", () => {
  const variants = [
    <HighTierFlow mode="add" saveHighTierField={noopSave} />,
    <HighTierFlow mode="add" saveHighTierField={noopSave} initialOpen={true} />,
    <HighTierFlow mode="raise" field={RAISE_FIELD} raiseFieldToHighTier={noopRaise} />,
    <HighTierFlow mode="raise" field={RAISE_FIELD} raiseFieldToHighTier={noopRaise} initialOpen={true} />,
  ];
  for (const el of variants) {
    const markup = renderToStaticMarkup(el);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the HighTierFlow markup, got: ${markup}`,
    );
  }
});

// ═══ Review fix W1 — the vault recovery phrase ═══════════════════════════════════════

test("W1 — a first high-tier detail waits for a new recovery phrase to be saved, then seals under the same key", async () => {
  const server = makeServer();
  const save = makeSave();
  const { flow } = makeFlow({ mode: "add", server, passkey: makePasskey(), createKey: makeCreateKey(), save });
  fillAdd(flow, { value: "PA1234567", label: "Passport" });
  await flow.submit();

  assert.equal(flow.getState().status, "phrase");
  const phrase = flow.getUnlockState().newPhrase!;
  assert.equal(save.count, 0, "nothing is saved before the phrase is");

  flow.setPhraseSaved(true);
  await flow.confirmRecoveryPhrase();
  assert.equal(flow.getState().status, "saved");
  assert.equal(save.count, 1);
  assert.ok(bytesEqual(await unlockWithRecoveryPhrase(phrase, server.store.recovery!), FIXED_VK));
  for (const post of server.posts) {
    assert.ok(!JSON.stringify(post).includes(phrase.replace(/-/g, "")), "the phrase never leaves the device");
  }
});

test("W1 — the recovery phrase unlocks the vault for a new detail when the passkey can't", async () => {
  const server = makeServer();
  const createKey = makeCreateKey();
  const setup = makeFlow({ mode: "add", server, passkey: makePasskey(), createKey, save: makeSave() });
  fillAdd(setup.flow, { value: "PA1234567", label: "Passport" });
  await setup.flow.submit();
  const phrase = setup.flow.getUnlockState().newPhrase!;
  setup.flow.setPhraseSaved(true);
  await setup.flow.confirmRecoveryPhrase();

  const save = makeSave();
  // This device's passkey has no PRF result, so it can't unlock: the phrase does.
  const noPrf = {
    fn: async () => ({ clientExtensionResults: {} }),
    calls: [] as unknown[],
  } as unknown as Passkey;
  const ctx = makeFlow({ mode: "add", server, passkey: noPrf, createKey, save });
  fillAdd(ctx.flow, { value: "DL998877", label: "Driver licence" });
  ctx.flow.setUnlockMethod("recovery");
  ctx.flow.setRecoveryPhrase(phrase);
  await ctx.flow.submit();

  assert.equal(ctx.flow.getState().status, "saved", `error=${ctx.flow.getState().error}`);
  assert.equal(createKey.count, 1, "the original vault key, never a new one");
  assert.equal(await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, save.subs[0]!.ciphertext), "DL998877");
  assert.ok(ctx.flow.getUnlockState().notice, "a plain note says the phrase is needed on this device");
});

test("W1 — the open panel offers the recovery phrase as a way to unlock", () => {
  const html = renderToStaticMarkup(<HighTierFlow mode="add" initialOpen />);
  assert.match(html, /recovery phrase/i);
  assert.match(html, /vault passphrase/i);
});

// Card billing addresses (docs/adr/card-billing-addresses.md): a refused raise because a card uses
// the address says what to do, not a generic "couldn't save".
test("a raise refused because a card uses the address says to change the card's billing address first", async () => {
  const { BILLING_IN_USE_COPY } = await import("./high-tier-flow");
  const ctx = makeFlow({
    mode: "raise",
    field: { id: RAISE_FIELD_ID, value: RAISE_VALUE, label: "Home" },
    server: makeServer(),
    passkey: makePasskey(),
    createKey: makeCreateKey(),
    save: makeSave(),
    raise: makeRaise({ ok: false, reason: "billing_address_in_use" }),
  });
  await submitThroughPhrase(ctx.flow);
  assert.equal(ctx.flow.getState().status, "error");
  assert.equal(ctx.flow.getState().error, BILLING_IN_USE_COPY);
  assert.equal(ctx.savedCount, 0);
});
