"use client";
import * as React from "react";
import { X, Download, Save, Trash2, FileText, Plus, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { parsePackage, parseSkillFile, updateSkillFile, duplicatePackage, validateFiles, type ParsedPackage, type PackageFile } from "@/domain/skills/package";
import type { StoredPackage } from "@/server/db/skill-packages";
import type { SkillsViewSkill } from "./skills-view";
import { AgentScope, SKILL_CONTROL, type SkillAgent } from "./agent-scope";
import { createPackageOperation } from "./package-operation";
import { savePackageAction, deletePackageAction, downloadPackageAction, saveSkillAccessAction } from "@/app/(portal)/(protected)/skills/library-actions";

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FileEditor({ file, onChange }: { file: PackageFile; onChange: (content: string) => void }) {
  const uid = React.useId();
  const readFields = () => {
    try {
      if (file.path === "SKILL.md" || file.path.endsWith("/SKILL.md")) return parseSkillFile(file);
      if (file.path === ".claude-plugin/plugin.json") {
        const manifest = JSON.parse(file.content);
        return { name: String(manifest.name ?? ""), description: String(manifest.description ?? ""), body: "" };
      }
    } catch { /* Invalid source stays editable as text. */ }
    return null;
  };
  const [fields, setFields] = React.useState(readFields);
  const [raw, setRaw] = React.useState(!fields);
  const manifest = file.path === ".claude-plugin/plugin.json";
  function update(next: NonNullable<typeof fields>) {
    setFields(next);
    onChange(manifest ? JSON.stringify({ ...JSON.parse(file.content), name: next.name, description: next.description }, null, 2) + "\n" : updateSkillFile(file.content, next.name, next.description, next.body));
  }
  return <div className="space-y-3">
    {(fields || readFields()) && <Button variant="secondary" onClick={() => { if (raw) { const next = readFields(); if (!next) return; setFields(next); } setRaw(!raw); }}>{raw ? "Use form editor" : "Edit source"}</Button>}
    {raw || !fields ? <textarea aria-label={`${file.path} source`} className={`${SKILL_CONTROL} min-h-80 font-mono leading-relaxed`} spellCheck={false} value={file.content} onChange={(e) => onChange(e.target.value)} /> : <>
      <Field label={manifest ? "Plugin name" : "Skill name"} value={fields.name} maxLength={150} onChange={(e) => update({ ...fields, name: e.target.value })} />
      <Field label={manifest ? "Description" : "When to use this"} value={fields.description} maxLength={500} onChange={(e) => update({ ...fields, description: e.target.value })} />
      {!manifest && <div className="space-y-1.5"><Label htmlFor={uid}>Full instructions</Label><textarea id={uid} className={`${SKILL_CONTROL} min-h-64 leading-relaxed`} value={fields.body} onChange={(e) => update({ ...fields, body: e.target.value })} /></div>}
      <p className="text-xs text-fg-muted">Additional file metadata is preserved. Use Edit source to change it.</p>
    </>}
  </div>;
}

function SkillAccess({ skill, agents, onSaved, busy, perform }: {
  skill: SkillsViewSkill; agents: readonly SkillAgent[]; onSaved: (skill: SkillsViewSkill) => void;
  busy: boolean; perform: (operation: () => Promise<void>) => Promise<void>;
}) {
  const [message, setMessage] = React.useState("");
  return <form className="space-y-3 rounded-card border border-line p-4" onSubmit={(e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void perform(async () => {
      setMessage("");
      const access = { id: skill.id, enabled: form.get("enabled") === "on", scope: form.get("scope") as "all" | "chosen", scopedAgentIds: form.getAll("scopedAgentIds").map(String) };
      const result = await saveSkillAccessAction(access);
      if (result.ok) onSaved({ ...skill, ...access });
      setMessage(result.ok ? "Access saved." : result.error);
    });
  }}>
    <h3 className="font-medium [overflow-wrap:anywhere]">{skill.title}</h3>
    <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" name="enabled" defaultChecked={skill.enabled} className="h-4 w-4 accent-accent" />Available to agents</label>
    <AgentScope agents={agents} scope={skill.scope} selected={skill.scopedAgentIds} />
    <Button variant="secondary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save access"}</Button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </form>;
}

