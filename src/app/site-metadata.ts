import type { Metadata, Viewport } from "next";

// The root document metadata (layout.tsx exports these as `metadata` / `viewport`). They
// live in their own module because layout.tsx imports the global stylesheet and
// next/font, which load only under Next's bundler — this one stays importable by a test.
//
// Review fix G4 — installable PWA: the web app manifest is linked (Next emits
// <link rel="manifest">), the icons and an apple-touch-icon are declared (all committed
// under public/icons), and the apple-mobile-web-app tags make iOS "Add to Home Screen"
// launch a standalone web app — which iOS web push requires. Page titles use the
// "%s · Warthog" template (each portal page exports its own title).

export const SITE_METADATA: Metadata = {
  title: { default: "Warthog", template: "%s · Warthog" },
  description: "Your agents work for you, on your terms, from your home.",
  applicationName: "Warthog",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Warthog",
    statusBarStyle: "default",
  },
};

export const SITE_VIEWPORT: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};
