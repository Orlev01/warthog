"use client";

import * as React from "react";
import { createDeviceVault, StepUpRequiredError, type DeviceVault } from "@/client/vault/device-vault";
import { createVaultKey } from "@/client/vault/key";
import { startVaultAuthentication } from "@/client/vault/prf-ceremony";
import { buildDeviceProtected } from "@/client/vault/export";
import { reprotectDeviceProtected } from "@/client/vault/import";
import { plaintextVaultSchema, sealedVaultSchema } from "@/domain/data-transfer";
import { exportDocumentSchema, type ExportDocument } from "@/server/export/schema";
import { createVaultKeyStep, VaultUnlockChoice, RecoveryPhraseReveal } from "@/components/vault/vault-key-step";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { Button } from "@/components/ui/button";

interface LocalFile { size: number; text(): Promise<string> }
interface TransferState { working: boolean; error: string | null; notice: string | null; needsConfirm: boolean; includeProtected: boolean; hasFile: boolean }
interface TransferDeps { vault: DeviceVault; fetch: typeof fetch; download(contents: string, filename: string): void; onChange?(): void }
class TransferError extends Error {}

// A file and any pending plaintext live only in this controller's memory. Every POST
// is constructed from the ordinary document plus freshly encrypted protected records.
export function createDataTransfer(deps: TransferDeps) {
  let state: TransferState = { working: false, error: null, notice: null, needsConfirm: false, includeProtected: false, hasFile: false };
  let file: LocalFile | null = null;
  let pending: ExportDocument | null = null;
  const set = (patch: Partial<TransferState>) => { state = { ...state, ...patch }; deps.onChange?.(); };
  const keyStep = createVaultKeyStep({ vault: deps.vault, createIfMissing: true, onChange: deps.onChange });
  async function run(action: () => Promise<void>) {
    if (state.working) return;
    set({ working: true, error: null, notice: null });
    try { await action(); }
    catch (error) {
      if (error instanceof StepUpRequiredError) set({ needsConfirm: true, error: "Confirm it's you below, then try the transfer again." });
      else set({ error: error instanceof TransferError ? error.message : "The transfer could not be completed. Check the file and vault unlock method, then try again." });
    } finally { set({ working: false }); }
  }
  async function request(url: string, body?: unknown) {
    const response = await deps.fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 403) throw new StepUpRequiredError();
    if (response.status === 401) throw new TransferError("Your session ended. Sign in again before transferring data.");
    if (!response.ok) throw new TransferError("The server could not accept this transfer. Check the file and try again; an interrupted response may need checking before you repeat an import.");
    return response.json();
  }
  function ordinaryDocument(doc: ExportDocument): ExportDocument {
    // Do not spread the file: unknown top-level fields and device plaintext never upload.
    return { version: doc.version, exportedAt: doc.exportedAt, profile: doc.profile, preferences: doc.preferences, skills: doc.skills, memory: doc.memory, rules: doc.rules, tasks: doc.tasks, lifeAdmin: doc.lifeAdmin, connections: doc.connections, activity: doc.activity };
  }
  async function submitImport(doc: ExportDocument, key?: Uint8Array<ArrayBuffer>) {
    let protectedVault;
    if (doc.deviceProtected) {
      const plaintext = plaintextVaultSchema.parse(doc.deviceProtected);
      if (plaintext.cards.length || plaintext.highTierFields.length) {
        try {
          const { sealed, failed } = await reprotectDeviceProtected(key, plaintext);
          if (failed.length) throw new TransferError("Some protected details could not be read. Nothing was imported.");
          protectedVault = sealedVaultSchema.parse(sealed);
        } finally { key?.fill(0); }
      }
    }
    file = null; set({ hasFile: false });
    try {
      await request("/api/data/import", { document: ordinaryDocument(doc), ...(protectedVault ? { protectedVault } : {}) });
    } catch (error) {
      if (error instanceof StepUpRequiredError || error instanceof TransferError) throw error;
      throw new TransferError("The import response was interrupted. Check this account before choosing the file again, to avoid duplicates.");
    }
    pending = null; file = null; keyStep.cancelPhrase();
    set({ hasFile: false, needsConfirm: false, notice: "Your data was imported. Reload this page to see the imported history. Agents and service connections must be connected again." });
  }
  return {
    keyStep,
    getState: () => state,
    setIncludeProtected(value: boolean) { if (!state.working && !pending) set({ includeProtected: value }); },
    setFile(value: LocalFile | null) { if (!state.working && !pending) { file = value; set({ hasFile: value !== null, error: null, notice: null }); } },
    clearConfirmation() { set({ needsConfirm: false }); },
    cancel() { if (!state.working) { pending = null; file = null; keyStep.cancelPhrase(); keyStep.setPassphrase(""); keyStep.setRecoveryPhrase(""); set({ hasFile: false, error: null, notice: "Transfer cancelled." }); } },
    async exportData() {
      if (pending) return;
      await run(async () => {
        const bundle = await request("/settings/data/export?device=1");
        const doc = exportDocumentSchema.parse(bundle.document);
        let download = ordinaryDocument(doc);
        if (state.includeProtected) {
          const stored = sealedVaultSchema.parse(bundle.protectedVault);
          if (stored.cards.length || stored.highTierFields.length) {
            const unlock = keyStep.getState();
            let key: Uint8Array<ArrayBuffer>;
            if (unlock.method === "passkey") key = (await deps.vault.unlockWithPasskey({ createIfMissing: false })).vaultKey;
            else if (unlock.method === "passphrase") { const phrase = unlock.passphrase; keyStep.setPassphrase(""); key = await deps.vault.unlockWithPassphrase(phrase, { createIfMissing: false }); }
            else { const phrase = unlock.recoveryPhrase; keyStep.setRecoveryPhrase(""); key = await deps.vault.unlockWithRecoveryPhrase(phrase); }
            try { download = exportDocumentSchema.parse({ ...download, deviceProtected: await buildDeviceProtected(key, stored) }); }
            finally { key.fill(0); }
          }
        }
        deps.download(JSON.stringify(download, null, 2), "warthog-export.json");
        set({ needsConfirm: false, notice: "Your export is ready. Keep the downloaded file somewhere private." });
      });
    },
    async importData() {
      if (pending) return;
      await run(async () => {
        if (!file) throw new TransferError("Choose a Warthog export file first.");
        if (file.size > 16 * 1024 * 1024) throw new TransferError("Choose an export file smaller than 16 MiB.");
        const raw = await file.text();
        if (new TextEncoder().encode(raw).byteLength > 16 * 1024 * 1024) throw new TransferError("Choose an export file smaller than 16 MiB.");
        const doc = exportDocumentSchema.parse(JSON.parse(raw));
        const protectedData = doc.deviceProtected ? plaintextVaultSchema.safeParse(doc.deviceProtected) : null;
        if (protectedData && !protectedData.success) throw new TransferError("This file's protected details are incomplete or invalid. Create a new export from the original account; nothing was uploaded.");
        if (protectedData?.success && (protectedData.data.cards.length || protectedData.data.highTierFields.length)) {
          const obtained = await keyStep.obtain();
          if (obtained.kind === "reveal") { pending = doc; return; }
          await submitImport(doc, obtained.vaultKey);
        } else await submitImport(doc);
      });
    },
    async confirmRecovery() {
      await run(async () => {
        if (!pending) return;
        if (!keyStep.getState().phraseSaved) throw new TransferError("Save your vault recovery phrase and tick the box before continuing.");
        const doc = pending;
        const key = await keyStep.confirmPhrase();
        // Clear before the transport: a failed/ambiguous request requires an explicit new
        // file selection/unlock, never an automatic repeat of a state-changing import.
        pending = null;
        await submitImport(doc, key);
      });
    },
  };
}

