// About you suggestions (docs/adr/profile-build.md; migration 0125).
//
// A low-tier identity detail an agent SUGGESTS — a preferred name, an email address, a phone
// number, a postal address (with an optional moving-on date), a language or a time zone — and the
// person confirms one at a time. A suggestion is NOT an identity field: it lives in its own table,
// so nothing that lists identity fields (get_context, About you, the per-agent detail toggles,
// moving) can see it, and no agent reads it until the person accepts it. Accepting saves it as an
// identity field (`./identity-fields`) and deletes the suggestion; declining keeps only its match
// key, so the same suggestion is never made again.
//
// The value and its provenance (where the agent says it found it, and an address's moving-on date)
// are PERSONAL CONTENT, stored only DEK-ENCRYPTED (`../crypto/envelope`): the id is generated up
// front so each envelope binds to its exact (table, column, row). The match key is an opaque HMAC
// of the kind and the normalised value under the person's derived Life admin match key
// (`recordMatchKey`), never a plain hash of the value. The kind, state, suggesting agent id and
// creation time are plaintext metadata.
//
// Every statement is parameterized through the `Db` seam (INV-102) and member-scoped by the
// `userId` the caller passes (the session's or the agent connection owner's id, never a client
// value). Ids from a client are shape-checked before they reach a query. The DEK is injected;
// this module reads no env (INV-103).

import { randomUUID } from "node:crypto";

import { calendarDate } from "../../domain/life-admin/normalise";
import { decrypt, encrypt } from "../crypto/envelope";
import { listIdentityFields, saveIdentityField, type IdentityField, updateIdentityField } from "./identity-fields";
import { withTransaction, type Db, type Row } from "./index";
import { recordMatchKey } from "./life-admin-records";

const TABLE = "identity_suggestions";
const VALUE_COLUMN = "value";
const META_COLUMN = "meta";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The match key's namespace within the shared HMAC key: no Life admin type id starts with it.
const MATCH_NAMESPACE = "about_you";

// The low-tier kinds an agent may suggest. Never a name or a general preference (the person
// writes those), and never a high-tier detail (those live in the device-held vault).
export const IDENTITY_SUGGESTION_KINDS = ["preferred_name", "email", "phone", "postal_address", "language", "time_zone"] as const;
export type IdentitySuggestionKind = (typeof IDENTITY_SUGGESTION_KINDS)[number];

// Where the agent says it found the detail (encrypted with the suggestion).
export interface IdentitySuggestionSource {
  readonly service: string;
  readonly messageId?: string;
  readonly date?: string;
  readonly sender?: string;
}

// What suggestIdentityDetail records. `userId` is the owner (the connection owner's id, never a
// client value); `agentId` is the suggesting agent's opaque id. `movingOn` (an ISO calendar date)
// is kept for a postal address only.
export interface NewIdentitySuggestion {
  readonly userId: string;
  readonly kind: IdentitySuggestionKind;
  readonly value: string;
  readonly movingOn?: string | null;
  readonly source: IdentitySuggestionSource;
  readonly agentId: string;
}

// What a suggestion did: saved as a new suggestion (with its id), or nothing was written because
// About you already holds that detail, it is already waiting, or the person declined it before.
export type SuggestIdentityDetailResult =
  | { readonly outcome: "suggested"; readonly id: string }
  | { readonly outcome: "already_saved" | "already_suggested" | "declined_before"; readonly id?: undefined };

// A waiting suggestion as shown to its owner, decrypted.
export interface IdentitySuggestion {
  readonly id: string;
  readonly kind: IdentitySuggestionKind;
  readonly value: string;
  readonly movingOn: string | null;
  readonly source: IdentitySuggestionSource;
  readonly agentId: string | null;
  readonly createdAt: string;
}

// The encrypted `meta` envelope's content.
interface SuggestionMeta {
  readonly source: IdentitySuggestionSource;
  readonly movingOn?: string;
}

function isSuggestionKind(kind: unknown): kind is IdentitySuggestionKind {
  return typeof kind === "string" && (IDENTITY_SUGGESTION_KINDS as readonly string[]).includes(kind);
}

