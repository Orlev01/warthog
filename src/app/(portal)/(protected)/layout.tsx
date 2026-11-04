import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { loadConfig } from "@/server/config";
import { createDb } from "@/server/db/index";
import { requireSession } from "@/server/auth/guard";
import { systemClock } from "@/server/seams/clock";

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

// The host-locked session cookie set by the session module.
const SESSION_COOKIE = "__Host-wh_session";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const config = loadConfig();
  const db = await createDb(config.databaseUrl);
  let result;
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
    result = await requireSession(token, { db, clock: systemClock });
  } finally {
    await db.close();
  }

  // No valid session → send the person to sign in (outside this group, so no loop).
  if (!result.ok) redirect(result.redirectTo);

  return <>{children}</>;
}
