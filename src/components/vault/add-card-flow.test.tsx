// E11-S19 — Set up the vault and add a card on this device
// (src/components/vault/add-card-flow.tsx).
//
// RED-first: src/components/vault/add-card-flow.tsx does NOT exist yet, so importing
// `./add-card-flow` throws and EVERY test in this file fails until the builder adds the
// component. That absence is the entire point of test-first — do NOT implement anything
// to make these pass.
//
// WHY this module exists (brief "Saved cards" / "Device-held protection" / "Vault unlock
// methods"; design §4.2 device-held vault; constitution 17 "no readable card numbers or
// security codes on Warthog's side"; INV-103): the cards page renders an "Add a card"
// control with NO behaviour and `sealCard` is never called, so no card can be saved. This
// task is the self-wired CLIENT flow behind that control. On this device it:
//   • on FIRST use creates the vault key in the browser (createVaultKey) and wraps it under
//     the person's passkey PRF — and, when a vault passphrase is chosen, ALSO under that
//     passphrase — saving each wrapped key via POST /api/vault/unlock-method;
//   • on LATER use unlocks the EXISTING vault key through the unlock-material endpoint
//     (GET /api/vault/unlock-material/passkey_prf) — no new key is created;
//   • seals the entered card number on the device (sealCard) and submits ONLY the
//     ciphertext plus plaintext metadata (brand, last four, expiry, nickname, billing
//     address) to the page's addCard action.
// The security code is NEVER collected here (it is typed only at release time, E11-S17).
//
// This file pins the TWO seams `add-card-flow.tsx` exports, exactly mirroring the repo's
// established split for a screen that is both render-testable AND interactive (SignupView +
// createSignupFlow; ReleaseApprove + createReleaseApproveFlow):
//
//   1. AddCardFlow — the Client Component the cards page / CardsView mounts as the "Add a
//      card" surface. Closed: a live "Add a card" control. Open: the sensitive-moment
//      explainer, the "security code is never stored" note, the billing-address picker, a
//      live card-number field (plus nickname / expiry and an optional "set a vault
//      passphrase" control) and a LIVE confirm that runs the device flow. It is a Client
//      Component, render-tested here with `react-dom/server` (no DOM — React component /
//      E2E testing is a per-job ADR), exactly like every other component render test.
//
//   2. createAddCardFlow(deps) — the framework-free, injectable controller behind the LIVE
//      confirm. The interactive behaviour — set up or unlock the vault key on this device,
//      seal the number, submit only the ciphertext + metadata — is tested by DRIVING THE
//      CONTROLLER with fake I/O seams and asserting what it DOES, never the source text.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the control RENDERS for its props, and what the controller
//     DOES for its inputs (the HTTP it makes, the key it creates vs unlocks, what it
//     submits) — never the source text of add-card-flow.tsx. A behaviour-preserving
//     refactor (reworded-but-still-plain copy, different wrappers, extra classes, a
//     different icon, a select vs radios) stays green.
//   * Only the I/O boundaries are faked (fetch, the WebAuthn PRF ceremony, the vault-key
//     entropy, the addCard submit). The REAL client/vault crypto runs (derive → wrap /
//     unwrap → seal), so "the ciphertext decrypts under the created key" and "a second card
//     uses the SAME key" are proven, not asserted by inspecting source.
//   * The device-seal step itself (sealCard — number → `v1:` ciphertext + last four, never
//     a security code) is already pinned by cards-view.test.tsx; these tests do not re-prove
//     it — they prove the flow CALLS it with the unlocked key and submits only its output.
//   * Absence checks ("the full number never appears in any request body / storage / the
//     console", "no security-code field") are scoped to the EXACT unit under test — the
//     bodies this flow actually sends and the one panel it renders.
//
// ─── the contract this task introduces (documented here as the cross-task contract) ───
//
//   createAddCardFlow(deps: {
//     billingAddresses?: readonly { id: string; value: string }[]; // billing-picker choices
//     fetch: typeof fetch;                 // GET /api/vault/unlock-material/<method>,
//                                          // POST /api/vault/unlock-method
//     startAuthentication: (opts: { optionsJSON: unknown }) => Promise<{
//       clientExtensionResults?: { prf?: { results?: { first?: string } } };
//     }>;                                  // the WebAuthn PRF assertion (OS passkey prompt);
//                                          // a dismissed prompt REJECTS. PRF output is
//                                          // base64url in clientExtensionResults.prf.results.first
//     createVaultKey: () => Uint8Array;    // fresh vault-key entropy; called ONLY on first use
//     addCard: (submission: {             // the page's addCard server action
//       brand: string; lastFour: string; expiryMonth: number; expiryYear: number;
//       nickname: string; billingAddressId: string; numberCiphertext: string;
//     }) => Promise<{ ok: boolean; reason?: string }>;
//     onChange?: () => void;               // re-render notifier (the component wires it)
//     onAdded?: () => void;                // called once on a completed save (list refresh)
//   }): AddCardController
//
//   AddCardController = {
//     getState(): AddCardState;            // a snapshot the component renders from
//     setNumber(v: string): void; setNickname(v: string): void;
//     setExpiryMonth(v: string): void; setExpiryYear(v: string): void;
//     setBillingAddressId(v: string): void;
//     setUsePassphrase(v: boolean): void; setPassphrase(v: string): void;
//     submit(): Promise<void>;             // set up / unlock the vault key → seal → addCard
//   }
//
//   AddCardState = {
//     number: string; nickname: string; expiryMonth: string; expiryYear: string;
//     billingAddressId: string; usePassphrase: boolean; passphrase: string;
//     status: "idle" | "working" | "added" | "error"; error?: string;
//   }
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { renderToStaticMarkup } from "react-dom/server";

