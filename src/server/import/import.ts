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

import { cardBillingAddressesSchema, sealedVaultSchema, type SealedVault } from "../../domain/data-transfer";
import { addCard } from "../db/cards";
import { applyBillingSelection, lockCardBilling } from "../vault/card-billing";
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
import { createRecord, recordMatchKey, type RecordFoundIn, type RecordKind, type RecordSource } from "../db/life-admin-records";
import { findForbidden } from "../../domain/life-admin/identifiers";
import { calendarDate, identityAlternatives } from "../../domain/life-admin/normalise";
import { buildCatalogue, type Catalogue, type CustomCategoryDefinition, type CustomCategoryEntry } from "../../domain/life-admin/catalogue";
import { definitionOf, newCategorySchema, SLUG_PATTERN } from "../../domain/life-admin/custom-category";
import { JOURNAL_KINDS, type ChangeSummary, type JournalKind } from "../../domain/life-admin/journal";
import { cleanJournalText, findForbiddenText } from "../../domain/life-admin/journal-text";
import { remindUntilOf } from "../../domain/life-admin/lifecycle";
import { createCustomCategory, restoreDeclined, setBuiltInSetting } from "../db/life-admin-categories";
import { appendJournalEntry } from "../db/life-admin-journal";
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
  // The person's card-only billing addresses (docs/adr/card-billing-addresses.md), validated
  // against `cardBillingAddressesSchema` before any write.
  readonly cardBillingAddresses?: unknown;
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
  // The life-admin record it's about, by its id in the export (re-linked to the new id).
  readonly recordId?: string;
}
interface LifeAdminDoc {
  readonly id?: string;
  readonly kind?: string;
  readonly fields?: Record<string, unknown>;
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly reminderOffsets?: number[];
  readonly source?: RecordSource;
  readonly type?: string | null;
  readonly reviewState?: string;
  readonly parentId?: string | null;
  readonly foundIn?: RecordFoundIn | null;
  readonly state?: string;
  readonly journal?: JournalDoc[];
}
interface JournalDoc {
  readonly id?: string;
  readonly at?: string;
  readonly kind?: string;
  readonly by?: string;
  readonly refId?: string;
  readonly text?: string;
  readonly due?: string;
  readonly change?: ChangeSummary;
}
interface CategoryDoc {
  readonly slug?: string;
  readonly state?: string;
  readonly definition?: CustomCategoryDefinition & { readonly why?: string };
  readonly builtIn?: string;
  readonly setting?: string;
  readonly declined?: string;
}

const RECORD_KIND_VALUES: readonly string[] = ["subscription", "receipt_warranty", "renewal_appointment", "item"];

