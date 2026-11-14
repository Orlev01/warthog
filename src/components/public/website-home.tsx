"use client";

import * as React from "react";

// Where "home" is for the account-entry screens: the website's front door when it has its
// own host (docs/adr/website-root-domain.md), else the app's root. The (auth) layout reads
// it from configuration on the server and provides it here, because the screens that show
// the brand bar are client components.
const WebsiteHomeContext = React.createContext("/");

export function WebsiteHome({ href, children }: { href: string; children: React.ReactNode }) {
  return <WebsiteHomeContext.Provider value={href}>{children}</WebsiteHomeContext.Provider>;
}

export function useWebsiteHome(): string {
  return React.useContext(WebsiteHomeContext);
}
