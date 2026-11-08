// Review fix W1 — the device vault helper (`src/client/vault/device-vault.ts`): the one
// client seam every vault-unlocking flow (add a card, add a high-tier detail, release from
// the inbox, Vault settings) composes to set up, unlock and re-seal the vault key on this
// device. Only the I/O boundaries are faked (fetch, the passkey ceremony); the real
// client/vault crypto runs, so "the envelope unwraps to the same vault key" is proven.
//
// The fake server below behaves like the real endpoints after review fix W1.1: an unlock
// method is INSERT-ONLY unless the session confirmed "it's you" (step-up finish), in which
// case a save replaces it; anything else is 403 step_up_required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { createDeviceVault, StepUpRequiredError } from "./device-vault";
import { deriveWrappingKeyFromPrf } from "./derive";
import { unwrapVaultKey, wrapVaultKey } from "./key";
import { generateRecoveryPhrase, unlockWithRecoveryPhrase, wrapVaultKeyWithRecoveryPhrase } from "./recovery-phrase";

function bytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_unused, i) => (i * seed + seed) & 0xff);
}
const VK = bytes(32, 11);
const OTHER_VK = bytes(32, 5);
const PRF_A = bytes(32, 7); // the passkey the vault was set up with
const PRF_B = bytes(32, 9); // a new passkey (e.g. after account recovery)
const PRF_SALT = bytes(32, 13);

function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}
function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}
async function wrapUnderPrf(prf: Uint8Array<ArrayBuffer>, vk: Uint8Array<ArrayBuffer>): Promise<string> {
  return wrapVaultKey(await deriveWrappingKeyFromPrf(prf), vk);
}

const MATERIAL_OPTIONS = {
  rpId: "warthog.com.au",
  challenge: "bWF0ZXJpYWw",
  userVerification: "required",
  extensions: { prf: { eval: { first: b64url(PRF_SALT) } } },
};
const STEP_UP_OPTIONS = {
  rpId: "warthog.com.au",
  challenge: "c3RlcC11cA",
  userVerification: "required",
  extensions: { prf: {} },
};

type Method = "passkey_prf" | "passphrase" | "recovery";
type Row = { wrapped: string; params: Record<string, unknown> };

