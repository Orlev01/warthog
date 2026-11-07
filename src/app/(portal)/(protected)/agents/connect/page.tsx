import * as React from "react";

import { loadConfig } from "@/server/config";
import { ConnectGuide } from "@/components/agents/connect-guide";

// E10-S05 — Agents connect page loader. The `/agents/connect` page the Agents screen
// links to, inside the `(protected)` route group (the auth guard is the group layout's
// job). The entry's own job is thin: read the public address from configuration (INV-21 /
// constitution #21) and derive Warthog's connector address (`<publicBaseUrl>/mcp`, design
// §6.1/§6.2), handing it to the guided-connect view. The flag/secret values are read only
// through the config module (secrets-from-env; INV-103).
//
// Thin entry over the render-tested view: all content lives in
// src/components/agents/connect-guide.tsx (the platform picker and each platform's
// guided-connect steps). `loadConfig()` is called INSIDE the handler, never at module load.
//
// E10-S13 (AC3) — a platform that can't use the standard connector sign-in gets a
// per-agent access key instead (constitution 16). The guided-connect view names that gap in
// words; this page turns it into a navigable link to the new `/agents/access-key` page.

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Touch request data first so `next build` marks this page dynamic and never
  // prerenders it — `loadConfig()` reads runtime config, which is absent at build.
  await searchParams;
  const config = loadConfig();
  const connectorAddress = `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp`;
  return (
    <div className="flex flex-col gap-8">
      <ConnectGuide connectorAddress={connectorAddress} />
      <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-base font-medium text-fg">Can&rsquo;t use a connector?</h2>
        <p className="text-sm text-fg-muted">
          Some agents can&rsquo;t sign in through a connector yet. Create an access key and
          paste that in instead.
        </p>
        <a
          href="/agents/access-key"
          className="inline-flex min-h-11 w-fit items-center justify-center gap-2 rounded-card border border-line bg-surface px-4 text-sm font-medium text-fg transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Create an access key
        </a>
      </section>
    </div>
  );
}
