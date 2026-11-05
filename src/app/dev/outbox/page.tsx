import * as React from "react";

import { loadConfig } from "@/server/config";
import { requireDevTools } from "@/server/dev/guard";
import { outbox } from "@/server/notify/outbox";
import { OutboxView } from "@/components/dev/outbox-view";

// E17-S08 — Dev outbox viewer (loader). The `/dev/outbox` page lists the push /
// email / SMS the process-wide dev outbox captured, so the primary journey's
// notifications and single-use approval / sign-in links can be seen while driving
// it over HTTP.
//
// Behind the dev-tools guard: the loader re-derives it here
// (`requireDevTools(loadConfig())`) rather than trusting the `/dev` layout alone —
// exactly as the protected pages re-derive their own session guard — so the route
// 404s whenever dev tools are off. The flag is read only through the config module
// (secrets-from-env; INV-103), never from `process.env` directly.
//
// Thin entry over the tested view: it reads `outbox.list()` at request time (the
// live outbox, not a build-time snapshot) and renders the render-testable
// `OutboxView`.

export default async function DevOutboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Touch request data first so `next build` marks this page dynamic and never
  // prerenders it — `loadConfig()` reads runtime config, which is absent at build.
  await searchParams;
  requireDevTools(loadConfig());
  const messages = outbox.list();
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Dev outbox</h1>
        <p className="text-sm text-fg-muted">
          Every push, email and SMS the dev outbox captured, with their single-use links.
        </p>
      </header>
      <OutboxView messages={messages} />
    </main>
  );
}
