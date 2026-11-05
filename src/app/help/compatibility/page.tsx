import * as React from "react";

import { loadConfig } from "@/server/config";
import { Help } from "@/components/public/help";

// E05-S02 — Compatibility page entry. A PUBLIC `/help/compatibility` page, reachable
// by anyone with no authentication (it sits at the top level, under no guard layout),
// that mounts the help / compatibility VIEW. The entry's own job is to read the
// public address from configuration (INV-21) and derive Warthog's connector address
// (`<publicBaseUrl>/mcp`, design §6.1/§6.2), handing it to the view. The flag/secret
// values are read only through the config module (secrets-from-env; INV-103).
//
// Thin entry over the render-tested view: all content lives in src/components/public/help.tsx.

export default async function CompatibilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Touch request data first so `next build` marks this page dynamic and never
  // prerenders it — `loadConfig()` reads runtime config, which is absent at build.
  await searchParams;
  const config = loadConfig();
  const connectorAddress = `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp`;
  return <Help connectorAddress={connectorAddress} />;
}
