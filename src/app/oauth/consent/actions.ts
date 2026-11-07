// E10-S12 — Consent page loader (the SIBLING seam the thin `src/app/oauth/consent/page.tsx`
// entry mounts). A Next entry file may export only its framework fields (OBS-025), so the
// loader logic lives here and the page stays thin over it.
//
// After a signed-in person's valid authorize request is carried to the consent screen
// (`beginAuthorization`, which stores the request SERVER-SIDE under an opaque handle the
// route puts in a host-locked cookie), this loader turns the pending request — resolved by
// its handle, NEVER trusted from a form/URL field — into the prop-driven <ConsentView>'s
// props (E10-S02): the connecting platform name, the redirect { host, verified } (verified
// === the callback host is a KNOWN platform, EXACT host match, never a look-alike), a valid
// preselected starting set, and the plain-words scopes.
//
// Rendering must NOT consume the one-time pending request — the page renders first and the
// person approves afterwards — so the loader reads through the NON-consuming
// `getPendingAuthorization`. An unknown or already-consumed handle resolves to null, so the
// page shows an expired-request message rather than crashing.

import { getPendingAuthorization } from "../../../server/oauth/pending";
import type { ConsentViewProps } from "../../../components/agents/consent-view";

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

export async function loadConsentView(handle: string): Promise<ConsentViewProps | null> {
  const pending = getPendingAuthorization(handle);
  if (pending == null) return null;

  const redirectUri = pending.params.get("redirect_uri");
  if (redirectUri == null || redirectUri === "") return null;

  let host: string;
  try {
    host = new URL(redirectUri).hostname;
  } catch {
    return null;
  }

  const friendly = KNOWN_PLATFORMS.get(host);
  const verified = friendly != null;
  const platform = friendly ?? host;

  return {
    platform,
    defaultName: platform,
    requestedScopes: REQUESTED_SCOPES,
    template: DEFAULT_TEMPLATE,
    redirect: { host, verified },
  };
}
