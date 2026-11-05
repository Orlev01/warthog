"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { AppShell } from "./app-shell";
import { SignOutControl } from "./sign-out";
import { activeSectionForPath } from "./nav";

// PortalChrome — the signed-in app chrome the (portal)/(protected) layout mounts
// to wrap every portal page: <PortalChrome>{children}</PortalChrome>. A `layout.tsx`
// is an awkward unit-test target (reserved Next props, it reads cookies/redirects),
// so — like DocumentShell for the root layout — the guard layout delegates the
// navigation to this plain, render-testable client component. It turns the CURRENT
// PATH into the lit navigation section and wraps the page in the shared AppShell
// (both the mobile bottom nav and the desktop sidebar).
//
// The path is the `pathname` prop when given (the SSR / render-test override),
// otherwise the live path from usePathname() (next/navigation). The layout mounts
// PortalChrome with NO prop, so the propless mount must work: usePathname resolves
// to null with no router present, which activeSectionForPath normalises to "no
// section", so nothing is lit rather than crashing or lighting a default.
//
// The section keys and routes come from the one canonical IA (nav.ts); AppShell is
// the single source of the two nav surfaces. PortalChrome only names the active
// section — it adds no second copy of the destination list.

export type PortalChromeProps = {
  // The current path, supplied for SSR / render tests. Optional: the layout mounts
  // PortalChrome propless and the live path is read from usePathname at runtime.
  pathname?: string;
  // The page content, rendered inside the shell's <main> content region.
  children: React.ReactNode;
};

export function PortalChrome({ pathname, children }: PortalChromeProps) {
  // usePathname is called unconditionally (rules of hooks); the prop overrides it
  // when present. With no router mounted usePathname is null, so default to "".
  const livePath = usePathname();
  const path = pathname ?? livePath ?? "";
  const activeSection = activeSectionForPath(path) ?? "";

  // The 'Sign out' control sits in the desktop sidebar FOOTER (its mobile twin lives
  // in the More menu, <MoreMenu>); both reuse the one shared SignOutControl.
  return (
    <AppShell activeSection={activeSection} sidebarFooter={<SignOutControl className="px-3 py-2" />}>
      {children}
    </AppShell>
  );
}
