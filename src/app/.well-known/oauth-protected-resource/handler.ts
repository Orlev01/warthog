// The RFC 9728 protected-resource metadata document
// (`/.well-known/oauth-protected-resource`), so an agent can discover that Warthog's
// MCP endpoint is a protected resource and which authorization server guards it
// (design §6.1).
//
// The injection seam lives here, in a SIBLING of `route.ts`: a `route.ts` may export
// ONLY the known route keys (the HTTP verbs + config) or `next build` rejects it
// (OBS-025), so the factory that lets the handler be built against an explicit config
// cannot live there. `route.ts` imports `createProtectedResourceMetadataHandler` and
// wires it to `loadConfig()` before exporting `GET`.
//
// The document is PUBLIC: the handler takes only config (no session), so an
// unauthenticated GET is served (INV-101: public routes stay usable with no auth).
// The resource identifier and the listed authorization server both flow from the
// CONFIGURED public base URL (`config.publicBaseUrl`), never from the request host —
// the resource is `https://<public host>/mcp` (design §6.1).

import type { Config } from "../../../server/config";

// Strip a single trailing slash so the `/mcp` resource path joins cleanly whether or
// not the configured base URL carries one.
function baseUrl(config: Config): string {
  return config.publicBaseUrl.replace(/\/$/, "");
}

export function createProtectedResourceMetadataHandler({
  config,
}: {
  config: Config;
}): (request: Request) => Response {
  const issuer = baseUrl(config);
  const document = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["warthog"],
    bearer_methods_supported: ["header"],
  };
  return () => Response.json(document);
}
