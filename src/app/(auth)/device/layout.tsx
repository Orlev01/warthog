import * as React from "react";
import type { Metadata } from "next";

// Metadata-only segment layout: names this screen in the browser tab and to screen readers
// ("Sign in on this device · Warthog" via the root template; WCAG 2.4.2 Page Titled). It renders its children
// unchanged.
// Named after the screen's heading (public-19, content-48).
export const metadata: Metadata = { title: "Add this device" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
