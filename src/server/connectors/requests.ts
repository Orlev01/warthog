// E09-S14 — Connector-request create path (brief "Request a connector", design §7).
//
// requestConnector (the CREATE path): a person requests a service that is not yet in
// the catalogue. Warthog records it 'requested' FOR THAT PERSON (the userId is the
// session's, never a client value). The operator reads it, with who asked, on the admin
// portal's Requests page (docs/adr/admin-portal.md, amendment of 20 November 2026); it is
// no longer emailed. Asking again for a service the person is already waiting on (the same
// name, ignoring case and punctuation) records nothing new (docs/adr/requests-for-members.md).
//
// Telling the person when their service arrives is the hourly arrivals sweep
// (`./request-arrivals.ts`, docs/adr/requests-for-members.md).

import { matchesRequest } from "../../domain/catalogue/match";
import {
  createConnectorRequest,
  listConnectorRequestsForUser,
  type ConnectorRequest,
} from "../db/connector-requests";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

// What the CREATE path records: the owner (the session's id, never a client value) and
// the free-text service name the person requested.
export interface RequestConnectorInput {
  readonly userId: string;
  readonly serviceName: string;
}

// The injected seams the CREATE path runs from (this module reads no process.env).
export interface RequestConnectorDeps {
  readonly db: Db;
  readonly clock: Clock;
}

// Record a 'requested' service request for the person, for the operator to read in the
// admin portal, or hand back the one they are already waiting on for the same service.
export async function requestConnector(
  input: RequestConnectorInput,
  deps: RequestConnectorDeps,
): Promise<ConnectorRequest> {
  const waiting = (await listConnectorRequestsForUser(deps.db, input.userId)).find(
    (request) =>
      request.kind === "service" &&
      request.status === "requested" &&
      request.handledAt === null &&
      matchesRequest(input.serviceName, { name: request.serviceName, aliases: [] }),
  );
  if (waiting) return waiting;
  return createConnectorRequest(
    deps.db,
    { userId: input.userId, serviceName: input.serviceName, kind: "service" },
    deps.clock,
  );
}
