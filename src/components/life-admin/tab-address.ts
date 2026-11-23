// Life admin's tabs in the address (founder, 23 Nov 2026): `?tab=records|upcoming|history|tasks`
// (Records, the first, has no parameter), and older addresses mapped onto them — the two-level
// `?view=life|tasks&tab=…`, the Bookings tab (its bookings are Upcoming's now), the moving
// checklist (gone), the Records tab's old name ("things") and the tabs Life admin had before typed
// records (subscriptions, receipts, renewals), still in reminder notifications, whose links the
// installed service worker only lets through with those names. Pure: the page reads the tab to
// show first, and the view puts today's address in the browser, keeping the `#record-<id>`.

import { allParams } from "@/lib/href";
import type { LifeAdminTab } from "./record-view-types";

type Params = Readonly<Record<string, string | readonly string[] | undefined>>;

const PAGE_TABS: readonly LifeAdminTab[] = ["records", "upcoming", "history", "tasks"];
const OLDER_TABS: Readonly<Record<string, LifeAdminTab>> = {
  bookings: "upcoming",
  checklist: "records",
  things: "records",
  subscriptions: "records",
  receipts: "records",
  renewals: "records",
};
const first = (value: string | readonly string[] | undefined): string | undefined => (typeof value === "string" ? value : value?.[0]);
const isPageTab = (value: string | undefined): value is LifeAdminTab => value !== undefined && (PAGE_TABS as readonly string[]).includes(value);

/** A tab by today's name or an older one; undefined for anything else. */
export function tabNamed(value: string): LifeAdminTab | undefined {
  if (isPageTab(value)) return value;
  return Object.hasOwn(OLDER_TABS, value) ? OLDER_TABS[value] : undefined;
}

/** The tab an address opens: `?tab=`, an older address mapped onto today's tabs, else Records. */
export function lifeAdminTab(params: Params): LifeAdminTab {
  if (first(params.view) === "tasks") return "tasks";
  const tab = first(params.tab);
  return (tab !== undefined && tabNamed(tab)) || "records";
}

/**
 * Today's address for an older one, keeping the rest of the query (the old Bookings tab's own
 * filters have no place now); null when the address is already current.
 */
export function currentLifeAdminHref(params: Params): string | null {
  const tab = first(params.tab);
  if (params.view === undefined && (tab === undefined || isPageTab(tab))) return null;
  const query = new URLSearchParams();
  const target = lifeAdminTab(params);
  if (target !== "records") query.set("tab", target);
  for (const [name, value] of Object.entries(params)) {
    if (name === "view" || name === "tab" || name === "for_whom" || name === "state" || name === "page") continue;
    for (const one of allParams(value)) query.append(name, one);
  }
  const search = query.toString();
  return search ? `/life-admin?${search}` : "/life-admin";
}

/** The same for a browser address's query string. */
export function currentLifeAdminSearch(search: string): string | null {
  const params: Record<string, string[]> = {};
  for (const [name, value] of new URLSearchParams(search)) (params[name] ??= []).push(value);
  return currentLifeAdminHref(params);
}
