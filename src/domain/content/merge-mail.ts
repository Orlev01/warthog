// Mail across inboxes (docs/adr/several-accounts-per-agent.md, decision 5).
//
// A Gmail or Outlook search with no account named covers every inbox the agent may read. Each
// inbox is searched and checked by the result guard with its own account; this module merges
// the checked views into one result that says which inbox each email is in, and which inboxes
// were searched or left out. Message ids carry their inbox's handle (`<handle>.<id>`), so a read
// or a reply by id goes to the inbox that holds the email, even from a client that can't add a
// field.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now. The merge order
// is fixed (newest first, then account order, then id), so one search always reads the same.

import { tagId, untagId } from "../permissions/account-access";
import { untrustedNotice } from "./untrusted";

/** What happened to one inbox in a search across inboxes. */
export type InboxStatus = "searched" | "needs reconnecting" | "not allowed" | "asks first" | "failed";

/** One inbox's part in a search: its account's label, and its checked view when it was searched. */
export interface InboxSearch {
  readonly account: string;
  readonly status: InboxStatus;
  // The guarded view, its ids already tagged (`tagMailIds`).
  readonly view?: Record<string, unknown>;
}

/** How many results a page may ask for, as the service's own search tool allows. */
export interface SearchLimits {
  readonly default: number;
  readonly max: number;
}

// Why an inbox wasn't searched, in words the agent can pass on or act on.
const NOT_SEARCHED: Readonly<Record<Exclude<InboxStatus, "searched">, string>> = {
  "needs reconnecting": "needs reconnecting in Warthog → Connectors",
  "not allowed": "isn't allowed for this agent",
  "asks first": "asks the person first, so search it on its own with account",
  failed: "couldn't be searched just now",
};

const PREVIEWS_NOTE = "Previews only: read a message by its id for its full text.";

type View = Record<string, unknown>;

const isRecord = (value: unknown): value is View => value !== null && typeof value === "object" && !Array.isArray(value);

// A message's ids with the inbox's handle. An id that already carries one is left as it is.
function tagged(message: unknown, handle: string): unknown {
  if (!isRecord(message)) return message;
  const out: View = { ...message };
  for (const key of ["id", "threadId"] as const) {
    const value = out[key];
    if (typeof value === "string" && value !== "" && untagId(value) === null) out[key] = tagId(handle, value);
  }
  return out;
}

/** A checked mail view (a search, a message or one of its links) with every message id and thread id carrying `handle`. Anything else is returned as it is. */
export function tagMailIds(result: unknown, handle: string): unknown {
  if (!isRecord(result) || typeof result.notice !== "string") return result;
  if (Array.isArray(result.messages)) return { ...result, messages: result.messages.map((m) => tagged(m, handle)) };
  if (isRecord(result.message)) return { ...result, message: tagged(result.message, handle) };
  return result;
}

/** How many results to ask each of `inboxes` for, so the search returns about one page in all (at least 3 from each). */
export function splitSearchSize(asked: string | undefined, inboxes: number, limits: SearchLimits): number {
  const wanted = Number.parseInt(asked ?? "", 10);
  const page = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, limits.max) : limits.default;
  return inboxes <= 1 ? page : Math.max(3, Math.ceil(page / inboxes));
}

const countOf = (inbox: InboxSearch) => (inbox.status === "searched" && Array.isArray(inbox.view?.messages) ? inbox.view.messages.length : 0);

/** The one line that says which inboxes were searched and why any weren't, e.g. "Searched 2 inboxes: a@x (7), b@x (3). Not searched: c@x needs reconnecting in Warthog → Connectors." */
export function coverageOf(inboxes: readonly InboxSearch[], note?: string): string {
  const searched = inboxes.filter((inbox) => inbox.status === "searched");
  const skipped = inboxes.filter((inbox) => inbox.status !== "searched");
  const parts = [searched.length === 0
    ? "No inbox could be searched."
    : `Searched ${searched.length} ${searched.length === 1 ? "inbox" : "inboxes"}: ${searched.map((inbox) => `${inbox.account} (${countOf(inbox)})`).join(", ")}.`];
  if (skipped.length > 0) {
    parts.push(`Not searched: ${skipped.map((inbox) => `${inbox.account} ${NOT_SEARCHED[inbox.status as Exclude<InboxStatus, "searched">]}`).join("; ")}.`);
  }
  if (note) parts.push(note);
  return parts.join(" ");
}

// An Outlook inbox's next page, as the $skip its next link carries.
function skipOf(nextLink: unknown): string | undefined {
  if (typeof nextLink !== "string") return undefined;
  try {
    const skip = new URL(nextLink).searchParams.get("$skip");
    return skip !== null && /^\d{1,9}$/.test(skip) ? skip : undefined;
  } catch {
    return undefined;
  }
}

// When a message was received, for ordering; one with no readable date sorts last.
function timeOf(message: View): number {
  const at = Date.parse(String(message.date ?? message.receivedDateTime ?? ""));
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * One result for a search across inboxes: each message names its inbox (`account`), newest
 * first, then in account order, then by id; `accounts` says what happened to each inbox (with its
 * own next page, since a page belongs to one inbox) and `coverage` says it in words. `note` adds
 * any inboxes that were left out over the limit.
 */
export function mergeMailSearch(inboxes: readonly InboxSearch[], options: { readonly note?: string } = {}): View {
  const first = inboxes.find((inbox) => inbox.status === "searched" && inbox.view)?.view;
  const service = isRecord(first?.source) && typeof first.source.service === "string" ? first.source.service : undefined;
  const found: { order: number; message: View }[] = [];
  const accounts = inboxes.map((inbox, order) => {
    const list = inbox.status === "searched" && Array.isArray(inbox.view?.messages) ? inbox.view.messages : [];
    for (const message of list) found.push({ order, message: { account: inbox.account, ...(isRecord(message) ? message : {}) } });
    const nextPageToken = inbox.status === "searched" && typeof inbox.view?.nextPageToken === "string" ? inbox.view.nextPageToken : undefined;
    const nextSkip = inbox.status === "searched" ? skipOf(inbox.view?.nextLink) : undefined;
    return {
      account: inbox.account,
      status: inbox.status,
      count: list.length,
      ...(nextPageToken ? { nextPageToken } : {}),
      ...(nextSkip ? { nextSkip } : {}),
    };
  });
  const idOf = (entry: { message: View }) => String(entry.message.id ?? "");
  found.sort((a, b) => (timeOf(b.message) - timeOf(a.message)) || (a.order - b.order) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
  return {
    notice: typeof first?.notice === "string" ? first.notice : untrustedNotice("email"),
    source: service ? { service } : {},
    messages: found.map((entry) => entry.message),
    accounts,
    coverage: coverageOf(inboxes, options.note),
    note: typeof first?.note === "string" ? first.note : PREVIEWS_NOTE,
  };
}
