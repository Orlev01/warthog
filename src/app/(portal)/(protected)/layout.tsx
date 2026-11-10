import { listAgentsForUser } from "@/server/db/agents";
import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getServerDb } from "@/server/db/server";
import { requireSession } from "@/server/auth/guard";
import { getPendingAccountReset } from "@/server/auth/account-reset";
import { systemClock } from "@/server/seams/clock";
import { PortalChrome } from "@/components/shell/portal-chrome";
import { PendingResetBanner } from "@/components/auth/pending-reset-banner";
import { timeZoneFor } from "@/server/spending/time-zone";
import { getUserById } from "@/server/db/users";
import { loadConfig } from "@/server/config";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";

// The auth-guard layout for the `(protected)` route group (INV-101, design §5): every
// admin route under it requires an authenticated operator session verified on the server,
// so an unauthenticated request is sent to sign in before any protected page renders. The
// public site (the `(auth)` sign-in page, `/privacy`, the `.well-known` metadata) lives
// OUTSIDE this group and stays reachable with no session.
//
// Thin by design: a `layout.tsx` is an awkward unit-test target (reserved Next props,
// `redirect()` throws), so this entry only reads the `__Host-wh_session` cookie and
// delegates the admit/redirect decision to the tested `requireSession` seam
// (`src/server/auth/guard.ts`). Identity is taken from that cookie alone, never from any
// other client-supplied value (INV-101).
//
// With a valid session the page is wrapped in PortalChrome — the client app shell that
// lights the current navigation section from the live path (render-tested in
// `src/components/shell/portal-chrome.test.tsx`), mounted propless so it reads the path
// from usePathname at runtime.
//
// While the person has an account reset pending, every signed-in screen leads with a banner
// that offers to cancel it (review fix W3.3; the brief: a reset "can be cancelled from any
// signed-in device"). The read is member-scoped by the verified session's user id.

// The host-locked session cookie set by the session module.
const SESSION_COOKIE = "__Host-wh_session";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  // Read the request first (marks the group dynamic, so next build never prerenders it), then
  // take the process-wide database — never createDb per request, never close the shared one.
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const db = await getServerDb();
  const result = await requireSession(token, { db, clock: systemClock });

  // No valid session → send the person to sign in (outside this group, so no loop).
  if (!result.ok) redirect(result.redirectTo);

  const pendingReset = await getPendingAccountReset(db, { userId: result.session.userId });
  let timeZone: string | undefined;
  if (pendingReset) {
    const user = await getUserById(db, result.session.userId);
    if (!user) redirect("/signin");
    const config = loadConfig();
    const wrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
    timeZone = await timeZoneFor(db, user.id, await wrapper.unwrap(user.wrappedDek));
  }
  const agents = await listAgentsForUser(db, result.session.userId);
  return (
    <PortalChrome agents={agents.map(agent => ({ id: agent.id, name: agent.displayName }))}>
      {pendingReset ? (
        <PendingResetBanner
          requestedAt={pendingReset.requestedAt.toISOString()}
          completesAt={pendingReset.completesAt.toISOString()}
          timeZone={timeZone}
        />
      ) : null}
      {children}
    </PortalChrome>
  );
}
