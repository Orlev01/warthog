// Telling people their request has arrived (brief "Request a connector": the person "is notified
// when a catalogue entry is added whose name or listed aliases match the requested service name";
// docs/adr/requests-for-members.md). The catalogue and the Google early-access list change only
// with a release, so an hourly sweep (whose first run is at boot) is soon enough:
//   • a waiting service request is answered once a catalogue entry the person can connect
//     matches it (`connectableMatchFor`), and
//   • a waiting early-access request is answered once the person is on the list.
// Each answered request is claimed (marked 'matched' only while still 'requested', so two
// replicas tell the person once), and each person gets ONE email naming everything now ready.
// A deleted account (its key gone) is skipped, and a "Contact us" message is never matched.
//
// Email, not push: a push carries no text (only a fixed destination), and someone who asked for a
// service wants to hear which one. Project hard rule: the copy runs through redaction before it
// reaches the sender, and a failed send is logged by error class only, never by address.

import { redact } from "../../domain/redaction/redact";
import {
  claimArrivedRequest,
  listPendingConnectorRequests,
  listPendingEarlyAccessRequests,
  listLiveRequesterEmails,
} from "../db/connector-requests";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { EmailSender } from "../notify/senders";
import type { EmailContent } from "../notify/email";
import type { ConnectableMatch } from "./request-match";

export interface RequestArrivalsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly email: EmailSender;
  readonly match: ConnectableMatch;
  readonly onGoogleEarlyAccess: (email: string) => boolean;
  readonly connectorName: (connectorId: string) => string | undefined;
  readonly publicBaseUrl: string;
  readonly log?: (line: string) => void;
}

interface Arrival {
  readonly email: string;
  readonly services: Set<string>;
  earlyAccess: boolean;
}

const scrub = (text: string) => redact(text, () => false) as string;

// "Gmail", "Gmail and Drive", "Gmail, Calendar and Drive".
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function emailFor(arrival: Arrival, publicBaseUrl: string): { body: string; email: EmailContent } {
  const names = [...arrival.services].sort((a, b) => a.localeCompare(b));
  const one = names.length === 1 ? names[0]! : null;
  const url = new URL("/connectors", publicBaseUrl);
  url.searchParams.set("view", "catalogue");
  if (one) url.searchParams.set("q", one);
  const first = arrival.earlyAccess
    ? `You're in Google early access, so you can now connect ${listOf(names)}.`
    : one
      ? `You asked for ${one}, and it's now in Warthog.`
      : `These services you asked for are now in Warthog: ${listOf(names)}.`;
  const second = "Connect it from Connectors, then choose which agents can use it on each agent's page.";
  const subject = one ? `${one} is ready to connect` : "Services you asked for are ready to connect";
  return {
    body: `${first} ${second}`,
    email: {
      subject,
      heading: subject,
      paragraphs: [first, one ? second : second.replace("Connect it", "Connect them")],
      action: { label: "Open Connectors", url: url.href },
      reason: "You're getting this because you asked for it in Warthog.",
    },
  };
}

export async function runRequestArrivals(deps: RequestArrivalsDeps): Promise<{ told: number; requests: number }> {
  const services = await listPendingConnectorRequests(deps.db);
  const early = await listPendingEarlyAccessRequests(deps.db);
  const emails = await listLiveRequesterEmails(deps.db, [...new Set([...services, ...early].map((r) => r.userId))]);

  const arrivals = new Map<string, Arrival>();
  const arrive = (userId: string, email: string, name: string, earlyAccess: boolean) => {
    const arrival = arrivals.get(userId) ?? { email, services: new Set<string>(), earlyAccess: false };
    arrival.services.add(name);
    arrival.earlyAccess ||= earlyAccess;
    arrivals.set(userId, arrival);
  };

  let requests = 0;
  for (const request of services) {
    const email = emails.get(request.userId);
    if (!email) continue;
    const found = deps.match(request.serviceName, email);
    if (!found) continue;
    if (!(await claimArrivedRequest(deps.db, { id: request.id, connectorId: found.id }, deps.clock))) continue;
    requests += 1;
    arrive(request.userId, email, found.name, false);
  }
  for (const request of early) {
    const email = emails.get(request.userId);
    if (!email || !request.connectorId || !deps.onGoogleEarlyAccess(email)) continue;
    if (!(await claimArrivedRequest(deps.db, { id: request.id, connectorId: request.connectorId }, deps.clock))) continue;
    requests += 1;
    arrive(request.userId, email, deps.connectorName(request.connectorId) ?? request.serviceName, true);
  }

  let told = 0;
  for (const arrival of arrivals.values()) {
    const { body, email } = emailFor(arrival, deps.publicBaseUrl);
    try {
      await deps.email.sendEmail({
        recipient: arrival.email,
        body: scrub(body),
        email: { ...email, heading: scrub(email.heading), paragraphs: email.paragraphs.map(scrub) },
      });
      told += 1;
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      (deps.log ?? console.error)(`[warthog requests] arrival email not delivered (${name})`);
    }
  }
  return { told, requests };
}
