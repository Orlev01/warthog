import * as React from "react";

import { FilterLinks } from "@/components/ui/filter-links";
import { RANGE_KEYS, type RangeKey } from "@/domain/admin/model";

// RangeTabs — the time window of an admin page as real links (docs/design/admin-portal.md §5):
// `?range=` on the page's own path, keeping any other query parameter the page carries, so
// Back/Forward and deep links work with no client state.

export const RANGE_LABELS: Readonly<Record<RangeKey, string>> = { today: "Today", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

export function rangeHref(path: string, key: RangeKey, params: Readonly<Record<string, string | undefined>> = {}): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined && name !== "range") query.set(name, value);
  query.set("range", key);
  return `${path}?${query.toString()}`;
}

export function RangeTabs({ path, active, params }: { path: string; active: RangeKey; params?: Readonly<Record<string, string | undefined>> }) {
  return (
    <FilterLinks
      label="Time range"
      items={RANGE_KEYS.map((key) => ({ label: RANGE_LABELS[key], href: rangeHref(path, key, params), active: key === active }))}
    />
  );
}
