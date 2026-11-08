import * as React from "react";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SITE_METADATA, SITE_VIEWPORT } from "./site-metadata";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

// The root metadata (manifest link, icons, iOS standalone tags, title template) and
// viewport live in ./site-metadata so a test can import them (see that module).
export const metadata: Metadata = SITE_METADATA;

export const viewport: Viewport = SITE_VIEWPORT;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU" className={inter.variable}>
      <body className="min-h-dvh bg-bg font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
