// Warthog's own Client ID Metadata Document (CIMD), served at
// `/oauth/client-metadata.json` (design §6.1, §7). Warthog connects to `provider_mcp`
// connectors as an MCP *client*; under CIMD a client is identified by the https URL at
// which its metadata document lives — the document URL *is* the `client_id` — so a
// provider acting as the authorization server fetches this document to self-register
// Warthog, with no pre-shared secret.
//
// The injection seam lives here, in a SIBLING of `route.ts`: a `route.ts` may export
// ONLY the known route keys (the HTTP verbs + config) or `next build` rejects it
// (OBS-025), so the factory that lets the handler be built against an explicit config
// cannot live there. `route.ts` imports `createClientMetadataHandler` and wires it to
// `loadConfig()` before exporting `GET`.
//
// The document is PUBLIC: the handler takes only config (no session), so an
// unauthenticated GET is served (INV-101: public routes stay usable with no auth).
// Every value flows from the CONFIGURED public base URL (`config.publicBaseUrl`),
// never from the incoming request's host — the `client_id` is the document's own
// served URL and must not be rewritable by a spoofed Host header.

import type { Config } from "../../../server/config";
import { connectCallbackUrl } from "../../../server/http/routes";

// Strip a single trailing slash so sub-path endpoints join cleanly whether or not the
// configured base URL carries one (`https://host/` + `/oauth/...` must not double the
// slash).
function baseUrl(config: Config): string {
  return config.publicBaseUrl.replace(/\/$/, "");
}

export function createClientMetadataHandler({
  config,
}: {
  config: Config;
}): (request: Request) => Response {
  const issuer = baseUrl(config);
  const document = {
    // The defining CIMD rule: the document URL is the client_id.
    client_id: `${issuer}/oauth/client-metadata.json`,
    // Where a provider returns the authorization code — on Warthog's own host.
    redirect_uris: [connectCallbackUrl(issuer)],
    // Warthog is a public client (PKCE, no client secret).
    token_endpoint_auth_method: "none",
    // The name the provider's consent screen shows. Required in practice: Notion's
    // authorization server refuses a document without it as "Invalid client_id"
    // (17 Nov 2026), and the CIMD draft recommends it. Matches the metadata Warthog sends
    // when it registers by DCR instead (src/server/connectors/provider-client.ts).
    client_name: "Warthog",
    // Without refresh_token a provider may refuse to renew the connection's access.
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  return () => Response.json(document);
}
