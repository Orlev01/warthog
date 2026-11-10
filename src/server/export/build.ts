// E16-S02 — Export document builder (server).
//
// Assembles a person's complete export document to the E16-S01 schema (`./schema`),
// so they can take EVERYTHING THEY KEEP to another account or provider (brief "Export
// and portability"; design: data portability; constitution 20 "every person can export
// all of their data"). It is built ENTIRELY by COMPOSING the already-built, tested
// list-all reads and stores — `listIdentityFields`, `getPreferences`,
// `listSkillsForUser`, `listMemoriesForUser`, `listAllRules`, `listTasksForUser`,
// `listRecordsForUser`, `listConnectionsForUser`, and the activity read — rather than
// re-running SQL or re-implementing decryption, so there is ONE source of truth for
// each read and each aggregate's DEK decryption happens in its own store.
//
// This is the SERVER builder: a server-only export, so it carries NO device-protected
// section (high-tier identity values and card numbers are encrypted in the browser and
// the server cannot decrypt them — the brief exports those "on the device", a separate
// path). It therefore omits the schema's optional `deviceProtected` block.
//
// Security properties, all inherited from the composed stores:
//   • MEMBER-SCOPED BY `userId` ALONE (the session's id the caller passes, never a
//     client value): every read binds that one id, so an id supplied in a request body
//     can never widen the scope to another person's data (AC4, INV-102).
//   • NO CREDENTIALS: the connection list read (`listConnectionsForUser`) never selects
//     or returns the DEK-encrypted credentials, so connector OAuth tokens / API keys
//     never reach the export document (AC2).
//   • INJECTED DEPS ONLY: the db, the person's already-unwrapped DEK, and the clock are
//     all passed in; this module reads no `process.env` and holds no key, so no ambient
//     env value can land in the document and the content decrypts only under the
//     injected DEK (AC6, INV-103).
//   • BOUNDED ACTIVITY READ: the full activity history is read in keyset pages, so an
//     arbitrarily long chain is never held — nor decrypted — all at once.

import { listIdentityFields, type IdentityField, type IdentityFieldKind } from "../db/identity-fields";
import { getPreferences } from "../db/preferences";
import { listSkillsForUser, type Skill } from "../db/skills";
import { listPackages } from "../db/skill-packages";
import { listMemoriesForUser } from "../db/memories";
import { listAllRules } from "../db/rules";
import { listTasksForUser } from "../db/tasks";
import { listRecordsForUser } from "../db/life-admin-records";
import { listConnectionsForUser } from "../db/connections";
import { readActivityBatch } from "../activity/writer";
import type { ActivityEntry } from "../activity/recorder";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";
import type { ExportDocument } from "./schema";

// The export-format version this builder produces (the E16-S01 contract's `version`).
const EXPORT_VERSION = 1;

// The bounded page size for reading the full activity chain. The history is read in
// keyset pages of at most this many rows (`readActivityBatch`), so however long the
// chain is, at most this many payloads are decrypted and held at once — the complete
// history is still assembled across as many pages as the person's chain needs (the
// brief's 100,000-entry export is read in bounded pages, well within its time budget).
const ACTIVITY_BATCH = 20;

// Render one skill as PLAIN TEXT usable outside Warthog (AC3): its title, a labelled
// "use this when" line, then the full body — the form another AI tool can read directly.
function renderSkillText(skill: Skill): string {
  return `${skill.title}\n\nUse this when: ${skill.useThisWhen}\n\n${skill.fullText}`;
}

// The person's LOW-TIER identity as the schema's `profile` object: the documented
// `name` / `email` scalars (the first field of each kind) plus the full list of
// low-tier fields, so a person who holds several emails/phones loses none on export.
function buildProfile(fields: IdentityField[]): ExportDocument["profile"] {
  const firstValue = (kind: IdentityFieldKind): string | undefined =>
    fields.find((field) => field.kind === kind)?.value;
  return {
    name: firstValue("name"),
    email: firstValue("email"),
    fields: fields.map((field) => ({
      kind: field.kind,
      value: field.value,
      movingOn: field.movingOn ?? null,
    })),
  };
}

