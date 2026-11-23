// The prop contract between the Life admin loader (`life-admin/actions.ts` `load`) and the
// view (`life-admin-view.tsx` and the panels it composes). Plain, already-decrypted,
// already-resolved values: agent ids come with their display names, non-text values an
// older agent saved come pre-summarised, and where each record stands (its phase, from
// `domain/life-admin/lifecycle.ts`) is worked out by the loader against the person's clock and
// time zone, so the client view never reads the database, the clock or a session.
// Type-only module.

import type { Bucket, Phase } from "@/domain/life-admin/lifecycle";
import type { RecordTypeDef } from "@/domain/life-admin/record-types";
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
  // Present only when the change gives the record another kind ("vehicles.vehicle").
  type?: string;
  set: Record<string, string>;
  remove: string[];
  // Present only when the change moves the due date (null clears it).
  dueDate?: string | null;
  status?: string;
  // Present only when the change links the record to a thing (null unlinks it).
  parentId?: string | null;
  foundIn?: RecordFoundInView | null;
};

// Where a record stands now (`phaseOf`), as plain values: instants as ISO strings.
export type RecordPhaseView = {
  phase: Phase;
  bucket: Bucket;
  live: boolean;
  label: string;
  comingUp: boolean;
  // Whole days from the person's today to the due or start date (negative when past).
  inDays?: number;
  // A booking's (or an anchor's span's) start and end, ISO instants.
  starts?: string;
  ends?: string;
};

// Who is handling a record and its next open step, from its journal.
export type RecordHandlingView = {
  steward?: string | null;
  next?: { id: string; text: string; due?: string } | null;
};

// One life-admin record as the view renders it, AFTER the loader has decrypted its fields.
export type LifeAdminRecordView = {
  id: string;
  kind: RecordKind;
  // The record's type ("vehicles.registration"); absent or null ⇒ the type its kind reads as.
  type?: string | null;
  // Its text, number and yes/no fields as strings, editable.
  fields: Record<string, string>;
  // Values an older agent saved as lists or objects: shown read-only and kept as they are,
  // never flattened into the edit form (engineering finding M4).
  heldFields?: Record<string, string>;
  dueDate: string | null;
  status: string;
  // A booking's or case's detailed state (confirmed, pending, cancelled, no_show; open,
  // waiting, resolved).
  state?: string | null;
  reminderOffsets: number[];
  hasAttachedFile?: boolean;
  files?: readonly { id: string; size: number }[];
  // An agent's record is "suggested" until the person confirms it. Absent ⇒ confirmed.
  reviewState?: "suggested" | "confirmed";
  // The anchor (vehicle, home, trip, pet or a thing of the person's own) it belongs to.
  parentId?: string | null;
  // Absent ⇒ the person.
  addedBy?: RecordActorView;
  changedBy?: RecordActorView | null;
  foundIn?: RecordFoundInView | null;
  pending?: PendingChangeView | null;
  // Absent ⇒ worked out as current (tests and older callers).
  phase?: RecordPhaseView;
  handling?: RecordHandlingView;
};

// Life admin's tabs (`?tab=`): Records (what's ongoing), Upcoming (what needs the person, and
// every booking ahead), History (everything finished) and Tasks. The page maps older addresses
// (`?view=tasks`, `?view=life&tab=…`, the Bookings tab, older reminder links) onto these.
export type LifeAdminTab = "records" | "upcoming" | "history" | "tasks";

// Where a record stands, worked out from its phase (`listStatusOf`): active (live) or on hold
// (paused) on Records; finished (ended, completed, resolved) or cancelled (cancelled, missed,
// lapsed, or a standing item whose status is cancelled) in History.
export type RecordListStatus = "active" | "on_hold" | "finished" | "cancelled";

// The Records tab's filters (`?category=…&status=…`, each repeatable), validated by the page:
// no category ⇒ every category; the statuses are never empty (the page defaults to active).
export type RecordFilter = {
  categories: readonly string[];
  statuses: readonly RecordListStatus[];
};

// History's filters (`?history_category=…&history_status=…&history_page=…`), validated by the
// page: no category ⇒ every category, no status ⇒ both (finished and cancelled); the page number
// is 1-based.
export type HistoryFilter = {
  categories: readonly string[];
  statuses: readonly RecordListStatus[];
  page?: number;
};

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
  // Accepts every waiting change at once ("Accept all n changes"), one `recordId` per change.
  acceptAllPendingAction?: LifeAdminAction;
  declinePendingAction?: LifeAdminAction;
  keepCategoryAction?: LifeAdminAction;
  declineCategoryAction?: LifeAdminAction;
  setCategoryVisibilityAction?: LifeAdminAction;
};

// An anchor a record can belong to, for the "Belongs to" choice.
export type AssetOption = { id: string; name: string; typeId: string; typeLabel: string };

// A category's state: shown (it has records, the person chose to show it, or it is one of their
// own), available (built-in and empty) or not for me (the person hid it, and its records too).
export type CategoryStateView = {
  id: string;
  visibility: "shown" | "available" | "not_for_me";
  records: number;
};

// One of the person's own categories an agent suggested, waiting under To check.
export type SuggestedCategoryView = {
  slug: string;
  label: string;
  description: string;
  suggestedBy: string;
  why?: string;
  kinds: string[];
  records: number;
  suggestedRecords: number;
  confirmedRecords: number;
};

// An open next step that has a due date, on any item.
export type NextStepView = {
  id: string;
  recordId: string;
  recordName: string;
  text: string;
  due: string;
};

// ─── the item page ───────────────────────────────────────────────────────────────────

// One journal entry as the item page lists it: who wrote it ("You", or the agent's name), when
// (in the person's zone), its text and, for a next step, its due date.
export type JournalItemView = {
  id: string;
  at: string;
  when: string;
  by: string;
  text: string;
  due?: string;
};

// A next step already done, and a decision a later one replaced.
export type DoneStepView = JournalItemView & { doneWhen: string; doneBy: string };
export type ReplacedDecisionView = JournalItemView & { replacedBy: string };

// Warthog's own change entries, grouped by day and then by who made them.
export type HistoryDayView = {
  day: string;
  groups: { by: string; lines: string[] }[];
};

// A record another record belongs to, or one that belongs to it.
export type RelatedItemView = { id: string; name: string; kindLabel: string; phaseLabel?: string };

export type LifeAdminItemData = {
  today: string;
  zone: string;
  record: LifeAdminRecordView;
  // Its kind's definition (labels, fields), as plain data.
  type: RecordTypeDef;
  name: string;
  kindLabel: string;
  categoryLabel: string;
  lifecycle: "standing" | "booking" | "case";
  // The one-line hand-over summary agents get for this item (`handoverLine`).
  whereItStands: string;
  parent: RelatedItemView | null;
  children: RelatedItemView[];
  steward: { agentId: string; name: string } | null;
  // The person's connected agents, for "Handled by".
  agents: { id: string; name: string }[];
  openSteps: JournalItemView[];
  doneSteps: DoneStepView[];
  decisions: JournalItemView[];
  replaced: ReplacedDecisionView[];
  notes: JournalItemView[];
  handovers: JournalItemView[];
  history: HistoryDayView[];
  entries: number;
};

// The item page's server actions.
export type ItemActions = {
  addJournalAction?: LifeAdminAction;
  markNextDoneAction?: LifeAdminAction;
  setStewardAction?: LifeAdminAction;
};
