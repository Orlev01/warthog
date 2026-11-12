import * as React from "react";

import { loadConfig } from "@/server/config";
import { ConnectGuide } from "@/components/agents/connect-guide";
import { PageContainer } from "@/components/shell/page-container";

// E10-S05 — Agents connect page loader. The `/agents/connect` page the Agents screen
// links to, inside the `(protected)` route group (the auth guard is the group layout's
// job). The entry's own job is thin: read the public address from configuration (INV-21 /
// constitution #21) and derive Warthog's connector address (`<publicBaseUrl>/mcp`, design
// §6.1/§6.2), handing it to the guided-connect view. The flag/secret values are read only
// through the config module (secrets-from-env; INV-103).
//
// Thin entry over the render-tested view: all content lives in
// src/components/agents/connect-guide.tsx (the heading, how-to steps, each platform's
// guided-connect steps). `loadConfig()` is called INSIDE the handler, never at module load.
//
// E10-S13 (AC3) — a platform that can't use the standard connector sign-in gets a
// per-agent access key instead (constitution 16). The guided-connect view names that gap
// in words and links to the `/agents/access-key` page, in its steps and in its own panel.

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
    <PageContainer>
      <ConnectGuide connectorAddress={connectorAddress} />
    </PageContainer>
  );
}
