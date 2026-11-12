import * as React from "react";
import type { Metadata } from "next";

// Metadata-only segment layout: names this screen in the browser tab and to screen readers
// ("Connect an agent · Warthog"; review fix G8, WCAG 2.4.2 Page Titled). The parent Agents
// layout sets a plain title, which stops the root "%s · Warthog" template reaching this
// segment, so the suffix is written out (content-24). It
// renders its children unchanged — the shared app shell is the (protected) layout.
export const metadata: Metadata = { title: { absolute: "Connect an agent · Warthog" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
