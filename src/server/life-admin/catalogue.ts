// Loading a person's life-admin catalogue (docs/adr/life-admin-profile.md): the built-in categories
// and kinds plus their own categories, their settings for built-ins, the labels of suggestions they
// declined, and their time zone — everything the record service, the MCP tools and the page need
// to read and write records for them. Member-scoped by `userId`; the DEK is injected.

import { buildCatalogue, type Catalogue, type CategorySetting } from "../../domain/life-admin/catalogue";
import { listCategoryRows, type CustomCategoryRow } from "../db/life-admin-categories";
import { timeZoneFor } from "../spending/time-zone";
import type { Db } from "../db/index";

export interface PersonCatalogue {
  readonly catalogue: Catalogue;
  readonly settings: Readonly<Record<string, CategorySetting>>;
  readonly declined: readonly string[];
  readonly custom: readonly CustomCategoryRow[];
  readonly zone: string;
}

export async function catalogueFor(db: Db, userId: string, dek: Uint8Array): Promise<PersonCatalogue> {
  const rows = await listCategoryRows(db, userId, dek);
  const zone = await timeZoneFor(db, userId, dek).catch(() => "UTC");
  return {
    catalogue: buildCatalogue(rows.custom),
    settings: rows.settings,
    declined: rows.declined,
    custom: rows.custom as CustomCategoryRow[],
    zone,
  };
}
