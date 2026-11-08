// Review fix W1 — the shared "get the vault key on this device" step
// (src/components/vault/vault-key-step.tsx) that the add-card and high-tier flows run before
// they seal anything, plus its two views: the unlock choice (passkey, vault passphrase or
// recovery phrase) and the once-only recovery-phrase reveal.
//
// The controller is driven over a fake DeviceVault (its own seam is pinned by
// src/client/vault/device-vault.test.ts); the views are rendered with react-dom/server, as
// every component test in this repo is.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createVaultKeyStep,
  RecoveryPhraseReveal,
  VaultUnlockChoice,
} from "./vault-key-step";
import type { AdoptOutcome, DeviceVault } from "@/client/vault/device-vault";
import { StepUpRequiredError } from "@/client/vault/device-vault";

const VK = new Uint8Array(32).fill(7);

function makeVault(opts: { hasPhrase?: boolean; adopt?: AdoptOutcome | "fail"; saveFails?: unknown } = {}) {
  const calls: string[] = [];
  const saved: string[] = [];
  let hasPhrase = opts.hasPhrase ?? false;
  const vault: DeviceVault = {
    async unlockWithPasskey(o) {
      calls.push(`passkey:${o.createIfMissing}`);
      return { vaultKey: VK, created: false };
    },
    async unlockWithPassphrase(p) {
      calls.push(`passphrase:${p}`);
      return VK;
    },
    async unlockWithRecoveryPhrase(p) {
      calls.push(`recovery:${p}`);
      return VK;
    },
    async hasRecoveryPhrase() {
      calls.push("hasRecoveryPhrase");
      return hasPhrase;
    },
    async saveRecoveryPhrase(_vk, phrase) {
      calls.push("saveRecoveryPhrase");
      if (opts.saveFails) throw opts.saveFails;
      saved.push(phrase);
      hasPhrase = true;
    },
    async savePassphrase() {
      calls.push("savePassphrase");
    },
    async adoptPasskey() {
      calls.push("adoptPasskey");
      if (opts.adopt === "fail") throw new Error("cancelled");
      return opts.adopt ?? "adopted";
    },
  };
  return { vault, calls, saved };
}

test("a passkey unlock on a vault that already has a recovery phrase hands back the key with no reveal", async () => {
  const { vault, calls } = makeVault({ hasPhrase: true });
  const step = createVaultKeyStep({ vault, createIfMissing: true });
  const got = await step.obtain();
  assert.equal(got.kind, "key");
  assert.deepEqual(calls, ["passkey:true", "hasRecoveryPhrase"]);
  assert.equal(step.getState().newPhrase, null);
});

test("a vault with no recovery phrase pauses on a freshly generated phrase before handing back the key", async () => {
  const { vault, saved } = makeVault({ hasPhrase: false });
  const step = createVaultKeyStep({ vault, createIfMissing: true });
  const got = await step.obtain();
  assert.equal(got.kind, "reveal");
  const phrase = step.getState().newPhrase;
  assert.match(String(phrase), /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/, "a grouped 160-bit phrase is shown");
  assert.deepEqual(saved, [], "nothing is saved until the person says they have saved it");
});

test("the phrase is saved only after the 'I've saved it' tick, then the key is handed back and the phrase forgotten", async () => {
  const { vault, saved } = makeVault({ hasPhrase: false });
  const step = createVaultKeyStep({ vault, createIfMissing: true });
  await step.obtain();
  const phrase = step.getState().newPhrase!;

  await assert.rejects(step.confirmPhrase(), "an unticked confirmation saves nothing");
  assert.deepEqual(saved, []);

  step.setPhraseSaved(true);
  const vaultKey = await step.confirmPhrase();
  assert.equal(vaultKey, VK);
  assert.deepEqual(saved, [phrase], "the shown phrase is the one the vault key is sealed under");
  assert.equal(step.getState().newPhrase, null, "the phrase is not kept once saved");
  assert.equal(step.getState().phraseSaved, false);
});

test("cancelling the reveal forgets the phrase and the pending key", async () => {
  const { vault } = makeVault({ hasPhrase: false });
  const step = createVaultKeyStep({ vault, createIfMissing: true });
  await step.obtain();
  step.cancelPhrase();
  assert.equal(step.getState().newPhrase, null);
  await assert.rejects(step.confirmPhrase());
});

