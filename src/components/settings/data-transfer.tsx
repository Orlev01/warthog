"use client";

import * as React from "react";
import { splitPreparedTransfer, TRANSFER_PART_BYTES } from "@/domain/transfer-parts";
import { createDeviceVault, StepUpRequiredError, type DeviceVault } from "@/client/vault/device-vault";
import { createVaultKey } from "@/client/vault/key";
import { startVaultAuthentication } from "@/client/vault/prf-ceremony";
import { buildDeviceProtected } from "@/client/vault/export";
import { reprotectDeviceProtected } from "@/client/vault/import";
import { plaintextVaultSchema, sealedVaultSchema } from "@/domain/data-transfer";
import { exportDocumentSchema, type ExportDocument } from "@/server/export/schema";
import { createVaultKeyStep, VaultUnlockChoice, RecoveryPhraseReveal } from "@/components/vault/vault-key-step";
import { Download, LoaderCircle, Upload } from "lucide-react";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { Button } from "@/components/ui/button";
import { CONTROL_TEXT } from "@/components/ui/input";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";

interface LocalFile { size: number; text(): Promise<string> }
// `activity` names the transfer that is running (or ran last), so its pending label, error
// and outcome show next to the button that started it.
type TransferActivity = "export" | "import";
interface TransferState { working: boolean; activity: TransferActivity | null; error: string | null; notice: string | null; needsConfirm: boolean; includeProtected: boolean; hasFile: boolean }
interface TransferDeps { vault: DeviceVault; fetch: typeof fetch; download(contents: string, filename: string): void; onChange?(): void; onStepUpRequired?(): void }
class TransferError extends Error {}

