// When a person's request has been answered by the catalogue (docs/adr/requests-for-members.md):
// a requested service matches a catalogue entry by name or alias (ignoring case and
// punctuation, the shared matcher) that this person can connect right now, so a Google entry
// counts only for someone on the early-access list. The admin portal, the person's own
// Connectors page and the arrivals sweep all use these, so they always agree.

import { matchesRequest } from "../../domain/catalogue/match";
import { gateGoogleConnector } from "./google-early-access";
import type { CatalogueIndex } from "./catalogue";

// The catalogue entry a request is now answered by.
export interface ArrivedService {
  readonly id: string;
  readonly name: string;
}

export type ConnectableMatch = (requestedName: string, email: string) => ArrivedService | undefined;

export function connectableMatchFor(catalogue: CatalogueIndex, googleEarlyAccess: readonly string[]): ConnectableMatch {
  return (requestedName, email) => {
    const entry = catalogue
      .connectable()
      .find((candidate) => matchesRequest(requestedName, candidate) && gateGoogleConnector(candidate, email, googleEarlyAccess).kind === "connect");
    return entry ? { id: entry.id, name: entry.name } : undefined;
  };
}

// Whether an address is on the Google early-access list (case-insensitive).
export function onGoogleEarlyAccessFor(googleEarlyAccess: readonly string[]): (email: string) => boolean {
  return (email) => gateGoogleConnector({ google_early_access: true }, email, googleEarlyAccess).kind === "connect";
}
