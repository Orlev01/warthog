import { HOUSE_SKILL } from "./index";

export const PACKAGE_LIMITS = { files: 100, fileBytes: 200_000, totalBytes: 1_000_000, archiveBytes: 5_000_000 } as const;
export interface PackageFile { path: string; content: string }
export interface PackageSkill { path: string; name: string; description: string; body: string }
export interface ParsedPackage {
  kind: "skill" | "plugin";
  name: string;
  description: string;
  files: PackageFile[];
  skills: PackageSkill[];
  components: { agents: number; commands: number; hooks: number; connectors: number; scripts: number };
}
export class PackageError extends Error {}

export function safePackagePath(path: string): boolean {
  return path.length > 0 && path.length <= 300 && !/^[A-Za-z]:|[\\\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function ignoredPackagePath(path: string): boolean {
  return path.split("/").some((p) => [".git", "node_modules", "__MACOSX", ".DS_Store", ".env", ".next"].includes(p) || p.startsWith(".env."));
}

export function validateFiles(input: unknown): PackageFile[] {
  if (!Array.isArray(input) || !input.length) throw new PackageError("Choose files containing a SKILL.md or plugin first.");
  if (input.length > PACKAGE_LIMITS.files) throw new PackageError("A package can contain up to 100 files.");
  const seen = new Set<string>();
  let bytes = 0;
  return input.map((f) => {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") throw new PackageError("Could not read the files. Please choose them again.");
    if (!safePackagePath(f.path) || ignoredPackagePath(f.path)) throw new PackageError("A file path is unsafe or contains private system files.");
    if (seen.has(f.path.toLowerCase())) throw new PackageError(`Duplicate file path: ${f.path}`);
    seen.add(f.path.toLowerCase());
    const size = new TextEncoder().encode(f.content).length;
    bytes += size;
    if (size > PACKAGE_LIMITS.fileBytes || bytes > PACKAGE_LIMITS.totalBytes) throw new PackageError("Files are too large. Use up to 200 KB per file and 1 MB per package.");
    if (f.content.includes("\u0000")) throw new PackageError("Only UTF-8 text files can be edited here.");
    return { path: f.path, content: f.content };
  });
}

// Only display metadata is parsed. The original document, including unknown YAML
// fields, is retained verbatim; there is no YAML object construction or evaluation.
export function parseSkillFile(file: PackageFile): PackageSkill {
  const text = file.content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new PackageError(`${file.path} needs frontmatter with a name and description.`);
  const fields: Record<string, string> = Object.create(null);
  let key = "";
  let literal = false;
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-zA-Z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (field) {
      key = field[1]!;
      let value = field[2]!.trim();
      literal = value.startsWith("|");
      if (/^[>|][+-]?$/.test(value)) value = "";
      else if (value.startsWith('"') && value.endsWith('"')) {
        try { value = JSON.parse(value); } catch { throw new PackageError(`Invalid quoted frontmatter in ${file.path}.`); }
      } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
      else value = value.replace(/\s+#.*$/, "");
      fields[key] = value;
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] += (fields[key] ? (literal ? "\n" : " ") : "") + line.trim();
    }
  }
  const name = fields.name?.trim();
  const description = fields.description?.trim();
  const body = match[2]!.trim();
  if (!name || name.length > 150 || !description || description.length > 500) throw new PackageError(`${file.path} needs a name (up to 150 characters) and description (up to 500).`);
  if (name.toLowerCase() === HOUSE_SKILL.title.toLowerCase()) throw new PackageError("Using Warthog is a reserved skill name.");
  if (!body || body.length > 100_000) throw new PackageError(`${file.path} needs instructions of up to 100,000 characters.`);
  return { path: file.path, name, description, body };
}

export function makeSkillFile(name: string, description: string, body: string): string {
  return `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${body.trim()}\n`;
}

export function updateSkillFile(source: string, name: string, description: string, body: string): string {
  const match = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(source);
  if (!match) return makeSkillFile(name, description, body);
  let header = match[2]!;
  for (const [key, value] of [["name", name], ["description", description]] as const) {
    const scalar = new RegExp(`^${key}:[^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*`, "m");
    const replacement = `${key}: ${JSON.stringify(value.trim())}`;
    header = scalar.test(header) ? header.replace(scalar, () => replacement) : `${header}\n${replacement}`;
  }
  return `${match[1]}${header}${match[3]}\n${body}\n`;
}

export function duplicatePackage(original: ParsedPackage): ParsedPackage {
  const name = `${original.name.slice(0, 140)} copy`;
  let files = original.files.map((f) => ({ ...f }));
  if (original.kind === "skill") {
    const skill = original.skills[0]!;
    files = files.map((f) => f.path === skill.path ? { ...f, content: updateSkillFile(f.content, name, skill.description, skill.body) } : f);
  } else {
    files = files.map((f) => f.path === ".claude-plugin/plugin.json" ? { ...f, content: JSON.stringify({ ...JSON.parse(f.content), name }, null, 2) + "\n" } : f);
  }
  return parsePackage(files, name);
}

export function parsePackage(input: unknown, fallbackName = "My plugin"): ParsedPackage {
  let files = validateFiles(input);
  // Unwrap archive/folder wrappers, but preserve recognised package directories.
  while (files.every((f) => f.path.includes("/"))) {
    const top = files[0]!.path.split("/")[0]!;
    if (["skills", "agents", "commands", "hooks", "scripts", ".claude-plugin"].includes(top)
      || !files.every((f) => f.path.startsWith(`${top}/`))) break;
    fallbackName = top;
    files = files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) }));
  }
  const manifest = files.find((f) => f.path === ".claude-plugin/plugin.json");
  let metadata: Record<string, unknown> = {};
  if (manifest) {
    try {
      metadata = JSON.parse(manifest.content);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
    } catch { throw new PackageError("The plugin manifest must be a JSON object."); }
  }
  const components = {
    agents: files.filter((f) => f.path.startsWith("agents/")).length,
    commands: files.filter((f) => f.path.startsWith("commands/")).length,
    hooks: files.filter((f) => f.path.startsWith("hooks/")).length,
    connectors: files.filter((f) => f.path === ".mcp.json").length,
    scripts: files.filter((f) => f.path.startsWith("scripts/")).length,
  };
  const plugin = Boolean(manifest) || files.some((f) => f.path.startsWith("skills/")) || Object.entries(components).some(([k, count]) => k !== "scripts" && count > 0);
  const skills = files.filter((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md")).map(parseSkillFile);
  if (!skills.length && !plugin) throw new PackageError("No SKILL.md or plugin components found.");
  if (!plugin && skills.length !== 1) throw new PackageError("Put multiple skills in skills/<name>/SKILL.md inside a plugin folder.");
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name.toLowerCase())) throw new PackageError("Each skill in a plugin needs a different name.");
    names.add(skill.name.toLowerCase());
  }
  const name = plugin ? (typeof metadata.name === "string" ? metadata.name : fallbackName) : skills[0]!.name;
  const description = plugin ? (typeof metadata.description === "string" ? metadata.description : "A collection of skills and supporting files.") : skills[0]!.description;
  if (!name.trim() || name.length > 150 || description.length > 500) throw new PackageError("Use a package name up to 150 characters and description up to 500.");
  if (skills.some((s) => `${name} / ${s.name}`.length > 200)) throw new PackageError("Shorten the plugin or skill names so agents can identify them.");
  return { kind: plugin ? "plugin" : "skill", name: name.trim(), description, files, skills, components };
}
