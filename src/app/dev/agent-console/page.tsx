import * as React from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { loadConfig } from "@/server/config";
import { requireDevTools } from "@/server/dev/guard";
import { getServerDb } from "@/server/db/server";
import { verifySession, COOKIE_NAME, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { createAgentConsoleActions } from "./actions";
import { AgentConsoleView } from "@/components/dev/agent-console-view";
import { DevFrame } from "@/components/dev/dev-frame";
import type { Db } from "@/server/db/index";

// "Agent console · Warthog" in the tab (the dev pages used to be titled just "Warthog").
export const metadata: Metadata = { title: "Agent console" };

// E17-S11 — Dev agent console (loader). The `/dev/agent-console` page provisions (once per
// person, then reuses) a REAL dev agent FOR THE SIGNED-IN PERSON through the sibling
// `createAgentConsoleActions` seam and mounts the render-testable client view so a developer
// can POST tool calls to `/mcp` with that agent's access key and see the response — driving
// the primary journey over HTTP.
//
// Behind the dev-tools guard: the loader re-derives it here (`requireDevTools(loadConfig())`)
// rather than trusting the `/dev` layout alone — exactly as the sibling outbox loader does —
// so the route 404s whenever dev tools are off, provisioning nothing. The flag is read only
// through the config module (secrets-from-env; INV-103), never from `process.env` directly.
//
// Thin entry over tested modules: it reads per-request data first (searchParams, then a soft
// read of the session cookie), takes the process-wide database from `getServerDb()` (never
// `createDb`), reads config at request time, then renders `AgentConsoleView`. The session is
// a SOFT read — resolved from the `__Host-wh_session` cookie when present, otherwise null —
// so the seam provisions the person's own dev agent when signed in and the self-contained dev
// fallback when not (the state the guarded page renders in with no session).

// Resolve the signed-in session from the host-locked `__Host-wh_session` cookie, or null.
// A soft read: outside a request scope (a render with no request) there is no cookie store,
// so it degrades to "not signed in" rather than throwing — the seam then provisions the dev
// fallback (design §5: identity is read only from the presented session token).
async function resolveSession(db: Db): Promise<Session | null> {
  let token: string | null = null;
  try {
    token = (await cookies()).get(COOKIE_NAME)?.value ?? null;
  } catch {
    return null;
  }
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Issue a fresh key for the dev agent, on request only — loading the page reuses the key it
// already issued (interaction-09). Re-checks the dev-tools guard and the soft session.
async function rotateKey(): Promise<void> {
  "use server";
  const config = loadConfig();
  requireDevTools(config);
  const db = await getServerDb();
  const session = await resolveSession(db);
  await createAgentConsoleActions({ db, clock: systemClock, random: systemRandom, config }).rotate(session);
  redirect("/dev/agent-console");
}

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
  const session = await resolveSession(db);
  const { accessKey, endpoint } = await createAgentConsoleActions({
    db,
    clock: systemClock,
    random: systemRandom,
    config,
  }).load(session);

  return (
    <DevFrame
      current="/dev/agent-console"
      title="Agent console"
      description={<p>Call Warthog&rsquo;s agent endpoint as an agent, with a dev access key, and see the tool&rsquo;s response.</p>}
    >
      <AgentConsoleView accessKey={accessKey} endpoint={endpoint} rotateAction={rotateKey} />
    </DevFrame>
  );
}
