// The skills aggregate's data access (brief "Skills, preferences and shared
// memory"; design §4.1). A skill is an INSTRUCTION DOCUMENT a person writes for
// specific tasks — a title, a one-line "use this when" description and the full
// instruction text — scoped to all of their agents or to chosen ones. An agent's
// context lists only the titles and "use this when" lines of the skills it may use
// (`skillsForAgent`); it fetches a skill's full text by title when it decides the
// skill is relevant (`getSkillText`).
//
// PERSONAL CONTENT, SO DEK-ENCRYPTED. A skill's title, "use this when" line and
// full text are all personal content the person authored, not filterable metadata
// (design §4.1; constitution principle 19 forbids any operator path to decrypt a
// person's skills contents). So each is stored only DEK-ENCRYPTED
// (`../crypto/envelope`): the id is generated up front so each envelope's associated
// data binds the ciphertext to its exact (table, column, row) — the plaintext never
// lands in a column — and the fields are decrypted in the app within the already
// member-filtered set. The `enabled` flag, the `scope` and the chosen agent ids are
// PLAINTEXT METADATA (an "agent id" is §4.1 metadata), so a skill's applicable set
// can be filtered without decrypting.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every
// read/write is member-scoped by the `userId` the caller passes — the session's id,
// never a client value — so one person can never read or change another's skills.
// The DEK is injected (this module reads no `process.env` and holds no key, INV-103).

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db, Row } from "./index";
import { packageFilesForSkill, packageFileForSkill } from "./skill-packages";

// The envelope's associated data binds each field's ciphertext to its exact
// location, so a row lifted into another row/column/table fails to decrypt. Each
// content field is encrypted/decrypted under its own column name.
const TABLE = "skills";

// A skill applies to ALL of the owner's agents, or to CHOSEN ones.
export type SkillScope = "all" | "chosen";

// What createSkill records: the OWNER (the session's id, never a client value), the
// three content fields (each stored DEK-encrypted), the scope and (for a chosen
// scope) the chosen agent ids. `enabled` defaults to true (a fresh skill is on).
export interface NewSkill {
  readonly userId: string;
  readonly title: string;
  readonly useThisWhen: string;
  readonly fullText: string;
  readonly scope: SkillScope;
  readonly scopedAgentIds?: string[];
  readonly enabled?: boolean;
}

// The new content editSkill applies (a full replace of content + scope; the owner
// and the enabled flag are not changed here).
export interface SkillEdits {
  readonly title: string;
  readonly useThisWhen: string;
  readonly fullText: string;
  readonly scope: SkillScope;
  readonly scopedAgentIds?: string[];
}

// A skill as handed back to its OWNER (every content field DECRYPTED under the
// owner's DEK).
export interface Skill {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly useThisWhen: string;
  readonly fullText: string;
  readonly scope: SkillScope;
  readonly scopedAgentIds: string[];
  readonly enabled: boolean;
}

// One entry of the agent-scoped index — the title and "use this when" line only,
// never the full text.
export interface SkillIndexEntry {
  readonly title: string;
  readonly useThisWhen: string;
}

// Does a skill with this scope + chosen-agent list apply to `agentId`? An 'all'
// skill covers every agent; a 'chosen' skill covers only the agents it lists.
function scopeCovers(scope: SkillScope, scopedAgentIds: string[], agentId: string): boolean {
  return scope === "all" || (scope === "chosen" && scopedAgentIds.includes(agentId));
}

// Encrypt the three content fields under the owner's DEK, each bound to its row by
// the skill's id and to its column by its name.
async function encryptContent(
  dek: Uint8Array,
  id: string,
  content: { title: string; useThisWhen: string; fullText: string },
): Promise<{ title: string; useThisWhen: string; fullText: string }> {
  const [title, useThisWhen, fullText] = await Promise.all([
    encrypt(dek, TABLE, "title", id, content.title),
    encrypt(dek, TABLE, "use_this_when", id, content.useThisWhen),
    encrypt(dek, TABLE, "full_text", id, content.fullText),
  ]);
  return { title, useThisWhen, fullText };
}

