// How the Connectors catalogue groups services for people (presentation only — the
// operator's catalogue data keeps its own `category` per entry, unchanged).
//
// The data files carry 34 fine-grained categories, several of them near-duplicates
// ("storage" and "file-storage", "flight" and "travel", "banking", "finance", "payments" and
// "accounting"), and a dozen hold a single service. A member filtering for "files" or "travel"
// would find half the services in a sibling chip. So the catalogue shows about fifteen plain
// groups, everyday ones first, and folds each data category into exactly one of them. A data
// category added later that isn't listed here shows as a group of its own (its slug, in
// words), so no service can drop out of the catalogue.
//
// Old links keep working: `?category=` accepts a group key or any data category, which
// resolves to the group that holds it.

export type CatalogueCategoryGroup = {
  readonly key: string;
  readonly label: string;
  // The catalogue data categories this group holds.
  readonly includes: readonly string[];
};

export const CATALOGUE_CATEGORY_GROUPS: readonly CatalogueCategoryGroup[] = [
  { key: "email", label: "Email", includes: ["email"] },
  { key: "calendar", label: "Calendar", includes: ["calendar"] },
  { key: "files", label: "Files and storage", includes: ["storage", "file-storage"] },
  { key: "messaging", label: "Messaging", includes: ["messaging", "communications"] },
  // Nozbe and TickTick are task apps, filed under "notes" in the data.
  { key: "tasks", label: "Tasks and projects", includes: ["tasks", "project-management", "notes"] },
  { key: "docs", label: "Docs and notes", includes: ["productivity", "documentation"] },
  { key: "money", label: "Money", includes: ["finance", "banking", "payments", "accounting"] },
  { key: "shopping", label: "Shopping and selling", includes: ["ecommerce", "retail", "shopping"] },
  { key: "travel", label: "Travel", includes: ["travel", "flight"] },
  { key: "smart-home", label: "Smart home", includes: ["smart-home", "iot"] },
  { key: "customers", label: "Customers and marketing", includes: ["crm", "customer-support", "marketing"] },
  { key: "data", label: "Data and analytics", includes: ["analytics", "data-warehouse", "database"] },
  { key: "design", label: "Design and websites", includes: ["design", "website-builder"] },
  { key: "automation", label: "Automation", includes: ["automation"] },
  { key: "developer-tools", label: "Developer tools", includes: ["developer-tools", "infrastructure", "monitoring"] },
];

// The services most people connect first, offered as "Popular" at the top of the full
// catalogue (only those the person can connect or ask to join are shown).
export const POPULAR_SERVICES: readonly string[] = [
  "google-gmail",
  "google-calendar",
  "google-drive",
  "microsoft-outlook-mail",
  "microsoft-outlook-calendar",
  "microsoft-onedrive",
];

const GROUP_BY_KEY = new Map(CATALOGUE_CATEGORY_GROUPS.map((group) => [group.key, group]));
const GROUP_BY_DATA_CATEGORY = new Map(
  CATALOGUE_CATEGORY_GROUPS.flatMap((group) => group.includes.map((category) => [category, group.key] as const)),
);

/** The display group a catalogue data category belongs to (an unlisted one is its own). */
export function catalogueGroupOf(dataCategory: string): string {
  return GROUP_BY_DATA_CATEGORY.get(dataCategory) ?? dataCategory;
}

/** A display group as a person reads it: "files" → "Files and storage"; an unlisted slug
 * in words ("smart-home" → "Smart home"). */
export function catalogueGroupLabel(key: string): string {
  const known = GROUP_BY_KEY.get(key);
  if (known) return known.label;
  const words = key.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Display order: the listed groups in their everyday-first order, then any others A–Z. */
export function compareCatalogueGroups(a: string, b: string): number {
  const order = (key: string) => {
    const index = CATALOGUE_CATEGORY_GROUPS.findIndex((group) => group.key === key);
    return index < 0 ? CATALOGUE_CATEGORY_GROUPS.length : index;
  };
  return order(a) - order(b) || a.localeCompare(b);
}

/** A `?category=` value, kept only when it names one of `available` groups — directly or
 * through one of its data categories (so a link from before the grouping still lands). */
export function resolveCatalogueGroup(value: string | undefined, available: ReadonlySet<string>): string | null {
  if (value === undefined) return null;
  if (available.has(value)) return value;
  const group = GROUP_BY_DATA_CATEGORY.get(value);
  return group !== undefined && available.has(group) ? group : null;
}
