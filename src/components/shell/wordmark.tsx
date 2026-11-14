import * as React from "react";

// Wordmark — the Warthog product identity: the founder's Warthog logo (the head and the
// WARTHOG lettering, public/brand/warthog-logo.png). It is a single link whose
// destination the caller decides: the front door when signed out (the auth and public
// screens: the website when it has its own host, else /) and /home when signed in (the
// shell). The logo is a CSS mask over that asset filled with the
// `--wh-logo` theme token, so it reads navy in light mode and near-white in dark mode
// without a second image (globals.css `.wh-logo`). The image carries the name visually and
// is hidden from assistive technology; a visually-hidden "Warthog home" names the link.
// It is at least a 44px-tall target on every surface (WCAG 2.5.8 and the 44px touch rule).

const SIZES = {
  // Page headers (auth, public and status screens).
  md: "h-12",
  // The workspace sidebar, where the logo is the only brand element.
  lg: "h-16",
} as const;

export function Wordmark({ href, size = "md" }: { href: string; size?: keyof typeof SIZES }) {
  return (
    <a href={href} className="inline-flex min-h-11 items-center rounded-card">
      <span aria-hidden={true} className={`wh-logo ${SIZES[size]}`}></span>
      <span className="sr-only">Warthog home</span>
    </a>
  );
}