// Create a skill for `input.userId`, storing its three content fields DEK-encrypted
// plus the plaintext scope / chosen agents / enabled flag. The id is generated up
// front so the envelopes bind to the row; the returned Skill is assembled from the
// inputs (no dependency on a RETURNING read). Member-scoped: the user id is bound.
export async function createSkill(db: Db, input: NewSkill, dek: Uint8Array): Promise<Skill> {
  const id = randomUUID();
  const scopedAgentIds = input.scopedAgentIds ?? [];
  const enabled = input.enabled ?? true;
  const content = await encryptContent(dek, id, input);

  await db.query(
    `INSERT INTO skills (id, user_id, title, use_this_when, full_text, scope, scoped_agent_ids, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      id,
      input.userId,
      content.title,
      content.useThisWhen,
      content.fullText,
      input.scope,
      JSON.stringify(scopedAgentIds),
      enabled,
    ],
  );

  return {
    id,
    userId: input.userId,
    title: input.title,
    useThisWhen: input.useThisWhen,
    fullText: input.fullText,
    scope: input.scope,
    scopedAgentIds,
    enabled,
  };
}

// Replace an OWNED skill's content + scope in place (same id), re-encrypting the
// text; the enabled flag is PRESERVED (not touched by the UPDATE, read back here).
// Member-scoped (id AND user_id bound). THROWS when there is no such skill for this
// user, so a cross-user edit cannot silently no-op.
export async function editSkill(
  db: Db,
  userId: string,
  id: string,
  edits: SkillEdits,
  dek: Uint8Array,
): Promise<Skill> {
  const scopedAgentIds = edits.scopedAgentIds ?? [];
  const content = await encryptContent(dek, id, edits);

  const result = await db.query(
    `UPDATE skills
       SET title = $1, use_this_when = $2, full_text = $3, scope = $4, scoped_agent_ids = $5::jsonb
     WHERE id = $6 AND user_id = $7
     RETURNING enabled`,
    [content.title, content.useThisWhen, content.fullText, edits.scope, JSON.stringify(scopedAgentIds), id, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("editSkill: no such skill for this user");

  return {
    id,
    userId,
    title: edits.title,
    useThisWhen: edits.useThisWhen,
    fullText: edits.fullText,
    scope: edits.scope,
    scopedAgentIds,
    enabled: row.enabled as boolean,
  };
}

// Copy an OWNED skill into a NEW row (new id) with the same content + scope (and
// enabled state). The original's content is decrypted under the owner's DEK and
// re-encrypted under the new id (the envelope binds to the row, so ciphertext cannot
// simply be duplicated). Member-scoped. THROWS when there is no such skill for this
// user, so a cross-user duplicate creates nothing.
export async function duplicateSkill(
  db: Db,
  userId: string,
  id: string,
  dek: Uint8Array,
): Promise<Skill> {
  const result = await db.query(
    `SELECT id, title, use_this_when, full_text, scope, scoped_agent_ids, enabled
     FROM skills WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("duplicateSkill: no such skill for this user");

  const original = await decryptRow(dek, row);
  return createSkill(
    db,
    {
      userId,
      title: original.title,
      useThisWhen: original.useThisWhen,
      fullText: original.fullText,
      scope: original.scope,
      scopedAgentIds: original.scopedAgentIds,
      enabled: original.enabled,
    },
    dek,
  );
}

// Switch an OWNED skill OFF (enabled = false); it persists, it is not deleted.
// Member-scoped (id AND user_id bound). THROWS when there is no such skill for this
// user, so a cross-user disable cannot silently no-op.
export async function disableSkill(db: Db, userId: string, id: string): Promise<void> {
  const result = await db.query(
    `UPDATE skills SET enabled = false WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  if (result.rows.length === 0) throw new Error("disableSkill: no such skill for this user");
}

// Delete an OWNED skill; true when a row was removed, false when there was none for
// this user (so another person's delete is a no-op). Member-scoped (id AND user_id
// bound).
export async function deleteSkill(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM skills WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return result.rows.length > 0;
}

// The columns a full read returns, kept in one place; the three content columns come
// back as ciphertext and are decrypted separately.
const SELECT_COLUMNS =
  "id, user_id, title, use_this_when, full_text, scope, scoped_agent_ids, enabled";

// Decrypt a raw row's three content fields and assemble a Skill. jsonb comes back
// already parsed, so `scoped_agent_ids` is an array.
async function decryptRow(dek: Uint8Array, row: Row): Promise<Skill> {
  const id = row.id as string;
  const [title, useThisWhen, fullText] = await Promise.all([
    decrypt(dek, TABLE, "title", id, row.title as string),
    decrypt(dek, TABLE, "use_this_when", id, row.use_this_when as string),
    decrypt(dek, TABLE, "full_text", id, row.full_text as string),
  ]);
  return {
    id,
    userId: row.user_id as string,
    title,
    useThisWhen,
    fullText,
    scope: row.scope as SkillScope,
    scopedAgentIds: (row.scoped_agent_ids as string[]) ?? [],
    enabled: row.enabled as boolean,
  };
}

// List ALL of `userId`'s skills — enabled and disabled — each content field
// DECRYPTED under the owner's `dek`, carrying its scope and enabled state.
// Member-scoped (user_id bound); never another person's. An empty array when the
// person has none. A wrong DEK fails the GCM tag and rejects.
export async function listSkillsForUser(db: Db, userId: string, dek: Uint8Array): Promise<Skill[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM skills WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

  const skills: Skill[] = [];
  for (const row of result.rows) {
    skills.push(await decryptRow(dek, row));
  }
  return skills;
}

// The agent-scoped index: ONLY the title + useThisWhen of the owner's ENABLED skills
// whose scope covers `agentId` (scope 'all', or 'chosen' listing agentId). NO full
// text — it is neither selected nor returned. Member-scoped (user_id bound);
// decrypted under the owner's `dek`.
export async function skillsForAgent(
  db: Db,
  userId: string,
  agentId: string,
  dek: Uint8Array,
): Promise<SkillIndexEntry[]> {
  const result = await db.query(
    `SELECT s.id, s.title, s.use_this_when, s.scope, s.scoped_agent_ids, a.allowed
     FROM skills s LEFT JOIN agent_skill_access a ON a.skill_id = s.id AND a.user_id = s.user_id AND a.agent_id::text = $2
     WHERE s.user_id = $1 AND s.enabled = true ORDER BY s.created_at`,
    [userId, agentId],
  );

  const index: SkillIndexEntry[] = [];
  for (const row of result.rows) {
    const scopedAgentIds = (row.scoped_agent_ids as string[]) ?? [];
    if (!(row.allowed ?? scopeCovers(row.scope as SkillScope, scopedAgentIds, agentId))) continue;
    const id = row.id as string;
    const [title, useThisWhen] = await Promise.all([
      decrypt(dek, TABLE, "title", id, row.title as string),
      decrypt(dek, TABLE, "use_this_when", id, row.use_this_when as string),
    ]);
    index.push({ title, useThisWhen });
  }
  return index;
}

// The full text of the owner's ENABLED skill titled `title` IFF its scope covers
// `agentId`; null otherwise (unknown title, disabled, or not scoped to that agent).
// The title is encrypted, so it is matched by decrypting within the member-filtered
// set of enabled skills. Member-scoped (user_id bound): an agent never reads another
// person's skill. Decrypted under the owner's `dek`.
export async function getSkillText(
  db: Db,
  userId: string,
  agentId: string,
  title: string,
  dek: Uint8Array,
  file?: string,
): Promise<string | null> {
  const result = await db.query(
    `SELECT s.id, s.title, s.full_text, s.scope, s.scoped_agent_ids, a.allowed
     FROM skills s LEFT JOIN agent_skill_access a ON a.skill_id = s.id AND a.user_id = s.user_id AND a.agent_id::text = $2
     WHERE s.user_id = $1 AND s.enabled = true`,
    [userId, agentId],
  );

  for (const row of result.rows) {
    const scopedAgentIds = (row.scoped_agent_ids as string[]) ?? [];
    if (!(row.allowed ?? scopeCovers(row.scope as SkillScope, scopedAgentIds, agentId))) continue;
    const id = row.id as string;
    const rowTitle = await decrypt(dek, TABLE, "title", id, row.title as string);
    if (rowTitle !== title) continue;
    if (file) return packageFileForSkill(db, userId, id, file, dek);
    const body = await decrypt(dek, TABLE, "full_text", id, row.full_text as string);
    const files = await packageFilesForSkill(db, userId, id, dek);
    return files.length ? `${body}\n\nSupporting files (fetch with get_skill using this title and the file path):\n${files.map((f) => `- ${f.path}`).join("\n")}` : body;
  }
  return null;
}
