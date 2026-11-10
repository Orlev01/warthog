// E16-S05 — Import service (server).
//
// Validates an uploaded Warthog export document (the E16-S01 schema, `../export/schema`)
// and writes it into the SIGNED-IN fresh account (brief "Export and portability" /
// "Import"; design: data portability; constitution 20 "every person can export all of
// their data and delete their account", and 14 "Warthog writes the record, not the
// agents"). It is the mirror of the export builder (`../export/build.ts`): where the
// builder COMPOSED the real list-all reads, the importer COMPOSES the real stores —
// `saveIdentityField`, `savePreferences`, `createSkill`, `createMemory`, `createRule`,
// `createTask`, `createRecord` — so each restored section gets the SAME encryption and
// validation the person's own writes use (one source of truth, never a parallel path).
//
// Two sections are handled specially, both from constitution 14:
//   • the export's old ACTIVITY history goes to the imported-history ARCHIVE
//     (`createImportedEntry`), a separate read-only record — it is NEVER appended to the
//     live, hash-chained activity record, so an import never claims authorship of actions
//     Warthog did not handle and never perturbs the live integrity chain;
//   • AGENTS and service CONNECTIONS are NOT recreated — a connection's own credentials
//     never travel in an export, so it cannot be rebuilt, and an agent is a live
//     connection to a new account, not restorable content.
//
// SECURITY PROPERTIES, inherited from the composed stores:
//   • MEMBER-SCOPED BY `userId` ALONE (the session's id the caller passes): every restored
//     row is owned by that id. An `id` in the file is IGNORED — each store generates its
//     own row id — so a crafted file can never steer a write onto another account's row
//     (AC5, INV-102).
//   • VALIDATE-THEN-WRITE, ATOMICALLY: the document is validated against the schema BEFORE
//     any write, so a malformed / wrong-version document is rejected and writes nothing;
//     the writes then run inside ONE transaction, so a mid-way failure rolls the whole
//     import back rather than leaving a half-restored account (AC4).
//   • PARAMETER-BOUND: every store binds its values, so a SQL-shaped value in an input
//     field is stored as inert data and cannot alter a query (AC6, INV-102).
//   • INJECTED DEPS ONLY: the db, the person's already-unwrapped DEK and the clock are all
//     passed in; this module reads no `process.env` and holds no key (AC7, INV-103).

import { sealedVaultSchema, type SealedVault } from "../../domain/data-transfer";
import { addCard } from "../db/cards";
import { saveHighTierField } from "../db/high-tier-fields";
import { listMethods } from "../db/vault-unlock-methods";
import { HttpError } from "../http/validate";
import { withTransaction, type Db } from "../db/index";
import { exportDocumentSchema } from "../export/schema";
import { saveIdentityField, type IdentityFieldKind } from "../db/identity-fields";
import { savePreferences } from "../db/preferences";
import { createSkill } from "../db/skills";
import { savePackage } from "../db/skill-packages";
import { parsePackage } from "../../domain/skills/package";
import { createMemory, type MemoryScope } from "../db/memories";
import { createRule } from "../db/rules";
import type { RuleAction, RuleCondition, RuleKind, RuleScope } from "../../domain/rules/rules";
import { createTask, type TaskActor, type TaskNote, type TaskStatus } from "../db/tasks";
import { createRecord, type RecordKind, type RecordSource } from "../db/life-admin-records";
import { createImportedEntry } from "../db/imported-history";
import type { Clock } from "../seams/clock";

// --- the sections as the export CARRIES them -----------------------------------------
//
// The envelope schema (`../export/schema`) is deliberately LOOSE — it checks each
// section's KIND but passes its fields through unvalidated — so these shapes name the
// representative fields the builder emits, read back from the already-kind-checked
// document. Each is optional/defaulted here because the schema does not re-assert them;
// a faithful round-trip supplies them, so the defaults only guard a sparse file.

