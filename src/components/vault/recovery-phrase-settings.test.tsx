// Review fix W1 — the Vault page's recovery-phrase panel
// (src/components/vault/recovery-phrase-settings.tsx): it says whether a vault recovery
// phrase exists and offers to create or replace one. Replacing it is a security change,
// so it needs "Confirm it's you" before the new phrase is saved (the server also refuses
// an overwrite without a fresh step-up). Driven over a fake DeviceVault and a fake step-up.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createRecoveryPhraseSettings, RecoveryPhraseSettings } from "./recovery-phrase-settings";
import type { DeviceVault } from "@/client/vault/device-vault";

const VK = new Uint8Array(32).fill(3);

function makeVault() {
  const saved: string[] = [];
  const calls: string[] = [];
  const vault: DeviceVault = {
    async unlockWithPasskey(o) {
      calls.push(`passkey:${o.createIfMissing}`);
      return { vaultKey: VK, created: false };
    },
    async unlockWithPassphrase() {
      return VK;
    },
    async unlockWithRecoveryPhrase() {
      return VK;
    },
    async hasRecoveryPhrase() {
      return saved.length > 0;
    },
    async saveRecoveryPhrase(_vk, phrase) {
      calls.push("save");
      saved.push(phrase);
    },
    async savePassphrase() {},
    async adoptPasskey() {
      return "unchanged";
    },
  };
  return { vault, saved, calls };
}

test("replacing the phrase: unlock, show a new phrase, confirm it's you, then save it", async () => {
  const { vault, saved, calls } = makeVault();
  const confirms: true[] = [];
  const panel = createRecoveryPhraseSettings({
    vault,
    hasRecoveryPhrase: true,
    confirmItsYou: async () => {
      confirms.push(true);
      return true;
    },
  });
  await panel.start();
  assert.equal(panel.getState().status, "phrase");
  const phrase = panel.getStepState().newPhrase!;
  assert.ok(phrase);
  assert.deepEqual(calls, ["passkey:false"], "it never sets up a new vault from here");

  panel.setPhraseSaved(true);
  await panel.confirm();
  assert.equal(confirms.length, 1, "replacing needs a fresh confirmation");
  assert.deepEqual(saved, [phrase]);
  assert.equal(panel.getState().status, "done");
  assert.equal(panel.getState().hasRecoveryPhrase, true);
  assert.equal(panel.getStepState().newPhrase, null);
});

test("a refused 'Confirm it's you' saves nothing and keeps the new phrase on screen", async () => {
  const { vault, saved } = makeVault();
  const panel = createRecoveryPhraseSettings({ vault, hasRecoveryPhrase: true, confirmItsYou: async () => false });
  await panel.start();
  panel.setPhraseSaved(true);
  await panel.confirm();
  assert.deepEqual(saved, []);
  assert.equal(panel.getState().status, "phrase");
  assert.ok(panel.getState().error);
  assert.ok(panel.getStepState().newPhrase);
});

test("creating the first phrase for an existing vault needs no step-up", async () => {
  const { vault, saved } = makeVault();
  const confirms: true[] = [];
  const panel = createRecoveryPhraseSettings({
    vault,
    hasRecoveryPhrase: false,
    confirmItsYou: async () => {
      confirms.push(true);
      return true;
    },
  });
  await panel.start();
  panel.setPhraseSaved(true);
  await panel.confirm();
  assert.equal(confirms.length, 0);
  assert.equal(saved.length, 1);
});

test("an unticked Continue saves nothing", async () => {
  const { vault, saved } = makeVault();
  const panel = createRecoveryPhraseSettings({ vault, hasRecoveryPhrase: true, confirmItsYou: async () => true });
  await panel.start();
  await panel.confirm();
  assert.deepEqual(saved, []);
  assert.match(String(panel.getState().error), /tick/i);
});

test("the panel says whether a recovery phrase exists and offers a real control", () => {
  const withPhrase = renderToStaticMarkup(<RecoveryPhraseSettings hasRecoveryPhrase hasVault />);
  assert.match(withPhrase, /recovery phrase is set up/i);
  assert.match(withPhrase, /<button[^>]*>[^<]*Replace your recovery phrase/);

  const without = renderToStaticMarkup(<RecoveryPhraseSettings hasRecoveryPhrase={false} hasVault />);
  assert.match(without, /no recovery phrase/i);
  assert.match(without, /<button[^>]*>[^<]*Create a recovery phrase/);

  const noVault = renderToStaticMarkup(<RecoveryPhraseSettings hasRecoveryPhrase={false} hasVault={false} />);
  assert.doesNotMatch(noVault, /<button/, "no dead button before a vault exists");
  assert.match(noVault, /first card or high-tier detail/i);
});
