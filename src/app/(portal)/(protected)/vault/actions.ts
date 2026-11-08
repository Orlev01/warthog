// E11-S15 — Vault identity page loader + actions (the injectable, unit-testable
// seam the thin `page.tsx` composes — the convention's `createXActions(deps)`
// factory, as `connectors/actions.ts`, `agents/[id]/actions.ts` and
// `settings/security/actions.ts` do). A Next entry file may export only its
// framework fields, so the identity-triad logic lives here and the entry stays thin
// (OBS-025).
//
// The identity triad is the primary-journey "About you" surface (brief "Identity
// vault" + "Device-held protection"; design §4.1 low tier + §4.2 device-held vault).
// `load` reads the SESSION person's identity server-side — the low-tier fields
// DECRYPTED, the high-tier fields as METADATA ONLY (label/type, never the value or
// its ciphertext) — and shapes it into the already-render-tested <IdentityView/>'s
// props (E11-S13). The actions persist values, with high-tier values arriving ONLY
// as device ciphertext, gated by an unlock method existing.
//
// Security (each a reviewer veto; CLAUDE.md + the safety invariants):
//   • Every read/write is member-scoped by `session.userId` — the session's verified
//     id, NEVER a value smuggled in the input. `load` reads only the session person;
//     every mutation is scoped `WHERE … AND user_id = $N`, so another person's field
//     id matches nothing and changes nothing (a safe refusal, never a silent write).
//   • High-tier values arrive ONLY as device ciphertext (design §4.2: the server
//     holds no vault key and never decrypts). A high-tier write is REFUSED when the
//     account has no unlock method set — the reused vault unlock gate
//     (`assertVaultUnlockable`), which treats a recovery code alone as insufficient.
//   • Input is validated at the boundary (INV-102): a malformed / oversized / unknown
//     shape is refused with a 4xx `HttpError` BEFORE any query, so nothing is written.
//     A malformed field id is rejected at the boundary (OBS-049) before it can reach
//     `WHERE id = $1` as a cast. Every value reaches storage bound as a query
//     parameter, so a value shaped like SQL is stored as data and cannot alter a query.
//   • This module reads no `process.env` and holds no secret (INV-103): the db and the
//     KeyWrapper are INJECTED seams, so no ambient env value can surface in the loaded
//     screen or a stored row.

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import { withTransaction, type Db } from "@/server/db/index";
import { getUserById } from "@/server/db/users";
import {
  saveIdentityField,
  updateIdentityField,
  listIdentityFields,
  type IdentityField,
} from "@/server/db/identity-fields";
import {
  saveHighTierField as saveHighTierFieldRow,
  listHighTierFields,
  type HighTierFieldMetadata,
} from "@/server/db/high-tier-fields";
import { createVaultUnlockActions } from "@/server/vault/unlock";
import { systemRandom } from "@/server/seams/random";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Session } from "@/server/auth/session";

// The injected seams — no process.env, no secret (INV-103). `db` is the
// parameterizing database seam; `keyWrapper` unwraps the session person's own DEK
// (from users.wrapped_dek) so the low-tier values can be decrypted and encrypted.
export interface IdentityActionsDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
}

// What `load` returns — the owner's identity shaped into the two props
// <IdentityView/> is mounted over: low-tier fields DECRYPTED, high-tier fields as
// METADATA ONLY (never a value or its ciphertext).
export interface IdentityViewData {
  readonly lowTierFields: IdentityField[];
  readonly highTierFields: HighTierFieldMetadata[];
}

// Every mutation reports its outcome — success, or a refusal naming its reason (the
// unlock gate is closed, or the field is not this person's). Never a silent success
// (conventions: a server action reports success, the refusal reason, or a 4xx).
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// A NEW low-tier field: which kind, its plaintext value (DEK-encrypted server-side),
// and the optional "moving on" date a postal address may carry. The owner is taken
// from the session, never from this input.
export interface SaveLowTierFieldInput {
  readonly kind: string;
  readonly value: string;
  readonly movingOn?: string | null;
}

// An EXISTING low-tier field re-saved by its owner: the field id, its new plaintext value
// (re-encrypted server-side) and, for a postal address, the moving-on date — omitted to
// keep the stored date, null to clear it. The owner is taken from the session.
export interface UpdateLowTierFieldInput {
  readonly fieldId: string;
  readonly value: string;
  readonly movingOn?: string | null;
}

// A NEW high-tier field: its type/label (plaintext metadata) and the device-produced
// ciphertext. The plaintext value NEVER reaches the server.
export interface SaveHighTierFieldInput {
  readonly type: string;
  readonly label: string;
  readonly ciphertext: string;
}

