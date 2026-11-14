import type { Metadata, Viewport } from "next";

import { adminHostFromEnv, onWebsiteHost, websiteFromEnv } from "@/server/config";

// The root document metadata (layout.tsx serves these as its metadata and `viewport`). They
// live in their own module because layout.tsx imports the global stylesheet and
// next/font, which load only under Next's bundler — this one stays importable by a test.
//
// Review fix G4 — installable PWA: the web app manifest is linked (Next emits
// <link rel="manifest">), the icons and an apple-touch-icon are declared (all committed
// under public/icons), and the apple-mobile-web-app tags make iOS "Add to Home Screen"
// launch a standalone web app — which iOS web push requires. Page titles use the
// "%s · Warthog" template (each portal page exports its own title).
//
// Only the app host is the installable app. The website host (docs/adr/website-root-domain.md)
// and the admin host get the same document metadata without the manifest and the iOS
// standalone tags, so an install always happens on the app's own origin: the manifest starts
// at /home, which the website forwards to the app and the admin host does not have, and iOS
// web push needs the installed origin.

const DOCUMENT_METADATA: Metadata = {
  title: { default: "Warthog", template: "%s · Warthog" },
  description: "Your agents work for you, on your terms, from your home.",
  applicationName: "Warthog",
  icons: {
    icon: [
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const SITE_METADATA: Metadata = {
  ...DOCUMENT_METADATA,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Warthog",
    statusBarStyle: "default",
  },
};

export const NOT_INSTALLABLE_METADATA: Metadata = DOCUMENT_METADATA;

/** The root metadata for a request hostname (requestHostname). */
export function rootMetadataFor(hostname: string | null): Metadata {
  const elsewhere = onWebsiteHost(hostname) || (hostname !== null && hostname === adminHostFromEnv());
  return elsewhere ? NOT_INSTALLABLE_METADATA : SITE_METADATA;
}

/**
 * A public page's metadata with its canonical address on the website, when it has its own
 * host. Both hosts serve the public pages, so this tells search engines which copy to index.
 */
export function publicPageMetadata(path: string, metadata: Metadata = {}): Metadata {
  const website = websiteFromEnv();
  return website ? { ...metadata, alternates: { canonical: `${website.origin}${path}` } } : metadata;
}

export const SITE_VIEWPORT: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // The browser chrome matches the top bars every screen now has: the surface colour of the
  // workspace and public bars (workspace.css / public.css), not the retired palette (mobile-15).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#252628" },
  ],
};
