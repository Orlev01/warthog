// E09-S01 — Catalogue loader and availability (design §7 "Connector engine";
// brief "Connector catalogue — searchable and browsable by category … at least 100
// connectable services at launch").
//
// The catalogue is a set of DATA FILES the operator deploys (`catalogue/connectors/
// <id>.json`) with no code change (E03-S11 schema). This boot loader reads every
// `*.json` file in a directory, VALIDATES each against the catalogue schema at the
// boundary (INV-102 validate-input), and builds an in-memory index searchable by
// category and alias. A malformed, invalid or oversized file is rejected at load —
// the loader throws a clear error (naming the file + field) rather than returning a
// half-built index.
//
// Connectability is computed per entry: an `oauth2` connector is connectable only
// when its client id/secret are configured — decided by the INJECTED
// `isOAuthClientConfigured` seam, so this module reads no `process.env` and folds no
// ambient secret into its output (INV-103 secrets-from-env; config reads env, not
// this loader). `api_key` / `basic` / `provider_mcp` need no operator client, so they
// are always connectable.
//
// The catalogue is held purely in memory and never reaches a SQL query: every field
// value is inert DATA, only ever compared or returned as a literal key, so an
// injection probe in a field disturbs nothing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { validateCatalogueEntry, type CatalogueEntry } from "../../domain/catalogue/schema";
import { processSingleton } from "../seams/process-singleton";

// A single connector entry is tiny (well under a kilobyte). A multi-megabyte file is
// a boot-safety hazard; it is refused on size rather than parsed and indexed.
const MAX_ENTRY_BYTES = 256 * 1024;

export interface CatalogueIndex {
  all(): readonly CatalogueEntry[];
  get(id: string): CatalogueEntry | undefined;
  byCategory(category: string): readonly CatalogueEntry[];
  byAlias(alias: string): CatalogueEntry | undefined;
  categories(): readonly string[];
  isConnectable(id: string): boolean;
  connectable(): readonly CatalogueEntry[];
}

export interface LoadCatalogueOptions {
  // The directory of `*.json` catalogue data files to load.
  dir: string;
  // The config seam deciding whether an oauth2 connector's client id/secret are
  // configured. api_key / basic / provider_mcp ignore it (always connectable).
  isOAuthClientConfigured: (connectorId: string) => boolean;
}

// An oauth2 connector needs an operator-configured client to be usable; the other
// kinds carry everything they need in the entry itself.
function isConnectableEntry(
  entry: CatalogueEntry,
  isOAuthClientConfigured: (connectorId: string) => boolean,
): boolean {
  if (entry.auth_kind === "oauth2") {
    return isOAuthClientConfigured(entry.id);
  }
  return true;
}

// Read, parse and validate ONE catalogue file, throwing a clear error (naming the
// file and the offending field) on any defect.
function loadEntry(dir: string, fileName: string): CatalogueEntry {
  const path = join(dir, fileName);

  const size = statSync(path).size;
  if (size > MAX_ENTRY_BYTES) {
    throw new Error(
      `Catalogue file ${fileName} is too large (${size} bytes; max ${MAX_ENTRY_BYTES})`,
    );
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in catalogue file ${fileName}: ${detail}`);
  }

  const result = validateCatalogueEntry(parsed);
  if (!result.ok) {
    const detail = result.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid catalogue entry in ${fileName}: ${detail}`);
  }
  return result.entry;
}

// Build the in-memory index over validated entries. Lookups treat every field value
// as a literal key (byAlias folds case); none is interpreted.
function buildIndex(
  entries: readonly CatalogueEntry[],
  isOAuthClientConfigured: (connectorId: string) => boolean,
): CatalogueIndex {
  const byId = new Map<string, CatalogueEntry>();
  const byCategory = new Map<string, CatalogueEntry[]>();
  const byAlias = new Map<string, CatalogueEntry>();
  const connectableIds = new Set<string>();

  for (const entry of entries) {
    byId.set(entry.id, entry);

    const bucket = byCategory.get(entry.category);
    if (bucket) bucket.push(entry);
    else byCategory.set(entry.category, [entry]);

    for (const alias of entry.aliases) {
      byAlias.set(alias.toLowerCase(), entry);
    }

    if (isConnectableEntry(entry, isOAuthClientConfigured)) {
      connectableIds.add(entry.id);
    }
  }

  return {
    all: () => entries,
    get: (id) => byId.get(id),
    byCategory: (category) => byCategory.get(category) ?? [],
    byAlias: (alias) => byAlias.get(alias.toLowerCase()),
    categories: () => [...byCategory.keys()],
    isConnectable: (id) => connectableIds.has(id),
    connectable: () => entries.filter((entry) => connectableIds.has(entry.id)),
  };
}

// The synchronous boot loader: read every `*.json` file in `dir`, validate each, and
// build the index. Throws on the first malformed/oversized/invalid file — bad entries
// are rejected at boot, never half-loaded.
export function loadCatalogue(options: LoadCatalogueOptions): CatalogueIndex {
  const { dir, isOAuthClientConfigured } = options;
  const fileNames = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  const entries: CatalogueEntry[] = [];
  for (const fileName of fileNames) {
    entries.push(loadEntry(dir, fileName));
  }
  return buildIndex(entries, isOAuthClientConfigured);
}

// The process-wide catalogue index, built once from the operator's data files
// (`catalogue/connectors/*.json`, rooted at the working directory — never
// `import.meta.url`, which the bundler mis-resolves). Shared through processSingleton under
// the same key the connectors page uses, so the MCP surface and the page read one index.
// No per-connector OAuth client app is registered in config yet, so no oauth2 connector
// reports connectable until that operator registration lands.
export function getProcessCatalogue(): CatalogueIndex {
  return processSingleton("connectors.catalogue", () =>
    loadCatalogue({
      dir: join(process.cwd(), "catalogue", "connectors"),
      isOAuthClientConfigured: () => false,
    }),
  );
}