export function PackageEditor({ draft, agents, skills, onClose, onSaved, onDuplicate, skipped = [] }: {
  draft: ParsedPackage | StoredPackage; agents: readonly SkillAgent[]; skills: readonly SkillsViewSkill[];
  onClose: () => void; onSaved: () => void; onDuplicate?: (draft: ParsedPackage) => void; skipped?: string[];
}) {
  const stored = "id" in draft ? draft : null;
  const [files, setFiles] = React.useState(draft.files);
  const [selected, setSelected] = React.useState(draft.files[0]?.path ?? "");
  const [mode, setMode] = React.useState<"preview" | "edit" | "access">("preview");
  const [name, setName] = React.useState(draft.name);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
  const operationRef = React.useRef<ReturnType<typeof createPackageOperation> | null>(null);
  if (!operationRef.current) operationRef.current = createPackageOperation({ onBusy: setBusy, onError: setError });
  const operation = operationRef.current;
  const [confirm, setConfirm] = React.useState<"delete" | "close" | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [currentSkills, setCurrentSkills] = React.useState(skills);
  const [accessChanged, setAccessChanged] = React.useState(false);
  const [newPath, setNewPath] = React.useState("");
  const uid = React.useId();
  const file = files.find((f) => f.path === selected);
  let preview: ParsedPackage | null = null, validation = "";
  try { preview = parsePackage(files, name); } catch (e) { validation = e instanceof Error ? e.message : "Check the package files."; }
  const perform = operation.run;
  const close = () => accessChanged ? onSaved() : onClose();
  const requestClose = () => { if (operation.isBusy()) return; if (dirty) setConfirm("close"); else close(); };
  // Native dialog Escape is routed through the same unsaved-edits check.
  React.useEffect(() => {
    const handle = (e: Event) => { e.preventDefault(); if (!busy) requestClose(); };
    const dialog = document.getElementById(uid)?.closest("dialog");
    dialog?.addEventListener("cancel", handle);
    return () => dialog?.removeEventListener("cancel", handle);
  });
  return <div id={uid} className="flex min-w-0 flex-col gap-5">
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0"><p className="mb-1 text-sm text-fg-muted">{stored ? "Your library" : "Review before adding"} · {draft.kind === "plugin" ? "Plugin" : "Skill"}</p>
        <h2 id="package-dialog-title" className="text-xl font-semibold [overflow-wrap:anywhere]">{preview?.name ?? draft.name}</h2>
        <p className="mt-2 text-sm text-fg-muted [overflow-wrap:anywhere]">{preview?.description ?? draft.description}</p>
      </div><Button variant="secondary" onClick={requestClose} disabled={busy} aria-label="Close editor" className="shrink-0 px-3"><X aria-hidden className="h-5 w-5" /></Button>
    </header>
    {confirm && <Notice tone="warning">
      <p>{confirm === "delete" ? "Delete this package and all its skills? Agents will lose access immediately. This cannot be undone." : "Discard your unsaved file changes?"}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" autoFocus onClick={() => setConfirm(null)}>Keep editing</Button>
        <Button variant="secondary" disabled={busy} onClick={() => {
          if (confirm === "close") close();
          else if (stored) void perform(async () => { const result = await deletePackageAction({ id: stored.id, revision: stored.revision }); if (result.ok) onSaved(); else { setError(result.error); setConfirm(null); } });
        }}>{confirm === "delete" ? "Delete package permanently" : "Discard changes"}</Button></div>
    </Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    {skipped.length > 0 && <Notice tone="warning" announce={false}><p>{skipped.length} system or binary file(s) were excluded. The saved package will contain only the files below.</p><details><summary className="min-h-11 cursor-pointer py-3">Show excluded files</summary><ul>{skipped.map((p) => <li key={p} className="[overflow-wrap:anywhere]">{p}</li>)}</ul></details></Notice>}
    {draft.kind === "plugin" && <Notice announce={false}>Warthog makes this plugin’s skills available to your agents. Warthog does not run its hooks, commands, scripts or connector configuration. Those files stay here for editing and download.</Notice>}
    {!stored && <p className="text-sm text-fg-muted">New skills start switched off. After saving, choose which agents can use them.</p>}
    {busy && <p role="status" className="text-sm text-fg-muted">Please wait while your package is updated. Editing will be available when this finishes.</p>}
    <fieldset disabled={busy} className="contents">
      <div className="flex flex-wrap gap-2" aria-label="Package views">
        {(["preview", "edit", ...(stored ? ["access"] : [])] as const).map((tab) => <Button key={tab} variant="secondary" aria-pressed={mode === tab} onClick={() => setMode(tab as typeof mode)}>{tab === "preview" ? "Preview" : tab === "edit" ? "Edit files" : "Agent access"}</Button>)}
      </div>
      {mode === "access" && stored ? <div className="grid gap-4 sm:grid-cols-2">
        {stored.members.map((m) => currentSkills.find((s) => s.id === m.skillId)).filter((s): s is SkillsViewSkill => Boolean(s)).map((s) => <SkillAccess key={s.id} skill={s} agents={agents} busy={busy} perform={perform} onSaved={(next) => { setCurrentSkills((all) => all.map((s) => s.id === next.id ? next : s)); setAccessChanged(true); }} />)}
        {!stored.members.length && <p className="text-sm text-fg-muted">This plugin has no SKILL.md instructions to share with agents.</p>}
      </div> : <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
        <aside className="min-w-0 space-y-3">
          <h3 className="text-sm font-medium">Files · {files.length}</h3>
          <div className="max-h-56 overflow-y-auto rounded-card border border-line p-1 sm:max-h-96">
            {files.map((f) => <button key={f.path} type="button" aria-pressed={selected === f.path} className={`flex min-h-11 w-full items-center gap-2 rounded-card px-3 py-2 text-start text-sm [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${selected === f.path ? "bg-accent-soft text-fg font-medium" : "hover:bg-surface-muted text-fg-muted"}`} onClick={() => setSelected(f.path)}><FileText aria-hidden className="h-4 w-4 shrink-0" /><span className="min-w-0">{f.path}</span></button>)}
          </div>
          {mode === "edit" && <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); try { const updated = validateFiles([...files, { path: newPath, content: "" }]); setFiles(updated); setSelected(newPath); setNewPath(""); setDirty(true); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Check the file path."); } }}>
            <Field label="New file path" value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="references/guide.md" required maxLength={300} />
            <Button variant="secondary" type="submit"><Plus aria-hidden className="h-4 w-4" />Add file</Button>
          </form>}
        </aside>
        <div className="min-w-0 space-y-3">
          {mode === "edit" && draft.kind === "plugin" && !files.some((f) => f.path === ".claude-plugin/plugin.json") && <Field label="Plugin name" value={name} maxLength={150} onChange={(e) => { setName(e.target.value); setDirty(true); }} />}
          {file && <><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium [overflow-wrap:anywhere]">{file.path}</p>
            {mode === "edit" && <Button variant="secondary" onClick={() => { const next = files.filter((f) => f.path !== selected); setFiles(next); setSelected(next[0]?.path ?? ""); setDirty(true); }}>Remove file</Button>}</div>
            {mode === "edit" ? <FileEditor key={file.path} file={file} onChange={(content) => { setFiles(files.map((f) => f.path === selected ? { ...f, content } : f)); setDirty(true); }} />
              : <pre id={`${uid}-content`} tabIndex={0} className="max-h-96 min-h-56 overflow-auto whitespace-pre-wrap rounded-card bg-surface-muted p-4 text-sm leading-relaxed [overflow-wrap:anywhere]">{file.content}</pre>}</>}
        </div>
      </div>}
    </fieldset>
    {validation && <Notice tone="warning">{validation}</Notice>}
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap gap-2">{stored && <>
        {onDuplicate && <Button variant="secondary" disabled={busy || dirty} onClick={() => { try { onDuplicate(duplicatePackage(draft)); } catch (e) { setError(e instanceof Error ? e.message : "Could not duplicate this package."); } }}><Copy aria-hidden className="h-4 w-4" />Duplicate</Button>}
        <Button variant="secondary" disabled={busy} onClick={() => void perform(async () => { const result = await downloadPackageAction(stored.id); if (!result.ok) return setError(result.error); const bytes = Uint8Array.from(atob(result.value.base64), (c) => c.charCodeAt(0)); downloadBlob(new Blob([bytes], { type: "application/zip" }), result.value.name); })}><Download aria-hidden className="h-4 w-4" />Download saved files</Button>
        <Button variant="secondary" disabled={busy} onClick={() => setConfirm("delete")}><Trash2 aria-hidden className="h-4 w-4" />Delete package</Button>
      </>}</div>
      <Button disabled={Boolean(validation)} aria-disabled={busy} className="aria-disabled:opacity-50" onClick={() => void perform(async () => { const result = await savePackageAction({ files, name, ...(stored ? { id: stored.id, revision: stored.revision } : {}) }); if (result.ok) onSaved(); else setError(result.error); })}><Save aria-hidden className="h-4 w-4" />{busy ? "Working…" : stored ? "Save changes" : "Add to my library"}</Button>
    </footer>
  </div>;
}

export function PackageModal(props: React.ComponentProps<typeof PackageEditor>) {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  const dismiss = () => {
    // Close while mounted. The library restores its captured initiating control
    // after the dismissal render; activeElement here can already be body because
    // a card/import button was disabled during the asynchronous package load.
    if (ref.current?.open) ref.current.close();
    props.onClose();
  };
  return <dialog ref={ref} aria-labelledby="package-dialog-title" className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-5xl overflow-y-auto rounded-card border border-line bg-surface p-4 text-fg shadow-xl sm:p-6">
    {/* Saving keeps its existing reload/navigation path; only dismissal returns focus. */}
    <PackageEditor {...props} onClose={dismiss} />
  </dialog>;
}