import { AddCardFlow, createAddCardFlow } from "./add-card-flow";
import {
  deriveWrappingKeyFromPrf,
  deriveWrappingKeyFromPassphrase,
} from "@/client/vault/derive";
import { unwrapVaultKey, wrapVaultKey } from "@/client/vault/key";
import { unlockWithRecoveryPhrase } from "@/client/vault/recovery-phrase";
import { decryptValue } from "@/client/vault/values";

// ─── fixtures ────────────────────────────────────────────────────────────────────────

// Two Luhn-valid card numbers with distinctive, non-overlapping last fours so a "number
// leaked" scan and a "last four submitted" assertion are each unambiguous.
const VISA_NUMBER = "4242424242424242"; // last four 4242, a Visa BIN (starts with 4)
const MC_NUMBER = "5555555555554444"; // last four 4444, a Mastercard BIN (starts 55)

// A distinctive vault passphrase so a leak assertion can only match the real secret.
const VAULT_PASSPHRASE = "correct horse battery staple vault";

// A vault postal address the billing picker offers.
type VaultAddress = { id: string; value: string };
const ADDR_HOME: VaultAddress = { id: "addr-home", value: "12 Banksia Street, Perth" };
const ADDR_WORK: VaultAddress = { id: "addr-work", value: "5 Marine Parade, Fremantle" };

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
function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
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
// the shape E11-S18's getMaterial produces and E11-S17's control consumes.
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

type SavedPassphrase = { wrapped: string; salt: string };
type PostBody = { method: string; wrapped: string; params?: { salt?: string } };