interface ProfileFieldDoc {
  readonly id?: string;
  readonly kind: string;
  readonly value: string;
  readonly movingOn?: string | null;
}
interface ProfileDoc {
  readonly fields?: ProfileFieldDoc[];
}
interface PreferencesDoc {
  readonly tone?: string;
  readonly length?: string;
  readonly language?: string;
  readonly units?: string;
  readonly timeZone?: string;
  readonly briefing?: string;
}
interface SkillDoc {
  readonly scope?: "all" | "chosen";
  readonly enabled?: boolean;
  readonly packageId?: string;
  readonly title?: string;
  readonly text?: string;
}
interface MemoryDoc {
  readonly content?: string;
  readonly scope?: string;
  readonly sourceAgentId?: string | null;
}
interface RuleDoc {
  readonly kind?: string;
  readonly scope?: RuleScope;
  readonly action?: RuleAction;
  readonly condition?: RuleCondition;
}
interface TaskDoc {
  readonly title?: string;
  readonly notes?: TaskNote[];
  readonly assignee?: string;
  readonly status?: string;
  readonly createdBy?: TaskActor;
}
interface LifeAdminDoc {
  readonly kind?: string;
  readonly fields?: Record<string, unknown>;
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly reminderOffsets?: number[];
  readonly source?: RecordSource;
}
interface ActivityDoc {
  readonly occurredAt?: string;
  readonly kind?: string;
  readonly source?: string;
  readonly [key: string]: unknown;
}

// What the import reports back to its caller: how many rows each section restored (and
// whether a preferences profile was written). It carries no personal content and no
// ambient value — the import never fails silently, it reports its outcome.
export interface ImportSummary {
  readonly profileFields: number;
  readonly preferences: boolean;
  readonly skills: number;
  readonly memory: number;
  readonly rules: number;
  readonly tasks: number;
  readonly lifeAdmin: number;
  readonly archivedActivity: number;
}

// The export renders each skill to one plain-text block (`../export/build.ts`):
//   `${title}\n\nUse this when: ${useThisWhen}\n\n${fullText}`
// Split that block back into its "use this when" line and full body so the restored
// skill keeps the person's own text. A block that does not carry the marker (e.g. a
// sparse file) is kept whole as the full text.
function splitSkillText(text: string): { useThisWhen: string; fullText: string } {
  const marker = "\n\nUse this when: ";
  const markerAt = text.indexOf(marker);
  if (markerAt === -1) {
    return { useThisWhen: "", fullText: text };
  }
  const afterMarker = markerAt + marker.length;
  const bodyAt = text.indexOf("\n\n", afterMarker);
  if (bodyAt === -1) {
    return { useThisWhen: text.slice(afterMarker), fullText: "" };
  }
  return { useThisWhen: text.slice(afterMarker, bodyAt), fullText: text.slice(bodyAt + 2) };
}

