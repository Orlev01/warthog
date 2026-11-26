import { createRedactingRecorder } from "../mcp/recorder";
import { systemClock } from "../seams/clock";
import { z } from "zod";
import { PACKAGE_LIMITS, PackageError, parsePackage, ignoredPackagePath } from "../../domain/skills/package";
import { parseParams } from "../http/validate";
import { deletePackage, getPackage, savePackage } from "../db/skill-packages";
import { getUserById } from "../db/users";
import { withTransaction, type Db } from "../db/index";
import { getAgentById } from "../db/agents";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Session } from "../auth/session";
import { readArchive, writeArchive } from "./archive";

export const packageInputSchema = z.object({
  id: z.uuid().optional(), revision: z.number().int().positive().optional(), name: z.string().max(150).optional(),
  files: z.array(z.object({ path: z.string().max(300), content: z.string().max(PACKAGE_LIMITS.fileBytes) })).min(1).max(PACKAGE_LIMITS.files),
});

export function createLibraryActions({ db, keyWrapper }: { db: Db; keyWrapper: KeyWrapper }) {
  async function key(session: Session) {
    const user = await getUserById(db, session.userId);
    if (!user) throw new PackageError("Sign in again to manage your library.");
    return keyWrapper.unwrap(user.wrappedDek);
  }
  return {
    async load(session: Session, input: unknown) {
      const { id } = parseParams(z.object({ id: z.uuid() }), input);
      const p = await getPackage(db, session.userId, id, await key(session));
      if (!p) throw new PackageError("Package not found. It may have been deleted.");
      return p;
    },
    async access(session: Session, input: unknown) {
      const valid = parseParams(z.object({ id: z.uuid(), enabled: z.boolean(), scope: z.enum(["all", "chosen"]), scopedAgentIds: z.array(z.uuid()).max(100) }), input);
      const dek = await key(session);
      await withTransaction(db, async (tx) => {
        await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [session.userId]);
        if (valid.scope === "chosen") {
          for (const id of valid.scopedAgentIds) {
            const agent = await getAgentById(tx, session.userId, id);
            if (!agent || agent.status !== "connected") throw new PackageError("Choose one of your connected agents.");
          }
        }
        const result = await tx.query("UPDATE skills SET enabled = $3, scope = $4, scoped_agent_ids = $5::jsonb WHERE id = $1 AND user_id = $2 RETURNING id", [valid.id, session.userId, valid.enabled, valid.scope, JSON.stringify(valid.scope === "chosen" ? valid.scopedAgentIds : [])]);
        if (!result.rows.length) throw new PackageError("Skill not found. It may have been deleted.");
        await tx.query("DELETE FROM agent_skill_access WHERE user_id = $1 AND skill_id = $2", [session.userId, valid.id]);
        // The person has checked an agent's save: from now on that agent's changes wait for them
        // (docs/adr/agent-saved-skills.md).
        await tx.query("UPDATE skill_packages SET awaiting_check = false WHERE user_id = $1 AND id IN (SELECT package_id FROM skill_package_members WHERE user_id = $1 AND skill_id = $2)", [session.userId, valid.id]);
        await createRedactingRecorder({ db: tx, clock: systemClock, dekFor: async () => dek }).record({ userId: session.userId, kind: "skill_access_change", source: "warthog", outcome: "saved", payload: valid });
      });
    },
    async save(session: Session, input: unknown) {
      const valid = parseParams(packageInputSchema, input);
      return savePackage(db, session.userId, valid, await key(session), { refuseNewReservedNames: true });
    },
    async remove(session: Session, input: unknown) {
      const valid = parseParams(z.object({ id: z.uuid(), revision: z.number().int().positive() }), input);
      if (!(await deletePackage(db, session.userId, valid.id, valid.revision))) throw new PackageError("Package not found. It may have been deleted.");
    },
    async download(session: Session, input: unknown) {
      const { id } = parseParams(z.object({ id: z.uuid() }), input);
      const p = await getPackage(db, session.userId, id, await key(session));
      if (!p) throw new PackageError("Package not found. It may have been deleted.");
      return { name: `${p.name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "skill"}.zip`, base64: writeArchive(p.files).toString("base64") };
    },
  };
}

export async function previewUpload(form: FormData) {
  const entries = form.getAll("files");
  if (!entries.length || entries.length > PACKAGE_LIMITS.files) throw new PackageError("Choose up to 100 files, or one archive.");
  const files: { path: string; content: string }[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (typeof entry === "string" || typeof entry.arrayBuffer !== "function") throw new PackageError("Choose a file first.");
    total += entry.size;
    if (total > PACKAGE_LIMITS.archiveBytes) throw new PackageError("The upload is too large (maximum 5 MB).");
    if (/\.(zip|skill|plugin)$/i.test(entry.name)) {
      if (entries.length !== 1) throw new PackageError("Import one archive at a time.");
      const unpacked = readArchive(new Uint8Array(await entry.arrayBuffer()));
      return { package: parsePackage(unpacked.files, entry.name.replace(/\.[^.]+$/, "")), skipped: unpacked.skipped };
    }
    // Paths are separate fields because multipart parsers remove filename directories.
    const pathEntry = form.getAll("paths")[files.length + skipped.length];
    let path = typeof pathEntry === "string" ? pathEntry : entry.name;
    if (entries.length === 1 && /\.md$/i.test(path) && !path.includes("/")) path = "SKILL.md";
    if (ignoredPackagePath(path)) { skipped.push(path); continue; }
    if (entry.size > PACKAGE_LIMITS.fileBytes) throw new PackageError("A file is too large (maximum 200 KB).");
    try {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await entry.arrayBuffer());
      if (content.includes("\u0000")) throw new Error();
      files.push({ path, content });
    } catch { skipped.push(path); }
  }
  return { package: parsePackage(files), skipped };
}
