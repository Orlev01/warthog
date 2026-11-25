import { isReservedSkillTitle } from "../../domain/skills/builtins";
import { assertCollectionCapacity } from "./collection-limits";
import { randomUUID } from "node:crypto";
import {
  parsePackage,
  safePackagePath,
  PackageError,
  type PackageFile,
  type ParsedPackage,
} from "../../domain/skills/package";
import { encrypt, decrypt } from "../crypto/envelope";
import { withTransaction, type Db } from "./index";
import { createSkill, editSkill, listSkillsForUser } from "./skills";

export interface StoredPackage extends ParsedPackage {
  id: string;
  revision: number;
  members: { path: string; skillId: string }[];
}
export interface SavePackageInput {
  id?: string;
  revision?: number;
  name?: string;
  files: PackageFile[];
}
export type PackageSummary = Pick<
  StoredPackage,
  "id" | "revision" | "name" | "description" | "kind" | "members" | "components"
> & {
  skills: { path: string; name: string; description: string }[];
  fileCount: number;
};

export async function listPackageSummaries(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<PackageSummary[]> {
  const rows = await db.query(
    "SELECT id, revision, summary_ct FROM skill_packages WHERE user_id = $1 ORDER BY id",
    [userId],
  );
  return Promise.all(
    rows.rows.map(async (row) => ({
      ...JSON.parse(
        await decrypt(
          dek,
          "skill_packages",
          "summary_ct",
          row.id as string,
          row.summary_ct as string,
        ),
      ),
      id: row.id as string,
      revision: row.revision as number,
    })),
  );
}

export async function getPackage(
  db: Db,
  userId: string,
  id: string,
  dek: Uint8Array,
): Promise<StoredPackage | null> {
  const rows = await db.query(
    "SELECT id, revision, content_ct FROM skill_packages WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const content = JSON.parse(
    await decrypt(
      dek,
      "skill_packages",
      "content_ct",
      id,
      row.content_ct as string,
    ),
  );
  return {
    ...parsePackage(content.files, content.name),
    members: content.members,
    id,
    revision: row.revision as number,
  };
}

export async function listPackages(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<StoredPackage[]> {
  const rows = await db.query(
    "SELECT id, revision, content_ct FROM skill_packages WHERE user_id = $1 ORDER BY id",
    [userId],
  );
  return Promise.all(
    rows.rows.map(async (row) => {
      const content = JSON.parse(
        await decrypt(
          dek,
          "skill_packages",
          "content_ct",
          row.id as string,
          row.content_ct as string,
        ),
      );
      return {
        ...parsePackage(content.files, content.name),
        members: content.members,
        id: row.id as string,
        revision: row.revision as number,
      };
    }),
  );
}

export async function savePackage(
  db: Db,
  userId: string,
  input: SavePackageInput,
  dek: Uint8Array,
  // From the Skills page: a skill name that's one of Warthog's is refused unless the package
  // already had it (docs/adr/editable-builtin-skills.md). An import keeps what was exported.
  options: { readonly refuseNewReservedNames?: boolean } = {},
): Promise<StoredPackage> {
  const parsed = parsePackage(input.files, input.name);
  const save = async (tx: Db) => {
    // Serialize package edits and title checks for this owner, including a new package.
    await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const packages = await listPackageSummaries(tx, userId, dek);
    const previous = input.id
      ? packages.find((p) => p.id === input.id)
      : undefined;
    if (input.id && !previous)
      throw new PackageError("Package not found. It may have been deleted.");
    if (previous && previous.revision !== input.revision)
      throw new PackageError(
        "This package changed in another tab. Reload it before saving.",
      );
    if (options.refuseNewReservedNames) {
      const before = previous ? new Set(((await getPackage(tx, userId, previous.id, dek))?.skills ?? []).map((skill) => skill.name.trim().toLowerCase())) : new Set<string>();
      const clash = parsed.skills.find((skill) => isReservedSkillTitle(skill.name) && !before.has(skill.name.trim().toLowerCase()));
      if (clash) throw new PackageError(`${clash.name} is the name of one of Warthog's skills. Choose another name.`);
    }
    if (
      packages.some(
        (p) =>
          p.id !== input.id &&
          p.name.toLowerCase() === parsed.name.toLowerCase(),
      )
    )
      throw new PackageError(
        "A package with this name already exists. Edit it or give this copy another name.",
      );
    const id = previous?.id ?? randomUUID();
    const revision = (previous?.revision ?? 0) + 1;
    const ownedSkills = await listSkillsForUser(tx, userId, dek, {
      summaryOnly: true,
    });
    const oldIds = new Set(previous?.members.map((m) => m.skillId));
    const titles = parsed.skills.map((s) =>
      parsed.kind === "plugin" ? `${parsed.name} / ${s.name}` : s.name,
    );
    if (
      ownedSkills.some(
        (s) =>
          !oldIds.has(s.id) &&
          titles.some((t) => t.toLowerCase() === s.title.toLowerCase()),
      )
    )
      throw new PackageError(
        "A skill with this name already exists. Rename this skill before saving.",
      );
    const members: StoredPackage["members"] = [];
    for (const [i, skill] of parsed.skills.entries()) {
      const old = previous?.members.find((m) => m.path === skill.path);
      const original = old
        ? ownedSkills.find((s) => s.id === old.skillId)
        : undefined;
      const content = {
        title: titles[i]!,
        useThisWhen: skill.description,
        fullText: skill.body,
      };
      const saved = original
        ? await editSkill(
            tx,
            userId,
            original.id,
            {
              ...content,
              scope: original.scope,
              scopedAgentIds: original.scopedAgentIds,
            },
            dek,
          )
        : await createSkill(
            tx,
            { userId, ...content, scope: "all", enabled: false },
            dek,
          );
      members.push({ path: skill.path, skillId: saved.id });
    }
    const ct = await encrypt(
      dek,
      "skill_packages",
      "content_ct",
      id,
      JSON.stringify({ files: parsed.files, name: parsed.name, members }),
    );
    const summary = await encrypt(
      dek,
      "skill_packages",
      "summary_ct",
      id,
      JSON.stringify({
        name: parsed.name,
        description: parsed.description,
        kind: parsed.kind,
        components: parsed.components,
        skills: parsed.skills.map(({ path, name, description }) => ({
          path,
          name,
          description,
        })),
        fileCount: parsed.files.length,
        members,
      }),
    );
    await assertCollectionCapacity(
      tx,
      userId,
      "skill_packages",
      ct.length + summary.length,
      previous ? id : undefined,
    );
    if (previous) {
      await tx.query(
        "UPDATE skill_packages SET content_ct = $3, revision = $4, summary_ct = $5 WHERE id = $1 AND user_id = $2",
        [id, userId, ct, revision, summary],
      );
      await tx.query(
        "DELETE FROM skill_package_members WHERE package_id = $1 AND user_id = $2",
        [id, userId],
      );
      for (const old of previous.members.filter(
        (m) => !members.some((n) => n.skillId === m.skillId),
      )) {
        await tx.query("DELETE FROM skills WHERE id = $1 AND user_id = $2", [
          old.skillId,
          userId,
        ]);
      }
    } else {
      await tx.query(
        "INSERT INTO skill_packages (id, user_id, content_ct, summary_ct) VALUES ($1, $2, $3, $4)",
        [id, userId, ct, summary],
      );
    }
    for (const member of members) {
      await tx.query(
        "INSERT INTO skill_package_members (package_id, skill_id, user_id) VALUES ($1, $2, $3)",
        [id, member.skillId, userId],
      );
    }
    return { ...parsed, id, revision, members };
  };
  return db.inTransaction ? save(db) : withTransaction(db, save);
}

export async function deletePackage(
  db: Db,
  userId: string,
  id: string,
  revision: number,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const found = await tx.query(
      "SELECT revision FROM skill_packages WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    if (!found.rows.length) return false;
    if (found.rows[0]!.revision !== revision)
      throw new PackageError(
        "This package changed in another tab. Reload it before deleting.",
      );
    await tx.query(
      "DELETE FROM skills WHERE user_id = $1 AND id IN (SELECT skill_id FROM skill_package_members WHERE package_id = $2 AND user_id = $1)",
      [userId, id],
    );
    await tx.query(
      "DELETE FROM skill_packages WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    return true;
  });
}

export async function packageFilesForSkill(
  db: Db,
  userId: string,
  skillId: string,
  dek: Uint8Array,
): Promise<PackageFile[]> {
  const row = await db.query(
    "SELECT p.id, p.content_ct FROM skill_packages p JOIN skill_package_members m ON m.package_id = p.id AND m.user_id = p.user_id WHERE m.skill_id = $1 AND p.user_id = $2",
    [skillId, userId],
  );
  if (!row.rows[0]) return [];
  const p = row.rows[0];
  const content = JSON.parse(
    await decrypt(
      dek,
      "skill_packages",
      "content_ct",
      p.id as string,
      p.content_ct as string,
    ),
  );
  const member = (content.members as StoredPackage["members"]).find(
    (m) => m.skillId === skillId,
  );
  if (!member) return [];
  const prefix = member.path.slice(0, -"SKILL.md".length);
  // A nested skill has its own access controls, even when its directory sits
  // beneath this skill. Root-level plugin configuration is not a skill resource.
  const nestedPrefixes = (content.members as StoredPackage["members"])
    .filter((m) => m.path !== member.path && m.path.startsWith(prefix))
    .map((m) => m.path.slice(0, -"SKILL.md".length));
  return (content.files as PackageFile[])
    .filter(
      (f) =>
        f.path.startsWith(prefix) &&
        f.path !== member.path &&
        !nestedPrefixes.some((nested) => f.path.startsWith(nested)) &&
        (prefix !== "" ||
          !/^(?:\.claude-plugin\/|\.mcp\.json$|skills\/|agents\/|commands\/|hooks\/)/.test(
            f.path,
          )),
    )
    .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
}

// The caller first verifies the skill's enabled state and agent scope.
export async function packageFileForSkill(
  db: Db,
  userId: string,
  skillId: string,
  path: string,
  dek: Uint8Array,
): Promise<string | null> {
  if (!safePackagePath(path)) return null;
  return (
    (await packageFilesForSkill(db, userId, skillId, dek)).find(
      (f) => f.path === path,
    )?.content ?? null
  );
}

export async function isPackagedSkill(
  db: Db,
  userId: string,
  skillId: string,
): Promise<boolean> {
  return (
    (
      await db.query(
        "SELECT skill_id FROM skill_package_members WHERE skill_id = $1 AND user_id = $2",
        [skillId, userId],
      )
    ).rows.length > 0
  );
}
