// Paths Warthog advertises to other parties, named once so every advertisement matches the
// route that serves it (review fix F13).
//
// The provider OAuth callback: where a provider sends the person back after they sign in to a
// connected service. It is served by `src/app/connect/callback/route.ts` and advertised in
// Warthog's CIMD document, in Dynamic Client Registration with provider MCP servers, and as the
// redirect_uri of every provider authorize request — all three must name exactly this URL, or
// the provider refuses the redirect (or sends the person to a page that does not exist).

export const CONNECT_CALLBACK_PATH = "/connect/callback";

// The absolute callback URL on Warthog's configured public base URL (never the request host).
export function connectCallbackUrl(publicBaseUrl: string): string {
  return new URL(CONNECT_CALLBACK_PATH, publicBaseUrl).href;
}