function makeServer(initial: Partial<Record<Method, Row>> = {}) {
  const store: Partial<Record<Method, Row>> = { ...initial };
  const bodies: string[] = [];
  const calls: string[] = [];
  let steppedUp = false;
  // Simulates another tab winning a first-time save between this tab's GET and POST.
  let raceWinner: { method: Method; row: Row } | null = null;

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    if (init?.body != null) bodies.push(String(init.body));
    if (method === "GET" && url.startsWith("/api/vault/unlock-material/")) {
      const m = url.split("/").pop() as Method;
      const row = store[m];
      return json(200, {
        wrapped: row?.wrapped ?? null,
        params: row?.params ?? {},
        options: m === "passkey_prf" ? MATERIAL_OPTIONS : null,
      });
    }
    if (method === "POST" && url === "/api/vault/unlock-method") {
      if (raceWinner) {
        store[raceWinner.method] = raceWinner.row;
        raceWinner = null;
      }
      const body = JSON.parse(String(init?.body)) as { method: Method; wrapped: string; params?: Record<string, unknown> };
      if (store[body.method] && !steppedUp) return json(403, { error: "step_up_required" });
      store[body.method] = { wrapped: body.wrapped, params: body.params ?? {} };
      return json(200, { ok: true });
    }
    if (method === "POST" && url === "/api/auth/step-up/begin") return json(200, { options: STEP_UP_OPTIONS });
    if (method === "POST" && url === "/api/auth/step-up/finish") {
      steppedUp = true;
      return json(200, { ok: true });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;

  return {
    store,
    bodies,
    calls,
    fetch,
    stepUp() {
      steppedUp = true;
    },
    loseFirstSaveTo(m: Method, row: Row) {
      raceWinner = { method: m, row };
    },
  };
}

function makePasskey(prf: Uint8Array | null, opts: { cancelled?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const fn = async ({ optionsJSON }: { optionsJSON: unknown }) => {
    calls.push(optionsJSON as Record<string, unknown>);
    if (opts.cancelled) throw new Error("dismissed");
    return {
      id: "cred-b",
      rawId: "cred-b",
      type: "public-key",
      response: { clientDataJSON: "cdj", authenticatorData: "ad", signature: "sig" },
      clientExtensionResults: prf ? { prf: { results: { first: b64url(prf) } } } : {},
    };
  };
  return { fn, calls };
}

function vaultFor(server: ReturnType<typeof makeServer>, passkey: ReturnType<typeof makePasskey>) {
  return createDeviceVault({ fetch: server.fetch, startAuthentication: passkey.fn, createVaultKey: () => VK });
}

test("a passkey unlock sets the vault up on first use: a new key, saved sealed under the passkey", async () => {
  const server = makeServer();
  const passkey = makePasskey(PRF_A);
  const result = await vaultFor(server, passkey).unlockWithPasskey({ createIfMissing: true });
  assert.equal(result.created, true);
  assert.equal(hex(result.vaultKey), hex(VK));
  assert.deepEqual(passkey.calls[0], MATERIAL_OPTIONS, "the ceremony uses the endpoint's PRF options");
  const stored = server.store.passkey_prf!.wrapped;
  assert.equal(hex(await unwrapVaultKey(await deriveWrappingKeyFromPrf(PRF_A), stored)), hex(VK));
});

test("a passkey unlock on later use unwraps the existing key and saves nothing", async () => {
  const server = makeServer({ passkey_prf: { wrapped: await wrapUnderPrf(PRF_A, OTHER_VK), params: {} } });
  const result = await vaultFor(server, makePasskey(PRF_A)).unlockWithPasskey({ createIfMissing: true });
  assert.equal(result.created, false);
  assert.equal(hex(result.vaultKey), hex(OTHER_VK));
  assert.ok(!server.calls.some((c) => c.startsWith("POST")), "nothing is saved");
});

test("two tabs setting up at once: the losing tab adopts the winner's key instead of a second one", async () => {
  const server = makeServer();
  server.loseFirstSaveTo("passkey_prf", { wrapped: await wrapUnderPrf(PRF_A, OTHER_VK), params: {} });
  const result = await vaultFor(server, makePasskey(PRF_A)).unlockWithPasskey({ createIfMissing: true });
  assert.equal(hex(result.vaultKey), hex(OTHER_VK), "the vault key every saved item uses");
  assert.equal(result.created, false);
});

test("a passkey whose device cannot unlock (no PRF result) is refused, nothing is created", async () => {
  const server = makeServer();
  await assert.rejects(vaultFor(server, makePasskey(null)).unlockWithPasskey({ createIfMissing: true }));
  assert.equal(server.store.passkey_prf, undefined);
});

test("hasRecoveryPhrase reports whether a recovery envelope is saved", async () => {
  assert.equal(await vaultFor(makeServer(), makePasskey(PRF_A)).hasRecoveryPhrase(), false);
  const withPhrase = makeServer({ recovery: { wrapped: "v1:AAAA", params: {} } });
  assert.equal(await vaultFor(withPhrase, makePasskey(PRF_A)).hasRecoveryPhrase(), true);
});

test("saving a recovery phrase stores an envelope only that phrase opens, and never sends the phrase", async () => {
  const server = makeServer();
  const phrase = generateRecoveryPhrase();
  await vaultFor(server, makePasskey(PRF_A)).saveRecoveryPhrase(VK, phrase);
  const stored = server.store.recovery!.wrapped;
  assert.equal(hex(await unlockWithRecoveryPhrase(phrase, stored)), hex(VK));
  for (const body of server.bodies) {
    assert.ok(!body.includes(phrase) && !body.includes(phrase.replace(/-/g, "")), "the phrase never leaves the device");
  }
});

test("replacing an existing recovery phrase without a step-up throws StepUpRequiredError and changes nothing", async () => {
  const server = makeServer({ recovery: { wrapped: "v1:KEPT", params: {} } });
  await assert.rejects(
    vaultFor(server, makePasskey(PRF_A)).saveRecoveryPhrase(VK, generateRecoveryPhrase()),
    (error: unknown) => error instanceof StepUpRequiredError,
  );
  assert.equal(server.store.recovery!.wrapped, "v1:KEPT");
});

test("replacing it after confirming it's you overwrites the recovery method", async () => {
  const server = makeServer({ recovery: { wrapped: "v1:OLD", params: {} } });
  server.stepUp();
  const phrase = generateRecoveryPhrase();
  await vaultFor(server, makePasskey(PRF_A)).saveRecoveryPhrase(VK, phrase);
  assert.equal(hex(await unlockWithRecoveryPhrase(phrase, server.store.recovery!.wrapped)), hex(VK));
});

test("unlocking with the recovery phrase recovers the vault key; a wrong phrase or none saved is refused", async () => {
  const phrase = generateRecoveryPhrase();
  const server = makeServer({ recovery: { wrapped: await wrapVaultKeyWithRecoveryPhrase(phrase, VK), params: {} } });
  const vault = vaultFor(server, makePasskey(PRF_A));
  assert.equal(hex(await vault.unlockWithRecoveryPhrase(phrase.toLowerCase())), hex(VK));
  await assert.rejects(vault.unlockWithRecoveryPhrase(generateRecoveryPhrase()));
  await assert.rejects(vaultFor(makeServer(), makePasskey(PRF_A)).unlockWithRecoveryPhrase(phrase));
});

test("after a phrase unlock, adopting this device's new passkey re-seals the vault key under it with ONE prompt", async () => {
  const server = makeServer({ passkey_prf: { wrapped: await wrapUnderPrf(PRF_A, VK), params: {} } });
  const passkey = makePasskey(PRF_B);
  const outcome = await vaultFor(server, passkey).adoptPasskey(VK);
  assert.equal(outcome, "adopted");
  assert.equal(passkey.calls.length, 1, "one passkey prompt both confirms it's you and unlocks");
  const options = passkey.calls[0]!;
  assert.equal(options.challenge, STEP_UP_OPTIONS.challenge, "the step-up challenge is the one signed");
  assert.deepEqual(options.extensions, MATERIAL_OPTIONS.extensions, "the ceremony asks for the vault PRF");
  assert.ok(server.calls.includes("POST /api/auth/step-up/finish"), "the step-up is completed");
  for (const body of server.bodies) {
    assert.ok(!body.includes(b64url(PRF_B)), "the passkey's PRF output never reaches the server");
  }
  const resealed = server.store.passkey_prf!.wrapped;
  assert.equal(hex(await unwrapVaultKey(await deriveWrappingKeyFromPrf(PRF_B), resealed)), hex(VK));
});

test("adopting a passkey that already unlocks saves nothing", async () => {
  const server = makeServer({ passkey_prf: { wrapped: await wrapUnderPrf(PRF_A, VK), params: {} } });
  const before = server.store.passkey_prf!.wrapped;
  assert.equal(await vaultFor(server, makePasskey(PRF_A)).adoptPasskey(VK), "unchanged");
  assert.equal(server.store.passkey_prf!.wrapped, before);
});

test("adopting a passkey whose device cannot unlock leaves the vault as it was", async () => {
  const server = makeServer({ passkey_prf: { wrapped: await wrapUnderPrf(PRF_A, VK), params: {} } });
  const before = server.store.passkey_prf!.wrapped;
  assert.equal(await vaultFor(server, makePasskey(null)).adoptPasskey(VK), "unsupported");
  assert.equal(server.store.passkey_prf!.wrapped, before);
});

test("a cancelled adopt prompt rejects and saves nothing", async () => {
  const server = makeServer({ passkey_prf: { wrapped: await wrapUnderPrf(PRF_A, VK), params: {} } });
  const before = server.store.passkey_prf!.wrapped;
  await assert.rejects(vaultFor(server, makePasskey(PRF_B, { cancelled: true })).adoptPasskey(VK));
  assert.equal(server.store.passkey_prf!.wrapped, before);
});
