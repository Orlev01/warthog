// E16-S11 — Data & privacy loader + actions (the injectable seam the thin
// `page.tsx` loader + its server-action wrappers compose).
//
// The Data & privacy screen is the one plain-English home for the three heavy data
// actions — EXPORT everything Warthog stores, IMPORT a previous Warthog export, and
// DELETE the account — plus a read-only view of history brought over by a past import
// (brief "Export and portability"; constitution 20 "Australian Privacy Act and
// GDPR-style rights"; design §4.1 account deletion = crypto-shredding). This factory is
// the testable core behind those controls; the thin loader turns a verified session
// into <DataView>'s props and binds these actions.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file may
// export only its framework fields, so it cannot carry an injectable, unit-testable seam
// without breaking `next build`. The testable logic lives here (the convention's
// `createXActions(deps)` pattern, the same shape as the already-built security /
// notifications actions). Each action COMPOSES an already-built, tested service — the
// export builder (E16-S02), the import service (E16-S05), the imported-history store, and
// the account-deletion service (E16-S08) — rather than re-implementing any of them, so
// there is ONE source of truth for each.
//
// Security (each a reviewer veto; CLAUDE.md member scope + design §5):
//   • Every method takes the person's VERIFIED Session and derives the acting user id
//     from `session.userId` — never a client-supplied value. There is no userId on any
//     input, and the import IGNORES any id inside the uploaded file (each store generates
//     its own row id for the SESSION user), so a signed-in person can only export /
//     import / delete for THEMSELVES.
//   • EXPORT and DELETE are sensitive actions: each requires a fresh step-up (requireStepUp,
//     the 5-minute window) before it discloses or destroys anything; without one it is
//     refused and nothing is built / deleted. DELETE additionally requires the exact typed
//     confirmation phrase, so both must be present before the deletion service runs. IMPORT
//     needs no step-up (it discloses no secret).
//   • A malformed / wrong-version / oversized upload, or an oversized confirmation, is
//     rejected at the validation boundary with a 4xx HttpError BEFORE any write (INV-102);
//     every statement the composed services issue is parameterized, so a SQL-shaped value
//     travels as a BOUND value and cannot alter a query.
//   • The actions run purely from their INJECTED seams (db, clock, keyWrapper, revoker,
//     senders): they read no `process.env` and hold no secret (INV-103), so no ambient env
//     value can land in the export document, in restored/stored content, or in the delete
//     confirmation email.

import { z } from "zod";
import { formatAccountTime } from "@/server/display-time";
import { timeZoneFor } from "@/server/spending/time-zone";

import { parseParams, HttpError } from "@/server/http/validate";
import { requireStepUp } from "@/server/auth/step-up";
import { getUserById } from "@/server/db/users";
import { buildExportDocument } from "@/server/export/build";
import { importExportDocument, type ImportSummary } from "@/server/import/import";
import { exportDocumentSchema, type ExportDocument } from "@/server/export/schema";
import { listImportedEntriesForUser, type ImportedEntry } from "@/server/db/imported-history";
import {
  deleteAccount as deleteAccountService,
  type DeletionExecutor,
} from "@/server/account/delete";
import type { Session } from "@/server/auth/session";
import type { Clock } from "@/server/seams/clock";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Senders } from "@/server/notify/senders";
import type { Db } from "@/server/db/index";
import type { DataViewImportedEntry } from "@/components/settings/data-view";

// The injected seams — no process.env (INV-103). `keyWrapper` resolves the session
// person's own DEK (their content is stored DEK-encrypted); `revoker` is the
// cross-aggregate revoke the deletion service delegates; `senders` carries the delete
// confirmation email. `maxUploadBytes` caps the import upload; it defaults large (an
// export legitimately carries a whole account's content).
export interface DataActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
  readonly revoker: DeletionExecutor;
  readonly senders: Senders;
  readonly maxUploadBytes?: number;
}

// A single action's result: success, or a refusal naming its reason in plain words
// (never a silent success, never a silent failure — the page maps the reason to copy).
export type ActionResult = { ok: true } | { ok: false; reason: string };

// Export hands back the built document only on success; a refusal carries no document.
export type ExportResult =
  | { ok: true; document: ExportDocument }
  | { ok: false; reason: string };

// Import hands back a per-section summary on success (how many rows each section
// restored); a refusal carries its reason.
export type ImportResult =
  | { ok: true; summary: ImportSummary }
  | { ok: false; reason: string };