// Raise an existing low-tier field to high tier: the low-tier field's id plus the
// high-tier type/label and the device ciphertext its value was re-sealed into.
export interface RaiseFieldToHighTierInput {
  readonly fieldId: string;
  readonly type: string;
  readonly label: string;
  readonly ciphertext: string;
}

// Set (or clear, with null) the "moving on" date on one of the session person's own
// fields.
export interface SetMovingDateInput {
  readonly fieldId: string;
  readonly movingOn: string | null;
}

export interface IdentityActions {
  load(session: Session): Promise<IdentityViewData>;
  saveLowTierField(session: Session, input: SaveLowTierFieldInput): Promise<ActionResult>;
  updateLowTierField(session: Session, input: UpdateLowTierFieldInput): Promise<ActionResult>;
  saveHighTierField(session: Session, input: SaveHighTierFieldInput): Promise<ActionResult>;
  raiseFieldToHighTier(session: Session, input: RaiseFieldToHighTierInput): Promise<ActionResult>;
  setMovingDate(session: Session, input: SetMovingDateInput): Promise<ActionResult>;
}

// ---- boundary validation shapes (INV-102) -----------------------------------------
//
// The eight low-tier kinds and the five high-tier types (the store enums). A value
// outside either is refused at the boundary with a 4xx before any write. A low-tier
// value / high-tier label is bounded free text (a grossly oversized one is rejected);
// the device ciphertext is a short opaque `v1:` envelope, capped well above any
// genuine one. A field id is a uuid (identity_fields.id), shape-guarded so a non-uuid
// never reaches `WHERE id = $1` as a cast (OBS-049). A moving-on date is a real ISO
// calendar date (or null to clear) — "banana" is refused, never cast at `$3::date`.
const VALUE_MAX = 4096;
const LABEL_MAX = 256;
const CIPHERTEXT_MAX = 64 * 1024;

const lowTierKindSchema = z.enum([
  "name",
  "preferred_name",
  "email",
  "phone",
  "postal_address",
  "language",
  "time_zone",
  "preference",
]);
const highTierTypeSchema = z.enum([
  "date_of_birth",
  "passport",
  "driver_licence",
  "car_registration",
  "custom",
]);
const fieldIdSchema = z.uuid();
const dateSchema = z.iso.date();

const saveLowTierFieldSchema = z.object({
  kind: lowTierKindSchema,
  value: z.string().min(1).max(VALUE_MAX),
  movingOn: dateSchema.nullable().optional(),
});
const updateLowTierFieldSchema = z.object({
  fieldId: fieldIdSchema,
  value: z.string().min(1).max(VALUE_MAX),
  movingOn: dateSchema.nullable().optional(),
});
const saveHighTierFieldSchema = z.object({
  type: highTierTypeSchema,
  label: z.string().min(1).max(LABEL_MAX),
  ciphertext: z.string().min(1).max(CIPHERTEXT_MAX),
});
const raiseFieldToHighTierSchema = z.object({
  fieldId: fieldIdSchema,
  type: highTierTypeSchema,
  label: z.string().min(1).max(LABEL_MAX),
  ciphertext: z.string().min(1).max(CIPHERTEXT_MAX),
});
const setMovingDateSchema = z.object({
  fieldId: fieldIdSchema,
  movingOn: dateSchema.nullable(),
});