function downloadFile(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function DataTransferControls() {
  const [, redraw] = React.useReducer((value: number) => value + 1, 0);
  const [flow] = React.useState(() => createDataTransfer({ fetch: (...args) => fetch(...args), vault: createDeviceVault({ fetch: (...args) => fetch(...args), startAuthentication: ({ optionsJSON }) => startVaultAuthentication(optionsJSON), createVaultKey }), download: downloadFile, onChange: redraw }));
  const state = flow.getState(); const unlock = flow.keyStep.getState();
  return <section className="flex flex-col gap-4" aria-label="Export and import your data">
    <h2 className="text-sm font-semibold text-fg">Export your data</h2>
    <p className="text-sm text-fg-muted">Downloads your everyday details and activity. If you include protected details, the file also contains readable card numbers and sensitive identity details. Store it privately; anyone with the file can read it.</p>
    <fieldset disabled={state.working || unlock.newPhrase !== null} className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={state.includeProtected} onChange={(event) => flow.setIncludeProtected(event.target.checked)} />Include protected details and saved cards</label>
      <p className="text-sm text-fg-muted">Unlock only when including protected details or importing them. For a new vault, choose a passphrase of at least 12 characters if your passkey cannot unlock it. Save the new vault recovery phrase before importing; your account recovery code is different.</p>
      <VaultUnlockChoice state={unlock} onMethod={(method) => flow.keyStep.setMethod(method)} onPassphrase={(value) => flow.keyStep.setPassphrase(value)} onRecoveryPhrase={(value) => flow.keyStep.setRecoveryPhrase(value)} />
      <p className="text-sm text-fg-muted">This is a sensitive download. Keep the file somewhere safe.</p>
      <Button type="button" variant="secondary" onClick={() => void flow.exportData()}>Export my data</Button>
      <h2 className="text-sm font-semibold text-fg">Import a previous export</h2>
      <p className="text-sm text-fg-muted">Adds the file's details to this account; repeated imports add duplicates. Protected values are encrypted on this device before upload. Activity goes into a read-only archive. Reconnect agents and services separately.</p>
      <label className="flex flex-col gap-2 text-sm">Choose a file to import<input type="file" accept="application/json,.json" onChange={(event) => flow.setFile(event.target.files?.[0] ?? null)} /></label>
      <Button type="button" variant="secondary" disabled={!state.hasFile} onClick={() => void flow.importData()}>Import this file</Button>
    </fieldset>
    {unlock.newPhrase ? <RecoveryPhraseReveal phrase={unlock.newPhrase} saved={unlock.phraseSaved} onSavedChange={(saved) => flow.keyStep.setPhraseSaved(saved)} onContinue={() => void flow.confirmRecovery()} working={state.working} continueLabel="Save phrase and import" /> : null}
    {state.hasFile || unlock.newPhrase ? <Button type="button" variant="secondary" disabled={state.working} onClick={() => flow.cancel()}>Cancel transfer</Button> : null}
    {state.error ? <p role="alert" className="text-sm text-danger">{state.error}</p> : null}
    {state.notice ? <p role="status" className="text-sm text-fg">{state.notice}</p> : null}
    {state.needsConfirm ? <ConfirmItsYou onConfirmed={() => flow.clearConfirmation()} explanation="Confirm it's you, then choose the transfer again." /> : null}
  </section>;
}
