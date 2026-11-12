"use client";

import * as React from "react";

import "./fonts.css";
import "./globals.css";
import "./surfaces.css";
import "./controls.css";
import "./public.css";
import { ErrorScreen } from "@/components/shell/status-screens";

// The root error boundary (review fix G7): it replaces the root layout when the layout
// itself fails, so it renders its own <html>/<body> and loads the same stylesheets and local
// font as the root layout, in the same order. "Try
// again" re-renders the app; "Go to Home" always works.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en-AU">
      <body className="min-h-dvh bg-bg font-sans text-fg antialiased">
        <ErrorScreen digest={error.digest} reset={reset} />
      </body>
    </html>
  );
}