export function createIdentityActions(deps: IdentityActionsDeps): IdentityActions {
  const { db, keyWrapper } = deps;

  // Reuse the vault unlock gate (one source of truth for the policy): a high-tier
  // write is allowed only when the person has a PRF-passkey or a passphrase — a
  // recovery code alone is insufficient. The gate's "save_protected" question never
  // draws entropy, so the real `systemRandom` is passed and never invoked.
  const vaultGate = createVaultUnlockActions({ db, random: systemRandom });

  // Resolve the session person's unwrapped 256-bit DEK: read their wrapped DEK (bound
  // by userId) and unwrap it through the injected KeyWrapper. Throws when the person
  // has no row (never fails silently) — the page-data / agent-context idiom.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("createIdentityActions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Read ONLY the session person's identity (member-scoped by `session.userId`): the
  // low-tier values decrypted under their DEK, the high-tier fields as metadata only.
  async function load(session: Session): Promise<IdentityViewData> {
    const dek = await dataKeyFor(session.userId);
    const lowTierFields = await listIdentityFields(db, session.userId, dek);
    const highTierFields = await listHighTierFields(db, session.userId);
    return { lowTierFields, highTierFields };
  }

  // Store a NEW low-tier field for the session person (value DEK-encrypted by the
  // store). Validate at the boundary first (a 4xx before any write); the owner is the
  // session's id, so a userId smuggled in the input is ignored.
  async function saveLowTierField(
    session: Session,
    input: SaveLowTierFieldInput,
  ): Promise<ActionResult> {
    const valid = parseParams(saveLowTierFieldSchema, input);
    const dek = await dataKeyFor(session.userId);
    await saveIdentityField(
      db,
      { userId: session.userId, kind: valid.kind, value: valid.value, movingOn: valid.movingOn ?? null },
      dek,
    );
    return { ok: true };
  }

  // Re-save one of the session person's OWN low-tier fields: validate at the boundary (a
  // malformed id, an empty/oversized value or a non-date is a 4xx before any query), then
  // re-encrypt the value under their DEK and UPDATE scoped to this person — a field that
  // is not theirs matches nothing and changes nothing ({ ok: false, reason: "not_found" }).
  async function updateLowTierField(
    session: Session,
    input: UpdateLowTierFieldInput,
  ): Promise<ActionResult> {
    const valid = parseParams(updateLowTierFieldSchema, input);
    const dek = await dataKeyFor(session.userId);
    const updated = await updateIdentityField(
      db,
      { id: valid.fieldId, userId: session.userId, value: valid.value, movingOn: valid.movingOn },
      dek,
    );
    return updated ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Store a NEW high-tier field for the session person — ONLY the device ciphertext
  // plus the plaintext metadata (the server holds no key). Validate at the boundary
  // first (a 4xx before any write), then refuse via the unlock gate when the account
  // has no unlock method set (nothing is stored).
  async function saveHighTierField(
    session: Session,
    input: SaveHighTierFieldInput,
  ): Promise<ActionResult> {
    const valid = parseParams(saveHighTierFieldSchema, input);
    const gate = await vaultGate.assertVaultUnlockable(session.userId, { action: "save_protected" });
    if (!gate.ok) return gate;
    await saveHighTierFieldRow(db, {
      userId: session.userId,
      type: valid.type,
      label: valid.label,
      ciphertext: valid.ciphertext,
    });
    return { ok: true };
  }

  // Raise an existing low-tier field to high tier: validate at the boundary (a
  // malformed field id is a 4xx before any query), refuse via the unlock gate when
  // closed (nothing created or removed), then — member-scoped and in ONE transaction
  // so both commit or roll back together — save the high-tier ciphertext FIRST and
  // then REMOVE the low-tier value. A field id that is not this person's (or does not
  // exist) matches nothing, so nothing is created or removed ({ ok: false }).
  async function raiseFieldToHighTier(
    session: Session,
    input: RaiseFieldToHighTierInput,
  ): Promise<ActionResult> {
    const valid = parseParams(raiseFieldToHighTierSchema, input);
    const gate = await vaultGate.assertVaultUnlockable(session.userId, { action: "save_protected" });
    if (!gate.ok) return gate;

    return withTransaction(db, async (tx) => {
      const owned = await tx.query(
        `SELECT id FROM identity_fields WHERE id = $1 AND user_id = $2`,
        [valid.fieldId, session.userId],
      );
      if (owned.rows.length === 0) {
        return { ok: false, reason: "not_found" };
      }
      await saveHighTierFieldRow(tx, {
        userId: session.userId,
        type: valid.type,
        label: valid.label,
        ciphertext: valid.ciphertext,
      });
      await tx.query(
        `DELETE FROM identity_fields WHERE id = $1 AND user_id = $2`,
        [valid.fieldId, session.userId],
      );
      return { ok: true };
    });
  }

  // Set (or clear, with null) the moving-on date on one of the session person's own
  // fields. Validate at the boundary (a malformed id or a non-date is a 4xx before any
  // query), then UPDATE scoped to this person — a field that is not theirs matches
  // nothing and changes nothing ({ ok: false }).
  async function setMovingDate(
    session: Session,
    input: SetMovingDateInput,
  ): Promise<ActionResult> {
    const valid = parseParams(setMovingDateSchema, input);
    const result = await db.query(
      `UPDATE identity_fields SET moving_on = $3::date WHERE id = $1 AND user_id = $2 RETURNING id`,
      [valid.fieldId, session.userId, valid.movingOn],
    );
    return result.rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  }

  return {
    load,
    saveLowTierField,
    updateLowTierField,
    saveHighTierField,
    raiseFieldToHighTier,
    setMovingDate,
  };
}