test("a passphrase unlock uses the typed passphrase", async () => {
  const { vault, calls } = makeVault({ hasPhrase: true });
  const step = createVaultKeyStep({ vault, createIfMissing: true });
  step.setMethod("passphrase");
  step.setPassphrase("a long vault passphrase");
  assert.equal((await step.obtain()).kind, "key");
  assert.deepEqual(calls, ["passphrase:a long vault passphrase", "hasRecoveryPhrase"]);
});

test("a recovery-phrase unlock re-seals the vault key under this device's passkey and says so", async () => {
  const { vault, calls } = makeVault({ hasPhrase: true, adopt: "adopted" });
  const step = createVaultKeyStep({ vault, createIfMissing: true });
  step.setMethod("recovery");
  step.setRecoveryPhrase("abcd efgh");
  const got = await step.obtain();
  assert.equal(got.kind, "key");
  assert.deepEqual(calls, ["recovery:abcd efgh", "adoptPasskey"]);
  assert.match(String(step.getState().notice), /passkey/i);
  assert.equal(step.getState().recoveryPhrase, "", "the typed phrase is cleared once used");
});

test("a failed or unsupported passkey adoption never blocks the unlock", async () => {
  for (const adopt of ["fail", "unsupported"] as const) {
    const { vault } = makeVault({ hasPhrase: true, adopt });
    const step = createVaultKeyStep({ vault, createIfMissing: true });
    step.setMethod("recovery");
    step.setRecoveryPhrase("abcd");
    assert.equal((await step.obtain()).kind, "key", `${adopt}: the vault still unlocks`);
    assert.ok(step.getState().notice, `${adopt}: a plain note explains what happens next time`);
  }
});

test("a step-up refusal while saving the phrase propagates and keeps the phrase on screen", async () => {
  const { vault } = makeVault({ hasPhrase: false, saveFails: new StepUpRequiredError() });
  const step = createVaultKeyStep({ vault, createIfMissing: true });
  await step.obtain();
  step.setPhraseSaved(true);
  await assert.rejects(step.confirmPhrase(), StepUpRequiredError);
  assert.ok(step.getState().newPhrase, "the phrase stays so the person can try again");
});

test("obtain({ newPhrase: true }) always pauses on a new phrase, even when one exists (replacing it)", async () => {
  const { vault, calls } = makeVault({ hasPhrase: true });
  const step = createVaultKeyStep({ vault, createIfMissing: false });
  const got = await step.obtain({ newPhrase: true });
  assert.equal(got.kind, "reveal");
  assert.ok(step.getState().newPhrase);
  assert.deepEqual(calls, ["passkey:false"], "no need to ask whether a phrase exists");
});

// ─── the views ─────────────────────────────────────────────────────────────────────────

test("the reveal shows the phrase once, with real Copy and Download controls and an 'I've saved it' tick", () => {
  const html = renderToStaticMarkup(
    <RecoveryPhraseReveal
      phrase="ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567"
      saved={false}
      onSavedChange={() => {}}
      onContinue={() => {}}
    />,
  );
  assert.ok(html.includes("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567"));
  assert.match(html, />Copy</);
  assert.match(html, />Download</);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /I(&#x27;|')ve saved/);
  assert.match(html, /only (see|be shown) it once|only see this once/i);
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(html), "design tokens only, never a raw hex colour");
});

test("the unlock choice offers passkey, vault passphrase and recovery phrase, each a labelled control", () => {
  const html = renderToStaticMarkup(
    <VaultUnlockChoice
      state={{ method: "recovery", passphrase: "", recoveryPhrase: "", newPhrase: null, phraseSaved: false, notice: null }}
      onMethod={() => {}}
      onPassphrase={() => {}}
      onRecoveryPhrase={() => {}}
    />,
  );
  assert.match(html, /<legend[^>]*>[^<]*unlock/i);
  assert.match(html, /passkey/i);
  assert.match(html, /vault passphrase/i);
  assert.match(html, /recovery phrase/i);
  assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Recovery phrase<\/label>/, "the phrase field is labelled");
});