// A record restored from an export (docs/adr/life-admin-profile.md): an unknown kind or type
// is refused as a bad file (a 400, never a database error); a field that must never be kept
// (a tax file number, a password, a government ID number …) is dropped, since a hand-edited
// file could carry one; a missing review state reads as checked only for the person's own.
function restoredRecord(record: LifeAdminDoc, catalogue: Catalogue): { kind: RecordKind; type: string | null; fields: Record<string, unknown>; reviewState: "suggested" | "confirmed"; retyped: boolean } {
  if (!record.kind || !RECORD_KIND_VALUES.includes(record.kind)) throw new HttpError(400, "The export file has a life-admin record of an unknown kind.");
  let type = record.type ?? null;
  let retyped = false;
  if (type !== null && !catalogue.type(type)) {
    // A kind of a category of the person's own that isn't in the file reads as "Something else";
    // an unknown built-in kind means the file isn't one Warthog wrote.
    if (!/^x_/.test(type)) throw new HttpError(400, "The export file has a life-admin record of an unknown type.");
    type = "other.item";
    retyped = true;
  }
  const fields: Record<string, unknown> = { ...(record.fields ?? {}) };
  for (const finding of findForbidden(fields, type)) delete fields[finding.field];
  const source = record.source ?? { kind: "person" };
  const reviewState = record.reviewState === "confirmed" || record.reviewState === "suggested"
    ? record.reviewState
    : source.kind === "agent" ? "suggested" : "confirmed";
  return { kind: retyped ? "item" : (record.kind as RecordKind), type, fields, reviewState, retyped };
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
  // Records whose own category wasn't in the file, restored as "Something else".
  readonly lifeAdminRetyped?: number;
  // Restored cards that have no billing address — none in the file, or one the file doesn't
  // carry (docs/adr/card-billing-addresses.md). The person can give each one an address.
  readonly cardsWithoutBillingAddress?: number;
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

// What a multi-part import (`./parts`) keeps across its parts, so a card in a later part is
// re-linked to the billing address an earlier part carried. Card-only values are held in memory
// only, and an address is created only when a restored card uses it (a card-only address exists
// only while a card uses it).
export interface TransferContext {
  // An About you postal address's id in the export → its new identity field id.
  readonly importedAddresses: Map<string, string>;
  // A card-only billing address's id in the export → its (trimmed) value.
  readonly cardBillingValues: Map<string, string>;
  // A card-only billing address's id in the export → its new id, once a card has used it.
  readonly importedCardBilling: Map<string, string>;
}
export function newTransferContext(): TransferContext {
  return { importedAddresses: new Map(), cardBillingValues: new Map(), importedCardBilling: new Map() };
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
  transferContext?: TransferContext,
): Promise<ImportSummary> {
  // Validate BEFORE any write: a malformed / wrong-version document is rejected here, so
  // nothing is ever persisted for it (AC4). The envelope's `version: literal(1)` and the
  // per-section kind checks both run in this one pure, in-memory step.
  if (document && typeof document === "object" && Object.hasOwn(document, "deviceProtected")) {
    throw new HttpError(400, "Protected values must be encrypted on your device before import");
  }
  const sealedParsed = protectedVault === undefined ? undefined : sealedVaultSchema.safeParse(protectedVault);
  if (sealedParsed && !sealedParsed.success) throw new HttpError(400, "The export file's protected details are invalid.");
  const sealed = sealedParsed?.data;
  const parsed = exportDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error("Invalid export document");
  }
  const doc = parsed.data;
  const context = transferContext ?? newTransferContext();

  // Card-only billing addresses: checked before any write (a malformed value or a repeated id
  // is a bad file), then held in memory until a restored card uses one.
  const cardBilling = cardBillingAddressesSchema.optional().safeParse((doc.profile as ProfileDoc).cardBillingAddresses);
  if (!cardBilling.success) throw new HttpError(400, "The export file has an invalid card billing address.");
  for (const entry of cardBilling.data ?? []) {
    if (entry.id === undefined) continue; // the plain export carries values alone; no card can use them
    if (context.cardBillingValues.has(entry.id)) throw new HttpError(400, "Duplicate card billing address reference");
    context.cardBillingValues.set(entry.id, entry.value);
  }
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
  const activity = [...doc.activity, ...(doc.importedActivity ?? [])] as ActivityDoc[];

  // One transaction: every restore commits together, or a mid-way failure rolls the whole
  // import back (never a half-restored account).
  const restore = async (tx: Db): Promise<ImportSummary> => {
    // Profile — the full low-tier identity field list (the authoritative profile data),
    // each a fresh row owned by `userId`.
    const importedAddresses = context.importedAddresses;
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

    let cardsWithoutBillingAddress = 0;
    if (sealed && (sealed.cards.length || sealed.highTierFields.length)) {
      const methods = await listMethods(tx, userId);
      if ((!methods.includes("passphrase") && !methods.includes("passkey_prf")) || !methods.includes("recovery")) {
        throw new HttpError(409, "Set up your vault and save its recovery phrase before importing protected details");
      }
      for (const field of sealed.highTierFields) await saveHighTierField(tx, { ...field, userId });
      // Serialised with the person's card billing changes, like every other billing write.
      if (sealed.cards.length) await lockCardBilling(tx, userId);
      // Each card is re-linked to its billing address under its NEW id: an About you postal
      // address restored above, or a card-only address created now (once, however many cards
      // share it), re-encrypted under the importing person's DEK. A reference the export doesn't
      // carry (another person's address, one made protected, one that's gone) imports as no
      // billing address rather than failing the whole import (docs/adr/card-billing-addresses.md).
      // Both references are set explicitly; an id from the file is never stored.
      for (const card of sealed.cards) {
        const billingAddressId = card.billingAddressId === undefined ? null : importedAddresses.get(card.billingAddressId) ?? null;
        let billingEntryId: string | null = null;
        if (card.billingEntryId !== undefined) {
          billingEntryId = context.importedCardBilling.get(card.billingEntryId) ?? null;
          const value = context.cardBillingValues.get(card.billingEntryId);
          if (billingEntryId === null && value !== undefined) {
            // An identical address the person already keeps (or one this file already restored
            // under another id) is reused, as when adding a card.
            billingEntryId = (await applyBillingSelection(tx, userId, { source: "new", value }, dek))?.billingEntryId ?? null;
            if (billingEntryId !== null) context.importedCardBilling.set(card.billingEntryId, billingEntryId);
          }
        }
        if (billingAddressId === null && billingEntryId === null) cardsWithoutBillingAddress += 1;
        await addCard(tx, {
          userId,
          brand: card.brand,
          lastFour: card.lastFour,
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear,
          nickname: card.nickname,
          cardholderName: card.cardholderName ?? null,
          billingAddressId,
          billingEntryId,
          numberCiphertext: card.numberCiphertext,
        });
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
    const taskLinks: { id: string; oldRecord: string }[] = [];
    for (const task of tasks) {
      const createdTask = await createTask(
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
      if (typeof task.recordId === "string") taskLinks.push({ id: createdTask.id, oldRecord: task.recordId });
    }

    // Life admin (docs/adr/life-admin-profile.md, life-admin-journal.md), in order: the person's
    // own categories (re-validated, keeping their ids so records still resolve), settings and
    // declined labels; then records — kind, fields, due date, status, reminder offsets, source,
    // type, review state and provenance; then links between them; then each item's journal, as
    // imported history with its authors' names.
    let lifeAdminRetyped = 0;
    const customEntries: CustomCategoryEntry[] = [];
    for (const row of (doc.lifeAdminCategories ?? []) as CategoryDoc[]) {
      if (row.definition && (row.state === "suggested" || row.state === "active")) {
        const draft = newCategorySchema.safeParse({ ...row.definition, why: row.definition.why || "Imported", kinds: row.definition.kinds });
        if (!draft.success || !row.slug || !SLUG_PATTERN.test(row.slug)) continue;
        const definition = definitionOf(draft.data);
        await createCustomCategory(tx, { userId, state: row.state, origin: { kind: "person" }, definition, slug: row.slug }, dek, clock);
        customEntries.push({ slug: row.slug, state: row.state, definition });
      } else if (row.builtIn && (row.setting === "show" || row.setting === "not_for_me")) {
        await setBuiltInSetting(tx, userId, row.builtIn, row.setting, dek, clock);
      } else if (typeof row.declined === "string") {
        await restoreDeclined(tx, userId, row.declined.slice(0, 60), dek, clock);
      }
    }
    const catalogue = buildCatalogue(customEntries);

    const newIds = new Map<string, string>();
    const links: { id: string; oldParent: string }[] = [];
    const journals: { recordId: string; entries: JournalDoc[] }[] = [];
    for (const record of lifeAdmin) {
      const restored = restoredRecord(record, catalogue);
      if (restored.retyped) lifeAdminRetyped += 1;
      const typeDef = catalogue.typeOfRecord(restored.kind, restored.type);
      // Restore the match keys (so a later scan updates the record instead of adding a copy),
      // except those identified by their parent, whose new id isn't known yet.
      const matchKeys = restored.type
        ? identityAlternatives(typeDef, restored.fields, null).filter((alternative) => !alternative.keys.includes("parent")).map((alternative) => recordMatchKey(dek, typeDef.id, alternative.keys, alternative.values))
        : [];
      const status = record.status ?? "active";
      const state = typeof record.state === "string" ? record.state.slice(0, 20) : null;
      const created = await createRecord(
        tx,
        {
          userId,
          kind: restored.kind,
          type: restored.type,
          fields: restored.fields,
          dueDate: record.dueDate ?? null,
          status,
          state,
          remindUntil: remindUntilOf(typeDef, status, state, record.dueDate ?? null),
          reminderOffsets: record.reminderOffsets,
          source: record.source ?? { kind: "person" },
          reviewState: restored.reviewState,
          foundIn: record.foundIn ?? null,
          matchKeys,
        },
        dek,
      );
      if (record.id) newIds.set(record.id, created.id);
      if (record.parentId) links.push({ id: created.id, oldParent: record.parentId });
      if (Array.isArray(record.journal) && record.journal.length > 0) journals.push({ recordId: created.id, entries: record.journal.slice(0, 400) });
    }
    for (const link of links) {
      const parent = newIds.get(link.oldParent);
      if (parent) await tx.query("UPDATE life_admin_records SET parent_id = $3 WHERE id = $1 AND user_id = $2", [link.id, userId, parent]);
    }
    for (const link of taskLinks) {
      const record = newIds.get(link.oldRecord);
      if (record) await tx.query("UPDATE tasks SET record_id = $3 WHERE id = $1 AND user_id = $2", [link.id, userId, record]);
    }
    for (const { recordId, entries } of journals) {
      const newEntryIds = new Map<string, string>();
      for (const entry of entries) {
        if (!JOURNAL_KINDS.includes(entry.kind as never)) continue;
        const text = typeof entry.text === "string" ? cleanJournalText(entry.text) : null;
        if (text && findForbiddenText(text.text)) continue;
        const refId = entry.refId ? newEntryIds.get(entry.refId) ?? null : null;
        if ((entry.kind === "next_done" || (entry.kind === "decision" && entry.refId)) && !refId) continue;
        const at = typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at)) ? new Date(entry.at) : clock.now();
        const outcome = await appendJournalEntry(tx, {
          userId, recordId, kind: entry.kind as JournalKind, actorKind: "imported", refId, at,
          body: { ...(text ? { text: text.text } : {}), ...(entry.due && calendarDate(entry.due) ? { due: calendarDate(entry.due)! } : {}), ...(entry.change ? { change: entry.change } : {}), actorName: String(entry.by ?? "imported").slice(0, 80) },
        }, dek);
        if (outcome.appended && entry.id) newEntryIds.set(entry.id, outcome.id);
      }
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
      ...(lifeAdminRetyped > 0 ? { lifeAdminRetyped } : {}),
      ...(cardsWithoutBillingAddress > 0 ? { cardsWithoutBillingAddress } : {}),
      archivedActivity: activity.length,
    };
  };
  return db.inTransaction ? restore(db) : withTransaction(db, restore);
}