// The data slice <DataView> is mounted with: the session person's OWN imported-history
// archive, already display-ready. READ-ONLY.
export interface DataPageData {
  readonly importedHistory: DataViewImportedEntry[];
}

// The data & privacy actions the loader + its server-action wrappers drive.
export interface DataActions {
  // Turn the verified session into the view's data: ONLY the session person's own
  // imported-history archive (member-scoped by `session.userId`, never a client value).
  load(session: Session): Promise<DataPageData>;
  exportData(session: Session): Promise<ExportResult>;
  importData(session: Session, upload: unknown): Promise<ImportResult>;
  deleteAccount(session: Session, input: { confirmation: string }): Promise<ActionResult>;
}

// The exact phrase the delete action requires. ONE source of truth: the page passes the
// SAME value to <DataView>'s `confirmationPhrase`, so the gate on screen and the
// server-side check can never drift (it equals the view's own default phrase).
export const DELETE_ACCOUNT_CONFIRMATION = "delete my account";

// The one reason the sensitive-action gate refuses with, and the one the delete action
// refuses with when the typed phrase is absent or wrong. Stable codes, never passed-through
// sentences, so no internal detail or ambient value lands in a result.
const STEP_UP_REQUIRED = "step_up_required";
const CONFIRMATION_REQUIRED = "confirmation_required";
// The deletion service's one domain refusal (the person still owns a household), as a
// stable code the screen maps to plain words — never the service's sentence passed
// through as a `?notice=` the screen cannot recognise (which showed nothing at all).
const OWNS_HOUSEHOLD = "owns_household";

// A generous default upload cap — an export legitimately carries a whole account's
// content and its activity history. An oversized upload is refused at the byte boundary
// before it is parsed (INV-102); a tighter per-call cap can be injected.
const DEFAULT_MAX_UPLOAD_BYTES = 16 * 1024 * 1024; // 16 MiB

// The confirmation phrase is bounded: an oversized value is rejected at the boundary with
// a 4xx before any work, while a well-formed but wrong phrase is a domain refusal.
const CONFIRMATION_MAX = 200;
const confirmationSchema = z.string().max(CONFIRMATION_MAX);

// --- display helpers (mirrored from the activity loader, so an imported entry reads the
//     same way a live entry does) ---------------------------------------------------------

