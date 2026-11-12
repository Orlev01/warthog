import * as React from "react";
import type { Metadata } from "next";

// Metadata-only segment layout: names this screen in the browser tab and to screen readers
// ("Set up a new passkey · Warthog" via the root template; WCAG 2.4.2 Page Titled).
// The parent /reset layout sets a plain title, which stops the root "%s · Warthog" template
// for this child segment, so the full title is given here (public-19).
export const metadata: Metadata = { title: { absolute: "Set up a new passkey · Warthog" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