// The form two details of one kind are compared in: an email address trimmed and lower-cased; a
// phone number reduced to its digits and a leading + (no country is ever inferred); anything
// else trimmed, whitespace collapsed and lower-cased.
export function normaliseDetail(kind: IdentitySuggestionKind, value: string): string {
  const trimmed = value.trim();
  switch (kind) {
    case "email":
      return trimmed.toLowerCase();
    case "phone": {
      const digits = (/^[\s(]*\+/.test(trimmed) ? "+" : "") + trimmed.replace(/\D/g, "");
      // An Australian number written internationally is the same number: +61 4… is 04….
      return digits.startsWith("+61") ? `0${digits.slice(3)}` : digits;
    }
    default:
      return trimmed.replace(/\s+/g, " ").toLowerCase();
  }
}

// Kinds a person has one of: an added suggestion replaces theirs.
export const SINGLE_KINDS: ReadonlySet<IdentitySuggestionKind> = new Set(["preferred_name", "time_zone", "language"]);

// The opaque match key of one detail: an HMAC under the person's derived match key.
function matchKeyOf(dek: Uint8Array, kind: IdentitySuggestionKind, normalised: string): string {
  return recordMatchKey(dek, `${MATCH_NAMESPACE}.${kind}`, ["value"], [normalised]);
}

// A field the person already holds with the same detail, if any.
function sameDetail(fields: readonly IdentityField[], kind: IdentitySuggestionKind, normalised: string): IdentityField | undefined {
  return fields.find((field) => field.kind === kind && normaliseDetail(kind, field.value) === normalised);
}

// The moving-on date kept with a postal address: an exact ISO calendar date, or none.
function checkedMovingOn(kind: IdentitySuggestionKind, movingOn: string | null | undefined): string | undefined {
  if (kind !== "postal_address" || movingOn === undefined || movingOn === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movingOn) || calendarDate(movingOn) !== movingOn) {
    throw new Error("identity suggestion: movingOn must be a calendar date (YYYY-MM-DD)");
  }
  return movingOn;
}

// Only the provenance fields that were given, so the envelope holds nothing else.
function sourceOf(source: IdentitySuggestionSource): IdentitySuggestionSource {
  return {
    service: source.service,
    ...(source.messageId !== undefined ? { messageId: source.messageId } : {}),
    ...(source.date !== undefined ? { date: source.date } : {}),
    ...(source.sender !== undefined ? { sender: source.sender } : {}),
  };
}

