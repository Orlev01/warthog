// The Life Admin page's owner-scoped list-all read (task E14-S10; brief "Life
// admin" + "Tasks and hand-offs" + "Moving-house helper"; design §4.1). The Life
// Admin page needs ONE read that sees EVERY life-admin record, moving-checklist
// item and task the person holds, regardless of state — distinct from the
// agent-facing reads and never returning another person's data.
//
// This read COMPOSES the already-built, tested stores — `listRecordsForUser`
// (life-admin records, fields DEK-decrypted), the moving-checklist `listForUser`,
// and `listTasksForUser` — plus a member-scoped look-up of which of the person's
// receipt records carry an attached file (`listRecordIdsWithFileForUser`: the
// `receipt_files` PLAINTEXT METADATA only — NEVER the encrypted file bytes). It
// groups the records by kind (subscriptions, receipts/warranties, renewals/
// appointments) and flags each receipt that carries a saved file.
//
// It adds NO crypto of its own: every store it calls decrypts under the owner's
// DEK, which is INJECTED here (this module holds no key and reads no `process.env`,
// INV-103). Every read is member-scoped by `userId` — the session's id, never a
// client value (INV-102; project rule: every member-scoped read takes userId from
// the session) — and every underlying statement binds its values through the `Db`
// seam, so a value shaped like SQL is stored as data and cannot alter a query.

import type { Catalogue } from "../../domain/life-admin/catalogue";
import { anchorSpan, bookingSpan, phaseOf, type PhaseView } from "../../domain/life-admin/lifecycle";
import type { Db } from "../db/index";
import {
  listRecordsForUser,
  type LifeAdminRecord,
} from "../db/life-admin-records";
import { listForUser, type ChecklistItem } from "../db/moving-checklist";
import { listTasksForUser, type Task } from "../db/tasks";
import { listRecordIdsWithFileForUser } from "../storage/receipt-files";

// One life-admin record as the page shows it: the stored record plus the
// attached-file flag. The FILE BYTES are never part of this read — only the flag.
export interface LifeAdminPageRecord extends LifeAdminRecord {
  readonly hasAttachedFile: boolean;
}

// The owner-scoped list-all the Life Admin page renders: the records grouped by
// kind, the moving-checklist items, and the shared tasks. `records` is every live record
// in the owner order, typed ones (kind `item`) included — the Records tab reads it
// (docs/adr/life-admin-profile.md); the three kind groups stay for older readers.
export interface LifeAdminPageData {
  readonly records: LifeAdminPageRecord[];
  readonly subscriptions: LifeAdminPageRecord[];
  readonly receipts: LifeAdminPageRecord[];
  readonly renewals: LifeAdminPageRecord[];
  readonly checklist: ChecklistItem[];
  readonly tasks: Task[];
}

// Assemble the Life Admin page data for the session person: ALL of `userId`'s
// records (fields decrypted under the owner's `dek`), grouped by kind with each
// receipt flagged for a saved file (metadata only), alongside the owner's
// moving-checklist items and shared tasks. Member-scoped by `userId`; an empty
// person yields empty collections, never an error.
export async function lifeAdminPageData(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<LifeAdminPageData> {
  const records = await listRecordsForUser(db, userId, dek);
  const recordIdsWithFile = await listRecordIdsWithFileForUser(db, userId);
  const checklist = await listForUser(db, userId, dek);
  const tasks = await listTasksForUser(db, userId, dek);

  const all: LifeAdminPageRecord[] = [];
  const subscriptions: LifeAdminPageRecord[] = [];
  const receipts: LifeAdminPageRecord[] = [];
  const renewals: LifeAdminPageRecord[] = [];

  for (const record of records) {
    const pageRecord: LifeAdminPageRecord = {
      ...record,
      hasAttachedFile: recordIdsWithFile.has(record.id),
    };
    all.push(pageRecord);
    switch (record.kind) {
      case "subscription":
        subscriptions.push(pageRecord);
        break;
      case "receipt_warranty":
        receipts.push(pageRecord);
        break;
      case "renewal_appointment":
        renewals.push(pageRecord);
        break;
    }
  }

  return { records: all, subscriptions, receipts, renewals, checklist, tasks };
}

// Where each record stands now (docs/adr/life-admin-profile.md, "Lifecycle"), keyed by id: its
// phase from the one lifecycle module, worked out against the person's clock and time zone, so
// the page never needs its own copy of "not live". An anchor that bookings belong to (a trip,
// or any anchor of the person's own) carries the span of those bookings: a trip — an anchor
// that is itself a booking — takes its dates from every booking that went ahead (so a past trip
// still reads as completed on its dates); any other anchor shows the span of its live bookings.
// Pure: no DB, no clock of its own.
export function recordPhases(
  records: readonly Pick<LifeAdminRecord, "id" | "kind" | "type" | "status" | "state" | "dueDate" | "fields" | "parentId">[],
  catalogue: Catalogue,
  now: Date,
  zone: string,
): Map<string, PhaseView> {
  const out = new Map<string, PhaseView>();
  const typeOf = (record: (typeof records)[number]) => catalogue.typeOfRecord(record.kind, record.type);
  for (const record of records) out.set(record.id, phaseOf(record, typeOf(record), now, zone));
  for (const anchor of records) {
    const type = typeOf(anchor);
    if (!type.anchor) continue;
    const spans: { start: Date; end: Date }[] = [];
    for (const child of records) {
      if (child.parentId !== anchor.id || child.id === anchor.id) continue;
      const childType = typeOf(child);
      if (childType.lifecycle !== "booking") continue;
      const phase = out.get(child.id)!;
      if (phase.phase === "cancelled" || phase.phase === "missed" || phase.phase === "lapsed") continue;
      if (type.lifecycle !== "booking" && !phase.live) continue;
      const span = bookingSpan(child, childType, zone);
      if (span) spans.push({ start: span.start, end: span.end });
    }
    const span = anchorSpan(spans);
    if (!span) continue;
    if (type.lifecycle === "booking") out.set(anchor.id, phaseOf(anchor, type, now, zone, span));
    else out.set(anchor.id, { ...out.get(anchor.id)!, starts: span.start, ends: span.end });
  }
  return out;
}
