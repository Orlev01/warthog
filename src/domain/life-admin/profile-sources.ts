// What an agent can read to build the person's profile (docs/adr/profile-build.md): the person's
// email, calendars and files, through Warthog's own connectors (whose reads Warthog checks and
// never holds for approval). Services that ask the person before every read (provider-hosted
// ones) and LinkedIn (a public profile, not paperwork) are never counted; the "Building a profile"
// skill tells the agent to ask before using them.
//
// Pure domain module: get_context's offer and the skill read it, and Home names the sources.

import { MAIL_CONNECTOR_IDS } from "../content/mail-connectors";

export type SourceKind = "mail" | "calendar" | "files";

const ORDER: readonly SourceKind[] = ["mail", "calendar", "files"];

export const PROFILE_SOURCE_CONNECTORS: ReadonlyMap<string, SourceKind> = new Map<string, SourceKind>([
  ...[...MAIL_CONNECTOR_IDS].map((id) => [id, "mail"] as const),
  ["google-calendar", "calendar"],
  ["microsoft-outlook-calendar", "calendar"],
  ["google-drive", "files"],
  ["microsoft-onedrive", "files"],
]);

// One of the person's accounts as this agent sees it: connected (not expired or in error) and
// readable by this agent under its own settings.
export interface SourceAccount {
  readonly connectorId: string;
  readonly connected: boolean;
  readonly reads: boolean;
}

/** The kinds of source this agent can read, each once, in a fixed order. */
export function readableSources(accounts: readonly SourceAccount[]): SourceKind[] {
  const kinds = new Set<SourceKind>();
  for (const account of accounts) {
    const kind = PROFILE_SOURCE_CONNECTORS.get(account.connectorId);
    if (kind && account.connected && account.reads) kinds.add(kind);
  }
  return ORDER.filter((kind) => kinds.has(kind));
}

const WORDS: Readonly<Record<SourceKind, string>> = { mail: "email", calendar: "calendar", files: "files" };

/** "email, calendar and files". */
export function sourcesPhrase(sources: readonly SourceKind[]): string {
  const words = ORDER.filter((kind) => sources.includes(kind)).map((kind) => WORDS[kind]);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// The services' names as the person knows them, for Home ("Claude can read: Gmail, Google Drive").
const NAMES: ReadonlyMap<string, string> = new Map([
  ["google-gmail", "Gmail"],
  ["microsoft-outlook-mail", "Outlook"],
  ["google-calendar", "Google Calendar"],
  ["microsoft-outlook-calendar", "Outlook Calendar"],
  ["google-drive", "Google Drive"],
  ["microsoft-onedrive", "OneDrive"],
]);

/** The names of the readable source services among these accounts, each once, in catalogue order. */
export function readableSourceNames(accounts: readonly SourceAccount[]): string[] {
  const readable = new Set(accounts.filter((account) => account.connected && account.reads && PROFILE_SOURCE_CONNECTORS.has(account.connectorId)).map((account) => account.connectorId));
  return [...NAMES.entries()].filter(([id]) => readable.has(id)).map(([, name]) => name);
}
