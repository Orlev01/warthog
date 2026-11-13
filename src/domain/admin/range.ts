// Range parsing and windows for the admin portal (docs/design/admin-portal.md §5).
// PLACEHOLDER: the reads slice completes this module (windows, buckets, previous period).

import { RANGE_KEYS, type RangeKey } from "./model";

export const DEFAULT_RANGE: RangeKey = "7d";

/** The validated range from a query value; anything unknown is the default. */
export function parseRange(value: string | string[] | undefined): RangeKey {
  const key = Array.isArray(value) ? value[0] : value;
  return key && (RANGE_KEYS as readonly string[]).includes(key) ? (key as RangeKey) : DEFAULT_RANGE;
}