// A stored code → a display label (e.g. "payment" → "Payment", "tool_call" → "Tool call").
function humanise(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// A stored instant → an absolute, readable label (date + time of day), so two entries on
// the same day read as distinct moments. No clock seam: it shows WHEN the entry occurred.

// Collapse any run of whitespace to single spaces and trim, so a summary is one line.
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// A string field of a decrypted object (e.g. a payload's `summary`), or "" when absent /
// not a string.
function stringField(source: unknown, key: string): string {
  if (source !== null && typeof source === "object") {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

// A one-line, display-ready summary for an archived entry: prefer the original activity
// payload's summary, then a summary/note carried on the content itself, else a plain
// label derived from the entry's kind.
function summarise(entry: ImportedEntry): string {
  const fromPayload = oneLine(stringField(entry.content.payload, "summary"));
  if (fromPayload) return fromPayload;
  const direct = oneLine(stringField(entry.content, "summary") || stringField(entry.content, "note"));
  if (direct) return direct;
  const kind = humanise(entry.kind);
  return kind ? `Imported ${kind.toLowerCase()} entry` : "Imported activity entry";
}

// Map a decrypted archive entry to the view's display-ready row.
function toImportedView(entry: ImportedEntry, timeZone: string): DataViewImportedEntry {
  return {
    id: entry.id,
    kind: humanise(entry.kind),
    at: formatAccountTime(entry.occurredAt, timeZone),
    summary: summarise(entry),
  };
}

// Whether an uploaded value is file-like. Duck-typed, NEVER `instanceof File` — that fails
// across server realms (undici vs global); a real browser `File` has a numeric `size` and
// a `text()` reader, which is all the import needs.
function isUploadLike(value: unknown): value is { size: number; text(): Promise<string> } {
  return (
    value != null &&
    typeof (value as { size?: unknown }).size === "number" &&
    typeof (value as { text?: unknown }).text === "function"
  );
}

export function createDataActions(deps: DataActionsDeps): DataActions {
  const { db, clock, keyWrapper, revoker, senders } = deps;
  const maxUploadBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  // Resolve the acting person's unwrapped DEK (their content is stored DEK-encrypted).
  // Read the wrapped DEK member-scoped by `userId` (the session's, never a client value)
  // and unwrap it through the KeyWrapper seam. Throws when the person has no row — never
  // fails silently.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("data actions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Read ONLY the session person's own imported-history archive (member-scoped by
  // `session.userId`), decrypted under their DEK, and map each row to a display-ready view.
  async function load(session: Session): Promise<DataPageData> {
    const dek = await dataKeyFor(session.userId);
    try {
      const entries = await listImportedEntriesForUser(db, session.userId, dek);
      const zone = await timeZoneFor(db, session.userId, dek);
      return { importedHistory: entries.map((entry) => toImportedView(entry, zone)) };
    } finally { dek.fill(0); }
  }

  // Build the SESSION person's complete export document — but ONLY after a fresh step-up
  // (the 5-minute window): export discloses everything Warthog stores, so without a recent
  // re-authentication it is refused and no document is built. Every section is read
  // member-scoped by the session user id alone (never a client value).
  async function exportData(session: Session): Promise<ExportResult> {
    if (!requireStepUp(session, { clock })) {
      return { ok: false, reason: STEP_UP_REQUIRED };
    }
    const dek = await dataKeyFor(session.userId);
    try {
      const document = await buildExportDocument(db, session.userId, dek, clock);
      return { ok: true, document };
    } finally { dek.fill(0); }
  }

  // Validate an uploaded export and restore it into the SIGNED-IN account. The upload is
  // validated at the boundary FIRST — an oversized / malformed / wrong-version file is a
  // 4xx HttpError before any write (INV-102) — then the import service restores it member-
  // scoped by the session user id, ignoring any id inside the file. No step-up: import
  // discloses no secret.
  async function importData(session: Session, upload: unknown): Promise<ImportResult> {
    const document = await readUpload(upload);
    const dek = await dataKeyFor(session.userId);
    try {
      const summary = await importExportDocument(db, session.userId, document, dek, clock);
      return { ok: true, summary };
    } finally { dek.fill(0); }
  }

  // Read and validate the uploaded file at the input boundary: reject a non-file / oversized
  // / malformed / wrong-version upload with a 4xx HttpError, writing nothing. Size is checked
  // BEFORE the bytes are read or parsed, so an oversized upload never reaches the parser.
  async function readUpload(upload: unknown): Promise<ExportDocument> {
    if (!isUploadLike(upload)) {
      throw new HttpError(400, "No import file was provided");
    }
    if (upload.size > maxUploadBytes) {
      throw new HttpError(413, "Import file is too large");
    }
    const raw = await upload.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "Malformed JSON in import file");
    }
    // The envelope's `version: literal(1)` and per-section kind checks run here; a 4xx on
    // failure, so a wrong-version document never reaches the import service.
    if (json && typeof json === "object" && Object.hasOwn(json, "deviceProtected")) {
      throw new HttpError(400, "Use the device import controls for protected details");
    }
    return parseParams(exportDocumentSchema, json);
  }

  // Delete the SESSION person's own account — but ONLY after BOTH a fresh step-up AND the
  // exact typed confirmation phrase. The confirmation shape is validated at the boundary
  // first (an oversized value is a 4xx before any work); then, if either the step-up or the
  // phrase is missing, the action refuses and NOTHING is deleted (the DEK is intact, nothing
  // revoked / enqueued / emailed). Only when both pass does the deletion service run,
  // scoped to the session user id (never a client value).
  async function deleteAccount(
    session: Session,
    input: { confirmation: string },
  ): Promise<ActionResult> {
    const confirmation = parseParams(confirmationSchema, input.confirmation);
    if (!requireStepUp(session, { clock })) {
      return { ok: false, reason: STEP_UP_REQUIRED };
    }
    if (confirmation !== DELETE_ACCOUNT_CONFIRMATION) {
      return { ok: false, reason: CONFIRMATION_REQUIRED };
    }
    const deleted = await deleteAccountService({ db, revoker, senders }, { userId: session.userId });
    return deleted.ok ? { ok: true } : { ok: false, reason: OWNS_HOUSEHOLD };
  }

  return { load, exportData, importData, deleteAccount };
}
