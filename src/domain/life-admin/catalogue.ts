// A person's life-admin catalogue (docs/adr/life-admin-profile.md): the built-in categories and
// kinds (`./record-types.ts`) plus the categories an agent suggested for this person (or they
// made), merged into one value every reader goes through. Nothing looks a kind up statically, so
// a kind a person's own category declares is validated, labelled, rendered, linked and searched
// exactly like a built-in one.
//
// Relationships are generic: any kind may be an ANCHOR, and a kind says which anchors it may
// belong to (`belongsTo`, or "any"). One rule (`canBelongTo`) decides every link, built-in or
// custom; an anchor never belongs to another anchor, so lists stay one level deep.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import {
  BUILT_IN_CATEGORIES,
  BUILT_IN_TYPES,
  LEGACY_KIND_TYPES,
  buildKind,
  type CategoryDef,
  type CategoryIcon,
  type DueMeans,
  type FieldDef,
  type LifeArea,
  type Lifecycle,
  type RecordTypeDef,
  type StoredKind,
} from "./record-types";

// A kind as a person's own category defines it (the shape an agent's suggestion takes, after
// validation in `./custom-category.ts`).
export interface CustomKindDef {
  readonly key: string;
  readonly label: string;
  readonly lifecycle: Lifecycle;
  readonly use: string;
  readonly anchor?: boolean;
  // Built-in kind ids, "self.<key>" for a kind of this same category, or "any".
  readonly belongsTo?: readonly string[];
  readonly due?: { readonly means: DueMeans; readonly label: string };
  readonly fields: readonly FieldDef[];
  readonly identity?: readonly string[];
  readonly holdsAddress?: boolean;
}

export interface CustomCategoryDefinition {
  readonly label: string;
  readonly description: string;
  readonly lifeArea: LifeArea;
  readonly icon: CategoryIcon;
  readonly kinds: readonly CustomKindDef[];
  // What the suggesting agent saw (shown to the person only, never to agents).
  readonly why?: string;
}

export type CustomCategoryState = "suggested" | "active";

// One of the person's own categories, as the catalogue needs it.
export interface CustomCategoryEntry {
  readonly slug: string;
  readonly state: CustomCategoryState;
  readonly definition: CustomCategoryDefinition;
  readonly suggestedByAgentId?: string | null;
}

// What crosses from server to client components (no methods).
export interface CatalogueData {
  readonly categories: readonly CategoryDef[];
  readonly types: readonly RecordTypeDef[];
  readonly customStates: Readonly<Record<string, CustomCategoryState>>;
}

export interface Catalogue extends CatalogueData {
  category(id: string): CategoryDef | undefined;
  type(id: string): RecordTypeDef | undefined;
  typesIn(categoryId: string): RecordTypeDef[];
  // A stored record's kind: its own, else its original kind's, else "Something else".
  typeOfRecord(kind: StoredKind, storedType: string | null | undefined): RecordTypeDef;
  // Whether a stored type no longer exists (its category was removed).
  isRemovedType(storedType: string | null | undefined): boolean;
  canBelongTo(child: RecordTypeDef, parent: RecordTypeDef): boolean;
  readonly data: CatalogueData;
}

/** A custom kind's full definition, resolving "self.<key>" links within its category. */
export function customKind(slug: string, kind: CustomKindDef): RecordTypeDef {
  const belongsTo = kind.belongsTo?.map((target) => (target.startsWith("self.") ? `${slug}.${target.slice(5)}` : target));
  return buildKind(
    slug,
    {
      key: kind.key,
      label: kind.label,
      use: kind.use,
      lifecycle: kind.lifecycle,
      ...(kind.anchor ? { anchor: true as const } : {}),
      ...(belongsTo && belongsTo.length > 0 ? { belongsTo } : {}),
      ...(kind.due ? { due: kind.due } : {}),
      fields: kind.fields,
      ...(kind.identity && kind.identity.length > 0 ? { identity: [kind.identity] } : {}),
      ...(kind.holdsAddress ? { holdsAddress: true as const } : {}),
    },
    "custom",
  );
}

export function customCategoryDef(slug: string, definition: CustomCategoryDefinition): CategoryDef {
  return {
    id: slug,
    label: definition.label,
    description: definition.description,
    lifeArea: definition.lifeArea,
    icon: definition.icon,
    promptWords: definition.label.toLowerCase(),
    priority: 50,
    origin: "custom",
  };
}

export function catalogueFromData(data: CatalogueData): Catalogue {
  const byId = new Map(data.types.map((type) => [type.id, type]));
  const categories = new Map(data.categories.map((cat) => [cat.id, cat]));
  const other = byId.get("other.item")!;
  return {
    ...data,
    data,
    category: (id) => categories.get(id),
    type: (id) => byId.get(id),
    typesIn: (categoryId) => data.types.filter((type) => type.category === categoryId),
    typeOfRecord(kind, storedType) {
      const own = storedType ? byId.get(storedType) : undefined;
      if (own) return own;
      if (storedType) return other; // a removed category's kind reads as "Something else"
      return byId.get(LEGACY_KIND_TYPES[kind]) ?? other;
    },
    isRemovedType: (storedType) => Boolean(storedType) && !byId.has(storedType!),
    canBelongTo(child, parent) {
      if (!parent.anchor || child.anchor || child.id === parent.id) return false;
      return (child.belongsTo ?? []).some((target) => target === "any" || target === parent.id);
    },
  };
}

/** The catalogue for a person: the built-ins plus their own categories (suggested or kept). */
export function buildCatalogue(custom: readonly CustomCategoryEntry[] = []): Catalogue {
  const categories: CategoryDef[] = [...BUILT_IN_CATEGORIES];
  const types: RecordTypeDef[] = [...BUILT_IN_TYPES];
  const customStates: Record<string, CustomCategoryState> = {};
  for (const entry of custom) {
    categories.push(customCategoryDef(entry.slug, entry.definition));
    for (const kind of entry.definition.kinds) types.push(customKind(entry.slug, kind));
    customStates[entry.slug] = entry.state;
  }
  // Custom categories sit just before "Other".
  const otherIndex = categories.findIndex((cat) => cat.id === "other");
  if (otherIndex >= 0) categories.push(...categories.splice(otherIndex, 1));
  return catalogueFromData({ categories, types, customStates });
}

/** The built-in catalogue alone, for code that has no person (tests, defaults). */
export const BUILT_IN: Catalogue = buildCatalogue();

// ---- visibility: built-in categories stay hidden until they're used --------------------------

export type CategorySetting = "show" | "not_for_me";
export type CategoryVisibility = "shown" | "available" | "not_for_me";

/** Whether a category shows: it has records, or the person chose to show it; or they said "not for me". */
export function visibilityOf(hasRecords: boolean, setting: CategorySetting | undefined, origin: "builtin" | "custom"): CategoryVisibility {
  if (setting === "not_for_me") return "not_for_me";
  if (hasRecords || setting === "show" || origin === "custom") return "shown";
  return "available";
}