async function readMeta(dek: Uint8Array, id: string, envelope: string): Promise<SuggestionMeta> {
  return JSON.parse(await decrypt(dek, TABLE, META_COLUMN, id, envelope)) as SuggestionMeta;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

// Record an agent's suggestion for `input.userId`. Nothing is written when About you already holds
// the same detail of that kind ("already_saved"), when the same suggestion is already waiting
// ("already_suggested") or when the person declined it before ("declined_before"). A detail that
// differs from a saved field of its kind is a new suggestion; the saved field is never changed.
export async function suggestIdentityDetail(
  db: Db,
  input: NewIdentitySuggestion,
  dek: Uint8Array,
): Promise<SuggestIdentityDetailResult> {
  if (!isSuggestionKind(input.kind)) throw new Error("identity suggestion: not a kind an agent may suggest");
  const value = input.value.trim();
  const normalised = normaliseDetail(input.kind, value);
  if (normalised === "" || normalised === "+") throw new Error("identity suggestion: the value is empty");
  const movingOn = checkedMovingOn(input.kind, input.movingOn);

  if (sameDetail(await listIdentityFields(db, input.userId, dek), input.kind, normalised)) {
    return { outcome: "already_saved" };
  }

  const id = randomUUID();
  const matchKey = matchKeyOf(dek, input.kind, normalised);
  const meta: SuggestionMeta = { source: sourceOf(input.source), ...(movingOn ? { movingOn } : {}) };
  const valueEnvelope = await encrypt(dek, TABLE, VALUE_COLUMN, id, value);
  const metaEnvelope = await encrypt(dek, TABLE, META_COLUMN, id, JSON.stringify(meta));

  // One row per detail per person: a suggestion made at the same moment by another agent (or the
  // same one twice) meets the unique key and writes nothing.
  const inserted = await db.query(
    `INSERT INTO identity_suggestions (id, user_id, kind, value, meta, source_agent_id, match_key, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'suggested')
     ON CONFLICT (user_id, match_key) DO NOTHING
     RETURNING id`,
    [id, input.userId, input.kind, valueEnvelope, metaEnvelope, input.agentId, matchKey],
  );
  if (inserted.rows.length > 0) return { outcome: "suggested", id };

  const existing = await db.query(
    `SELECT state FROM identity_suggestions WHERE user_id = $1 AND match_key = $2`,
    [input.userId, matchKey],
  );
  const state = existing.rows[0]?.state;
  if (state === "declined") return { outcome: "declined_before" };
  // Gone again since the conflict: it was accepted meanwhile, so About you holds it now.
  return { outcome: state === "suggested" ? "already_suggested" : "already_saved" };
}

function toSuggestion(row: Row, value: string, meta: SuggestionMeta): IdentitySuggestion {
  return {
    id: row.id as string,
    kind: row.kind as IdentitySuggestionKind,
    value,
    movingOn: meta.movingOn ?? null,
    source: meta.source,
    agentId: (row.source_agent_id as string | null) ?? null,
    createdAt: iso(row.created_at),
  };
}

// The person's waiting suggestions, decrypted, oldest first (declined ones are never listed). A
// wrong DEK, or an envelope moved from another row, rejects.
export async function listIdentitySuggestions(db: Db, userId: string, dek: Uint8Array): Promise<IdentitySuggestion[]> {
  const result = await db.query(
    `SELECT id, kind, value, meta, source_agent_id, created_at
       FROM identity_suggestions
      WHERE user_id = $1 AND state = 'suggested'
      ORDER BY created_at, id`,
    [userId],
  );
  const out: IdentitySuggestion[] = [];
  for (const row of result.rows) {
    const id = row.id as string;
    const value = await decrypt(dek, TABLE, VALUE_COLUMN, id, row.value as string);
    out.push(toSuggestion(row, value, await readMeta(dek, id, row.meta as string)));
  }
  return out;
}

// Remove the person's waiting suggestions that About you now holds (they saved the same detail
// themselves), so they neither linger nor use up the waiting limit. Returns how many went.
export async function pruneSavedSuggestions(db: Db, userId: string, dek: Uint8Array): Promise<number> {
  const waiting = await listIdentitySuggestions(db, userId, dek);
  if (waiting.length === 0) return 0;
  const fields = await listIdentityFields(db, userId, dek);
  const stale = waiting.filter((item) => sameDetail(fields, item.kind, normaliseDetail(item.kind, item.value))).map((item) => item.id);
  if (stale.length === 0) return 0;
  const removed = await db.query(
    `DELETE FROM identity_suggestions WHERE user_id = $1 AND state = 'suggested' AND id = ANY($2::uuid[]) RETURNING id`,
    [userId, stale],
  );
  return removed.rows.length;
}

// How many suggestions are waiting for the person (no decryption).
export async function countIdentitySuggestions(db: Db, userId: string): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n FROM identity_suggestions WHERE user_id = $1 AND state = 'suggested'`,
    [userId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// Accept one of the person's waiting suggestions: it is saved as an identity field (a postal
// address with its moving-on date) and the suggestion is deleted, together in one transaction
// (the caller's, or one of its own). When the person has since saved the same detail themselves,
// that field is returned and nothing is saved twice. Undefined when no waiting suggestion of
// theirs has that id, so accepting twice (or another person's id) saves nothing.
export async function acceptIdentitySuggestion(
  db: Db,
  userId: string,
  id: string,
  dek: Uint8Array,
): Promise<IdentityField | undefined> {
  if (!UUID.test(id)) return undefined;
  const accept = async (tx: Db): Promise<IdentityField | undefined> => {
    // Deleting first claims the row: a second accept waits on it and then finds nothing. A failure
    // below (a wrong key, a tampered envelope) rolls the delete back.
    const removed = await tx.query(
      `DELETE FROM identity_suggestions
        WHERE id = $1 AND user_id = $2 AND state = 'suggested'
        RETURNING id, kind, value, meta`,
      [id, userId],
    );
    const row = removed.rows[0];
    if (!row) return undefined;
    const rowId = row.id as string;
    const kind = row.kind as IdentitySuggestionKind;
    const value = await decrypt(dek, TABLE, VALUE_COLUMN, rowId, row.value as string);
    const meta = await readMeta(dek, rowId, row.meta as string);

    const fields = await listIdentityFields(tx, userId, dek);
    const existing = sameDetail(fields, kind, normaliseDetail(kind, value));
    if (existing) return existing;
    // A detail a person has one of (preferred name, time zone, language): adding the suggestion
    // replaces theirs, the person's own choice on About you, rather than leaving two.
    const single = SINGLE_KINDS.has(kind) ? fields.find((field) => field.kind === kind) : undefined;
    if (single) {
      await updateIdentityField(tx, { id: single.id, userId, value }, dek);
      return { ...single, value };
    }
    return saveIdentityField(
      tx,
      { userId, kind, value, ...(kind === "postal_address" ? { movingOn: meta.movingOn ?? null } : {}) },
      dek,
    );
  };
  return db.inTransaction ? accept(db) : withTransaction(db, accept);
}

// Decline one of the person's waiting suggestions: only its match key is kept (the value,
// provenance and agent are cleared), so it is never suggested again. Returns whether a waiting
// suggestion of theirs was declined.
export async function declineIdentitySuggestion(db: Db, userId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const result = await db.query(
    `UPDATE identity_suggestions
        SET state = 'declined', value = NULL, meta = NULL, source_agent_id = NULL
      WHERE id = $1 AND user_id = $2 AND state = 'suggested'
      RETURNING id`,
    [id, userId],
  );
  return result.rows.length > 0;
}
