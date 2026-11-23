// A person's own life-admin categories and their built-in settings (docs/adr/life-admin-profile.md;
// db/migrations/0118). Each row is one of:
//   • a category of their own — suggested by an agent, or kept — whose label, kinds and fields
//     are in the encrypted `definition`;
//   • a setting for a built-in category ("show" it while empty, or "not for me");
//   • a declined suggestion's tombstone (its label), so the same suggestion isn't accepted again.
// The id (`slug`) is random and nothing that names a category is in plaintext: `state` and the
// origin are bookkeeping only. Every read and write is member-scoped by the caller's `userId`;
// the DEK is injected (this module reads no `process.env` and holds no key).

import { randomBytes, randomUUID } from "node:crypto";

import type { CategorySetting, CustomCategoryDefinition, CustomCategoryEntry } from "../../domain/life-admin/catalogue";
import { SLUG_PATTERN, slugFrom } from "../../domain/life-admin/custom-category";
import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import { assertCollectionCapacity } from "./collection-limits";
import { withTransaction, type Db, type Row } from "./index";

const TABLE = "life_admin_categories";
const COLUMN = "definition";

type Stored =
  | { readonly v: 1; readonly custom: CustomCategoryDefinition }
  | { readonly v: 1; readonly builtIn: string; readonly setting: CategorySetting }
  | { readonly v: 1; readonly declined: { readonly label: string } };

export interface CategoryRows {
  // The person's own categories, suggested or kept (what their catalogue is built from).
  readonly custom: CustomCategoryEntry[];
  // Their settings for built-in categories.
  readonly settings: Record<string, CategorySetting>;
  // Labels of suggestions they declined.
  readonly declined: string[];
}

export interface CustomCategoryRow extends CustomCategoryEntry {
  readonly id: string;
  readonly originKind: "person" | "agent";
  readonly createdAt: string;
}

async function decode(dek: Uint8Array, row: Row): Promise<Stored> {
  return JSON.parse(await decrypt(dek, TABLE, COLUMN, row.id as string, row.definition as string)) as Stored;
}

