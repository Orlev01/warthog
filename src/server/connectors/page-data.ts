// E09-S15 — Connectors read for the page (catalogue browse + connections list-all).
// Design §7 "Connector engine" + brief "Connector catalogue — searchable and browsable
// by category" / "Request a connector".
//
// The Connectors page needs two reads the earlier tasks did not provide (CLAUDE.md
// vocabulary: a *connector* is a catalogue entry; a *connection* is a person's connected
// service):
//
//   • browseCatalogue — a PURE read over the already-loaded in-memory catalogue index:
//     the matching entries grouped BY CATEGORY, each carrying a `connectable` flag (the
//     index's own connectability truth), plus a "Request a connector" affordance surfaced
//     when a browse/search comes up empty (a MISS) so the person can ask for a service not
//     in the catalogue yet. The catalogue lives purely in memory and reaches no query, so
//     an injection probe in a browse field is inert data compared as a literal key
//     (INV-102); the index is an INJECTED dependency, so this read folds in no ambient
//     secret (INV-103).
//
//   • listConnectionsForPage — a MEMBER-SCOPED read of ALL of the session person's
//     connections regardless of status (never another person's, never with credentials —
//     `listConnectionsForUser` selects no credential column and binds `user_id` as a
//     parameter, INV-102), each enriched with the TOOLS its connector offers, every tool
//     marked a read or makes-changes. For a curated connector the marking is the project's
//     OWN curated declaration for that slug (`./curated/*`, the single source of truth for
//     reads vs makes-changes — the catalogue data file carries no such flag), so the page
//     read and the engine can never disagree. The db, the catalogue index and the person
//     id are all injected, so this read holds no secret and reads no `process.env`
//     (INV-103).

import type { CatalogueEntry } from "../../domain/catalogue/schema";
import { listConnectionsForUser, type ConnectionStatus } from "../db/connections";
import type { Db } from "../db/index";
import type { CatalogueIndex } from "./catalogue";
import { GOOGLE_CURATED_TOOLS } from "./curated/google";
import { MICROSOFT_CURATED_TOOLS } from "./curated/microsoft";

// ---- catalogue browse -------------------------------------------------------------

// The browse filter: an optional category and/or a free-text search term.
export interface BrowseInput {
  readonly category?: string;
  readonly query?: string;
}

// One catalogue entry as the browse surfaces it — enough for the page to render a card and
// decide whether the "Connect" control is live (`connectable`).
export interface CatalogueBrowseEntry {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly connectable: boolean;
}

// The matching entries of one category, grouped so the page can render a section per
// category.
export interface CatalogueBrowseGroup {
  readonly category: string;
  readonly entries: CatalogueBrowseEntry[];
}

// The browse result: the matching entries grouped by category, the "Request a connector"
// affordance (true on a MISS — nothing matched), and the search term echoed back so the
// request form can prefill it (null when there was no search term).
export interface CatalogueBrowse {
  readonly groups: CatalogueBrowseGroup[];
  readonly canRequest: boolean;
  readonly query: string | null;
}

// Whether a free-text term matches an entry: a case-insensitive substring of its id, name
// or any alias. The term is only ever compared as a literal — never interpreted — so a
// value shaped like SQL matches nothing and disturbs nothing (the catalogue reaches no
// query at all).
function matchesQuery(entry: CatalogueEntry, term: string): boolean {
  const needle = term.toLowerCase();
  if (entry.id.toLowerCase().includes(needle)) return true;
  if (entry.name.toLowerCase().includes(needle)) return true;
  return entry.aliases.some((alias) => alias.toLowerCase().includes(needle));
}

// Browse/search the catalogue index. With no filter every entry is returned, grouped under
// its own category; a `category` narrows to that category's entries; a `query` keeps only
// the entries whose id/name/alias contains the term. A browse that matches nothing is a
// MISS: no groups, and the Request-a-connector affordance is offered.
export function browseCatalogue(index: CatalogueIndex, input: BrowseInput): CatalogueBrowse {
  const base = input.category !== undefined ? index.byCategory(input.category) : index.all();
  const matched =
    input.query !== undefined ? base.filter((entry) => matchesQuery(entry, input.query!)) : base;

  // Group the matches by category, preserving first-seen order.
  const byCategory = new Map<string, CatalogueBrowseEntry[]>();
  for (const entry of matched) {
    const browseEntry: CatalogueBrowseEntry = {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      connectable: index.isConnectable(entry.id),
    };
    const bucket = byCategory.get(entry.category);
    if (bucket) bucket.push(browseEntry);
    else byCategory.set(entry.category, [browseEntry]);
  }

  const groups: CatalogueBrowseGroup[] = [...byCategory.entries()].map(([category, entries]) => ({
    category,
    entries,
  }));

  return {
    groups,
    canRequest: matched.length === 0,
    query: input.query ?? null,
  };
}

// ---- connections list-all ---------------------------------------------------------

// One tool a connection offers, marked: false = a read, true = makes a change.
export interface PageTool {
  readonly name: string;
  readonly makesChange: boolean;
}

// One of the session person's connections as the page lists it: the metadata the list
// needs (never the credentials) plus the marked tools its connector offers.
export interface ConnectionForPage {
  readonly id: string;
  readonly connectorId: string;
  readonly accountLabel: string;
  readonly status: ConnectionStatus;
  readonly connectedAt: Date | string;
  readonly tools: PageTool[];
}

// The curated tool declarations, grouped by the connector slug they belong to — the single
// source of truth for each curated connector's reads vs makes-changes (one object list,
// reused: the page read and the engine read the SAME declarations). Built once at module
// load from the project's curated modules.
const CURATED_TOOLS_BY_CONNECTOR: ReadonlyMap<string, PageTool[]> = (() => {
  const map = new Map<string, PageTool[]>();
  for (const tool of [...GOOGLE_CURATED_TOOLS, ...MICROSOFT_CURATED_TOOLS]) {
    const bucket = map.get(tool.connectorId);
    const pageTool: PageTool = { name: tool.name, makesChange: tool.makesChange };
    if (bucket) bucket.push(pageTool);
    else map.set(tool.connectorId, [pageTool]);
  }
  return map;
})();

// The tools a connection's connector offers, each marked. A curated connector (one declared
// in `./curated/*`) offers its curated declarations; any other connector in the catalogue
// offers none (its tools carry no statically-known read/change marking). A connector no
// longer in the catalogue offers none.
function toolsForConnector(connectorId: string, index: CatalogueIndex): PageTool[] {
  if (!index.get(connectorId)) return [];
  const curated = CURATED_TOOLS_BY_CONNECTOR.get(connectorId);
  return curated ? curated.map((tool) => ({ name: tool.name, makesChange: tool.makesChange })) : [];
}

// List ALL of the session person's connections regardless of status, each enriched with the
// marked tools its connector offers. Member-scoped: `userId` is the session's id (never a
// client value), bound as a parameter by `listConnectionsForUser` — one person can never
// receive another's connections, and no credential column is ever selected.
export async function listConnectionsForPage(
  db: Db,
  userId: string,
  index: CatalogueIndex,
): Promise<ConnectionForPage[]> {
  const connections = await listConnectionsForUser(db, userId);
  return connections.map((connection) => ({
    id: connection.id,
    connectorId: connection.connectorId,
    accountLabel: connection.accountLabel,
    status: connection.status,
    connectedAt: connection.connectedAt,
    tools: toolsForConnector(connection.connectorId, index),
  }));
}