// Review fix W1: the fake also keeps the 'recovery' envelope (the vault recovery phrase),
// answers the step-up endpoints, and — like the real endpoint — refuses to REPLACE an
// existing method (403 step_up_required) until the session has confirmed it's you.
function makeServer() {
  const store: {
    passkey_prf: string | null;
    passphrase: SavedPassphrase | null;
    recovery: string | null;
  } = {
    passkey_prf: null,
    passphrase: null,
    recovery: null,
  };
  const gets: string[] = [];
  const posts: PostBody[] = [];
  const stepUpPosts: string[] = [];
  let steppedUp = false;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (init && String(init.method).toUpperCase() === "POST") {
      if (url.startsWith("/api/auth/step-up/")) {
        stepUpPosts.push(String(init.body ?? ""));
        if (url.endsWith("/begin")) return json({ options: STEP_UP_OPTIONS });
        steppedUp = true;
        return json({ ok: true });
      }
      const body = JSON.parse(String(init.body)) as PostBody;
      posts.push(body);
      const exists =
        body.method === "passkey_prf"
          ? store.passkey_prf !== null
          : body.method === "passphrase"
            ? store.passphrase !== null
            : store.recovery !== null;
      if (exists && !steppedUp) return json({ error: "step_up_required" }, 403);
      if (body.method === "passkey_prf") store.passkey_prf = body.wrapped;
      else if (body.method === "passphrase") {
        store.passphrase = { wrapped: body.wrapped, salt: String(body.params?.salt) };
      } else if (body.method === "recovery") store.recovery = body.wrapped;
      return json({ ok: true });
    }
    gets.push(url);
    const proof = { challenge: "A".repeat(43), mode: Object.values(store).some(Boolean) ? "prove" : "enroll" };
    if (url.includes("/vault/unlock-material/recovery")) {
      return json({ wrapped: store.recovery, params: {}, options: null, proof });
    }
    if (url.includes("/vault/unlock-material/passkey_prf")) {
      return json({ wrapped: store.passkey_prf, params: null, options: PASSKEY_OPTIONS, proof });
    }
    if (url.includes("/vault/unlock-material/passphrase")) {
      return json({
        wrapped: store.passphrase?.wrapped ?? null,
        params: store.passphrase ? { salt: store.passphrase.salt } : null,
        options: null,
        proof,
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

  return { store, gets, posts, stepUpPosts, fetch };
}

// The step-up endpoint's assertion options (a distinct challenge from the material's).
const STEP_UP_OPTIONS = {
  rpId: "warthog.com.au",
  challenge: "c3RlcC11cA",
  userVerification: "required",
  extensions: { prf: {} },
};

// The WebAuthn PRF ceremony fake: returns the fixed PRF output (base64url) for the salt in
// the options it was handed, recording the options so we can prove the endpoint's options
// are used. A `cancelled` prompt REJECTS (the OS dialog dismissed).
function makePasskey(opts: { cancelled?: boolean; prf?: Uint8Array } = {}) {
  const calls: unknown[] = [];
  const fn = async ({ optionsJSON }: { optionsJSON: unknown }) => {
    calls.push(optionsJSON);
    if (opts.cancelled) throw new Error("The passkey prompt was dismissed.");
    return { id: "YQ", clientExtensionResults: { prf: { results: { first: toBase64Url(opts.prf ?? FIXED_PRF) } } } };
  };
  return {
    fn,
    get calls() {
      return calls;
    },
  };
}

// The vault-key entropy fake: hands back FIXED_VK and records every call (so "a second add
// creates no new key" is countable).
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

type Submission = {
  brand: string;
  lastFour: string;
  expiryMonth: number;
  expiryYear: number;
  nickname: string;
  billingAddressId: string;
  numberCiphertext: string;
};

function makeAddCard(result: { ok: boolean; reason?: string } = { ok: true }) {
  const subs: Submission[] = [];
  const fn = async (submission: Submission) => {
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
type AddCard = ReturnType<typeof makeAddCard>;

function makeFlow(server: Server, passkey: Passkey, createKey: CreateKey, addCard: AddCard) {
  const changes: true[] = [];
  const added: true[] = [];
  const flow = createAddCardFlow({
    billingAddresses: [ADDR_HOME, ADDR_WORK],
    fetch: server.fetch,
    startAuthentication: passkey.fn,
    createVaultKey: createKey.fn,
    addCard: addCard.fn,
    onChange: () => changes.push(true),
    onAdded: () => added.push(true),
  });
  return {
    flow,
    get changeCount() {
      return changes.length;
    },
    get addedCount() {
      return added.length;
    },
  };
}

// Confirm, and when the flow pauses on a new vault recovery phrase (a vault with none —
// review fix W1), tick "I've saved it" and carry on, as the person would.
async function submitThroughPhrase(flow: ReturnType<typeof makeFlow>["flow"]): Promise<void> {
  await flow.submit();
  if (flow.getState().status === "phrase") {
    flow.setPhraseSaved(true);
    await flow.confirmRecoveryPhrase();
  }
}

function fillCard(
  flow: ReturnType<typeof makeFlow>["flow"],
  opts: { number: string; nickname?: string; cardholderName?: string; month?: string; year?: string; billing?: string },
): void {
  flow.setNumber(opts.number);
  flow.setNickname(opts.nickname ?? "Everyday spending");
  flow.setCardholderName(opts.cardholderName ?? "Oren Levy");
  flow.setExpiryMonth(opts.month ?? "11");
  flow.setExpiryYear(opts.year ?? "2029");
  flow.setBillingAddressId(opts.billing ?? "addr-home");
}

// Recover the vault key the passkey envelope wraps, using the REAL derivation + unwrap with
// the fixed PRF output — so "the saved envelope genuinely wraps the created key" is proven.
async function vkFromPasskeyEnvelope(wrapped: string): Promise<Uint8Array> {
  const wrappingKey = await deriveWrappingKeyFromPrf(u8(FIXED_PRF) as Uint8Array<ArrayBuffer>);
  return unwrapVaultKey(wrappingKey, wrapped);
}

// A failure message must read as plain Australian English — a real sentence, never a raw
// machine code or crypto/protocol jargon — and never the card number or the passphrase
// (brief design_ux.copy; constitution INV-22).
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
  for (const secret of [VISA_NUMBER, VAULT_PASSPHRASE]) {
    assert.ok(!text.includes(secret), `${ctx}: failure copy must never leak a secret value, got: "${text}"`);
  }
}

// ═══ construction does nothing ════════════════════════════════════════════════════════

test("constructing the flow touches no device seam and submits nothing", () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const addCard = makeAddCard();
  makeFlow(server, passkey, createKey, addCard);

  assert.deepEqual(server.gets, [], "no unlock-material is read until the person adds a card");
  assert.deepEqual(server.posts, [], "no unlock method is saved on construction");
  assert.equal(passkey.calls.length, 0, "no passkey prompt is shown on construction");
  assert.equal(createKey.count, 0, "no vault key is created on construction");
  assert.equal(addCard.count, 0, "no card is submitted on construction");
});

// ═══ AC1 — a FIRST add sets up the vault key, saves it wrapped, and submits ciphertext ══

test("AC1 — a first add creates the vault key, saves its passkey-wrapped envelope, and submits only ciphertext + metadata", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const addCard = makeAddCard();
  const ctx = makeFlow(server, passkey, createKey, addCard);

  fillCard(ctx.flow, { number: VISA_NUMBER });
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

  // Exactly one vault key is created and saved passkey-wrapped (no passphrase method).
  assert.equal(createKey.count, 1, "a first add creates the vault key exactly once");
  assert.equal(
    server.posts.filter((p) => p.method === "passkey_prf").length,
    1,
    `the passkey-wrapped vault key is saved once via POST /api/vault/unlock-method; posts=${JSON.stringify(server.posts)}`,
  );
  assert.equal(
    server.posts.filter((p) => p.method === "passphrase").length,
    0,
    "no passphrase method is saved when none was chosen",
  );

  // The saved passkey envelope genuinely wraps the created vault key.
  assert.ok(typeof server.store.passkey_prf === "string", "the passkey envelope was stored");
  assert.ok(
    bytesEqual(await vkFromPasskeyEnvelope(server.store.passkey_prf!), FIXED_VK),
    "the saved passkey envelope must unwrap to the created vault key",
  );

  // Exactly one card is submitted, carrying ONLY the sealed ciphertext + plaintext metadata.
  assert.equal(addCard.count, 1, "the card is submitted exactly once");
  const sub = addCard.subs[0]!;
  assert.ok(
    typeof sub.numberCiphertext === "string" && sub.numberCiphertext.startsWith("v1:"),
    `the submission carries the sealed number as a "v1:" ciphertext; submission=${JSON.stringify(sub)}`,
  );
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, sub.numberCiphertext),
    VISA_NUMBER,
    "the submitted ciphertext decrypts to the entered number under the created vault key",
  );
  assert.equal(sub.lastFour, "4242", "the derived last four is submitted");
  assert.match(String(sub.brand), /visa/i, "the brand is derived from the number");
  assert.equal(sub.expiryMonth, 11, "the expiry month is submitted as a number");
  assert.equal(sub.expiryYear, 2029, "the expiry year is submitted as a number");
  assert.equal(sub.nickname, "Everyday spending", "the nickname is submitted");
  assert.equal(sub.billingAddressId, "addr-home", "the chosen billing address is submitted");

  // Only the sealed number leaves — never the full number, never a security code.
  assert.ok(
    !JSON.stringify(sub).includes(VISA_NUMBER),
    `the full card number must never appear in the submission; submission=${JSON.stringify(sub)}`,
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(sub, "securityCode"),
    `no security code is ever carried (none is collected here); submission=${JSON.stringify(sub)}`,
  );

  // It reports success so the list can refresh and show the new card's last four.
  assert.equal(ctx.flow.getState().status, "added", "a completed add reports success");
  assert.equal(ctx.flow.getState().error, undefined, "a completed add carries no error");
  assert.equal(ctx.addedCount, 1, "a completed add signals success exactly once");
});

