import * as React from "react";
import type { Metadata } from "next";

// Metadata-only segment layout: names this screen in the browser tab and to screen readers
// ("Connect an agent · Warthog" via the root template; WCAG 2.4.2 Page Titled). It renders its children
// unchanged.
export const metadata: Metadata = { title: "Connect an agent" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
