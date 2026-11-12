// Same-page links that change one piece of URL state and keep the rest (the admin-console
// ADR: in-page view parameters preserve unrelated query parameters). Used by view tabs,
// filter links, removable filter chips and pagination on server-rendered list pages.
//
// Only a fixed `path` the caller supplies is ever emitted, so a crafted parameter can
// never turn one of these links into an off-site redirect.

export type QueryState = Readonly<Record<string, string | undefined>>;

/**
 * `path` with `state` overlaid by `patch`. A patch value of `undefined` or "" removes that
 * parameter; `drop` names further parameters NOT to carry over from `state` (a page cursor,
 * a one-off notice) — a value the patch sets explicitly is always kept. Parameters keep a
 * stable order so the same state always yields the same link.
 */
export function hrefWith(
  path: string,
  state: QueryState,
  patch: QueryState = {},
  drop: readonly string[] = [],
): string {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value !== undefined && value !== "" && !drop.includes(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== "") merged[key] = value;
    else delete merged[key];
  }
  const query = new URLSearchParams(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))).toString();
  return query ? `${path}?${query}` : path;
}

// The first non-empty value of a GET parameter (a repeated key takes its first entry).
export function firstParam(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && value.length > 0 ? value : undefined;
}

// A view or mode parameter validated against its known keys, else the fallback.
export function resolveKey<T extends string>(value: string | undefined, keys: readonly T[], fallback: T): T {
  return value !== undefined && (keys as readonly string[]).includes(value) ? (value as T) : fallback;
}
