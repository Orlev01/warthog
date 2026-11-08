import * as React from "react";
import type { Metadata } from "next";

// Metadata-only segment layout: names this screen in the browser tab and to screen readers
// ("Memory · Warthog" via the root template; review fix G8, WCAG 2.4.2 Page Titled). It
// renders its children unchanged — the shared app shell is the (protected) layout.
export const metadata: Metadata = { title: "Memory" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