// Validate `document` (the uploaded export) and write it into the signed-in account
// `userId`. The `dek` is the session person's already-unwrapped DEK; the `clock` supplies
// the created-at the dated stores stamp. Rejects with a plain validation error (writing
// nothing) when the document is malformed or the wrong version.
export async function importExportDocument(
  db: Db,
  userId: string,
  document: unknown,
  dek: Uint8Array,
  clock: Clock,
  protectedVault?: SealedVault,
): Promise<ImportSummary> {
  // Validate BEFORE any write: a malformed / wrong-version document is rejected here, so
  // nothing is ever persisted for it (AC4). The envelope's `version: literal(1)` and the
  // per-section kind checks both run in this one pure, in-memory step.
  if (document && typeof document === "object" && Object.hasOwn(document, "deviceProtected")) {
    throw new HttpError(400, "Protected values must be encrypted on your device before import");
  }
  const sealed = protectedVault === undefined ? undefined : sealedVaultSchema.parse(protectedVault);
  const parsed = exportDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error("Invalid export document");
  }
  const doc = parsed.data;
  const packages = (doc.skillPackages ?? []).map((p) => parsePackage(p.files, p.name));

  // Read each section back from the kind-checked document.
  const profileFields = (doc.profile as ProfileDoc).fields ?? [];
  const preferences = doc.preferences as PreferencesDoc;
  const packageIds = new Set((doc.skillPackages ?? []).map((p) => p.id).filter(Boolean));
  // Keep the plain-text fallback for older readers, but restore each packaged
  // skill once through its complete source package on this version.
  const skills = (doc.skills as SkillDoc[]).filter((s) => !s.packageId || !packageIds.has(s.packageId));
  const memories = doc.memory as MemoryDoc[];
  const rules = doc.rules as RuleDoc[];
  const tasks = doc.tasks as TaskDoc[];
  const lifeAdmin = doc.lifeAdmin as LifeAdminDoc[];
  const activity = doc.activity as ActivityDoc[];

  // One transaction: every restore commits together, or a mid-way failure rolls the whole
  // import back (never a half-restored account).
  return withTransaction(db, async (tx): Promise<ImportSummary> => {
    // Profile — the full low-tier identity field list (the authoritative profile data),
    // each a fresh row owned by `userId`.
    const importedAddresses = new Map<string, string>();
    for (const field of profileFields) {
      const saved = await saveIdentityField(
        tx,
        { userId, kind: field.kind as IdentityFieldKind, value: field.value, movingOn: field.movingOn ?? null },
        dek,
      );
      if (field.kind === "postal_address" && field.id) {
        if (importedAddresses.has(field.id)) throw new HttpError(400, "Duplicate address reference");
        importedAddresses.set(field.id, saved.id);
      }
    }

    if (sealed && (sealed.cards.length || sealed.highTierFields.length)) {
      const methods = await listMethods(tx, userId);
      if ((!methods.includes("passphrase") && !methods.includes("passkey_prf")) || !methods.includes("recovery")) {
        throw new HttpError(409, "Set up your vault and save its recovery phrase before importing protected details");
      }
      for (const field of sealed.highTierFields) await saveHighTierField(tx, { ...field, userId });
      for (const card of sealed.cards) {
        const billingAddressId = importedAddresses.get(card.billingAddressId);
        if (!billingAddressId) throw new HttpError(400, "A card billing address is missing from the export");
        await addCard(tx, { ...card, userId, billingAddressId });
      }
    }

    // Preferences — one profile per person. The server-only export emits `{}` when the
    // person has none, so an empty object writes no profile.
    const hasPreferences = Object.keys(preferences).length > 0;
    if (hasPreferences) {
      await savePreferences(
        tx,
        {
          userId,
          tone: preferences.tone ?? "",
          length: preferences.length ?? "",
          language: preferences.language ?? "",
          units: preferences.units ?? "",
          timeZone: preferences.timeZone ?? "",
          briefing: preferences.briefing ?? "",
        },
        dek,
      );
    }

    // Preserve disabled skills, but require assignment after every import. A shared
    // skill may have per-agent denials that cannot safely map to this account.
    for (const skill of skills) {
      const { useThisWhen, fullText } = splitSkillText(skill.text ?? "");
      await createSkill(tx, { userId, title: skill.title ?? "", useThisWhen, fullText, scope: "chosen", scopedAgentIds: [], enabled: skill.enabled ?? false }, dek);
    }
    for (const p of packages) {
      await savePackage(tx, userId, { files: p.files, name: p.name }, dek);
    }

    // Memory — content, scope and source round-trip; the created-at is stamped from the
    // injected clock (the live account's own time, not a file value).
    for (const memory of memories) {
      await createMemory(
        tx,
        { userId, content: memory.content ?? "", sourceAgentId: null, scope: "kept" },
        dek,
        clock,
      );
    }

    // Rules — restored active through the real store (the only create path); kind, scope,
    // action and the DEK-encrypted condition round-trip.
    for (const rule of rules) {
      await createRule(
        tx,
        { userId, kind: rule.kind as RuleKind, scope: rule.scope as RuleScope, action: rule.action as RuleAction, condition: rule.condition },
        dek,
      );
    }

    // Tasks — title, notes, assignee, status and created-by round-trip.
    for (const task of tasks) {
      await createTask(
        tx,
        {
          userId,
          title: task.title ?? "",
          notes: task.notes ?? [],
          assignee: "any", // Agent identities from another account are reference-only.
          status: (task.status as TaskStatus) ?? "open",
          createdBy: task.createdBy ?? { kind: "person" },
        },
        dek,
      );
    }

    // Life-admin records — kind, fields, due date, status, reminder offsets and source
    // round-trip.
    for (const record of lifeAdmin) {
      await createRecord(
        tx,
        {
          userId,
          kind: record.kind as RecordKind,
          fields: record.fields ?? {},
          dueDate: record.dueDate ?? null,
          status: record.status ?? "active",
          reminderOffsets: record.reminderOffsets,
          source: record.source ?? { kind: "person" },
        },
        dek,
      );
    }

    // Activity history — into the READ-ONLY imported-history ARCHIVE, never the live
    // hash-chained record. The whole original entry is kept as the archived content; its
    // occurred-at / kind / source stay as plaintext labels so the archive can be listed.
    for (const entry of activity) {
      await createImportedEntry(
        tx,
        { userId, content: entry, occurredAt: entry.occurredAt ?? clock.now().toISOString(), kind: entry.kind ?? "", source: entry.source ?? "" },
        dek,
      );
    }

    // Agents and service connections are intentionally NOT recreated (see header).

    return {
      profileFields: profileFields.length,
      preferences: hasPreferences,
      skills: skills.length + packages.reduce((sum, p) => sum + p.skills.length, 0),
      memory: memories.length,
      rules: rules.length,
      tasks: tasks.length,
      lifeAdmin: lifeAdmin.length,
      archivedActivity: activity.length,
    };
  });
}
