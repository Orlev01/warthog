"use client";
import * as React from "react";
import { Upload, FolderOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { makeSkillFile, parsePackage, PACKAGE_LIMITS, ignoredPackagePath, type ParsedPackage } from "@/domain/skills/package";
import { previewPackageAction } from "@/app/(portal)/(protected)/skills/library-actions";
import { SKILL_CONTROL } from "./agent-scope";

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
      if (files.length >= PACKAGE_LIMITS.files || bytes > PACKAGE_LIMITS.archiveBytes) throw new Error("Choose up to 100 files and 5 MB per upload.");
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
      if (files.length > PACKAGE_LIMITS.files || files.reduce((n, f) => n + f.file.size, 0) > PACKAGE_LIMITS.archiveBytes) throw new Error("Choose up to 100 files and 5 MB per upload.");
      const data = new FormData();
      for (const f of files) { data.append("files", f.file); data.append("paths", f.path); }
      const result = await previewPackageAction(data);
      if (result.ok) onReady(result.value.package, result.value.skipped); else setError(result.error);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read these files. Please try again."); }
    finally { guard.current = false; setBusy(false); if (input.current) input.current.value = ""; if (folder.current) folder.current.value = ""; }
  }
  const fromInput = (files: FileList | null) => read(async () => Array.from(files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name })));
  return <div className="space-y-3">
    <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }} onDrop={(e) => {
      e.preventDefault(); setOver(false);
      if (guard.current) return;
      // Capture DataTransfer entries synchronously before the browser clears them.
      const picked = droppedFiles(e.dataTransfer.items, e.dataTransfer.files);
      void read(() => picked);
    }} className={`rounded-card border-2 border-dashed p-5 sm:p-6 ${over ? "border-accent bg-accent-soft" : "border-line-strong bg-surface"}`} aria-busy={busy}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3"><Upload aria-hidden className="mt-1 h-5 w-5 shrink-0 text-fg-muted" /><div>
          <h2 className="font-medium">Bring your skills with you</h2>
          <p className="mt-1 text-sm text-fg-muted">Drop a skill or plugin folder, SKILL.md, .skill, .plugin or ZIP.</p>
          <p className="mt-2 text-xs text-fg-muted">Preview before saving · 100 text files · 200 KB each · 1 MB expanded</p>
        </div></div>
        <div className="flex shrink-0 flex-wrap gap-2"><Button disabled={busy} onClick={() => input.current?.click()}><Upload aria-hidden className="h-4 w-4" />Import files</Button>
          <Button variant="secondary" disabled={busy} onClick={() => folder.current?.click()}><FolderOpen aria-hidden className="h-4 w-4" />Choose folder</Button></div>
      </div>
      <input ref={input} type="file" multiple className="hidden" accept=".md,.skill,.plugin,.zip" aria-label="Import skill or plugin files" onChange={(e) => void fromInput(e.target.files)} />
      <input ref={folder} type="file" multiple className="hidden" {...{ webkitdirectory: "" }} aria-label="Import skill or plugin folder" onChange={(e) => void fromInput(e.target.files)} />
      {busy && <p role="status" className="mt-3 text-sm">Reading files and preparing your preview…</p>}
    </div>
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}

export function CreatePackage({ onReady }: { onReady: (draft: ParsedPackage) => void }) {
  const [kind, setKind] = React.useState("skill"), [error, setError] = React.useState("");
  const id = React.useId();
  return <details className="rounded-card border border-line bg-surface p-4">
    <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium"><Plus aria-hidden className="h-4 w-4" />Create a skill or plugin</summary>
    <form className="mt-4 max-w-2xl space-y-4" onSubmit={(e) => {
      e.preventDefault(); const data = new FormData(e.currentTarget);
      const name = String(data.get("name") ?? ""), description = String(data.get("description") ?? ""), body = String(data.get("body") ?? "");
      const files = kind === "plugin" ? [
        { path: ".claude-plugin/plugin.json", content: JSON.stringify({ name, description }, null, 2) + "\n" },
        { path: "skills/my-skill/SKILL.md", content: makeSkillFile("My skill", description, body) },
      ] : [{ path: "SKILL.md", content: makeSkillFile(name, description, body) }];
      try { onReady(parsePackage(files)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Check the fields."); }
    }}>
      <div className="space-y-1.5"><Label htmlFor={`${id}-kind`}>What are you creating?</Label><select id={`${id}-kind`} className={SKILL_CONTROL} value={kind} onChange={(e) => setKind(e.target.value)}><option value="skill">A skill</option><option value="plugin">A plugin with skills and files</option></select></div>
      <Field name="name" label={kind === "plugin" ? "Plugin name" : "Skill name"} required maxLength={150} placeholder="e.g. Plan my week" />
      <Field name="description" label="When to use this" required maxLength={500} placeholder="e.g. When I ask for help planning the week" />
      <div className="space-y-1.5"><Label htmlFor={`${id}-body`}>Full instructions</Label><textarea id={`${id}-body`} name="body" required maxLength={100000} rows={6} className={SKILL_CONTROL} placeholder="Describe what your agent should do, step by step." /></div>
      {kind === "plugin" && <p className="text-sm text-fg-muted">Start with one skill. In the preview you can rename it, add skills under skills/name/SKILL.md, and attach supporting files.</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit">Preview new {kind}</Button>
    </form>
  </details>;
}
