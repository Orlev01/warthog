import * as React from "react";

import { loadConfig } from "@/server/config";
import { requireDevTools } from "@/server/dev/guard";
import { getServerDb } from "@/server/db/server";
import { systemClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { createAgentConsoleActions } from "./actions";
import { AgentConsoleView } from "@/components/dev/agent-console-view";

// E17-S10 — Dev fake agent console (loader). The `/dev/agent-console` page mints or reads a
// dev access key through the REAL per-agent access-key mechanism (the sibling
// `createAgentConsoleActions` seam) and mounts the render-testable client view so a developer
// can POST tool calls to `/mcp` with that key and see the response — driving the primary
// journey over HTTP.
//
// Behind the dev-tools guard: the loader re-derives it here (`requireDevTools(loadConfig())`)
// rather than trusting the `/dev` layout alone — exactly as the sibling outbox loader does —
// so the route 404s whenever dev tools are off, provisioning nothing. The flag is read only
// through the config module (secrets-from-env; INV-103), never from `process.env` directly.
//
// Thin entry over tested modules: it takes the process-wide database from `getServerDb()`
// (never `createDb`) and reads config at request time, then renders `AgentConsoleView`.

export default async function DevAgentConsolePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Touch request data first so `next build` marks this page dynamic and never prerenders it
  // — `loadConfig()` reads runtime config, which is absent at build.
  await searchParams;
  const config = loadConfig();
  requireDevTools(config);

  const db = await getServerDb();
  const { accessKey, endpoint } = await createAgentConsoleActions({
    db,
    clock: systemClock,
    random: systemRandom,
    config,
  }).load();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Agent console</h1>
        <p className="text-sm text-fg-muted">
          Call <code>/mcp</code> as an agent with a dev access key and see the tool response.
        </p>
      </header>
      <AgentConsoleView accessKey={accessKey} endpoint={endpoint} />
    </main>
  );
}
