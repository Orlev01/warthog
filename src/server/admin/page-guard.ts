// The admin pages' own guard (docs/design/admin-portal.md §2). The portal layout checks the
// admin session, but a layout is not enough on its own: on a client navigation Next renders
// only the segments below the first one the browser says it lacks (the `Next-Router-State-Tree`
// header, which the client controls), so a crafted request can render a page without running
// its layout. Every admin page therefore calls this first, outside any try/catch (a caught
// redirect would render the page's error state instead): it verifies the `__Host-wh_admin`
// session (role, app session and idle limits re-checked) and sends anyone else to the admin
// host's sign-in page before any data is read.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getServerDb } from "../db/server";
import { systemClock } from "../seams/clock";
import { requireAdminSession } from "./guard";
import { ADMIN_COOKIE_NAME, type AdminSession } from "./session";

export async function requireAdminPage(): Promise<AdminSession> {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value ?? null;
  const result = await requireAdminSession(token, { db: await getServerDb(), clock: systemClock });
  if (!result.ok) redirect(result.redirectTo);
  return result.session;
}
