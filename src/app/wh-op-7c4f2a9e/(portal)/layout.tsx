import * as React from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { AdminChrome } from "@/components/admin/admin-chrome";
import { ADMIN_PATH_HEADER } from "@/proxy";
import { getServerDb } from "@/server/db/server";
import { loadConfig } from "@/server/config";
import { requireAdminSession } from "@/server/admin/guard";
import { ADMIN_COOKIE_NAME } from "@/server/admin/session";
import { systemClock } from "@/server/seams/clock";
import "../portal.css";

// The admin-area guard layout (docs/design/admin-portal.md §2): every page under the internal prefix —
// reached only on the admin host, where the proxy rewrites `/usage` to `<prefix>/usage` —
// requires a live `__Host-wh_admin` session verified on the server (which re-checks the
// admin role and the app session on every request). Anyone else is sent to the admin
// host's own sign-in page. Route handlers (the exchange and sign-out) are not wrapped by a
// layout and guard themselves.
//
// Thin by design: this entry reads the cookie and the proxy's forwarded original path, and
// delegates the admit/redirect decision to the tested `requireAdminSession` seam. The
// forwarded path lights the chrome's current section: `usePathname` would see the
// rewritten path on the server and the browser's path on the client.

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value ?? null;
  const pathname = (await headers()).get(ADMIN_PATH_HEADER) ?? "/";
  const config = loadConfig();
  const db = await getServerDb();
  const result = await requireAdminSession(token, { db, clock: systemClock });
  if (!result.ok) redirect(result.redirectTo);
  return (
    <AdminChrome pathname={pathname} appOrigin={new URL(config.publicBaseUrl).origin}>
      {children}
    </AdminChrome>
  );
}
