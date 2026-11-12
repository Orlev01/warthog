import * as React from "react";
import { X } from "lucide-react";

// Server-rendered organisation controls shared by list pages (Activity, Inbox, Memory,
// Connectors …), so every page groups and filters the same way:
//
//   • <FilterLinks> — a row of pill links (the `.wh-subtab` style) for a view switch or a
//     quick filter. The current one carries aria-current; each may show a count.
//   • <ActiveFilters> — the filters applied right now as removable chips, each a link to
//     the same page without that one filter, plus "Clear all".
//
// Both are plain links (no client state): Back/Forward restore them, they deep-link, and
// they work before hydration. Callers build every href with `hrefWith` so unrelated
// parameters survive.

export type FilterLink = {
  readonly label: string;
  readonly href: string;
  readonly active: boolean;
  readonly count?: number;
};

// `tabs` is the sub-tab pill row (a view switch); `chips` is a lighter bordered row for quick
// filters that sit under it.
const CHIP_LINK =
  "inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-3 text-sm text-fg-muted hover:bg-surface-muted hover:text-fg aria-[current=page]:border-line-strong aria-[current=page]:bg-surface-muted aria-[current=page]:font-semibold aria-[current=page]:text-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export function FilterLinks({
  label,
  items,
  variant = "tabs",
}: {
  label: string;
  items: readonly FilterLink[];
  variant?: "tabs" | "chips";
}) {
  return (
    <nav aria-label={label} className={variant === "tabs" ? "wh-subtabs" : "flex flex-wrap gap-2"}>
      {items.map((item) => (
        <a key={item.href} href={item.href} aria-current={item.active ? "page" : undefined} className={variant === "tabs" ? "wh-subtab gap-2" : CHIP_LINK}>
          {item.label}
          {item.count !== undefined ? (
            <span className="rounded-card bg-surface-muted px-1.5 text-xs font-medium tabular-nums text-fg-muted">
              {item.count}
            </span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}

export type AppliedFilter = {
  readonly label: string; // e.g. "Agent: Claude"
  readonly removeHref: string; // the same page without this filter
};

export function ActiveFilters({
  filters,
  clearHref,
  label = "Applied filters",
}: {
  filters: readonly AppliedFilter[];
  clearHref: string;
  label?: string;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ul aria-label={label} className="flex flex-wrap gap-2" role="list">
        {filters.map((filter) => (
          <li key={filter.removeHref + filter.label}>
            <a
              href={filter.removeHref}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-sm text-fg [overflow-wrap:anywhere] hover:bg-surface-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <span className="sr-only">Remove filter </span>
              {filter.label}
              <X aria-hidden={true} className="h-4 w-4 shrink-0" />
            </a>
          </li>
        ))}
      </ul>
      <a href={clearHref} className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-fg underline underline-offset-4">
        Clear all filters
      </a>
    </div>
  );
}
