import * as React from "react";

import { loadConfig } from "@/server/config";
import { requireDevTools } from "@/server/dev/guard";

// The dev-tools guard layout for every `/dev` route (E17-S07): the dev affordances must
// only exist when `WARTHOG_DEV_TOOLS=1` (the flag production refuses to start with), so a
// request here 404s unless dev tools are explicitly enabled.
//
// Thin by design: a `layout.tsx` is an awkward unit-test target (reserved Next props,
// `notFound()` throws), so this entry reads config at the request (never at module load —
// next build evaluates route modules with runtime config absent) and delegates the
// admit/not-found decision to the tested `requireDevTools` seam (`src/server/dev/guard`).
// The flag is taken from the config module alone, never from `process.env` directly
// (secrets-from-env; INV-103).
//
// Dev routes depend on runtime config (`loadConfig()`) and live in-memory state (the dev
// outbox / agent console), so they must never be prerendered: `force-dynamic` keeps every
// `/dev` route — this guard layout included — out of `next build`'s static-generation pass,
// where runtime config is absent and `loadConfig()` would throw (the server-composition-roots
// addendum). The option applies to this segment and every page nested under it.
export const dynamic = "force-dynamic";

export default function DevLayout({ children }: { children: React.ReactNode }) {
  requireDevTools(loadConfig());
  return <>{children}</>;
}
