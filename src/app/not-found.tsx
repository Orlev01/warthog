import * as React from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { NotFoundScreen } from "@/components/shell/status-screens";
import { PortalChrome } from "@/components/shell/portal-chrome";
import type { ScopeAgent } from "@/components/agents/resource-scope";
import { COOKIE_NAME } from "@/server/auth/session";
import { requireSession } from "@/server/auth/guard";
import { getServerDb } from "@/server/db/server";
import { listAgentsForUser } from "@/server/db/agents";
import { systemClock } from "@/server/seams/clock";

// The app-wide 404 page (review fix G7) — also what Next renders for any URL no route matches.
// A signed-in member (a stale link such as /settings/old or /vault/x) keeps the workspace
// shell: sidebar, top bar and drawer stay, and the not-found panel sits in the page container.
// Anyone else gets the public frame, whose way back is "/" (the landing page, which sends a
// signed-in member on to /home). An absent cookie never opens the database; a cookie is
// verified with the same revocation and expiry rules as the protected layout, and the agent
// list is scoped to that session's user.
export const metadata: Metadata = { title: "Page not found" };

async function signedInAgents(): Promise<ScopeAgent[] | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value ?? null;
  if (!token) return null;
  try {
    const db = await getServerDb();
    const result = await requireSession(token, { db, clock: systemClock });
    if (!result.ok) return null;
    const agents = await listAgentsForUser(db, result.session.userId);
    return agents.map((agent) => ({ id: agent.id, name: agent.displayName, connected: agent.status === "connected" }));
  } catch {
    // If the session can't be checked, the public 404 is still a correct answer.
    return null;
  }
}

export default async function NotFound() {
  const agents = await signedInAgents();
  if (agents) {
    return (
      <PortalChrome agents={agents} sectionChrome={false}>
        <NotFoundScreen variant="workspace" />
      </PortalChrome>
    );
  }
  return <NotFoundScreen />;
}