/** Everything the person's catalogue and settings need, decrypted. */
export async function listCategoryRows(db: Db, userId: string, dek: Uint8Array): Promise<CategoryRows> {
  const result = await db.query(
    `SELECT id, slug, state, origin_kind, origin_agent_id, definition, created_at FROM ${TABLE}
     WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  const custom: CustomCategoryRow[] = [];
  const settings: Record<string, CategorySetting> = {};
  const declined: string[] = [];
  for (const row of result.rows) {
    const stored = await decode(dek, row);
    if ("custom" in stored && (row.state === "suggested" || row.state === "active")) {
      custom.push({
        id: row.id as string,
        slug: row.slug as string,
        state: row.state as "suggested" | "active",
        definition: stored.custom,
        suggestedByAgentId: (row.origin_agent_id as string | null) ?? null,
        originKind: row.origin_kind as "person" | "agent",
        createdAt: new Date(String(row.created_at)).toISOString(),
      });
    } else if ("builtIn" in stored) {
      settings[stored.builtIn] = stored.setting;
    } else if ("declined" in stored) {
      declined.push(stored.declined.label);
    }
  }
  return { custom, settings, declined };
}

/** Create one of the person's own categories (suggested by an agent, or kept by the person). */
export async function createCustomCategory(
  db: Db,
  input: {
    readonly userId: string;
    readonly state: "suggested" | "active";
    readonly origin: { readonly kind: "person" } | { readonly kind: "agent"; readonly agentId: string };
    readonly definition: CustomCategoryDefinition;
    // Restoring an export keeps the category's id, so its records still resolve.
    readonly slug?: string;
  },
  dek: Uint8Array,
  clock: Clock,
): Promise<{ id: string; slug: string }> {
  if (!db.inTransaction) return withTransaction(db, (tx) => createCustomCategory(tx, input, dek, clock));
  const id = randomUUID();
  const slug = input.slug && SLUG_PATTERN.test(input.slug) ? input.slug : slugFrom(randomBytes(6));
  const definition = await encrypt(dek, TABLE, COLUMN, id, JSON.stringify({ v: 1, custom: input.definition } satisfies Stored));
  await assertCollectionCapacity(db, input.userId, "life_admin_categories", definition.length);
  const now = clock.now().toISOString();
  await db.query(
    `INSERT INTO ${TABLE} (user_id, id, slug, state, origin_kind, origin_agent_id, definition, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz)`,
    [input.userId, id, slug, input.state, input.origin.kind, input.origin.kind === "agent" ? input.origin.agentId : null, definition, now],
  );
  return { id, slug };
}

/** Keep a suggested category (it becomes the person's). True when one was kept. */
export async function keepCategory(db: Db, userId: string, slug: string, clock: Clock): Promise<boolean> {
  const result = await db.query(
    `UPDATE ${TABLE} SET state = 'active', updated_at = $3::timestamptz WHERE user_id = $1 AND slug = $2 AND state = 'suggested' RETURNING id`,
    [userId, slug, clock.now().toISOString()],
  );
  return result.rows.length > 0;
}

/** Remove one of the person's categories, leaving a tombstone of its label so a re-suggestion is skipped. */
export async function declineCategory(db: Db, userId: string, slug: string, dek: Uint8Array, clock: Clock): Promise<boolean> {
  const row = (await db.query(`SELECT id, definition, state FROM ${TABLE} WHERE user_id = $1 AND slug = $2 FOR UPDATE`, [userId, slug])).rows[0];
  if (!row || (row.state !== "suggested" && row.state !== "active")) return false;
  const stored = await decode(dek, row);
  if (!("custom" in stored)) return false;
  const definition = await encrypt(dek, TABLE, COLUMN, row.id as string, JSON.stringify({ v: 1, declined: { label: stored.custom.label } } satisfies Stored));
  await db.query(
    `UPDATE ${TABLE} SET state = 'dismissed', definition = $3, updated_at = $4::timestamptz WHERE user_id = $1 AND id = $2`,
    [userId, row.id, definition, clock.now().toISOString()],
  );
  return true;
}

/** Set (or clear, with null) the person's setting for a built-in category. */
export async function setBuiltInSetting(
  db: Db,
  userId: string,
  builtInId: string,
  setting: CategorySetting | null,
  dek: Uint8Array,
  clock: Clock,
): Promise<void> {
  if (!db.inTransaction) return withTransaction(db, (tx) => setBuiltInSetting(tx, userId, builtInId, setting, dek, clock));
  const rows = (await db.query(`SELECT id, definition FROM ${TABLE} WHERE user_id = $1 AND state = 'setting' FOR UPDATE`, [userId])).rows;
  for (const row of rows) {
    const stored = await decode(dek, row);
    if ("builtIn" in stored && stored.builtIn === builtInId) await db.query(`DELETE FROM ${TABLE} WHERE user_id = $1 AND id = $2`, [userId, row.id]);
  }
  if (setting === null) return;
  const id = randomUUID();
  const definition = await encrypt(dek, TABLE, COLUMN, id, JSON.stringify({ v: 1, builtIn: builtInId, setting } satisfies Stored));
  await assertCollectionCapacity(db, userId, "life_admin_categories", definition.length);
  const now = clock.now().toISOString();
  await db.query(
    `INSERT INTO ${TABLE} (user_id, id, slug, state, origin_kind, origin_agent_id, definition, created_at, updated_at)
     VALUES ($1, $2, $3, 'setting', 'person', NULL, $4, $5::timestamptz, $5::timestamptz)`,
    [userId, id, slugFrom(randomBytes(6)), definition, now],
  );
}

/** How many of the person's own categories exist, and how many wait for them (for the caps). */
export async function categoryCounts(db: Db, userId: string): Promise<{ custom: number; waiting: number }> {
  const row = (await db.query(
    `SELECT count(*) FILTER (WHERE state IN ('suggested', 'active')) AS custom, count(*) FILTER (WHERE state = 'suggested') AS waiting
     FROM ${TABLE} WHERE user_id = $1`,
    [userId],
  )).rows[0];
  return { custom: Number(row?.custom ?? 0), waiting: Number(row?.waiting ?? 0) };
}

/** Restore a declined suggestion's tombstone (its label) from an export. */
export async function restoreDeclined(db: Db, userId: string, label: string, dek: Uint8Array, clock: Clock): Promise<void> {
  const id = randomUUID();
  const definition = await encrypt(dek, TABLE, COLUMN, id, JSON.stringify({ v: 1, declined: { label } } satisfies Stored));
  const now = clock.now().toISOString();
  await db.query(
    `INSERT INTO ${TABLE} (user_id, id, slug, state, origin_kind, origin_agent_id, definition, created_at, updated_at)
     VALUES ($1, $2, $3, 'dismissed', 'person', NULL, $4, $5::timestamptz, $5::timestamptz)`,
    [userId, id, slugFrom(randomBytes(6)), definition, now],
  );
}

/** Every row as an export carries it: the person's own categories (with why), settings and declined labels. */
export async function exportCategoryRows(db: Db, userId: string, dek: Uint8Array): Promise<Record<string, unknown>[]> {
  const result = await db.query(`SELECT id, slug, state, origin_kind, definition, created_at, updated_at FROM ${TABLE} WHERE user_id = $1 ORDER BY created_at, id`, [userId]);
  const rows: Record<string, unknown>[] = [];
  for (const row of result.rows) {
    const stored = await decode(dek, row);
    rows.push({
      slug: row.slug, state: row.state, origin: row.origin_kind,
      ...("custom" in stored ? { definition: stored.custom } : "builtIn" in stored ? { builtIn: stored.builtIn, setting: stored.setting } : { declined: stored.declined.label }),
      createdAt: new Date(String(row.created_at)).toISOString(),
    });
  }
  return rows;
}
