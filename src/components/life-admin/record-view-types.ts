// The prop contract between the Life admin loader (`life-admin/actions.ts` `load`) and the
// view (`life-admin-view.tsx` and the panels it composes). Plain, already-decrypted,
// already-resolved values: agent ids come with their display names, non-text values an
// older agent saved come pre-summarised, so the client view never reads the database, the
// clock or a session. Type-only module.

import type { ProvenanceActor, ProvenanceFoundIn } from "./record-format";

// The stored kinds: the three original ones, and `item` for every other typed record.
export type RecordKind = "subscription" | "receipt_warranty" | "renewal_appointment" | "item";

// Who added or last changed a record: the person, or one of their agents by name.
export type RecordActorView = ProvenanceActor;

// Where an agent says it found a record. `seenByWarthog` is Warthog's own evidence: the
// agent had just read mail from that sender through Warthog.
export type RecordFoundInView = ProvenanceFoundIn;

// An agent's proposed change to a record the person confirmed, waiting for them to decide.
export type PendingChangeView = {
  byName: string;
  set: Record<string, string>;
  remove: string[];
  // Present only when the change moves the due date (null clears it).
  dueDate?: string | null;
  status?: string;
  foundIn?: RecordFoundInView | null;
};

// One life-admin record as the view renders it, AFTER the loader has decrypted its fields.
export type LifeAdminRecordView = {
  id: string;
  kind: RecordKind;
  // The record's type ("vehicle.registration"); absent or null ⇒ the type its kind reads as.
  type?: string | null;
  // Its text, number and yes/no fields as strings, editable.
  fields: Record<string, string>;
  // Values an older agent saved as lists or objects: shown read-only and kept as they are,
  // never flattened into the edit form (engineering finding M4).
  heldFields?: Record<string, string>;
  dueDate: string | null;
  status: string;
  reminderOffsets: number[];
  hasAttachedFile?: boolean;
  files?: readonly { id: string; size: number }[];
  // An agent's record is "suggested" until the person confirms it. Absent ⇒ confirmed.
  reviewState?: "suggested" | "confirmed";
  // The vehicle, home or pet this record belongs to.
  parentId?: string | null;
  // Absent ⇒ the person.
  addedBy?: RecordActorView;
  changedBy?: RecordActorView | null;
  foundIn?: RecordFoundInView | null;
  pending?: PendingChangeView | null;
};

// One moving-checklist item: its id, its label, whether it is ticked off, and the id of
// the task it was handed to an agent as (non-null ⇒ already handed off).
export type ChecklistItemView = {
  id: string;
  label: string;
  done: boolean;
  linkedTaskId: string | null;
};

// The records view's two in-page tabs (`?tab=`). The page maps the older tab values
// (subscriptions, receipts, renewals) to "things".
export type LifeAdminTab = "things" | "checklist";

// A control bound to a server action the page passes.
export type LifeAdminAction = (formData: FormData) => void | Promise<void>;

// The record controls' server actions. Each is OPTIONAL: a control whose action is
// supplied is LIVE; one with no action renders DISABLED with a stated reason (no dead
// controls). The page always supplies them.
export type RecordActions = {
  addRecordAction?: LifeAdminAction;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
  deleteRecordAction?: LifeAdminAction;
  confirmRecordAction?: LifeAdminAction;
  confirmAllAction?: LifeAdminAction;
  dismissRecordAction?: LifeAdminAction;
  acceptPendingAction?: LifeAdminAction;
  declinePendingAction?: LifeAdminAction;
};

// An asset a record can belong to, for the "Belongs to" choice.
export type AssetOption = { id: string; name: string; typeId: string; typeLabel: string };
