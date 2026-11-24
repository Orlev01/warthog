// The App-Router entry for `/.well-known/oauth-protected-resource/mcp`: the same RFC 9728
// document as `/.well-known/oauth-protected-resource`, at the path RFC 9728 §3.1 derives
// from the resource identifier (`https://<public host>/mcp`) — where a client that probes
// rather than reading the `401`'s `resource_metadata` looks for it (design §6.1).

import { loadConfig } from "../../../../server/config";
import { createProtectedResourceMetadataHandler } from "../handler";

// Config is read per request, never at module load (see the sibling `route.ts`).
export function GET(request: Request): Response {
  return createProtectedResourceMetadataHandler({ config: loadConfig() })(request);
}
