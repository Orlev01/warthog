// E10-S12 — Consent page loader (the SIBLING seam the thin `src/app/oauth/consent/page.tsx`
// entry mounts). A Next entry file may export only its framework fields (OBS-025), so the
// loader logic lives here and the page stays thin over it.
//
// After a signed-in person's valid authorize request is carried to the consent screen
// (`beginAuthorization`, which stores the request SERVER-SIDE under an opaque handle the
// route puts in a host-locked cookie), this loader turns the pending request — resolved by
// its handle, NEVER trusted from a form/URL field — into the prop-driven <ConsentView>'s
// props (E10-S02): the connecting platform name, the redirect { host, verified } (verified
// === the callback is an https URL on a KNOWN platform's default port, EXACT host match,
// never a look-alike), a valid preselected starting set, and the plain-words scopes.
//
// Review fix A1 (defence in depth): authorize now refuses any redirect the client did not
// register, but the loader still renders nothing for a redirect outside the shared rule
// (https, or http on localhost / 127.0.0.1) — `javascript://claude.ai/…` has hostname
// `claude.ai` and used to earn the Verified badge.
//
// Rendering must NOT consume the one-time pending request — the page renders first and the
// person approves afterwards — so the loader reads through the NON-consuming
// `getPendingAuthorization`. An unknown or already-consumed handle resolves to null, so the
// page shows an expired-request message rather than crashing.

import { getAgentDefaults } from "@/server/db/agent-defaults";
import { getPendingAuthorization } from "../../../server/oauth/pending";
import { isAllowedRedirectUri } from "../../../server/oauth/clients";
import { listConnectionsForUser } from "../../../server/db/connections";
import type { ConsentViewProps, ConsentViewService } from "../../../components/agents/consent-view";
import type { ConsentApproval } from "../authorize/actions";
import type { Db } from "../../../server/db/index";

// The platforms Warthog recognises, by the EXACT host their OAuth callback returns to
// (design §6.1). A known callback host earns the "Verified platform" badge and a friendly
// platform name; the match is exact, so a look-alike (`evil-claude.ai`) a naive
// suffix/substring check would accept is NOT trusted. Any other host is shown prominently
// and never marked verified.
const KNOWN_PLATFORMS: ReadonlyMap<string, string> = new Map([
  ["claude.ai", "Claude"],
  ["claude.com", "Claude"],
  ["chatgpt.com", "ChatGPT"],
  ["oauth-redirect.googleusercontent.com", "Google"],
]);

// The recommended starting set the consent screen opens on (the person can change it).
const DEFAULT_TEMPLATE = "standard" as const;

// What connecting an agent asks for, in plain words — shown verbatim on the screen under
// "<platform> is asking to". Warthog issues a single "warthog" scope and the real limits
// are the permissions the person chooses below, so these describe the connection itself.
const REQUESTED_SCOPES: ReadonlyArray<string> = [
  "Connect to your Warthog as one of your agents",
  "Use only the permissions you choose below",
];

// Review fix A2 — the person's own connected services, offered on the screen so their
// read tools can be ticked. Member-scoped by the SESSION's user id; one row per connected
// service (a person can connect two accounts of one service), named through the
// catalogue when it knows the service. Never ticked by default: the person opts in.
export interface ConsentServicesSource {
  readonly db: Db;
  readonly nameOf?: (connectorId: string) => string | undefined;
}

export async function connectedServices(source: ConsentServicesSource, userId: string): Promise<ConsentViewService[]> {
  const ids = [...new Set((await listConnectionsForUser(source.db, userId)).map((c) => c.connectorId))];
  return ids.map((id) => ({ id, name: source.nameOf?.(id) ?? id, ticked: false }));
}

// The consent view for the pending request under `handle`, as seen by the signed-in
// person `userId` (the session's id). A request someone else started renders nothing
// (review fix W3.4), exactly like an expired one.
export async function loadConsentView(
  handle: string,
  userId: string,
  services?: ConsentServicesSource,
): Promise<ConsentViewProps | null> {
  const pending = getPendingAuthorization(handle, userId);
  if (pending == null) return null;

  const redirectUri = pending.params.get("redirect_uri");
  if (redirectUri == null || redirectUri === "" || !isAllowedRedirectUri(redirectUri)) return null;

  const url = new URL(redirectUri);
  const host = url.hostname;

  // Only the platform's own https origin (default port) is the platform; anything else on
  // a known host is shown, by host, without the badge.
  const known = url.protocol === "https:" && url.port === "" ? KNOWN_PLATFORMS.get(host) : undefined;
  const verified = known != null;
  const platform = known ?? host;

  return {
    platform,
    defaultName: platform,
    requestedScopes: REQUESTED_SCOPES,
    template: services ? (await getAgentDefaults(services.db, userId)).template : DEFAULT_TEMPLATE,
    redirect: { host: url.host, verified },
    ...(services ? { services: await connectedServices(services, userId) } : {}),
  };
}

// Review fix A2 — the approval the person submits, read from the consent form: their
// chosen name, the starting set, and EVERY toggle the screen shows as adjustable (a
// ticked checkbox is present in the form data, an unticked one is absent — so each is
// submitted as an explicit true/false and overrides the starting set), the ticked
// services, and the card budget when card requests are on. The connecting platform is
// taken SERVER-SIDE from the pending request (never the form); the acting person's id and
// the pending request come from the session and the handle cookie. Values are passed
// through as typed — the decision's zod boundary rejects a malformed one (a 4xx).
const VALID_TEMPLATES = new Set(["minimal", "standard", "custom"]);

export function approvalFromForm(formData: FormData, platform: string): ConsentApproval {
  const rawTemplate = String(formData.get("starting-set") ?? "standard");
  const template = VALID_TEMPLATES.has(rawTemplate) ? rawTemplate : "standard";
  const ticked = (name: string) => formData.get(name) != null;
  const card = ticked("card");
  return {
    name: String(formData.get("name") ?? "").trim(),
    platform,
    template,
    identity: ticked("identity"),
    memoryRead: ticked("memoryRead"),
    memoryWrite: ticked("memoryWrite"),
    tasks: ticked("tasks"),
    records: ticked("records"),
    highTier: ticked("highTier"),
    learningSharing: ticked("learningSharing"),
    tickedServices: formData.getAll("service").map(String),
    card,
    cardBudget: card
      ? {
          amount: Number(String(formData.get("cardBudgetAmount") ?? "").trim() || Number.NaN),
          currency: String(formData.get("cardBudgetCurrency") ?? "AUD"),
          period: String(formData.get("cardBudgetPeriod") ?? "month"),
        }
      : null,
  };
}
