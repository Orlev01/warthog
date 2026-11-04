// The RFC 8414 authorization-server metadata document
// (`/.well-known/oauth-authorization-server`), so an agent platform can discover
// where Warthog's OAuth endpoints live and how to authenticate to them (design §6.1).
//
// The injection seam lives here, in a SIBLING of `route.ts`: a `route.ts` may export
// ONLY the known route keys (the HTTP verbs + config) or `next build` rejects it
// (OBS-025), so the factory that lets the handler be built against an explicit config
// cannot live there. `route.ts` imports `createAuthServerMetadataHandler` and wires
// it to `loadConfig()` before exporting `GET`.
//
// The document is PUBLIC: the handler takes only config (no session), so an
// unauthenticated GET is served (INV-101: public routes stay usable with no auth).
// Every value flows from the CONFIGURED public base URL (`config.publicBaseUrl`),
// never from the incoming request's host — a metadata document that echoed the
// request host would let a spoofed Host header rewrite the issuer.

import type { Config } from "../../../server/config";

// Strip a single trailing slash so sub-path endpoints join cleanly whether or not the
// configured base URL carries one (`https://host/` + `/oauth/token` must not be
// `https://host//oauth/token`).
function baseUrl(config: Config): string {
  return config.publicBaseUrl.replace(/\/$/, "");
}

export function createAuthServerMetadataHandler({
  config,
}: {
  config: Config;
}): (request: Request) => Response {
  const issuer = baseUrl(config);
  const document = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  return () => Response.json(document);
}