test("AC1 — when a vault passphrase is chosen it is ALSO saved, wrapping the same vault key", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const addCard = makeAddCard();
  const ctx = makeFlow(server, passkey, createKey, addCard);

  fillCard(ctx.flow, { number: VISA_NUMBER });
  ctx.flow.setUsePassphrase(true);
  ctx.flow.setPassphrase(VAULT_PASSPHRASE);
  await submitThroughPhrase(ctx.flow);

  // Still exactly one vault key, now saved under BOTH methods.
  assert.equal(createKey.count, 1, "one vault key is created even when two unlock methods are saved");
  assert.equal(
    server.posts.filter((p) => p.method === "passkey_prf").length,
    1,
    "the passkey-wrapped key is saved",
  );
  assert.equal(
    server.posts.filter((p) => p.method === "passphrase").length,
    1,
    "the passphrase-wrapped key is ALSO saved",
  );

  // Both envelopes wrap the SAME created vault key.
  assert.ok(
    bytesEqual(await vkFromPasskeyEnvelope(server.store.passkey_prf!), FIXED_VK),
    "the passkey envelope wraps the created key",
  );
  const saved = server.store.passphrase!;
  assert.equal(typeof saved.salt, "string", "a passphrase method carries its PBKDF2 salt as a public param");
  const wrappingKey = await deriveWrappingKeyFromPassphrase(
    VAULT_PASSPHRASE,
    u8(fromBase64(saved.salt)) as Uint8Array<ArrayBuffer>,
  );
  assert.ok(
    bytesEqual(await unwrapVaultKey(wrappingKey, saved.wrapped), FIXED_VK),
    "the passphrase envelope unwraps to the SAME vault key under the chosen passphrase + its salt",
  );

  // The card submitted, and the entered passphrase is not kept in state afterwards.
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, addCard.subs[0]!.numberCiphertext),
    VISA_NUMBER,
    "the card ciphertext decrypts under the created key",
  );
  assert.equal(ctx.flow.getState().passphrase, "", "the vault passphrase is cleared from state after saving");
});

// ═══ AC2 — a SECOND add unlocks the existing key; no new key is created ════════════════

test("AC2 — a second add unlocks the existing vault key (no new key) and seals under that same key", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  const addCard = makeAddCard();

  // First card sets the vault up.
  const first = makeFlow(server, passkey, createKey, addCard);
  fillCard(first.flow, { number: VISA_NUMBER, nickname: "Everyday spending" });
  await submitThroughPhrase(first.flow);
  assert.equal(createKey.count, 1, "the first add created the vault key");
  const postsAfterFirst = server.posts.length;

  // Second card on the SAME account (same server state, same seams).
  const second = makeFlow(server, passkey, createKey, addCard);
  fillCard(second.flow, { number: MC_NUMBER, nickname: "Travel backup", billing: "addr-work" });
  await submitThroughPhrase(second.flow);

  // No new key, no new unlock method saved — it UNLOCKED the existing one.
  assert.equal(createKey.count, 1, "the second add does NOT create a new vault key");
  assert.equal(
    server.posts.length,
    postsAfterFirst,
    `the second add saves no new unlock method; posts=${JSON.stringify(server.posts)}`,
  );
  assert.equal(passkey.calls.length, 2, "the second add unlocks via the passkey PRF ceremony again");

  // Both cards' ciphertext decrypts under the SAME vault key the first add created.
  assert.equal(addCard.count, 2, "two cards were submitted");
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, addCard.subs[0]!.numberCiphertext),
    VISA_NUMBER,
    "the first card decrypts under the vault key",
  );
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, addCard.subs[1]!.numberCiphertext),
    MC_NUMBER,
    "the second card decrypts under the SAME vault key",
  );
  assert.equal(addCard.subs[1]!.lastFour, "4444", "the second card's last four is submitted");
  assert.match(String(addCard.subs[1]!.brand), /master/i, "the second card's brand is derived");
  assert.equal(second.flow.getState().status, "added", "the second add reports success");
});

// ═══ AC3 — the number never leaks; a cancelled prompt saves nothing + plain copy ══════

test("AC3 — cancelling the passkey prompt saves nothing and shows plain-English copy", async () => {
  const server = makeServer();
  const passkey = makePasskey({ cancelled: true });
  const createKey = makeCreateKey();
  const addCard = makeAddCard();
  const ctx = makeFlow(server, passkey, createKey, addCard);

  fillCard(ctx.flow, { number: VISA_NUMBER });
  await submitThroughPhrase(ctx.flow);

  assert.equal(passkey.calls.length, 1, "the passkey prompt was shown");
  assert.equal(server.posts.length, 0, "a cancelled prompt saves no unlock method");
  assert.equal(addCard.count, 0, "a cancelled prompt submits no card");
  assert.equal(ctx.addedCount, 0, "a cancelled prompt signals no success — nothing was saved");

  const state = ctx.flow.getState();
  assert.equal(state.status, "error", "the control shows an error state the person can act on");
  assertPlainFailure(state.error, "cancelled passkey prompt");
});

