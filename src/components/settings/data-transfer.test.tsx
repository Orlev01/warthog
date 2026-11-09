import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDataTransfer, DataTransferControls } from "./data-transfer";
import { encryptValue, decryptValue } from "@/client/vault/values";
import type { DeviceVault } from "@/client/vault/device-vault";
const document = { version: 1, exportedAt: "2026-11-09", profile: {}, preferences: {}, skills: [], memory: [], rules: [], tasks: [], lifeAdmin: [], connections: [], activity: [] };
function vault(key: Uint8Array<ArrayBuffer>, recovered = true): DeviceVault {
  return { unlockWithPasskey: async () => ({ vaultKey: key.slice(), created: false }), unlockWithPassphrase: async () => key.slice(), unlockWithRecoveryPhrase: async () => key.slice(), hasRecoveryPhrase: async () => recovered, saveRecoveryPhrase: async () => {}, savePassphrase: async () => {}, adoptPasskey: async () => "unchanged" };
}
test("protected import reads locally and sends only newly encrypted values", async () => {
  const key = new Uint8Array(randomBytes(32)); const bodies: string[] = [];
  const flow = createDataTransfer({ vault: vault(key), fetch: (async (_url, init) => { bodies.push(String(init?.body)); return Response.json({ status: "imported" }); }) as typeof fetch, download: () => {} });
  const data = JSON.stringify({ ...document, deviceProtected: { highTierFields: [{ type: "passport", label: "Passport", value: "LOCAL-SECRET-9371" }], cards: [] } });
  flow.setFile({ size: data.length, text: async () => data });
  await flow.importData();
  assert.equal(bodies.length, 1); assert.equal(bodies[0]!.includes("LOCAL-SECRET-9371"), false); assert.equal(bodies[0]!.includes("deviceProtected"), false);
  const body = JSON.parse(bodies[0]!); assert.equal(await decryptValue(key, body.protectedVault.highTierFields[0].ciphertext), "LOCAL-SECRET-9371");
  assert.equal(flow.getState().hasFile, false); assert.match(flow.getState().notice ?? "", /imported/i);
});
test("new vault import waits for recovery acknowledgement before any data POST", async () => {
  const key = new Uint8Array(randomBytes(32)); let sends = 0;
  const flow = createDataTransfer({ vault: vault(key, false), fetch: (async () => { sends++; return Response.json({ status: "imported" }); }) as typeof fetch, download: () => {} });
  const raw = JSON.stringify({ ...document, deviceProtected: { highTierFields: [{ type: "passport", label: "Passport", value: "secret" }], cards: [] } });
  flow.setFile({ size: raw.length, text: async () => raw }); await flow.importData();
  assert.equal(sends, 0); assert.ok(flow.keyStep.getState().newPhrase);
  await flow.confirmRecovery(); assert.equal(sends, 0);
  flow.keyStep.setPhraseSaved(true); await flow.confirmRecovery(); assert.equal(sends, 1);
});
test("protected export decrypts only for local download and never creates a vault", async () => {
  const key = new Uint8Array(randomBytes(32)); const downloaded: string[] = []; let createIfMissing: boolean | undefined;
  const v = vault(key); v.unlockWithPasskey = async (opts) => { createIfMissing = opts.createIfMissing; return { vaultKey: key, created: false }; };
  const flow = createDataTransfer({ vault: v, fetch: (async () => Response.json({ document, protectedVault: { highTierFields: [{ type: "passport", label: "Passport", ciphertext: await encryptValue(key, "EXPORT-LOCAL-SECRET") }], cards: [] } })) as typeof fetch, download: (contents) => downloaded.push(contents) });
  flow.setIncludeProtected(true); await flow.exportData();
  assert.equal(createIfMissing, false); assert.equal(downloaded.length, 1); assert.match(downloaded[0]!, /EXPORT-LOCAL-SECRET/);
});
test("invalid old card files and stale confirmations are explicit failures without plaintext uploads or automatic retry", async () => {
  let sends = 0;
  const flow = createDataTransfer({ vault: vault(new Uint8Array(randomBytes(32))), fetch: (async () => { sends++; return Response.json({ error: "step_up_required" }, { status: 403 }); }) as typeof fetch, download: () => assert.fail("must not download") });
  const raw = JSON.stringify({ ...document, deviceProtected: { highTierFields: [], cards: [{ number: "4242424242424242" }] } });
  flow.setFile({ size: raw.length, text: async () => raw }); await flow.importData(); assert.equal(sends, 0); assert.ok(flow.getState().error);
  await flow.exportData(); assert.equal(sends, 1); assert.equal(flow.getState().needsConfirm, true);
});
test("transfer UI has no native file-upload form and clearly warns about plaintext backups", () => {
  const html = renderToStaticMarkup(<DataTransferControls />);
  assert.match(html, /Choose a file to import/); assert.match(html, /type="file"/); assert.doesNotMatch(html, /<form/); assert.match(html, /readable card numbers/); assert.match(html, /Include protected details/);
});


test("duplicate submits and ambiguous failures never automatically repeat an import", async () => {
  let release: () => void = () => {}; const waiting = new Promise<void>((resolve) => { release = resolve; }); let sends = 0;
  const flow = createDataTransfer({ vault: vault(new Uint8Array(randomBytes(32))), fetch: (async () => { sends++; await waiting; throw new Error("transport interrupted"); }) as typeof fetch, download: () => {} });
  const raw = JSON.stringify(document); flow.setFile({ size: raw.length, text: async () => raw });
  const first = flow.importData(); await new Promise((resolve) => setTimeout(resolve, 0));
  await flow.importData(); assert.equal(sends, 1); release(); await first;
  assert.equal(flow.getState().hasFile, false); assert.match(flow.getState().error ?? "", /check this account/i);
  await flow.importData(); assert.equal(sends, 1);
});

test("wrong vault keys and oversized files fail before download or import upload", async () => {
  const key = new Uint8Array(randomBytes(32)); let sends = 0; let downloads = 0;
  const flow = createDataTransfer({ vault: vault(new Uint8Array(randomBytes(32))), fetch: (async () => { sends++; return Response.json({ document, protectedVault: { highTierFields: [{ type: "passport", label: "Passport", ciphertext: await encryptValue(key, "wrong-key-secret") }], cards: [] } }); }) as typeof fetch, download: () => { downloads++; } });
  flow.setIncludeProtected(true); await flow.exportData(); assert.equal(downloads, 0); assert.ok(flow.getState().error);
  flow.setFile({ size: 17 * 1024 * 1024, text: async () => assert.fail("must reject before reading") }); await flow.importData(); assert.equal(sends, 1);
});
