import * as React from "react";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./fonts.css";
import "./globals.css";
import "./surfaces.css";
import "./controls.css";
import "./public.css";
import { requestHostname } from "@/server/admin/origin";
import { SITE_VIEWPORT, rootMetadataFor } from "./site-metadata";


// The root metadata (manifest link, icons, iOS standalone tags, title template) and
// viewport live in ./site-metadata so a test can import them (see that module). Only the app
// host gets the installable-app tags.
export async function generateMetadata(): Promise<Metadata> {
  return rootMetadataFor(requestHostname(await headers()));
}

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
