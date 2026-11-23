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

/**
 * `path` with `state`, where a value may be a list (`?state=upcoming&state=completed`): keys in a
 * stable order, a list's values in turn, empty values left out.
 */
export function hrefWithLists(path: string, state: Readonly<Record<string, string | readonly string[] | undefined>>): string {
  const query = new URLSearchParams();
  for (const key of Object.keys(state).sort((a, b) => a.localeCompare(b))) {
    const value = state[key];
    for (const one of typeof value === "string" ? [value] : value ?? []) if (one !== "") query.append(key, one);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

// The first non-empty value of a GET parameter (a repeated key takes its first entry).
export function firstParam(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && value.length > 0 ? value : undefined;
}

// Every non-empty value of a repeatable GET parameter (`?category=a&category=b`), each once and in
// order, at most `max` of them so a crafted address can't make a page do unbounded work.
export function allParams(raw: string | readonly string[] | undefined, max = 40): string[] {
  const values = raw === undefined ? [] : typeof raw === "string" ? [raw] : raw;
  return [...new Set(values.filter((value) => value.length > 0))].slice(0, max);
}

// A view or mode parameter validated against its known keys, else the fallback.
export function resolveKey<T extends string>(value: string | undefined, keys: readonly T[], fallback: T): T {
  return value !== undefined && (keys as readonly string[]).includes(value) ? (value as T) : fallback;
}
