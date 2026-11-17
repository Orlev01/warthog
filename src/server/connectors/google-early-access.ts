// E09-S13 — Google early-access gating (brief "Google early access", design §7).
//
// Until Google verifies Warthog, at most 100 people can ever connect a Google account to it
// (a lifetime cap Google never resets), so the three Google connectors (flagged
// `google_early_access: true`) are offered only to people whose email the founder has
// placed on the early-access allowlist. Everyone else is funnelled to "Early access — ask
// to join", which files a connector request and emails the operator so they can add the
// person to the allowlist. The Google app itself is published (17 Nov 2026,
// docs/adr/google-published-and-accounts.md), so connections no longer lapse after 7 days.
//
//   gateGoogleConnector (pure): decides what a person sees for a connector entry —
//     an unflagged entry connects with no warning; a flagged entry whose email is on
//     the INJECTED allowlist connects with the Google unverified-app note; a flagged entry whose email is not on the allowlist is funnelled to
//     ask-to-join. The allowlist is read from configuration (`config.googleEarlyAccess`)
//     and passed in, never hard-coded (INV-103). Matching is case-insensitive.
//
//   askToJoinEarlyAccess (the filing path): records a 'requested' connector request
//     FOR THE SESSION USER (the userId is the session's, never a client value) naming
//     the Google service, and emails the operator at the ADDRESS read from configuration
//     and passed in (INV-103 — nothing baked in; this module reads no process.env).
//
// Project hard rule (a reviewer veto): everything reaching an email passes through
// `src/domain/redaction` first, so a card number planted in the service name is masked
// before it leaves Warthog. The service name itself is stored VERBATIM (free text the
// person's connector carried), bound as a parameter through the db seam (INV-102), so a
// value shaped like SQL is stored as data and cannot alter the query.

import { redact } from "../../domain/redaction/redact";
import { createConnectorRequest, type ConnectorRequest } from "../db/connector-requests";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { EmailSender } from "../notify/senders";
import { mapEmailText, OPERATOR_EMAIL_REASON } from "../notify/email";

// The exact funnel label a non-allowlisted person sees (UI copy; do not drift).
const ASK_TO_JOIN_LABEL = "Early access — ask to join";

// What Google shows during sign-in while Warthog is unverified, and how to get past it.
const UNVERIFIED_APP_NOTICE =
  "Google will say it hasn't verified Warthog yet. To continue, choose Advanced, then Go to warthog.com.au.";

// The note an allowed Google connect carries: Google's unverified-app screen.
export interface GoogleConnectWarning {
  readonly unverifiedApp: string;
}

// What the gate decides: connect (with the Google warning for a flagged entry, or no
// warning for an unflagged one) or ask-to-join (the funnel, carrying its label).
export type GoogleGateDecision =
  | { readonly kind: "connect"; readonly warning: GoogleConnectWarning | null }
  | { readonly kind: "ask_to_join"; readonly label: string };

// Decide what a person sees for a connector entry. An entry not flagged for Google
// early access is never gated (connect, no warning). A flagged entry connects only when
// the person's email is on the injected allowlist (case-insensitive) and then carries
// the unverified-app note; otherwise it is funnelled to ask-to-join.
export function gateGoogleConnector(
  entry: { google_early_access?: boolean },
  email: string,
  allowlist: readonly string[],
): GoogleGateDecision {
  if (!entry.google_early_access) {
    return { kind: "connect", warning: null };
  }

  const normalised = email.trim().toLowerCase();
  const allowed = allowlist.some((listed) => listed.trim().toLowerCase() === normalised);
  if (!allowed) {
    return { kind: "ask_to_join", label: ASK_TO_JOIN_LABEL };
  }

  return {
    kind: "connect",
    warning: { unverifiedApp: UNVERIFIED_APP_NOTICE },
  };
}

// What the filing path records: the owner (the session's id, never a client value) and
// the Google connector the person asked to join early access for.
export interface AskToJoinInput {
  readonly userId: string;
  readonly connector: { readonly id: string; readonly name: string };
}

// The injected seams the filing path runs from (this module reads no process.env). The
// operator ADDRESS comes from configuration (INV-103), passed in rather than read here.
export interface AskToJoinDeps {
  readonly db: Db;
  readonly email: EmailSender;
  readonly operatorEmail: string;
  readonly clock: Clock;
}

// Run a body through the redaction module before it reaches a sender (project hard
// rule). There is no released value to match here, so the matcher reports false; the
// card-masking and truncation rules still apply.
function scrub(body: string): string {
  return redact(body, () => false) as string;
}

// A non-allowlisted person asks to join early access for a Google connector. Record a
// 'requested' connector request naming the service for the session user and email the
// operator so they can add the person to the allowlist. Returns the recorded request.
export async function askToJoinEarlyAccess(
  input: AskToJoinInput,
  deps: AskToJoinDeps,
): Promise<ConnectorRequest> {
  const serviceName = `Google early access: ${input.connector.name}`;

  const request = await createConnectorRequest(
    deps.db,
    { userId: input.userId, serviceName },
    deps.clock,
  );

  await deps.email.sendEmail({
    recipient: deps.operatorEmail,
    body: scrub(
      `Someone asked to join Google early access for "${input.connector.name}". ` +
        "Add their email to the early-access allowlist in Warthog if it fits.",
    ),
    email: mapEmailText({
      subject: "Google early access request",
      heading: "Someone asked to join Google early access",
      paragraphs: [
        `Someone asked to join Google early access for "${input.connector.name}".`,
        "Add their email to the early-access allowlist in Warthog if it fits.",
      ],
      reason: OPERATOR_EMAIL_REASON,
    }, scrub),
  });

  return request;
}