test("AC3 — the full card number never appears in any request body, browser storage or the console", async () => {
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
    const addCard = makeAddCard();
    const ctx = makeFlow(server, passkey, createKey, addCard);

    fillCard(ctx.flow, { number: VISA_NUMBER });
    ctx.flow.setUsePassphrase(true);
    ctx.flow.setPassphrase(VAULT_PASSPHRASE);
    await submitThroughPhrase(ctx.flow);

    // Sanity: it DID submit a ciphertext that genuinely decrypts to the number ...
    assert.equal(
      await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, addCard.subs[0]!.numberCiphertext),
      VISA_NUMBER,
      "the card was sealed and submitted as ciphertext",
    );

    // ... but the full number appears in NO request body (the unlock-method POSTs carry only
    // the wrapped vault key; the submission carries only the ciphertext + metadata) ...
    for (const post of server.posts) {
      assert.ok(
        !JSON.stringify(post).includes(VISA_NUMBER),
        `the full card number must never appear in an unlock-method request body; body=${JSON.stringify(post)}`,
      );
    }
    for (const sub of addCard.subs) {
      assert.ok(
        !JSON.stringify(sub).includes(VISA_NUMBER),
        `the full card number must never appear in the addCard submission; submission=${JSON.stringify(sub)}`,
      );
    }

    // ... nor in browser storage, and neither does the vault passphrase ...
    for (const w of [...local.writes, ...session.writes]) {
      for (const secret of [VISA_NUMBER, VAULT_PASSPHRASE]) {
        assert.ok(
          !String(w.value).includes(secret) && !String(w.key).includes(secret),
          `a secret must never be written to browser storage, write: ${w.key}=${w.value}`,
        );
      }
    }
    // ... and never to the console.
    for (const line of consoleOut) {
      for (const secret of [VISA_NUMBER, VAULT_PASSPHRASE]) {
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

test("a refused save reports a plain-English error and does not claim success", async () => {
  const server = makeServer();
  const passkey = makePasskey();
  const createKey = makeCreateKey();
  // The server action refuses with a raw machine reason; the flow must not surface it raw.
  const addCard = makeAddCard({ ok: false, reason: "not_found" });
  const ctx = makeFlow(server, passkey, createKey, addCard);

  fillCard(ctx.flow, { number: VISA_NUMBER });
  await submitThroughPhrase(ctx.flow);

  assert.equal(addCard.count, 1, "the save was attempted");
  assert.equal(ctx.addedCount, 0, "a refused save signals no success");
  const state = ctx.flow.getState();
  assert.equal(state.status, "error", "a refused save shows an error state");
  assertPlainFailure(state.error, "refused save");
});

// ═══ the AddCardFlow component renders the right surface, open and closed ══════════════
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
// The "label-ish" text that NAMES a field: <label>/<legend> text, input names/placeholders,
// select names, aria-labels — used to prove a security-code FIELD is absent (the note copy,
// which lives in a <p>, is NOT a field name).
function controlLabelText(markup: string): string {
  const parts: string[] = [];
  for (const l of findAll(markup, "label")) parts.push(visibleText(l.inner));
  for (const l of findAll(markup, "legend")) parts.push(visibleText(l.inner));
  for (const m of markup.matchAll(/aria-label="([^"]*)"/gi)) parts.push(decode(m[1]!));
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    for (const n of ["name", "placeholder"]) {
      const v = attr(m[1]!, n);
      if (v) parts.push(decode(v));
    }
  }
  for (const s of findAll(markup, "select")) {
    const n = attr(s.attrs, "name");
    if (n) parts.push(n);
  }
  return parts.join(" | ");
}
function nearInText(markup: string, needle: string, re: RegExp, window = 240): boolean {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return false;
  return re.test(vt.slice(Math.max(0, i - window), Math.min(vt.length, i + needle.length + window)));
}

const noopAddCard = async () => ({ ok: true as const });

test("the closed panel offers a live Add-a-card control and no value fields", () => {
  const markup = renderToStaticMarkup(
    <AddCardFlow billingAddresses={[ADDR_HOME, ADDR_WORK]} addCard={noopAddCard} />,
  );
  assert.ok(
    liveButtons(markup).some((n) => /add/i.test(n) && /card/i.test(n)),
    `the closed panel must offer a live control to add a card; live controls=${JSON.stringify(liveButtons(markup))}`,
  );
  assert.deepEqual(
    editableFields(markup),
    [],
    `the closed panel must show no value-entry field; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
});

test("the open panel shows the explainer, the 'security code is never stored' note, a billing picker, a live number field and a live confirm", () => {
  const markup = renderToStaticMarkup(
    <AddCardFlow billingAddresses={[ADDR_HOME, ADDR_WORK]} addCard={noopAddCard} initialOpen={true} />,
  );
  const text = visibleText(markup);

  // The sensitive-moment explainer (several plain phrasings, all strong "slow down / your
  // number is protected on this device" signals).
  assert.match(
    text,
    /sensitive|take a moment|before (it|this) (goes|is saved)|lock|on your device|seal|never (leaves|read)/i,
    `the open panel must show the sensitive-moment explainer; text="${text}"`,
  );

  // It refers to the card security code and notes it is never stored (plain Australian
  // English, so "security code" is expected, a "CVV"/"CVC" wording tolerated).
  assert.match(text, /security code|\bCVV\b|\bCVC\b/i, `the open panel must mention the security code; text="${text}"`);
  const codeTerm = /security code/i.test(text) ? "security code" : /CVC/i.test(text) ? "CVC" : "CVV";
  const neverStored = /\b(never|not|isn'?t|won'?t|don'?t|do not|no)\b[^.]*\b(stor|kept|keep|saved|save)\w*/i;
  assert.ok(
    nearInText(markup, codeTerm, neverStored),
    `the open panel must note the card security code is never stored; text="${text}"`,
  );

  // A billing-address picker drawn from the vault.
  for (const addr of [ADDR_HOME, ADDR_WORK]) {
    assert.ok(text.includes(addr.value), `the billing picker must offer "${addr.value}"; text="${text}"`);
  }
  const options = findAll(markup, "option").length;
  const radios = [...markup.matchAll(/<input\b[^>]*type="radio"[^>]*>/gi)].length;
  assert.ok(
    /<select\b/i.test(markup) || options >= 2 || radios >= 2,
    `the vault addresses must be offered as a selectable picker; markup=${markup}`,
  );

  // A live card-number value field and a live confirm control.
  assert.ok(
    editableFields(markup).length >= 1,
    `the open panel must offer a live card-number field; editable fields=${JSON.stringify(editableFields(markup))}`,
  );
  assert.ok(
    liveButtons(markup).some((n) => /add|save|confirm|continue/i.test(n)),
    `the open panel must offer a live confirm/add control; live controls=${JSON.stringify(liveButtons(markup))}`,
  );

  // The security code is NEVER collected here — no security-code FIELD (the note is copy).
  assert.ok(
    !/security code|\bcvv\b|\bcvc\b|security number|card code/i.test(controlLabelText(markup)),
    `the open panel must collect NO security code; control labels="${controlLabelText(markup)}"`,
  );
});

test("uses design tokens, never a raw hex colour (open and closed)", () => {
  for (const el of [
    <AddCardFlow billingAddresses={[ADDR_HOME, ADDR_WORK]} addCard={noopAddCard} />,
    <AddCardFlow billingAddresses={[ADDR_HOME, ADDR_WORK]} addCard={noopAddCard} initialOpen={true} />,
  ]) {
    const markup = renderToStaticMarkup(el);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the AddCardFlow markup, got: ${markup}`,
    );
  }
});

// ═══ Review fix G12 — no plaintext left on screen, no duplicate on a repeat Confirm, the
//     passphrase choice is honoured, and Confirm is never a dead end ═══════════════════

test("after a card is saved its number, expiry and name are cleared from the form", async () => {
  const server = makeServer();
  const { flow } = makeFlow(server, makePasskey(), makeCreateKey(), makeAddCard());
  fillCard(flow, { number: VISA_NUMBER });
  await submitThroughPhrase(flow);
  const state = flow.getState();
  assert.equal(state.status, "added");
  assert.equal(state.number, "", "the full card number does not stay on screen");
  assert.equal(state.expiryMonth, "");
  assert.equal(state.expiryYear, "");
  assert.equal(state.nickname, "");
});

test("a repeat Confirm after saving stores no second copy and asks for a card number", async () => {
  const server = makeServer();
  const addCard = makeAddCard();
  const passkey = makePasskey();
  const { flow } = makeFlow(server, passkey, makeCreateKey(), addCard);
  fillCard(flow, { number: VISA_NUMBER });
  await submitThroughPhrase(flow);
  await submitThroughPhrase(flow);
  assert.equal(addCard.count, 1, "only one card is stored");
  assert.equal(passkey.calls.length, 1, "the second Confirm never reaches the passkey prompt");
  assert.equal(flow.getState().status, "error");
  assert.match(flow.getState().error ?? "", /card number/i);
});

test("an incomplete card (short number, bad month, no name) is refused on the device and nothing is sent", async () => {
  for (const [label, opts] of [
    ["short number", { number: "4242" }],
    ["month 13", { number: VISA_NUMBER, month: "13" }],
    ["two-digit year", { number: VISA_NUMBER, year: "29" }],
    ["no name", { number: VISA_NUMBER, nickname: "   " }],
  ] as const) {
    const server = makeServer();
    const addCard = makeAddCard();
    const { flow } = makeFlow(server, makePasskey(), makeCreateKey(), addCard);
    fillCard(flow, opts);
    await submitThroughPhrase(flow);
    assert.equal(addCard.count, 0, `${label}: nothing is stored`);
    assert.equal(server.gets.length + server.posts.length, 0, `${label}: nothing leaves the device`);
    assert.equal(flow.getState().status, "error", label);
    assertPlainFailure(flow.getState().error, label);
  }
});

test("choosing a passphrase on an account that already has a vault wraps the EXISTING vault key with it", async () => {
  const server = makeServer();
  const createKey = makeCreateKey();
  const first = makeFlow(server, makePasskey(), createKey, makeAddCard());
  fillCard(first.flow, { number: VISA_NUMBER });
  await submitThroughPhrase(first.flow);
  assert.equal(server.store.passphrase, null, "no passphrase yet");

  const second = makeFlow(server, makePasskey(), createKey, makeAddCard());
  fillCard(second.flow, { number: MC_NUMBER });
  second.flow.setUsePassphrase(true);
  second.flow.setPassphrase(VAULT_PASSPHRASE);
  await submitThroughPhrase(second.flow);

  assert.equal(createKey.count, 1, "no new vault key");
  const saved = server.store.passphrase;
  assert.ok(saved, "the passphrase unlock method is saved");
  const wrappingKey = await deriveWrappingKeyFromPassphrase(
    VAULT_PASSPHRASE,
    fromBase64(saved!.salt) as Uint8Array<ArrayBuffer>,
  );
  assert.ok(
    bytesEqual(await unwrapVaultKey(wrappingKey, saved!.wrapped), FIXED_VK),
    "the passphrase opens the same vault key the passkey does",
  );
});

test("a vault passphrase shorter than 12 characters is refused before anything leaves the device", async () => {
  const server = makeServer();
  const addCard = makeAddCard();
  const { flow } = makeFlow(server, makePasskey(), makeCreateKey(), addCard);
  fillCard(flow, { number: VISA_NUMBER });
  flow.setUsePassphrase(true);
  flow.setPassphrase("hunter2");
  await submitThroughPhrase(flow);
  assert.equal(addCard.count, 0);
  assert.equal(server.gets.length + server.posts.length, 0);
  assert.match(flow.getState().error ?? "", /12/);
});

test("with no postal address on file there is no dead Confirm: the reason and a link to add one are shown", () => {
  const markup = renderToStaticMarkup(
    <AddCardFlow billingAddresses={[]} addCard={noopAddCard} initialOpen />,
  );
  assert.ok(!liveButtons(markup).some((n) => /^confirm$/i.test(n)), `no live Confirm; live=${JSON.stringify(liveButtons(markup))}`);
  assert.match(visibleText(markup), /postal address/i);
  assert.match(markup, /<a\b[^>]*href="\/vault"/);
});

// ═══ Review fix W1 — the vault recovery phrase ═══════════════════════════════════════

test("W1 — a first add shows a new recovery phrase and saves nothing until the person ticks 'I've saved it'", async () => {
  const server = makeServer();
  const addCard = makeAddCard();
  const { flow } = makeFlow(server, makePasskey(), makeCreateKey(), addCard);
  fillCard(flow, { number: VISA_NUMBER });
  await flow.submit();

  assert.equal(flow.getState().status, "phrase", "the flow pauses on the phrase");
  const phrase = flow.getUnlockState().newPhrase;
  assert.match(String(phrase), /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
  assert.equal(addCard.count, 0, "no card is saved before the phrase is");
  assert.equal(server.store.recovery, null, "no recovery envelope yet");

  await flow.confirmRecoveryPhrase();
  assert.equal(flow.getState().status, "phrase", "an unticked Continue keeps the phrase on screen");
  assertPlainFailure(flow.getState().error, "unticked");
  assert.equal(addCard.count, 0);

  flow.setPhraseSaved(true);
  await flow.confirmRecoveryPhrase();
  assert.equal(flow.getState().status, "added");
  assert.equal(addCard.count, 1);
  assert.equal(flow.getUnlockState().newPhrase, null, "the phrase is not kept once saved");
  assert.ok(
    bytesEqual(await unlockWithRecoveryPhrase(phrase!, server.store.recovery!), FIXED_VK),
    "the recovery envelope opens the vault key the card is sealed under",
  );
  for (const post of server.posts) {
    const body = JSON.stringify(post);
    assert.ok(!body.includes(phrase!) && !body.includes(phrase!.replace(/-/g, "")), "the phrase never leaves the device");
  }
});

test("W1 — an existing vault with no recovery phrase is asked for one once, then never again", async () => {
  const server = makeServer();
  server.store.passkey_prf = await wrapVaultKey(
    await deriveWrappingKeyFromPrf(u8(FIXED_PRF) as Uint8Array<ArrayBuffer>),
    u8(FIXED_VK) as Uint8Array<ArrayBuffer>,
  );
  const createKey = makeCreateKey();
  const first = makeFlow(server, makePasskey(), createKey, makeAddCard());
  fillCard(first.flow, { number: VISA_NUMBER });
  await first.flow.submit();
  assert.equal(first.flow.getState().status, "phrase", "the one-time prompt appears on the next unlock");
  first.flow.setPhraseSaved(true);
  await first.flow.confirmRecoveryPhrase();
  assert.equal(first.flow.getState().status, "added");
  assert.equal(createKey.count, 0, "the EXISTING vault key is sealed under the phrase, never a new one");

  const second = makeFlow(server, makePasskey(), createKey, makeAddCard());
  fillCard(second.flow, { number: MC_NUMBER });
  await second.flow.submit();
  assert.equal(second.flow.getState().status, "added", "no second prompt");
});

test("W1 — after losing the passkey, the recovery phrase unlocks the vault and this device's new passkey takes over", async () => {
  const server = makeServer();
  const createKey = makeCreateKey();
  const first = makeFlow(server, makePasskey(), createKey, makeAddCard());
  fillCard(first.flow, { number: VISA_NUMBER });
  await first.flow.submit();
  const phrase = first.flow.getUnlockState().newPhrase!;
  first.flow.setPhraseSaved(true);
  await first.flow.confirmRecoveryPhrase();

  // A new passkey (a different PRF output) cannot open the old passkey envelope.
  const NEW_PRF = bytes(32, 23);
  const newPasskey = makePasskey({ prf: NEW_PRF });
  const addCard = makeAddCard();
  const second = makeFlow(server, newPasskey, createKey, addCard);
  fillCard(second.flow, { number: MC_NUMBER });
  second.flow.setUnlockMethod("recovery");
  second.flow.setRecoveryPhrase(phrase.toLowerCase().replace(/-/g, " "));
  await second.flow.submit();

  assert.equal(second.flow.getState().status, "added", `saved; error=${second.flow.getState().error}`);
  assert.equal(createKey.count, 1, "no new vault key — the original one is recovered");
  assert.equal(
    await decryptValue(FIXED_VK as Uint8Array<ArrayBuffer>, addCard.subs[0]!.numberCiphertext),
    MC_NUMBER,
    "the card is sealed under the original vault key",
  );
  assert.equal(newPasskey.calls.length, 1, "one passkey prompt re-seals the vault and confirms it's you");
  const resealed = await unwrapVaultKey(
    await deriveWrappingKeyFromPrf(u8(NEW_PRF) as Uint8Array<ArrayBuffer>),
    server.store.passkey_prf!,
  );
  assert.ok(bytesEqual(resealed, FIXED_VK), "the new passkey now opens the vault");
  for (const body of server.stepUpPosts) {
    assert.ok(!body.includes(toBase64Url(NEW_PRF)), "the PRF output never reaches the server");
  }
  assert.match(String(second.flow.getUnlockState().notice), /passkey/i);
});

test("W1 — a wrong recovery phrase saves nothing and says so plainly", async () => {
  const server = makeServer();
  const first = makeFlow(server, makePasskey(), makeCreateKey(), makeAddCard());
  fillCard(first.flow, { number: VISA_NUMBER });
  await submitThroughPhrase(first.flow);

  const addCard = makeAddCard();
  const second = makeFlow(server, makePasskey(), makeCreateKey(), addCard);
  fillCard(second.flow, { number: MC_NUMBER });
  second.flow.setUnlockMethod("recovery");
  second.flow.setRecoveryPhrase("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
  await second.flow.submit();
  assert.equal(second.flow.getState().status, "error");
  assertPlainFailure(second.flow.getState().error, "wrong phrase");
  assert.equal(addCard.count, 0);
});

test("W1 — replacing an existing vault passphrase without a fresh step-up offers 'Confirm it's you' and saves no card", async () => {
  const server = makeServer();
  const first = makeFlow(server, makePasskey(), makeCreateKey(), makeAddCard());
  fillCard(first.flow, { number: VISA_NUMBER });
  first.flow.setUsePassphrase(true);
  first.flow.setPassphrase(VAULT_PASSPHRASE);
  await submitThroughPhrase(first.flow);
  const kept = server.store.passphrase;

  const addCard = makeAddCard();
  const second = makeFlow(server, makePasskey(), makeCreateKey(), addCard);
  fillCard(second.flow, { number: MC_NUMBER });
  second.flow.setUsePassphrase(true);
  second.flow.setPassphrase("another long vault passphrase");
  await second.flow.submit();

  assert.equal(second.flow.getState().confirmRequired, true, "Confirm it's you is offered inline");
  assertPlainFailure(second.flow.getState().error, "passphrase step-up");
  assert.equal(addCard.count, 0, "no card is saved while the passphrase change is pending");
  assert.deepEqual(server.store.passphrase, kept, "the stored passphrase is unchanged");

  const html = renderToStaticMarkup(
    <AddCardFlow billingAddresses={[ADDR_HOME]} addCard={async () => ({ ok: true })} initialOpen />,
  );
  assert.match(html, /recovery phrase/i, "the open panel offers unlocking with the recovery phrase");
});

// ═══ Review fix W6 — the name on the card ══════════════════════════════════════════════
//
// A checkout needs the cardholder name, so the form asks for it ("Name on card"), pre-filled
// with the person's saved name from About you, and sends it with the other plaintext metadata.

test("W6 — the open panel has a Name on card field, pre-filled with the person's saved name", () => {
  const markup = renderToStaticMarkup(
    <AddCardFlow
      billingAddresses={[ADDR_HOME, ADDR_WORK]}
      addCard={noopAddCard}
      initialOpen={true}
      defaultCardholderName="Oren Quokka Levy"
    />,
  );
  const field = editableFields(markup).find((f) => /name on card/i.test(f.label));
  assert.ok(field, `the panel offers a "Name on card" field; fields=${JSON.stringify(editableFields(markup))}`);
  assert.equal(field!.value, "Oren Quokka Levy", "it starts with the saved name");

  const empty = renderToStaticMarkup(
    <AddCardFlow billingAddresses={[ADDR_HOME]} addCard={noopAddCard} initialOpen={true} />,
  );
  const blank = editableFields(empty).find((f) => /name on card/i.test(f.label));
  assert.ok(blank, "the field is there with no saved name too");
  assert.equal(blank!.value, "", "and starts empty");
});

test("W6 — the name on the card is submitted with the card, and reset to the saved name after", async () => {
  const server = makeServer();
  const addCard = makeAddCard();
  const flow = createAddCardFlow({
    billingAddresses: [ADDR_HOME],
    defaultCardholderName: "Oren Quokka Levy",
    fetch: server.fetch,
    startAuthentication: makePasskey().fn,
    createVaultKey: makeCreateKey().fn,
    addCard: addCard.fn,
  });
  assert.equal(flow.getState().cardholderName, "Oren Quokka Levy", "the saved name pre-fills the field");
  flow.setNumber(VISA_NUMBER);
  flow.setNickname("Everyday spending");
  flow.setCardholderName("  O Q Levy  ");
  flow.setExpiryMonth("11");
  flow.setExpiryYear("2029");
  await submitThroughPhrase(flow);
  assert.equal(addCard.count, 1, "the card is submitted");
  assert.equal(
    (addCard.subs[0] as unknown as { cardholderName: string }).cardholderName,
    "O Q Levy",
    "the name on the card travels with the metadata, trimmed",
  );
  assert.equal(flow.getState().status, "added");
  assert.equal(flow.getState().cardholderName, "Oren Quokka Levy", "the field goes back to the saved name");
});

test("W6 — a blank name on the card is refused on the device and nothing is sent", async () => {
  const server = makeServer();
  const addCard = makeAddCard();
  const { flow } = makeFlow(server, makePasskey(), makeCreateKey(), addCard);
  fillCard(flow, { number: VISA_NUMBER, cardholderName: "   " });
  await submitThroughPhrase(flow);
  assert.equal(addCard.count, 0, "nothing is stored");
  assert.equal(server.gets.length + server.posts.length, 0, "nothing leaves the device");
  assert.equal(flow.getState().status, "error");
  assertPlainFailure(flow.getState().error, "blank name on card");
  assert.match(flow.getState().error ?? "", /name on the card/i, "the copy says what to fix");
});
