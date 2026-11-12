import * as React from "react";
import type { Metadata } from "next";

// Metadata-only segment layout: names this screen in the browser tab and to screen readers
// (review fix G8, WCAG 2.4.2 Page Titled), after the page's heading. The parent /help layout
// sets a plain title, which stops the root "%s · Warthog" template for this child segment, so
// the full title is given here (public-19, content-08). It renders its children unchanged.
export const metadata: Metadata = { title: { absolute: "Connect your agents · Warthog" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
