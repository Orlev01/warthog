"use client";

import * as React from "react";
import { ArrowLeft, LogOut } from "lucide-react";

import { AppShell } from "@/components/shell/app-shell";
import { ADMIN_ICONS, ADMIN_NAV_GROUPS, activeAdminSection, adminMeasureFor } from "./admin-nav";

// AdminChrome — the admin portal's shell (docs/design/admin-portal.md §5): the same AppShell
// the member portal uses, handed the admin IA through its `chrome` prop, so both portals share
// one sidebar, drawer, top bar and page-measure contract. The current section comes from the
// `pathname` PROP — the ORIGINAL un-prefixed path the proxy forwards to the layout — never
// from usePathname, which would see the rewritten `/admin/...` path on the server and the
// browser's path on the client. The sidebar footer carries the two ways out: back to the
// member app (the configured app origin, never a request host) and signing out of admin (a
// plain form POST to the admin host's sign-out route, so it works without client JavaScript).

export type AdminChromeProps = {
  pathname: string;
  appOrigin: string;
  children: React.ReactNode;
};

function AdminFooter({ appOrigin }: { appOrigin: string }) {
  return (
    <div className="wh-admin-footer">
      <a href={`${appOrigin}/home`} className="wh-sidebar-link text-fg-muted">
        <ArrowLeft aria-hidden={true} className="h-[18px] w-[18px] shrink-0" strokeWidth={1.7} />
        <span>Back to Warthog</span>
      </a>
      <form method="post" action="/signout">
        <button type="submit" className="wh-sidebar-link w-full text-fg-muted">
          <LogOut aria-hidden={true} className="h-[18px] w-[18px] shrink-0" strokeWidth={1.7} />
          <span>Sign out of admin</span>
        </button>
      </form>
    </div>
  );
}

export function AdminChrome({ pathname, appOrigin, children }: AdminChromeProps) {
  const section = activeAdminSection(pathname);
  return (
    <AppShell
      activeSection={section ?? ""}
      measure={adminMeasureFor(section)}
      chrome={{
        groups: ADMIN_NAV_GROUPS,
        icons: ADMIN_ICONS,
        homeHref: "/",
        workspace: { label: "Admin", initial: "A" },
        helpHref: null,
      }}
      sidebarFooter={<AdminFooter appOrigin={appOrigin} />}
    >
      {children}
    </AppShell>
  );
}
