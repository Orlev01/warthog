// E17-S07 — the dev-tools guard (design: dev affordances off by default, out of prod).
//
// The `/dev` affordances must only exist when `WARTHOG_DEV_TOOLS=1` — the flag the
// production config refuses to start with (`assertProductionSafe` in
// `src/server/config.ts`). This is the single gate that keeps the whole dev surface off
// by default: the thin `src/app/dev/layout.tsx` entry calls this guard, which admits the
// request when dev tools are enabled and triggers a Next not-found when they are not, so
// every `/dev` route 404s unless the flag is explicitly set.
//
// Thin entries over tested modules (conventions): a `layout.tsx` is an awkward unit-test
// target (reserved Next props, `notFound()` throws), so the decision lives in this server
// seam exactly as the admin `(protected)/layout.tsx` delegates to `requireSession`.
//
// The flag is read only through the config module (`config.devTools`, which the config
// module parsed from the environment), never from `process.env` directly
// (secrets-from-env; INV-103).

import { notFound } from "next/navigation";

import type { Config } from "../config";

// Admit the request when dev tools are enabled; otherwise trigger a Next not-found so the
// `/dev` route renders the 404 page. `notFound()` throws, so this never returns on the
// disabled path.
export function requireDevTools(config: Config): void {
  if (!config.devTools) notFound();
}
