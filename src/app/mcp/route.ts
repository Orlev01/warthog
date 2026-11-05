// The App-Router entry for `/mcp`, the agent connector endpoint (design §6.2): thin by
// design. `createMcpHandler` is stateless and needs Node APIs, so the route runs on the
// nodejs runtime. A `route.ts` may export ONLY the known route keys (the HTTP verbs +
// config) or `next build` rejects it (OBS-025), so the injection seam lives in the
// sibling `handler.ts`; this file exports just `runtime` and the three verbs.
//
// Building the handler here is side-effect-free: the factory resolves its config / db /
// MCP seams lazily, per request, so no runtime configuration is read at module load
// (next build evaluates route modules where it is absent).

import { createMcpRouteHandler } from "./handler";

export const runtime = "nodejs";

const handlers = createMcpRouteHandler();

export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
