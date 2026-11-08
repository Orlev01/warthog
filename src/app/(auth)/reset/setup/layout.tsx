import * as React from "react";
import type { Metadata } from "next";

// Metadata-only segment layout: names this screen in the browser tab and to screen readers
// ("Set up a new passkey · Warthog" via the root template; WCAG 2.4.2 Page Titled).
export const metadata: Metadata = { title: "Set up a new passkey" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
