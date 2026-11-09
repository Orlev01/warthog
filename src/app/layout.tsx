import * as React from "react";
import type { Metadata, Viewport } from "next";
import "./fonts.css";
import "./globals.css";
import { SITE_METADATA, SITE_VIEWPORT } from "./site-metadata";


// The root metadata (manifest link, icons, iOS standalone tags, title template) and
// viewport live in ./site-metadata so a test can import them (see that module).
export const metadata: Metadata = SITE_METADATA;

export const viewport: Viewport = SITE_VIEWPORT;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <head><link rel="preload" href="/fonts/inter/latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /></head>
      <body className="min-h-dvh bg-bg font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
// Nonce-bearing HTML must be rendered per request; cached HTML would carry a
// nonce different from the current response's CSP.
export const dynamic = "force-dynamic";