// A file and any pending plaintext live only in this controller's memory. Every POST
// is constructed from the ordinary document plus freshly encrypted protected records.
export function createDataTransfer(deps: TransferDeps) {
  let state: TransferState = { working: false, activity: null, error: null, notice: null, needsConfirm: false, includeProtected: false, hasFile: false };
  let file: LocalFile | null = null;
  let pending: ExportDocument | null = null;
  const set = (patch: Partial<TransferState>) => { state = { ...state, ...patch }; deps.onChange?.(); };
  const keyStep = createVaultKeyStep({ vault: deps.vault, createIfMissing: true, onChange: deps.onChange });
  async function run(activity: TransferActivity, action: () => Promise<void>) {
    if (state.working) return;
    set({ working: true, activity, error: null, notice: null });
    try { await action(); }
    catch (error) {
      if (error instanceof StepUpRequiredError) {
        set({ needsConfirm: true, error: activity === "export"
          ? "Nothing was exported. Confirm it's you, then choose Export my data again."
          : "Nothing was imported. Confirm it's you, then choose the file and import it again." });
        deps.onStepUpRequired?.();
      }
      else set({ error: error instanceof TransferError ? error.message : "The transfer could not be completed. Check the file and vault unlock method, then try again." });
    } finally { set({ working: false }); }
  }
  async function request(url: string, body?: unknown) {
    const response = await deps.fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 403) throw new StepUpRequiredError();
    if (response.status === 401) throw new TransferError("Your session ended. Sign in again before transferring data.");
    if (!response.ok) throw new TransferError("We couldn't finish that. If you were importing, check this account for anything already imported before you try the file again.");
    return response.json();
  }
  function ordinaryDocument(doc: ExportDocument): ExportDocument {
    // Do not spread the file: unknown top-level fields and device plaintext never upload.
    return { version: doc.version, exportedAt: doc.exportedAt, profile: doc.profile, agentSettings: doc.agentSettings, preferences: doc.preferences, skills: doc.skills, skillPackages: doc.skillPackages, memory: doc.memory, rules: doc.rules, tasks: doc.tasks, lifeAdmin: doc.lifeAdmin, connections: doc.connections, activity: doc.activity, importedActivity: doc.importedActivity };
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
      const ordinary = ordinaryDocument(doc);
      const payload = { document: ordinary, ...(protectedVault ? { protectedVault } : {}) };
      if (new TextEncoder().encode(JSON.stringify(payload)).length <= TRANSFER_PART_BYTES) {
        await request("/api/data/import", payload);
      } else {
        const parts = [...splitPreparedTransfer(ordinary, protectedVault)];
        const started = await request("/api/data/import", { operation: "begin", partCount: parts.length });
        for (let seq = 0; seq < parts.length; seq++) {
          set({ notice: `Uploading part ${seq + 1} of ${parts.length}. Nothing is restored until all parts are verified.` });
          await request("/api/data/import", { operation: "part", id: started.id, seq, part: parts[seq] });
        }
        set({ notice: "Verifying and restoring your data…" });
        await request("/api/data/import", { operation: "commit", id: started.id });
      }
    } catch (error) {
      if (error instanceof StepUpRequiredError || error instanceof TransferError) throw error;
      throw new TransferError("The import response was interrupted. Check this account before choosing the file again, to avoid duplicates.");
    }
    pending = null; file = null; keyStep.cancelPhrase();
    set({ hasFile: false, needsConfirm: false, notice: "Your data was imported. Reload this page to see the imported history. Agents and service connections must be connected again. Review and assign imported skills before agents can use them." });
  }
  return {
    keyStep,
    getState: () => state,
    setIncludeProtected(value: boolean) { if (!state.working && !pending) set({ includeProtected: value }); },
    setFile(value: LocalFile | null) { if (!state.working && !pending) { file = value; set({ hasFile: value !== null, error: null, notice: null }); } },
    clearConfirmation() { set({ needsConfirm: false }); },
    cancel() { if (!state.working) { pending = null; file = null; keyStep.cancelPhrase(); keyStep.setPassphrase(""); keyStep.setRecoveryPhrase(""); set({ activity: "import", hasFile: false, error: null, notice: "Import cancelled. Nothing was imported." }); } },
    async exportData() {
      if (pending) return;
      await run("export", async () => {
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
      await run("import", async () => {
        if (!file) throw new TransferError("Choose a Warthog export file first.");
        const raw = await file.text();
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
      await run("import", async () => {
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
// The native file picker, styled as the secondary button the rest of the workspace uses.
const FILE_INPUT_CLASS =
  `min-h-11 min-w-0 w-full max-w-full text-fg-muted ${CONTROL_TEXT} file:me-3 file:min-h-11 file:cursor-pointer file:rounded-full file:border file:border-solid file:border-line file:bg-surface file:px-4 file:text-sm file:font-medium file:text-fg hover:file:bg-surface-muted`;

// The outcome of the last transfer, shown next to the button that started it.
function TransferOutcome({ state, activity }: { state: TransferState; activity: TransferActivity }) {
  if (state.activity !== activity) return null;
  if (state.error) return <p role="alert" className="min-w-0 basis-full text-sm text-danger">{state.error}</p>;
  if (state.notice) return <p role="status" className="min-w-0 basis-full text-sm text-fg">{state.notice}</p>;
  return null;
}

/**
 * Export and import, as two panels (Settings › Data & privacy). Everything runs in this
 * browser so protected plaintext never enters a native form. When the page already offers
 * "Confirm it's you" (`onStepUpRequired` given), a refused transfer points there instead of
 * mounting a second confirmation; on its own the controls offer their own.
 */
export function DataTransferControls({ onStepUpRequired }: { onStepUpRequired?: () => void } = {}) {
  const [, redraw] = React.useReducer((value: number) => value + 1, 0);
  const stepUp = React.useRef(onStepUpRequired);
  stepUp.current = onStepUpRequired;
  const [flow] = React.useState(() => createDataTransfer({ fetch: (...args) => fetch(...args), vault: createDeviceVault({ fetch: (...args) => fetch(...args), startAuthentication: ({ optionsJSON }) => startVaultAuthentication(optionsJSON), createVaultKey }), download: downloadFile, onChange: redraw, onStepUpRequired: () => stepUp.current?.() }));
  const state = flow.getState(); const unlock = flow.keyStep.getState();
  // Fields freeze while a transfer runs or a new vault recovery phrase is waiting to be saved.
  const locked = state.working || unlock.newPhrase !== null;
  const exporting = state.working && state.activity === "export";
  const importing = state.working && state.activity === "import";
  const unlockChoice = <VaultUnlockChoice state={unlock} onMethod={(method) => flow.keyStep.setMethod(method)} onPassphrase={(value) => flow.keyStep.setPassphrase(value)} onRecoveryPhrase={(value) => flow.keyStep.setRecoveryPhrase(value)} />;
  return <>
    <WorkspacePanel
      title="Export your data"
      description="Downloads a file of everything Warthog keeps about you: your everyday details, preferences, agent defaults, skills, memory, rules, tasks, life-admin records, the services you've connected (without their passwords or keys) and your activity. Cards and protected details are left out unless you include them."
      footer={<>
        <Button type="button" variant="secondary" aria-disabled={locked || undefined} aria-busy={exporting || undefined}
          onClick={() => { if (!locked) void flow.exportData(); }}>
          {exporting ? <><LoaderCircle aria-hidden={true} className="h-4 w-4 shrink-0 animate-spin" />Preparing export…</> : <><Download aria-hidden={true} className="h-4 w-4 shrink-0" />Export my data</>}
        </Button>
        <span className="min-w-0">Anyone with the file can read it, so keep it somewhere private.</span>
        <TransferOutcome state={state} activity="export" />
      </>}
    >
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col">
          <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
            <input type="checkbox" className="h-4 w-4 shrink-0" checked={state.includeProtected} aria-describedby="data-export-protected-note" onChange={(event) => flow.setIncludeProtected(event.target.checked)} />
            Include protected details and saved cards
          </label>
          <p id="data-export-protected-note" className="pl-7 text-sm text-fg-muted">The file will then contain readable card numbers and protected details.</p>
        </div>
        {state.includeProtected ? (
          <div className="flex min-w-0 flex-col gap-3 rounded-field bg-surface-muted p-3 sm:p-4">
            <p className="text-sm text-fg">To include protected details, unlock your vault first.</p>
            {unlockChoice}
          </div>
        ) : null}
      </fieldset>
    </WorkspacePanel>

    <WorkspacePanel
      title="Import a previous export"
      description="Adds a Warthog export file's details to this account. Importing the same file twice adds everything twice. Activity goes into Imported history below, and agents and services need connecting again."
      footer={<>
        <Button type="button" variant="secondary" disabled={!state.hasFile} aria-disabled={state.hasFile && locked ? true : undefined} aria-busy={importing || undefined}
          onClick={() => { if (!locked) void flow.importData(); }}>
          {importing ? <><LoaderCircle aria-hidden={true} className="h-4 w-4 shrink-0 animate-spin" />Importing…</> : <><Upload aria-hidden={true} className="h-4 w-4 shrink-0" />Import this file</>}
        </Button>
        {state.hasFile || unlock.newPhrase ? <Button type="button" variant="ghost" aria-disabled={state.working || undefined} onClick={() => { if (!state.working) flow.cancel(); }}>Cancel import</Button> : null}
        {state.hasFile || unlock.newPhrase ? null : <span className="min-w-0">Choose a file first.</span>}
        <TransferOutcome state={state} activity="import" />
      </>}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-4">
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium text-fg">
            Choose a file to import
            <input type="file" className={FILE_INPUT_CLASS} accept="application/json,.json" onChange={(event) => flow.setFile(event.target.files?.[0] ?? null)} />
          </label>
          {state.hasFile ? (
            <div className="flex min-w-0 flex-col gap-3 rounded-field bg-surface-muted p-3 sm:p-4">
              <p className="text-sm text-fg">
                If the file includes cards or protected details, they&apos;re encrypted on this device before they&apos;re sent. Choose how to unlock your vault. If you don&apos;t have a vault yet and your passkey can&apos;t unlock one, choose a vault passphrase of at least 12 characters.
              </p>
              {unlockChoice}
            </div>
          ) : null}
        </fieldset>
        {unlock.newPhrase ? <RecoveryPhraseReveal phrase={unlock.newPhrase} saved={unlock.phraseSaved} onSavedChange={(saved) => flow.keyStep.setPhraseSaved(saved)} onContinue={() => void flow.confirmRecovery()} working={state.working} continueLabel="Save phrase and import" /> : null}
      </div>
    </WorkspacePanel>

    {state.needsConfirm && !onStepUpRequired ? <ConfirmItsYou onConfirmed={() => flow.clearConfirmation()} explanation="Confirm it's you, then choose the transfer again." /> : null}
  </>;
}
