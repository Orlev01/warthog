"use client";

import { ResourceScope, type ScopeAgent } from "@/components/agents/resource-scope";
import * as React from "react";
import { usePathname } from "next/navigation";

import { SectionNavigation } from "./section-navigation";
import { AppShell } from "./app-shell";
import { SignOutControl } from "./sign-out";
import { activeSectionForPath } from "./nav";
import { pageMeasureFor, sectionNavigation } from "./workspace-navigation";
import { WorkspaceContext } from "./workspace-context";

// PortalChrome — the signed-in app chrome the (portal)/(protected) layout mounts
// to wrap every portal page: <PortalChrome>{children}</PortalChrome>. A `layout.tsx`
// is an awkward unit-test target (reserved Next props, it reads cookies/redirects),
// so — like DocumentShell for the root layout — the guard layout delegates the
// navigation to this plain, render-testable client component. It turns the CURRENT
// PATH into the lit navigation section and wraps the page in the shared AppShell
// (both the mobile drawer and the desktop sidebar).
//
// The path is the `pathname` prop when given (the SSR / render-test override),
// otherwise the live path from usePathname() (next/navigation). The layout mounts
// PortalChrome with NO prop, so the propless mount must work: usePathname resolves
// to null with no router present, which activeSectionForPath normalises to "no
// section", so nothing is lit rather than crashing or lighting a default.
//
// The section keys and routes come from the one canonical IA (nav.ts); AppShell is
// the single source of the two nav surfaces. PortalChrome only names the active
// section — it adds no second copy of the destination list. It also names the page
// measure for the section family (pageMeasureFor) and shares the path and agents with the
// page's WorkspaceHeading (WorkspaceContext), which shows the agent-scope row in its band.

export type PortalChromeProps = {
  // The current path, supplied for SSR / render tests. Optional: the layout mounts
  // PortalChrome propless and the live path is read from usePathname at runtime.
  pathname?: string;
  agents?: readonly ScopeAgent[];
  // false: no route tabs or scope strip (a not-found page under a real section's path).
  sectionChrome?: boolean;
  // The page content, rendered inside the shell's <main> content region.
  children: React.ReactNode;
};

export function PortalChrome({ pathname, children, agents = [], sectionChrome = true }: PortalChromeProps) {
  // usePathname is called unconditionally (rules of hooks); the prop overrides it
  // when present. With no router mounted usePathname is null, so default to "".
  const livePath = usePathname();
  const path = pathname ?? livePath ?? "";
  const activeSection = activeSectionForPath(path) ?? "";
  const tabs = sectionChrome ? sectionNavigation(path) : null;
  const tab = tabs?.items.find((item) => item.active);
  const workspace = React.useMemo(() => ({ pathname: path, agents }), [path, agents]);

  // The desktop sidebar and mobile drawer share the same sign-out control. The route tabs sit
  // with the top bar, outside <main>, so "Skip to content" lands on the page itself.
  return (
    <WorkspaceContext.Provider value={workspace}>
      <AppShell
        activeSection={activeSection}
        page={tab ? { label: tab.label, href: tab.href } : undefined}
        measure={sectionChrome ? pageMeasureFor(path) : "reading"}
        sectionNavigation={sectionChrome ? <SectionNavigation pathname={path} /> : null}
        sidebarFooter={<SignOutControl variant="sidebar" />}
      >
        {sectionChrome ? <ResourceScope pathname={path} agents={agents} /> : null}
        {children}
      </AppShell>
    </WorkspaceContext.Provider>
  );
}
