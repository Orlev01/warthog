// E09-S14 — Connector-request create path and match-notify (brief "Request a
// connector", design §7).
//
// requestConnector (the CREATE path): a person requests a service that is not yet in
// the catalogue. Warthog records it 'requested' FOR THAT PERSON (the userId is the
// session's, never a client value) and emails the operator so they can consider adding
// it. The operator ADDRESS is read from configuration (INV-103 — injected, never baked
// in), so no env value is read here.
//
// notifyMatchingRequests (the MATCH-NOTIFY path): run when a catalogue entry is added.
// It scans EVERY person's pending request (the system "list all" pending scan, not a
// member read), marks each request the entry matches — name OR alias, case- and
// punctuation-insensitive via the shared `src/domain/catalogue/match` matcher — and
// pushes the owner a notice that their service has arrived. A matched request drops out
// of the pending scan, so running the match-notify twice notifies each person once. A
// non-matching entry marks nothing and notifies nobody; those requests stay 'requested'.
//
// Project hard rule (a reviewer veto): everything that reaches an email or a
// notification passes through `src/domain/redaction` first. Both the operator email and
// the person's push body are scrubbed, so a card number planted in the free-text
// service name is masked to its last four digits before it leaves Warthog. There is no
// released-value context here, so the redaction pass matches no released values; the
// card-masking and truncation rules still apply.

import { redact } from "../../domain/redaction/redact";
import { matchesRequest } from "../../domain/catalogue/match";
import {
  createConnectorRequest,
  listPendingConnectorRequests,
  markConnectorRequestMatched,
  type ConnectorRequest,
} from "../db/connector-requests";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { EmailSender, PushSender } from "../notify/senders";

// What the CREATE path records: the owner (the session's id, never a client value) and
// the free-text service name the person requested.
export interface RequestConnectorInput {
  readonly userId: string;
  readonly serviceName: string;
}

// The injected seams the CREATE path runs from (this module reads no process.env). The
// operator ADDRESS comes from configuration (INV-103), passed in rather than read here.
export interface RequestConnectorDeps {
  readonly db: Db;
  readonly email: EmailSender;
  readonly operatorEmail: string;
  readonly clock: Clock;
}

// The injected seams the MATCH-NOTIFY path runs from.
export interface NotifyMatchingDeps {
  readonly db: Db;
  readonly push: PushSender;
  readonly clock: Clock;
}

// A catalogue entry, structurally — just the id (slug), display name and aliases the
// matcher compares against, so a full CatalogueEntry fits.
export interface CatalogueEntryRef {
  readonly id: string;
  readonly name: string;
  readonly aliases: string[];
}

// Run a body through the redaction module before it reaches a sender (project hard
// rule). There is no released value to match here, so the matcher reports false; the
// card-masking and truncation rules still apply.
function scrub(body: string): string {
  return redact(body, () => false) as string;
}

// Record a 'requested' item for the person and email the operator so they can consider
// adding the service. Returns the recorded, Requested request.
export async function requestConnector(
  input: RequestConnectorInput,
  deps: RequestConnectorDeps,
): Promise<ConnectorRequest> {
  const request = await createConnectorRequest(
    deps.db,
    { userId: input.userId, serviceName: input.serviceName },
    deps.clock,
  );

  await deps.email.sendEmail({
    recipient: deps.operatorEmail,
    body: scrub(
      "Someone requested a connector that is not in the catalogue yet. " +
        "Review it in Warthog and add the service if it fits.",
    ),
  });

  return request;
}

// Run when a catalogue entry is added: scan every pending request, mark those the entry
// matches (name or alias, case- & punctuation-insensitive) and notify each owner.
// Returns the requests newly marked matched. A non-matching entry returns an empty array
// and notifies nobody.
export async function notifyMatchingRequests(
  entry: CatalogueEntryRef,
  deps: NotifyMatchingDeps,
): Promise<ConnectorRequest[]> {
  const pending = await listPendingConnectorRequests(deps.db);

  const matched: ConnectorRequest[] = [];
  for (const request of pending) {
    if (!matchesRequest(request.serviceName, { name: entry.name, aliases: entry.aliases })) {
      continue;
    }

    const updated = await markConnectorRequestMatched(
      deps.db,
      { id: request.id, connectorId: entry.id },
      deps.clock,
    );

    await deps.push.sendPush({
      recipient: request.userId,
      body: scrub(
        `Good news — a service you asked for has arrived: ${entry.name}. ` +
          "Open Warthog to connect it.",
      ),
    });

    matched.push(updated);
  }

  return matched;
}