// Read the person's FULL activity history in bounded keyset pages, ascending seq.
// A correct loop assembles EVERY entry across as many pages as the chain needs: it
// pages forward from the last seq it saw and stops when a page comes back short (or
// empty), so nothing is lost and nothing is read twice.
async function readFullActivity(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<ActivityEntry[]> {
  const entries: ActivityEntry[] = [];
  let afterSeq = 0;
  for (;;) {
    const batch = await readActivityBatch(db, userId, dek, afterSeq, ACTIVITY_BATCH);
    if (batch.length === 0) break;
    entries.push(...batch);
    afterSeq = batch[batch.length - 1]!.seq;
    if (batch.length < ACTIVITY_BATCH) break;
  }
  return entries;
}

// Build the complete export document for the SESSION person `userId`, decrypting every
// DEK-encrypted section server-side under the injected `dek` and stamping `exportedAt`
// from the injected `clock`. Every section is read member-scoped by `userId` alone.
// Rejects if `dek` cannot decrypt the person's content (a wrong DEK fails the GCM tag).
export async function buildExportDocument(
  db: Db,
  userId: string,
  dek: Uint8Array,
  clock: Clock,
): Promise<ExportDocument> {
  const identityFields = await listIdentityFields(db, userId, dek);
  const preferences = await getPreferences(db, userId, dek);
  const skills = await listSkillsForUser(db, userId, dek);
  const packages = await listPackages(db, userId, dek);
  const packageBySkill = new Map(packages.flatMap((p) => p.members.map((m) => [m.skillId, p.id] as const)));
  const memory = await listMemoriesForUser(db, userId, dek);
  const rules = await listAllRules(db, userId, dek);
  const tasks = await listTasksForUser(db, userId, dek);
  const lifeAdmin = await listRecordsForUser(db, userId, dek);
  const connections = await listConnectionsForUser(db, userId);
  const activity = await readFullActivity(db, userId, dek);

  return {
    version: EXPORT_VERSION,
    exportedAt: clock.now().toISOString(),
    profile: buildProfile(identityFields),
    preferences: preferences
      ? {
          tone: preferences.tone,
          length: preferences.length,
          language: preferences.language,
          units: preferences.units,
          timeZone: preferences.timeZone,
          briefing: preferences.briefing,
        }
      : {},
    ...(packages.length ? { skillPackages: packages.map((p) => ({ id: p.id, name: p.name, files: p.files })) } : {}),
    skills: skills.map((skill) => ({
      id: skill.id,
      ...(packageBySkill.has(skill.id) ? { packageId: packageBySkill.get(skill.id) } : {}),
      title: skill.title,
      text: renderSkillText(skill),
    })),
    memory: memory.map((entry) => ({
      id: entry.id,
      content: entry.content,
      scope: entry.scope,
      sourceAgentId: entry.sourceAgentId,
      createdAt: entry.createdAt.toISOString(),
    })),
    rules: rules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      scope: rule.scope,
      action: rule.action,
      condition: rule.condition,
      status: rule.status,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      notes: task.notes,
      assignee: task.assignee,
      status: task.status,
      createdBy: task.createdBy,
    })),
    lifeAdmin: lifeAdmin.map((record) => ({
      id: record.id,
      kind: record.kind,
      fields: record.fields,
      dueDate: record.dueDate,
      status: record.status,
      reminderOffsets: record.reminderOffsets,
      source: record.source,
    })),
    connections: connections.map((connection) => ({
      id: connection.id,
      connectorId: connection.connectorId,
      accountLabel: connection.accountLabel,
      status: connection.status,
      connectedAt: connection.connectedAt,
    })),
    activity: activity.map((entry) => ({
      seq: entry.seq,
      occurredAt: entry.occurredAt,
      kind: entry.kind,
      source: entry.source,
      agentId: entry.agentId,
      connectorId: entry.connectorId,
      tool: entry.tool,
      outcome: entry.outcome,
      merchant: entry.merchant,
      payload: entry.payload,
      prevHash: entry.prevHash,
      entryHash: entry.entryHash,
    })),
  };
}
