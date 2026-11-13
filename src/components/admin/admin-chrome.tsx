"use client";

import * as React from "react";

// AdminChrome — the admin portal's shell (docs/design/admin-portal.md §5). PLACEHOLDER: the
// UI slice replaces this with a twin of PortalChrome over AppShell's `chrome` prop. The
// contract the layout relies on is fixed here: the original path on the admin host
// (forwarded by the proxy as x-admin-pathname) and the app origin for "Back to Warthog".
export type AdminChromeProps = {
  pathname: string;
  appOrigin: string;
  children: React.ReactNode;
};

export function AdminChrome({ children }: AdminChromeProps) {
  return <div className="wh-workspace"><main id="workspace-content" className="wh-content">{children}</main></div>;
}
