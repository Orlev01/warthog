"use client";

import * as React from "react";

import "./globals.css";
import { ErrorScreen } from "@/components/shell/status-screens";

// The root error boundary (review fix G7): it replaces the root layout when the layout
// itself fails, so it renders its own <html>/<body> and loads the stylesheet. "Try
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
