// Life admin's tabs in the address (founder, 23, 24 and 25 Nov 2026): `?tab=records|add|upcoming|bills|history|tasks`
// (the page's default tab has no parameter: Records, or Add while nothing is on file), and older
// addresses mapped onto them — the two-level
// `?view=life|tasks&tab=…`, the Bookings tab (its bookings are Upcoming's now), the moving
// checklist (gone), the Records tab's old name ("things") and the tabs Life admin had before typed
// records (subscriptions, receipts, renewals), still in reminder notifications, whose links the
// installed service worker only lets through with those names. Pure: the page reads the tab to
// show first, and the view puts today's address in the browser, keeping the `#record-<id>`.

import { allParams } from "@/lib/href";
import type { LifeAdminTab } from "./record-view-types";

type Params = Readonly<Record<string, string | readonly string[] | undefined>>;

const PAGE_TABS: readonly LifeAdminTab[] = ["records", "add", "upcoming", "bills", "history", "tasks"];

// The Add tab (what's still to fill in, and adding a record) and its add form's anchor.
export const ADD_TAB_HREF = "/life-admin?tab=add";
export const ADD_ANCHOR = "new-record";
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
 * The tab an address asks for, or undefined when it asks for none (the page then opens Records,
 * or Add while nothing is on file). A kind picked to add (`?add=`) asks for Add.
 */
export function requestedLifeAdminTab(params: Params): LifeAdminTab | undefined {
  if (params.view === undefined && params.tab === undefined) return params.add === undefined ? undefined : "add";
  return lifeAdminTab(params);
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
  return currentLifeAdminHref(paramsOf(search));
}

function paramsOf(search: string): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const [name, value] of new URLSearchParams(search)) (params[name] ??= []).push(value);
  return params;
}

/**
 * The address for the tab the page opened (`shown`), or null when the browser's is already right:
 * older addresses mapped onto today's, and the tab named in `?tab=` whenever it isn't the page's
 * default for this person (`defaultTab`: Records, or Add while nothing is on file). The tabs read
 * `?tab=` (or, on load, the tab the page drew) and otherwise the default, so naming it keeps Back,
 * Forward and a reload on the tab the page drew.
 */
export function shownLifeAdminAddress(search: string, hash: string, shown: LifeAdminTab, defaultTab: LifeAdminTab): string | null {
  const asked = paramsOf(search);
  const mapped = new URL(currentLifeAdminHref(asked) ?? `/life-admin${search}`, "https://life-admin.invalid");
  const query = new URLSearchParams(shown === defaultTab ? [] : [["tab", shown]]);
  for (const [name, value] of mapped.searchParams) if (name !== "tab") query.append(name, value);
  const built = query.toString();
  const next = built ? `/life-admin?${built}` : "/life-admin";
  const now = new URLSearchParams(search).toString();
  return next === (now ? `/life-admin?${now}` : "/life-admin") ? null : `${next}${hash}`;
}

/**
 * Where an old link to the add form (`/life-admin#new-record`, from before the Add tab) goes: the
 * Add tab's address, when the address names no tab and the page drew another. Null otherwise.
 */
export function addFormRedirect(search: string, hash: string, shown: LifeAdminTab): string | null {
  if (hash !== `#${ADD_ANCHOR}` || shown === "add") return null;
  const asked = paramsOf(search);
  return asked.tab === undefined && asked.view === undefined ? `${ADD_TAB_HREF}${hash}` : null;
}
