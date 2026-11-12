"use client";
import * as React from "react";
import { Upload, FolderOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { makeSkillFile, parsePackage, PACKAGE_LIMITS, ignoredPackagePath, type ParsedPackage } from "@/domain/skills/package";
import { previewPackageAction } from "@/app/(portal)/(protected)/skills/library-actions";

// A value of only spaces counts as empty.
const NOT_BLANK = ".*\\S.*";

interface PickedFile { file: File; path: string }
async function droppedFiles(items: DataTransferItemList, fallback: FileList): Promise<PickedFile[]> {
  const roots = Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => Boolean(e));
  if (!roots.length) return Array.from(fallback).map((file) => ({ file, path: file.name }));
  const files: PickedFile[] = [];
  let entries = 0, bytes = 0;
  async function walk(entry: FileSystemEntry, prefix: string) {
    if (++entries > 500) throw new Error("This folder has too many entries. Choose just the skill or plugin folder.");
    const path = prefix + entry.name;
    if (ignoredPackagePath(path)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      bytes += file.size;
      if (files.length >= PACKAGE_LIMITS.files || bytes > PACKAGE_LIMITS.archiveBytes) throw new Error("That's too much to import at once. Choose up to 100 text files and 5 MB in total.");
      files.push({ file, path });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${path}/`);
      }
    }
  }
  for (const root of roots) await walk(root, "");
  return files;
}

export function PackageImport({ onReady }: { onReady: (draft: ParsedPackage, skipped?: string[]) => void }) {
  const [busy, setBusy] = React.useState(false), [over, setOver] = React.useState(false), [error, setError] = React.useState("");
  const input = React.useRef<HTMLInputElement>(null), folder = React.useRef<HTMLInputElement>(null);
  const guard = React.useRef(false);
  async function read(pick: () => Promise<PickedFile[]>) {
    if (guard.current) return; guard.current = true; setBusy(true); setError("");
    try {
      const files = await pick();
      if (!files.length) return;
      if (files.length > PACKAGE_LIMITS.files || files.reduce((n, f) => n + f.file.size, 0) > PACKAGE_LIMITS.archiveBytes) throw new Error("That's too much to import at once. Choose up to 100 text files and 5 MB in total.");
      const data = new FormData();
      for (const f of files) { data.append("files", f.file); data.append("paths", f.path); }
      const result = await previewPackageAction(data);
      if (result.ok) onReady(result.value.package, result.value.skipped); else setError(result.error);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read these files. Please try again."); }
    finally { guard.current = false; setBusy(false); if (input.current) input.current.value = ""; if (folder.current) folder.current.value = ""; }
  }
  const fromInput = (files: FileList | null) => read(async () => Array.from(files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name })));
  // Secondary to writing a skill: importing files you already have (content-45). The drop
  // zone is the panel's body; the file limits are told when a choice goes over them.
  return <WorkspacePanel title="Import skills you already have" description="Already have skills as files? Drop them here: SKILL.md files, a skill or plugin folder, or a ZIP. You'll see a preview before anything is saved.">
    <div className="space-y-3">
      <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }} onDrop={(e) => {
        e.preventDefault(); setOver(false);
        if (guard.current) return;
        // Capture DataTransfer entries synchronously before the browser clears them.
        const picked = droppedFiles(e.dataTransfer.items, e.dataTransfer.files);
        void read(() => picked);
      }} className={`rounded-card border-2 border-dashed p-5 sm:p-6 ${over ? "border-accent bg-accent-soft" : "border-line-strong bg-surface"}`} aria-busy={busy}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3"><Upload aria-hidden className="mt-1 h-5 w-5 shrink-0 text-fg-muted" />
            <p className="text-sm text-fg-muted">Drop files or a folder here, or choose them.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2"><Button variant="secondary" aria-disabled={busy || undefined} onClick={() => { if (!busy) input.current?.click(); }}><Upload aria-hidden className="h-4 w-4" />Choose files</Button>
            <Button variant="secondary" aria-disabled={busy || undefined} onClick={() => { if (!busy) folder.current?.click(); }}><FolderOpen aria-hidden className="h-4 w-4" />Choose a folder</Button></div>
        </div>
        <input ref={input} type="file" multiple className="hidden" accept=".md,.skill,.plugin,.zip" aria-label="Import skill or plugin files" onChange={(e) => void fromInput(e.target.files)} />
        <input ref={folder} type="file" multiple className="hidden" {...{ webkitdirectory: "" }} aria-label="Import skill or plugin folder" onChange={(e) => void fromInput(e.target.files)} />
        {busy && <p role="status" className="mt-3 text-sm">Reading files and preparing your preview…</p>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  </WorkspacePanel>;
}

export function CreatePackage({ onReady }: { onReady: (draft: ParsedPackage) => void }) {
  const [kind, setKind] = React.useState("skill"), [error, setError] = React.useState("");
  // Writing a skill in plain words comes first (content-45); a plugin is the advanced choice.
  return <WorkspacePanel title="Create a skill" description="Give it a name, say when your agents should use it, and write what they should do. You'll see a preview before it's saved.">
    <form className="max-w-2xl space-y-4" onSubmit={(e) => {
      e.preventDefault(); const data = new FormData(e.currentTarget);
      const name = String(data.get("name") ?? ""), description = String(data.get("description") ?? ""), body = String(data.get("body") ?? "");
      const files = kind === "plugin" ? [
        { path: ".claude-plugin/plugin.json", content: JSON.stringify({ name, description }, null, 2) + "\n" },
        { path: "skills/my-skill/SKILL.md", content: makeSkillFile("My skill", description, body) },
      ] : [{ path: "SKILL.md", content: makeSkillFile(name, description, body) }];
      try { onReady(parsePackage(files)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Check the fields."); }
    }}>
      <SelectField label="What are you creating?" width="text" value={kind} onChange={(e) => setKind(e.target.value)}><option value="skill">A skill</option><option value="plugin">A plugin (several skills and files)</option></SelectField>
      <Field name="name" label={kind === "plugin" ? "Plugin name" : "Skill name"} required pattern={NOT_BLANK} maxLength={150} width="text" placeholder="e.g. Plan my week" />
      <Field name="description" label="When to use this" required pattern={NOT_BLANK} maxLength={500} placeholder="e.g. when I ask for help planning the week" />
      <TextareaField name="body" label="Full instructions" required maxLength={100000} rows={6} placeholder="Describe what your agent should do, step by step." />
      {kind === "plugin" && <p className="text-sm text-fg-muted">Start with one skill. In the preview you can rename it, add more skills and attach supporting files.</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit">Preview new {kind}</Button>
    </form>
  </WorkspacePanel>;
}
